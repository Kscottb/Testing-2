/**
 * FX unit tests (node: no DOM, no WebGL). The simulation core is tested directly; the whole system is
 * driven through its public interface against a minimal GameContext.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FX_CAPS, FX_STREAM_IDS } from '../core/constants';
import { createEventBus } from '../core/events';
import { createRng } from '../core/rng';
import { createTime } from '../core/time';
import type { TimeCore } from '../core/time';
import type { CollisionBox, FxId, FxSystem, GameContext, QualityParams, SettingsData, TimeOfDayId } from '../core/types';
import { QUALITY } from '../data/quality';
import { TIME_OF_DAY } from '../data/timeOfDay';
import { MAX_BURST_LIFE, MAX_STREAM_LIFE, PARTICLE_STRIDE, PF_ADD, PF_PLAYER_CLOCK } from './consts';
import { DEAD_BEAM, DEAD_TELEGRAPH, DEAD_TRAIL } from './handles';
import { createFxSystem } from './index';
import { LIBRARY } from './library';
import { LightPool } from './lights';
import type { PoolLight } from './lights';
import { bakeRamps } from './ramps';
import { ParticleSim } from './sim';
import { StormClock } from './weather';

const ALL_IDS = Object.keys(LIBRARY) as FxId[];

interface Harness {
  ctx: GameContext;
  fx: FxSystem;
  time: TimeCore;
  errors: { source: string; error: unknown }[];
  sounds: { id: string; delay: number }[];
  flashes: number[];
  boxes: Mutable<CollisionBox>[];
  collision: { version: number };
  render: { timeOfDay: TimeOfDayId; qualityParams: QualityParams; lighting: { storm: number; flash: number } };
  settings: SettingsData;
  /** Advance the game clock and the system like core does (one substep per frame). */
  step(seconds: number, opts?: { dt?: number; scale?: number; mode?: 'playing' | 'menu' }): void;
  /** Instances a batch draws right now. */
  drawn(mesh: string): number;
  /** Instance data of a batch (first `drawn` instances are valid). */
  data(mesh: string): Float32Array;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function box(id: number, patch: Partial<CollisionBox> = {}): Mutable<CollisionBox> {
  return { id, minX: -100, minY: -1, minZ: -100, maxX: 100, maxY: 0, maxZ: 100, flags: 15, surface: 'metal', tag: '', decals: true, enabled: true, ...patch };
}

function harness(options: { testMode?: boolean; init?: boolean } = {}): Harness {
  const events = createEventBus();
  const time = createTime();
  const errors: Harness['errors'] = [];
  const sounds: Harness['sounds'] = [];
  const flashes: number[] = [];
  const boxes = [box(0), box(1, { decals: false }), box(2, { tag: 'gate:deck-refinery:main' })];
  const collision = {
    boxes,
    version: 1,
    groundHeight: (): number => 0,
    raycast: (): boolean => false,
  };
  const lighting = {
    sunDirection: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 0.8, 0.6),
    sunIntensity: 3,
    ambientColor: new THREE.Color(0.3, 0.4, 0.5),
    ambientIntensity: 1,
    fogColor: new THREE.Color(0.2, 0.2, 0.3),
    fogDensity: 0.004,
    storm: 0,
    night: 0,
    flash: 0,
  };
  const render = {
    timeOfDay: 'dusk' as TimeOfDayId,
    qualityParams: QUALITY.high as QualityParams,
    lighting,
    width: 1280,
    height: 720,
    warm(): void {},
    lightningFlash(intensity: number): void {
      flashes.push(intensity);
    },
  };
  const settings = { reduceFlashes: false, damageNumbers: true } as SettingsData;
  const game = {
    mode: 'playing',
    reportError(source: string, error: unknown): void {
      errors.push({ source, error });
    },
  };
  const scene = new THREE.Scene();
  const ctx = {
    scene,
    camera: new THREE.PerspectiveCamera(),
    events,
    time,
    cosmeticRng: createRng(0xc0ffee),
    settings: { data: settings },
    game,
    render,
    audio: {
      play(id: string, opts?: { delay?: number }): void {
        sounds.push({ id, delay: opts?.delay ?? 0 });
      },
    },
    collision,
    world: {
      bounds: { minX: -90, minY: -1, minZ: -30, maxX: 90, maxY: 40, maxZ: 30 },
      bossArena: { center: new THREE.Vector3(60, 0, 0), radius: 22, hoverHeight: 10 },
    },
    player: { position: new THREE.Vector3(0, 0, 0) },
    testMode: options.testMode ?? false,
  } as unknown as GameContext;
  const fx = createFxSystem(ctx);
  if (options.init !== false) void fx.init();
  const find = (name: string): THREE.Mesh => {
    const mesh = scene.getObjectByName(name) as THREE.Mesh | undefined;
    if (!mesh) throw new Error(`no mesh ${name}`);
    return mesh;
  };
  return {
    ctx,
    fx,
    time,
    errors,
    sounds,
    flashes,
    boxes,
    collision,
    render,
    settings,
    step(seconds, opts = {}): void {
      const dt = opts.dt ?? 1 / 60;
      const frames = Math.round(seconds / dt);
      game.mode = opts.mode ?? 'playing';
      if (opts.scale !== undefined) time.setScale('debug', opts.scale);
      for (let i = 0; i < frames; i++) {
        time.beginFrame(dt);
        time.advance(dt, true, game.mode === 'playing', 0, 1);
        fx.update(time.dt);
        fx.lateUpdate?.(time.dt);
      }
      if (opts.scale !== undefined) time.clearScale('debug');
    },
    drawn: (name) => (find(name).geometry as THREE.InstancedBufferGeometry).instanceCount,
    data: (name) => {
      // Every instanced attribute of a batch is a view on its one interleaved buffer.
      for (const attribute of Object.values(find(name).geometry.attributes)) {
        const interleaved = attribute as THREE.InterleavedBufferAttribute;
        if (interleaved.isInterleavedBufferAttribute) return interleaved.data.array as Float32Array;
      }
      throw new Error(`no instance buffer on ${name}`);
    },
  };
}

function allFinite(data: Float32Array, count: number): boolean {
  for (let i = 0; i < count; i++) if (!Number.isFinite(data[i])) return false;
  return true;
}

const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------------------------------
describe('particle core', () => {
  const make = (capacity = 8): ParticleSim => new ParticleSim(capacity, bakeRamps());
  const add = (sim: ParticleSim, prio: number, life = 1): number => {
    const i = sim.alloc(prio);
    if (i >= 0) sim.life[i] = life;
    return i;
  };

  it('never exceeds its capacity and reports what it dropped', () => {
    const sim = make(8);
    for (let i = 0; i < 8; i++) expect(add(sim, 1)).toBe(i);
    expect(sim.count).toBe(8);
    // Same priority, nobody past half-life yet: the newcomer is the one dropped.
    expect(add(sim, 1)).toBe(-1);
    expect(sim.dropped).toBe(1);
    expect(sim.count).toBe(8);
  });

  it('drops the oldest low-priority particles first when the pool is full', () => {
    const sim = make(8);
    for (let i = 0; i < 6; i++) add(sim, 0);
    add(sim, 2);
    add(sim, 2);
    sim.age[3] = 0.9;
    sim.age[1] = 0.6;
    // A normal particle replaces the most finished secondary one.
    expect(add(sim, 1)).toBe(3);
    expect(sim.prio[3]).toBe(1);
    expect(sim.age[3]).toBe(0);
    // A secondary newcomer may only replace a secondary one that is past half its life.
    expect(add(sim, 0)).toBe(1);
    expect(add(sim, 0)).toBe(-1);
    expect(sim.count).toBe(8);
  });

  it('always finds room for a critical particle', () => {
    const sim = make(4);
    for (let i = 0; i < 4; i++) add(sim, 2);
    sim.age[2] = 0.3;
    // Everything is critical: the oldest critical one makes room.
    expect(add(sim, 2)).toBe(2);
    expect(sim.count).toBe(4);
  });

  it('lowers its active cap without reallocating and keeps the important particles', () => {
    const sim = make(16);
    for (let i = 0; i < 16; i++) add(sim, i < 4 ? 2 : 0);
    const px = sim.px;
    sim.setCap(6);
    expect(sim.count).toBe(6);
    expect(sim.px).toBe(px);
    let critical = 0;
    for (let i = 0; i < sim.count; i++) if (sim.prio[i] === 2) critical++;
    expect(critical).toBe(4);
    expect(add(sim, 0)).toBe(-1);
    sim.setCap(1e9);
    expect(sim.cap).toBe(16);
    sim.setCap(Number.NaN);
    expect(sim.cap).toBe(16);
  });

  it('runs world and player particles on their own clocks and ends them on time', () => {
    const sim = make();
    const w = add(sim, 1, 0.5);
    const p = add(sim, 1, 0.5);
    sim.flags[p] = PF_PLAYER_CLOCK;
    sim.vx[w] = 10;
    sim.vx[p] = 10;
    sim.update(0.04, 0.1);
    expect(sim.px[w]).toBeCloseTo(0.4, 5);
    expect(sim.px[p]).toBeCloseTo(1, 5);
    // World frozen (hit-stop), player clock running.
    sim.update(0, 0.1);
    expect(sim.px[w]).toBeCloseTo(0.4, 5);
    expect(sim.px[p]).toBeCloseTo(2, 5);
    for (let i = 0; i < 4; i++) sim.update(0, 0.1);
    expect(sim.count).toBe(1);
    expect(sim.flags[0]).toBe(0);
  });

  it('survives hostile numbers: NaN, infinities, zero and negative steps', () => {
    const sim = make(16);
    for (let i = 0; i < 8; i++) add(sim, 1, 1);
    sim.vx[0] = Number.NaN;
    sim.py[1] = Number.POSITIVE_INFINITY;
    sim.vz[2] = 1e30;
    sim.grav[3] = Number.NaN;
    sim.update(Number.NaN, Number.NaN);
    sim.update(-1, -1);
    sim.update(0, 0);
    expect(sim.count).toBe(8);
    sim.update(1 / 60, 1 / 60);
    // The four broken particles are gone, the healthy ones live on.
    expect(sim.count).toBe(4);
    const add16 = new Float32Array(16 * PARTICLE_STRIDE);
    const alpha16 = new Float32Array(16 * PARTICLE_STRIDE);
    sim.write(add16, alpha16);
    expect(sim.addCount + sim.alphaCount).toBe(4);
    expect(allFinite(alpha16, sim.alphaCount * PARTICLE_STRIDE)).toBe(true);
    // A huge step is clamped, not integrated.
    sim.update(1e9, 1e9);
    expect(sim.count).toBe(0);
  });

  it('bounces debris on its floor and never lets it fall through', () => {
    const sim = make();
    const i = add(sim, 1, 5);
    sim.flags[i] = 8;
    sim.py[i] = 1;
    sim.grav[i] = 15;
    sim.bounce[i] = 0.4;
    sim.floorY[i] = 0;
    let lowest = 1;
    for (let k = 0; k < 240; k++) {
      sim.update(1 / 60, 1 / 60);
      lowest = Math.min(lowest, sim.py[i] as number);
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(sim.py[i]).toBeCloseTo(0, 3);
    expect(sim.vy[i]).toBe(0);
  });

  it('writes additive and alpha particles into their own buffers and never overruns them', () => {
    const sim = make(8);
    for (let i = 0; i < 8; i++) {
      const k = add(sim, 1);
      sim.flags[k] = i % 2 === 0 ? PF_ADD : 0;
    }
    const small = new Float32Array(2 * PARTICLE_STRIDE);
    const big = new Float32Array(8 * PARTICLE_STRIDE);
    sim.write(small, big);
    expect(sim.addCount).toBe(2);
    expect(sim.alphaCount).toBe(4);
    sim.clear();
    expect(sim.count).toBe(0);
    sim.write(small, big);
    expect(sim.addCount + sim.alphaCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('effect library', () => {
  it('implements every FxId, bursts and streams alike', () => {
    for (const id of FX_STREAM_IDS) expect(ALL_IDS).toContain(id);
    expect(ALL_IDS.length).toBeGreaterThan(100);
  });

  it('spawns every effect without an error and with finite output', () => {
    const h = harness();
    for (const id of ALL_IDS) {
      h.fx.clear();
      h.fx.spawn(id, at(3, 1, -2));
      expect(h.fx.stats.particles, id).toBeGreaterThan(0);
      h.step(0.1);
      const add = h.drawn('fx-particles-add');
      const alpha = h.drawn('fx-particles-alpha');
      expect(add + alpha, id).toBe(h.fx.stats.particles);
      expect(allFinite(h.data('fx-particles-add'), add * PARTICLE_STRIDE), id).toBe(true);
      expect(allFinite(h.data('fx-particles-alpha'), alpha * PARTICLE_STRIDE), id).toBe(true);
    }
    expect(h.errors).toEqual([]);
  });

  it('ends every burst within 2.5 s and every stream puff within 0.25 s', () => {
    const h = harness();
    expect(MAX_BURST_LIFE).toBeLessThan(2.5);
    for (const id of ALL_IDS) {
      const stream = FX_STREAM_IDS.includes(id);
      h.fx.clear();
      h.fx.spawn(id, at(0, 0.5, 0), { charge: 1, radius: 6 });
      h.step(stream ? MAX_STREAM_LIFE + 0.02 : 2.5);
      expect(h.fx.stats.particles, id).toBe(0);
    }
  });

  it('accepts hostile options and unknown ids without throwing or reporting', () => {
    const h = harness();
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1e12];
    for (const id of ['explosionLarge', 'impactMetal', 'lanceCharge', 'deathBulwark', 'muzzleVector'] as FxId[]) {
      for (const v of bad) {
        h.fx.spawn(id, at(0, 0, 0), {
          normal: { x: v, y: v, z: v },
          dir: { x: 0, y: 0, z: 0 },
          scale: v,
          radius: v,
          charge: v,
          color: v,
          velocity: { x: v, y: 0, z: 0 },
        });
      }
      h.fx.spawn(id, { x: Number.NaN, y: 0, z: 0 });
      h.fx.spawn(id, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 });
    }
    h.fx.spawn('notAnEffect' as FxId, at(0, 0, 0));
    h.step(0.5);
    const add = h.drawn('fx-particles-add');
    expect(allFinite(h.data('fx-particles-add'), add * PARTICLE_STRIDE)).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('covers the radius it is given: the shock ring of a blast ends exactly on it', () => {
    const h = harness();
    for (const radius of [2, 5, 9]) {
      h.fx.clear();
      h.fx.spawn('shockwaveRing', at(0, 0, 0), { radius });
      // The ring is the aligned RING sprite (cell 5, mode 2); its bright edge sits at 0.856 of the half size.
      let size = 0;
      for (let t = 0; t < 0.39; t += 1 / 60) {
        h.step(1 / 60);
        const n = h.drawn('fx-particles-add');
        const d = h.data('fx-particles-add');
        for (let i = 0; i < n; i++) {
          if (d[i * PARTICLE_STRIDE + 12] === 5 && d[i * PARTICLE_STRIDE + 13] === 2) size = Math.max(size, d[i * PARTICLE_STRIDE + 3] as number);
        }
      }
      expect((size / 2) * 0.856).toBeGreaterThan(radius * 0.97);
      expect((size / 2) * 0.856).toBeLessThanOrEqual(radius * 1.001);
    }
  });

  it('thins secondary particles with the quality preset but never the core of a blast', () => {
    const count = (preset: 'low' | 'high' | 'ultra'): { total: number; critical: number } => {
      const h = harness();
      h.ctx.events.emit('quality:changed', { preset, params: QUALITY[preset] });
      let total = 0;
      let critical = 0;
      for (let i = 0; i < 20; i++) {
        h.fx.clear();
        h.fx.spawn('explosionLarge', at(0, 0, 0), { radius: 5 });
        total += h.fx.stats.particles;
        h.step(1 / 60);
        // Core flashes and the shock ring: glow (cell 0) and ring (cell 5) sprites of the additive batch.
        const n = h.drawn('fx-particles-add');
        const d = h.data('fx-particles-add');
        for (let k = 0; k < n; k++) {
          const cell = d[k * PARTICLE_STRIDE + 12];
          if (cell === 0 || cell === 5) critical++;
        }
      }
      return { total, critical };
    };
    const low = count('low');
    const high = count('high');
    const ultra = count('ultra');
    expect(low.total).toBeLessThan(high.total * 0.8);
    expect(ultra.total).toBeGreaterThan(high.total);
    expect(low.critical).toBe(high.critical);
    expect(ultra.critical).toBe(high.critical);
    expect(low.critical).toBe(20 * 3);
  });

  it('runs effects with clock "player" at full speed while the world is slowed', () => {
    const h = harness();
    h.fx.spawn('muzzleVector', at(0, 1, 0), { clock: 'player' });
    h.fx.spawn('riveterMuzzle', at(5, 1, 0));
    expect(h.fx.stats.particles).toBeGreaterThan(4);
    // 0.5 s of real time in Overclock (world x0.4 = 0.2 s): the player's flash is long gone, the
    // enemy's is still fading.
    h.step(0.5, { scale: 0.4 });
    const left = h.fx.stats.particles;
    expect(left).toBeGreaterThan(0);
    const d = h.data('fx-particles-add');
    const n = h.drawn('fx-particles-add');
    for (let i = 0; i < n; i++) expect(d[i * PARTICLE_STRIDE]).toBeGreaterThan(2.5);
    h.step(3);
    expect(h.fx.stats.particles).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('handles', () => {
  it('returns the shared frozen dead handles before init and after dispose, and never throws', () => {
    const h = harness({ init: false });
    const p = at(0, 0, 0);
    expect(h.fx.beam(p, p, { kind: 'rail' })).toBe(DEAD_BEAM);
    expect(h.fx.telegraph({ kind: 'ring', position: p, radius: 2, seconds: 1 })).toBe(DEAD_TELEGRAPH);
    expect(h.fx.attachTrail('rocket', p)).toBe(DEAD_TRAIL);
    expect(Object.isFrozen(DEAD_BEAM) && Object.isFrozen(DEAD_TELEGRAPH) && Object.isFrozen(DEAD_TRAIL)).toBe(true);
    h.fx.spawn('explosionLarge', p);
    h.fx.tracer(p, at(10, 0, 0));
    h.fx.decal('scorch', p, at(0, 1, 0));
    h.fx.damageNumber(p, 10);
    h.fx.lightFlash(p, 0xffffff, 1, 5, 0.1);
    h.fx.lightningBolt(p, at(0, 10, 0));
    h.fx.cancelOwner(3);
    h.fx.setWeather('haze');
    h.fx.clear();
    h.fx.update(0.016);
    h.fx.reset();
    expect(h.fx.weather).toBe('clear');
    void h.fx.init();
    h.fx.dispose();
    expect(h.fx.beam(p, p, { kind: 'rail' })).toBe(DEAD_BEAM);
    expect(h.ctx.scene.getObjectByName('fx')).toBeUndefined();
    DEAD_BEAM.set(p, p);
    DEAD_BEAM.stop();
    DEAD_TELEGRAPH.cancel();
    DEAD_TRAIL.detach();
    expect(h.errors).toEqual([]);
  });

  it('binds a beam handle to one beam for ever', () => {
    const h = harness();
    const a = h.fx.beam(at(0, 1, 0), at(10, 1, 0), { kind: 'lockLaser', seconds: 0, owner: 5 });
    expect(a.active).toBe(true);
    expect(h.fx.stats.beams).toBe(1);
    a.set(at(0, 2, 0), at(10, 2, 0));
    a.setIntensity(0.5);
    a.setColor(0xff00ff);
    h.step(1);
    expect(a.active).toBe(true);
    a.stop();
    expect(a.active).toBe(false);
    expect(h.fx.stats.beams).toBe(0);
    h.step(0.5);
    // The slot is free again and goes to another beam: the stale handle must not reach it.
    const b = h.fx.beam(at(0, 1, 0), at(5, 1, 0), { kind: 'sweep', seconds: 0 });
    h.step(1 / 60);
    const before = Array.from(h.data('fx-streaks').subarray(0, 16));
    a.set(at(99, 99, 99), at(98, 98, 98));
    a.setIntensity(0);
    a.stop();
    h.step(1 / 60);
    expect(b.active).toBe(true);
    expect(Array.from(h.data('fx-streaks').subarray(0, 8))).toEqual(before.slice(0, 8));
    expect(a).not.toBe(b);
  });

  it('expires one-shot beams by themselves', () => {
    const h = harness();
    const rail = h.fx.beam(at(0, 1, 0), at(30, 1, 0), { kind: 'rail', clock: 'player' });
    expect(rail.active).toBe(true);
    h.step(0.13);
    expect(rail.active).toBe(false);
    expect(h.drawn('fx-streaks')).toBeGreaterThan(0);
    h.step(1);
    expect(h.drawn('fx-streaks')).toBe(0);
  });

  it('never refuses a persistent beam below the cap and never steals one from its owner', () => {
    const h = harness();
    const beams = [];
    for (let i = 0; i < FX_CAPS.beams; i++) beams.push(h.fx.beam(at(i, 1, 0), at(i, 1, 9), { kind: 'lockLaser', seconds: 0 }));
    expect(beams.every((b) => b.active)).toBe(true);
    expect(h.fx.beam(at(0, 1, 0), at(1, 1, 0), { kind: 'sweep', seconds: 0 })).toBe(DEAD_BEAM);
    expect(beams.every((b) => b.active)).toBe(true);
    // A one-shot in the pool is what gives way.
    (beams[3] as (typeof beams)[number]).stop();
    h.step(0.5);
    const shot = h.fx.beam(at(0, 1, 0), at(1, 1, 0), { kind: 'laser', seconds: 0.5 });
    expect(shot.active).toBe(true);
    const next = h.fx.beam(at(0, 1, 0), at(1, 1, 0), { kind: 'sweep', seconds: 0 });
    expect(next.active).toBe(true);
    expect(shot.active).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it('never fails a telegraph below the cap; beyond it the oldest timed one is recycled', () => {
    const h = harness();
    const handles = [];
    for (let i = 0; i < FX_CAPS.telegraphs; i++) {
      handles.push(h.fx.telegraph({ kind: i % 2 === 0 ? 'circle' : 'shock', position: at(i, 0, 0), radius: 3, seconds: i % 2 === 0 ? 10 : 0 }));
    }
    expect(handles.every((t) => t.active)).toBe(true);
    expect(h.fx.stats.telegraphs).toBe(FX_CAPS.telegraphs);
    const extra = h.fx.telegraph({ kind: 'mortar', position: at(0, 0, 5), radius: 4, seconds: 2 });
    expect(extra.active).toBe(true);
    expect((handles[0] as (typeof handles)[number]).active).toBe(false);
    expect((handles[1] as (typeof handles)[number]).active).toBe(true);
    expect((handles[2] as (typeof handles)[number]).active).toBe(true);
    expect(h.fx.stats.telegraphs).toBe(FX_CAPS.telegraphs);
    // Low quality changes nothing about it.
    h.ctx.events.emit('quality:changed', { preset: 'low', params: QUALITY.low });
    h.step(1 / 60);
    expect(h.drawn('fx-telegraphs')).toBe(FX_CAPS.telegraphs);
  });

  it('fills timed telegraphs over world time and lets owners drive persistent ones', () => {
    const h = harness();
    const timed = h.fx.telegraph({ kind: 'circle', position: at(0, 0, 0), radius: 4, seconds: 1 });
    const ring = h.fx.telegraph({ kind: 'shock', position: at(9, 0, 0), radius: 1, seconds: 0, owner: 42 });
    ring.setRadius(7.5);
    ring.setProgress(0.25);
    timed.setProgress(0.99);
    // Half a second of real time at half speed is a quarter of the way.
    h.step(0.5, { scale: 0.5 });
    const d = h.data('fx-telegraphs');
    expect(h.drawn('fx-telegraphs')).toBe(2);
    expect(d[9]).toBeCloseTo(0.25, 2);
    // The shock ring is drawn exactly at the radius its owner set, lifted off the ground.
    expect(d[12 + 3]).toBe(7.5);
    expect(d[12 + 1]).toBeGreaterThan(0);
    expect(d[12 + 1]).toBeLessThan(0.1);
    expect(d[12 + 9]).toBeCloseTo(0.25, 5);
    h.step(0.8);
    expect(timed.active).toBe(false);
    expect(ring.active).toBe(true);
    ring.setPosition({ x: Number.NaN, y: 0, z: 0 });
    ring.setRadius(Number.NaN);
    h.step(1 / 60);
    expect(allFinite(h.data('fx-telegraphs'), 12)).toBe(true);
    h.fx.cancelOwner(42);
    expect(ring.active).toBe(false);
    ring.setRadius(3);
    ring.cancel();
    expect(h.fx.stats.telegraphs).toBe(0);
  });

  it('follows a retained vector with a trail until it is detached, cancelled or goes bad', () => {
    const h = harness();
    const rocket = at(0, 2, 0);
    const handle = h.fx.attachTrail('rocket', rocket, undefined, 7);
    expect(handle.active).toBe(true);
    for (let i = 0; i < 30; i++) {
      rocket.x += 45 / 60;
      h.step(1 / 60);
    }
    expect(h.drawn('fx-ribbons')).toBeGreaterThan(3);
    expect(h.fx.stats.particles).toBeGreaterThan(0);
    expect(h.fx.stats.trails).toBe(1);
    handle.detach();
    expect(handle.active).toBe(false);
    expect(h.fx.stats.trails).toBe(0);
    h.step(1.5);
    expect(h.drawn('fx-ribbons')).toBe(0);

    const b = h.fx.attachTrail('plasma', rocket, 0xff0000, 8);
    h.fx.cancelOwner(8);
    expect(b.active).toBe(false);
    const c = h.fx.attachTrail('bolt', rocket);
    rocket.x = Number.NaN;
    h.step(1 / 60);
    expect(c.active).toBe(false);
    expect(allFinite(h.data('fx-ribbons'), h.drawn('fx-ribbons') * 24)).toBe(true);
    expect(h.fx.attachTrail('bolt', rocket)).toBe(DEAD_TRAIL);
  });

  it('returns the dead trail handle when every trail is still attached', () => {
    const h = harness();
    const p = at(0, 1, 0);
    const first = h.fx.attachTrail('grenade', p);
    for (let i = 1; i < FX_CAPS.trails; i++) expect(h.fx.attachTrail('grenade', p).active).toBe(true);
    expect(h.fx.attachTrail('grenade', p)).toBe(DEAD_TRAIL);
    // A fading trail is what a newcomer may replace.
    first.detach();
    expect(h.fx.attachTrail('grenade', p).active).toBe(true);
  });

  it('invalidates every handle on clear() and reset(), for ever', () => {
    const h = harness();
    for (const wipe of [() => h.fx.clear(), () => h.fx.reset()]) {
      const p = at(1, 1, 1);
      const beam = h.fx.beam(p, at(5, 1, 1), { kind: 'sweep', seconds: 0 });
      const mark = h.fx.telegraph({ kind: 'ring', position: p, radius: 2, seconds: 0 });
      const trail = h.fx.attachTrail('missile', p);
      h.fx.spawn('explosionLarge', p);
      h.fx.tracer(p, at(40, 1, 1));
      h.fx.lightningBolt(at(0, 30, 0), p);
      h.fx.damageNumber(p, 25);
      h.fx.decal('scorch', p, at(0, 1, 0), 2, 0);
      h.step(0.05);
      expect(h.fx.stats.particles).toBeGreaterThan(0);
      wipe();
      expect(beam.active || mark.active || trail.active).toBe(false);
      expect(h.fx.stats).toMatchObject({ particles: 0, decals: 0, beams: 0, telegraphs: 0, trails: 0, lights: 0 });
      // Nothing of it is drawn any more, even before the next update.
      for (const mesh of ['fx-particles-add', 'fx-particles-alpha', 'fx-streaks', 'fx-ribbons', 'fx-telegraphs', 'fx-decals', 'fx-numbers']) {
        expect(h.drawn(mesh), mesh).toBe(0);
      }
      // New effects take the freed slots; the stale handles stay dead.
      const again = h.fx.beam(p, at(5, 1, 1), { kind: 'sweep', seconds: 0 });
      beam.stop();
      mark.cancel();
      trail.detach();
      expect(again.active).toBe(true);
      again.stop();
    }
    expect(h.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('light pool', () => {
  const lights = (h: Harness): THREE.PointLight[] => {
    const list: THREE.PointLight[] = [];
    h.ctx.scene.getObjectByName('fx')?.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight) list.push(o as THREE.PointLight);
    });
    return list;
  };

  it('owns exactly six point lights that are never added, removed or hidden', () => {
    const h = harness();
    const before = lights(h);
    expect(before.length).toBe(FX_CAPS.lights);
    expect(before.every((l) => l.intensity === 0 && l.visible && !l.castShadow)).toBe(true);
    for (let i = 0; i < 40; i++) h.fx.lightFlash(at(i, 1, 0), 0xff8800, 1 + (i % 5), 8, 0.2);
    h.fx.lightningBolt(at(0, 30, 0), at(0, 0, 0));
    h.step(0.05);
    const after = lights(h);
    expect(after).toEqual(before);
    expect(after.every((l) => l.visible)).toBe(true);
    expect(h.fx.stats.lights).toBe(6);
    h.step(1);
    expect(h.fx.stats.lights).toBe(0);
    expect(after.every((l) => l.intensity === 0)).toBe(true);
    h.fx.reset();
    expect(lights(h)).toEqual(before);
  });

  it('converts the normalised intensity, clamps it and fades it to zero', () => {
    const h = harness();
    h.fx.lightFlash(at(1, 2, 3), 0xffffff, 1, 9, 1);
    const light = lights(h).find((l) => l.intensity > 0) as THREE.PointLight;
    const unit = light.intensity;
    // 1 lights a white wall 3 m away to about mid-grey: I / d^2 / pi * albedo ~ 0.2.
    expect((unit / 9 / Math.PI) * 0.9).toBeGreaterThan(0.15);
    expect((unit / 9 / Math.PI) * 0.9).toBeLessThan(0.25);
    expect(light.distance).toBe(9);
    expect(light.position.toArray()).toEqual([1, 2, 3]);
    h.step(0.5);
    expect(light.intensity).toBeLessThan(unit * 0.5);
    expect(light.intensity).toBeGreaterThan(0);
    h.step(0.6);
    expect(light.intensity).toBe(0);
    h.fx.lightFlash(at(0, 0, 0), 0xffffff, 1000, 9, 1);
    expect(Math.max(...lights(h).map((l) => l.intensity))).toBeCloseTo(unit * 8, 4);
  });

  it('halves the intensity with reduce flashes', () => {
    const h = harness();
    h.fx.lightFlash(at(0, 0, 0), 0xffffff, 2, 9, 1);
    const full = Math.max(...lights(h).map((l) => l.intensity));
    h.fx.clear();
    h.settings.reduceFlashes = true;
    h.fx.lightFlash(at(0, 0, 0), 0xffffff, 2, 9, 1);
    expect(Math.max(...lights(h).map((l) => l.intensity))).toBeCloseTo(full / 2, 5);
  });

  it('refreshes the slot of a key, holds at most two keyed slots and steals the weakest flash', () => {
    const pool: PoolLight[] = [];
    const made: { intensity: number; distance: number; x: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const state = { intensity: 0, distance: 0, x: 0 };
      made.push(state);
      pool.push({
        position: { set: (x: number) => (state.x = x) },
        color: { setHex: () => undefined },
        get intensity() {
          return state.intensity;
        },
        set intensity(v: number) {
          state.intensity = v;
        },
        get distance() {
          return state.distance;
        },
        set distance(v: number) {
          state.distance = v;
        },
      });
    }
    const lit = (): number => made.filter((m) => m.intensity > 0).length;
    const p = new LightPool(pool, 2);
    p.flash(1, 0, 0, 0xffffff, 1, 5, 1, 77, false);
    p.flash(2, 0, 0, 0xffffff, 2, 5, 1, 77, false);
    expect(lit()).toBe(1);
    expect(made.find((m) => m.intensity > 0)?.x).toBe(2);
    p.flash(3, 0, 0, 0xffffff, 1, 5, 1, 78, false);
    p.flash(4, 0, 0, 0xffffff, 1, 5, 1, 79, false);
    // The third key is ignored.
    expect(lit()).toBe(2);
    for (let i = 0; i < 4; i++) p.flash(10 + i, 0, 0, 0xffffff, 2 + i, 5, 1, 0, false);
    expect(lit()).toBe(6);
    expect(p.lit).toBe(6);
    // All busy: a strong flash takes the weakest un-keyed slot (x = 10), never a keyed one.
    p.flash(50, 0, 0, 0xffffff, 6, 5, 1, 0, false);
    expect(made.some((m) => m.x === 10)).toBe(false);
    expect(made.some((m) => m.x === 2) && made.some((m) => m.x === 3)).toBe(true);
    // A flash weaker than everything still burning is the one that goes without.
    p.flash(60, 0, 0, 0xffffff, 0.1, 5, 1, 0, false);
    expect(made.some((m) => m.x === 60)).toBe(false);
    p.flash(Number.NaN, 0, 0, 0xffffff, 1, 5, 1, 0, false);
    p.flash(0, 0, 0, 0xffffff, Number.NaN, 5, 1, 0, false);
    p.update(2);
    expect(lit()).toBe(0);
    expect(p.lit).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('damage numbers, decals, bolts, tracers', () => {
  it('merges hits on one target into one growing number and respects the setting', () => {
    const h = harness();
    for (let i = 0; i < 9; i++) h.fx.damageNumber(at(0, 1, 0), 11, { targetId: 5 });
    h.step(1 / 60);
    // "99": two glyphs.
    expect(h.drawn('fx-numbers')).toBe(2);
    const d = h.data('fx-numbers');
    expect([d[4], d[12 + 4]].sort()).toEqual([9, 9]);
    h.fx.damageNumber(at(0, 1, 0), 1, { targetId: 5 });
    h.fx.damageNumber(at(3, 1, 0), 7, { targetId: 6 });
    h.fx.damageNumber(at(6, 1, 0), 7);
    h.fx.damageNumber(at(6, 1, 0), 7);
    h.step(1 / 60);
    // "100" + "7" + "7" + "7": un-targeted numbers never merge.
    expect(h.drawn('fx-numbers')).toBe(6);
    // After the merge window a new hit on the same target starts a new number.
    h.step(0.3);
    h.fx.damageNumber(at(0, 1, 0), 5, { targetId: 5 });
    h.step(1 / 60);
    expect(h.drawn('fx-numbers')).toBe(7);
    h.step(2);
    expect(h.drawn('fx-numbers')).toBe(0);

    h.settings.damageNumbers = false;
    h.fx.damageNumber(at(0, 1, 0), 50);
    h.step(1 / 60);
    expect(h.drawn('fx-numbers')).toBe(0);
    h.settings.damageNumbers = true;
    h.fx.damageNumber(at(0, 1, 0), Number.NaN);
    h.fx.damageNumber({ x: Number.NaN, y: 0, z: 0 }, 5);
    for (let i = 0; i < 200; i++) h.fx.damageNumber(at(i, 1, 0), 123456, { crit: i % 2 === 0, kill: i % 3 === 0, shield: i % 5 === 0 });
    h.step(1 / 60);
    expect(h.drawn('fx-numbers')).toBe(FX_CAPS.damageNumbers * 5);
    expect(allFinite(h.data('fx-numbers'), h.drawn('fx-numbers') * 12)).toBe(true);
  });

  it('keeps damage numbers moving on the player clock during a hit-stop', () => {
    const h = harness();
    h.fx.damageNumber(at(0, 1, 0), 40);
    h.step(1.5, { scale: 0.05 });
    expect(h.drawn('fx-numbers')).toBe(0);
  });

  it('skips boxes that take no decals, caps by quality and drops decals of disabled boxes', () => {
    const h = harness();
    const up = at(0, 1, 0);
    h.fx.decal('bulletHole', at(0, 0, 0), up, undefined, 1);
    expect(h.fx.stats.decals).toBe(0);
    h.fx.decal('bulletHole', at(0, 0, 0), up, undefined, 0);
    h.fx.decal('scorch', at(1, 0, 0), up, 3, 2);
    h.fx.decal('crack', at(2, 0, 0), up);
    h.fx.decal('energyMark', at(2, 0, 0), { x: 0, y: 0, z: 0 }, Number.NaN, 9999);
    expect(h.fx.stats.decals).toBe(4);
    h.step(1 / 60);
    expect(h.drawn('fx-decals')).toBe(4);
    expect(allFinite(h.data('fx-decals'), 4 * 18)).toBe(true);
    // The gate opens: its box is switched off and its decal goes with it.
    (h.boxes[2] as Mutable<CollisionBox>).enabled = false;
    h.collision.version++;
    h.step(1 / 60);
    expect(h.fx.stats.decals).toBe(3);
    expect(h.drawn('fx-decals')).toBe(3);
    h.fx.decal('scorch', at(1, 0, 0), up, 3, 2);
    expect(h.fx.stats.decals).toBe(3);

    for (let i = 0; i < 400; i++) h.fx.decal('bulletHole', at(i * 0.1, 0, 0), up, undefined, 0);
    expect(h.fx.stats.decals).toBe(QUALITY.high.maxDecals);
    h.ctx.events.emit('quality:changed', { preset: 'low', params: QUALITY.low });
    expect(h.fx.stats.decals).toBe(QUALITY.low.maxDecals);
    h.step(1 / 60);
    expect(h.drawn('fx-decals')).toBe(QUALITY.low.maxDecals);
    // Decals fade out and are released.
    h.step(40, { dt: 1 / 10 });
    expect(h.fx.stats.decals).toBe(0);
    expect(h.drawn('fx-decals')).toBe(0);
  });

  it('draws bolts for their lifetime, recycles the oldest beyond the cap and stops strobing on request', () => {
    const h = harness();
    const level = (): number => {
      const d = h.data('fx-ribbons');
      return h.drawn('fx-ribbons') > 0 ? (d[19] as number) : 0;
    };
    h.fx.lightningBolt(at(0, 40, 0), at(0, 0, 0), { light: false, branches: 0 });
    const strobe: number[] = [];
    for (let i = 0; i < 16; i++) {
      h.step(1 / 60);
      strobe.push(level());
    }
    // Strike, dip, re-strike: the brightness is not monotonic.
    expect(strobe.some((v, i) => i > 0 && v > (strobe[i - 1] as number) + 0.3)).toBe(true);
    expect(h.drawn('fx-ribbons')).toBe(0);
    expect(h.fx.stats.lights).toBe(0);

    h.settings.reduceFlashes = true;
    h.fx.lightningBolt(at(0, 40, 0), at(0, 0, 0), { light: false, branches: 0 });
    const steady: number[] = [];
    for (let i = 0; i < 12; i++) {
      h.step(1 / 60);
      steady.push(level());
    }
    expect(steady.every((v, i) => i === 0 || v <= (steady[i - 1] as number) + 1e-6)).toBe(true);
    h.settings.reduceFlashes = false;

    h.fx.clear();
    for (let i = 0; i < FX_CAPS.bolts + 10; i++) h.fx.lightningBolt(at(i, 40, 0), at(i, 0, 0), { seconds: 1, branches: 6, light: false });
    h.fx.lightningBolt(at(0, 0, 0), at(0, 0, 0));
    h.fx.lightningBolt({ x: Number.NaN, y: 0, z: 0 }, at(0, 0, 0));
    h.step(1 / 60);
    const segments = h.drawn('fx-ribbons');
    expect(segments).toBeGreaterThan(FX_CAPS.bolts * 20);
    expect(segments).toBeLessThanOrEqual(FX_CAPS.bolts * 62);
    expect(allFinite(h.data('fx-ribbons'), segments * 24)).toBe(true);
  });

  it('flies tracers from muzzle to hit, on either clock, and recycles the oldest beyond the cap', () => {
    const h = harness();
    h.fx.tracer(at(0, 1, 0), at(32, 1, 0), { clock: 'player' });
    h.fx.tracer(at(0, 2, 0), at(32, 2, 0), { faction: 'enemy' });
    h.fx.tracer(at(0, 1, 0), at(0.1, 1, 0));
    h.fx.tracer({ x: Number.NaN, y: 0, z: 0 }, at(1, 1, 1));
    h.step(1 / 60, { scale: 0.4 });
    expect(h.drawn('fx-streaks')).toBe(2);
    // 0.15 s real time at world scale 0.4: the player's tracer has arrived, the enemy's is on its way.
    h.step(0.15, { scale: 0.4 });
    expect(h.drawn('fx-streaks')).toBe(1);
    h.step(1);
    expect(h.drawn('fx-streaks')).toBe(0);
    for (let i = 0; i < FX_CAPS.tracers + 50; i++) h.fx.tracer(at(0, 1, i), at(300, 1, i));
    h.step(1 / 60);
    expect(h.drawn('fx-streaks')).toBe(FX_CAPS.tracers);
    expect(allFinite(h.data('fx-streaks'), FX_CAPS.tracers * 16)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('weather and the ambient storm', () => {
  it('follows the time of day in init, on the event and at the end of reset', () => {
    const h = harness({ init: false });
    h.render.timeOfDay = 'twilight';
    void h.fx.init();
    expect(h.fx.weather).toBe(TIME_OF_DAY.twilight.weather);
    h.render.timeOfDay = 'stormnight';
    h.ctx.events.emit('timeOfDay:changed', { id: 'stormnight', prev: 'twilight', seconds: 5 });
    expect(h.fx.weather).toBe('staticRain');
    h.fx.setWeather('clear');
    expect(h.fx.weather).toBe('clear');
    h.fx.setWeather('nonsense' as never);
    expect(h.fx.weather).toBe('clear');
    // clear() keeps the weather; reset() syncs it again (render has snapped to dusk by then).
    h.fx.setWeather('vortex', 0.5);
    h.fx.clear();
    expect(h.fx.weather).toBe('vortex');
    h.render.timeOfDay = 'dusk';
    h.fx.reset();
    expect(h.fx.weather).toBe('embers');
    h.step(1);
    expect(h.fx.stats.batches).toBe(1);
  });

  it('schedules strikes at the rate of the table, with flash, thunder delay and crackle', () => {
    const h = harness();
    h.render.timeOfDay = 'stormnight';
    h.render.lighting.storm = 1;
    h.fx.reset();
    h.step(600, { dt: 1 / 10 });
    const expected = TIME_OF_DAY.stormnight.lightningPerMinute * 10;
    expect(h.flashes.length).toBeGreaterThan(expected * 0.8);
    expect(h.flashes.length).toBeLessThan(expected * 1.2);
    expect(h.flashes.every((v) => v > 0 && v <= 1)).toBe(true);
    const thunder = h.sounds.filter((s) => s.id === 'thunderNear' || s.id === 'thunderFar');
    expect(thunder.length).toBe(h.flashes.length);
    for (const s of thunder) {
      const distance = s.delay * 343;
      expect(distance).toBeGreaterThanOrEqual(149);
      expect(distance).toBeLessThanOrEqual(500);
      expect(s.id).toBe(distance < 200 ? 'thunderNear' : 'thunderFar');
    }
    const ids = new Set(h.sounds.map((s) => s.id));
    expect([...ids].sort()).toEqual(['lightningCrack', 'staticCrackle', 'thunderFar', 'thunderNear', 'windGust']);
    expect(h.errors).toEqual([]);
  });

  it('scales the strike rate with the storm level and is silent without one', () => {
    const h = harness();
    h.render.timeOfDay = 'stormnight';
    h.render.lighting.storm = 0;
    h.fx.reset();
    h.step(300, { dt: 1 / 10 });
    expect(h.flashes.length).toBe(0);
    h.render.lighting.storm = 0.5;
    h.step(600, { dt: 1 / 10 });
    const expected = TIME_OF_DAY.stormnight.lightningPerMinute * 0.5 * 10;
    expect(h.flashes.length).toBeGreaterThan(expected * 0.75);
    expect(h.flashes.length).toBeLessThan(expected * 1.25);
    // Dusk has no lightning at all.
    const calm = harness();
    calm.render.lighting.storm = 1;
    calm.step(300, { dt: 1 / 10 });
    expect(calm.flashes.length).toBe(0);
    expect(calm.sounds.every((s) => s.id === 'windGust')).toBe(true);
  });

  it('keeps the ambient storm off in test mode until setWeather is called from outside', () => {
    const h = harness({ testMode: true });
    h.render.timeOfDay = 'stormnight';
    h.render.lighting.storm = 1;
    h.fx.reset();
    h.step(300, { dt: 1 / 10 });
    expect(h.flashes.length).toBe(0);
    expect(h.sounds.length).toBe(0);
    h.fx.setWeather('staticRain');
    h.step(120, { dt: 1 / 10 });
    expect(h.flashes.length).toBeGreaterThan(8);
    // A reset forgets the override.
    h.fx.reset();
    const before = h.flashes.length;
    h.step(120, { dt: 1 / 10 });
    expect(h.flashes.length).toBe(before);
  });

  it('fires each storm event at its own rate, whatever the others do', () => {
    const rng = createRng(3);
    const clock = new StormClock();
    clock.reset(rng);
    const counts = [0, 0, 0];
    for (let i = 0; i < 60 * 60 * 10; i++) {
      const due = clock.step(1 / 60, 6, 0, 30, rng);
      if (due & StormClock.STRIKE) counts[0]++;
      if (due & StormClock.CRACKLE) counts[1]++;
      if (due & StormClock.GUST) counts[2]++;
    }
    expect(counts[0]).toBeGreaterThan(48);
    expect(counts[0]).toBeLessThan(72);
    expect(counts[1]).toBe(0);
    expect(counts[2]).toBeGreaterThan(250);
    expect(clock.step(0, 6, 6, 6, rng)).toBe(0);
    expect(clock.step(Number.NaN, 6, 6, 6, rng)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('lifecycle and containment', () => {
  it('writes its GPU buffers once per frame: in the last substep only', () => {
    const h = harness();
    h.fx.spawn('explosionSmall', at(0, 0, 0));
    const frame = (substeps: number, flushAt: number[]): void => {
      h.time.beginFrame(1 / 20);
      for (let i = 0; i < substeps; i++) {
        h.time.advance(1 / 20 / substeps, true, true, i, substeps);
        h.fx.spawn('impactMetal', at(i, 0, 0));
        const before = h.drawn('fx-particles-add');
        h.fx.update(h.time.dt);
        h.fx.lateUpdate?.(h.time.dt);
        const flushed = h.drawn('fx-particles-add') !== before;
        expect(flushed, `substep ${i} of ${substeps}`).toBe(flushAt.includes(i));
      }
    };
    frame(3, [2]);
    frame(2, [1]);
    frame(1, [0]);
  });

  it('restores a pristine state on reset: a second run behaves like the first', () => {
    const run = (h: Harness): number[] => {
      const p = at(2, 0, 2);
      h.fx.spawn('explosionLarge', p, { radius: 5 });
      h.fx.beam(p, at(9, 1, 9), { kind: 'sweep', seconds: 0, owner: 3 });
      h.fx.telegraph({ kind: 'mortar', position: p, radius: 4, seconds: 1.5, owner: 3 });
      h.fx.attachTrail('rocket', p, undefined, 3);
      h.fx.lightFlash(p, 0xffaa00, 3, 12, 0.4);
      h.fx.lightningBolt(at(0, 30, 0), p);
      h.fx.decal('scorch', p, at(0, 1, 0), 4, 0);
      h.fx.damageNumber(p, 120, { crit: true });
      h.step(0.3);
      const s = h.fx.stats;
      return [s.decals, s.beams, s.telegraphs, s.trails, s.lights, h.drawn('fx-streaks'), h.drawn('fx-telegraphs'), h.drawn('fx-numbers'), h.drawn('fx-decals')];
    };
    const h = harness();
    const first = run(h);
    h.fx.reset();
    h.fx.reset();
    expect(h.fx.stats).toMatchObject({ particles: 0, decals: 0, beams: 0, telegraphs: 0, trails: 0, lights: 0 });
    const second = run(h);
    expect(second).toEqual(first);
    const children = h.ctx.scene.getObjectByName('fx')?.children.length;
    h.fx.reset();
    expect(h.ctx.scene.getObjectByName('fx')?.children.length).toBe(children);
    expect(h.errors).toEqual([]);
  });

  it('adds one root named fx and removes everything again on dispose', () => {
    const h = harness();
    const roots = h.ctx.scene.children.filter((c) => c.name === 'fx');
    expect(roots.length).toBe(1);
    const root = roots[0] as THREE.Object3D;
    const meshes = root.children.filter((c) => (c as THREE.Mesh).isMesh);
    // Eight batches in total: well inside the budget of 25.
    expect(meshes.length).toBe(8);
    expect(meshes.every((m) => !m.frustumCulled && !m.castShadow)).toBe(true);
    void h.fx.init();
    expect(h.ctx.scene.children.filter((c) => c.name === 'fx').length).toBe(1);
    h.fx.dispose();
    h.fx.dispose();
    expect(h.ctx.scene.children.length).toBe(0);
    // The events no longer reach it.
    h.ctx.events.emit('quality:changed', { preset: 'low', params: QUALITY.low });
    h.ctx.events.emit('timeOfDay:changed', { id: 'eclipse', prev: 'dusk', seconds: 0 });
    expect(h.fx.weather).toBe('clear');
  });

  it('contains errors at the boundary: reported once as "fx", never thrown', () => {
    const h = harness();
    const bomb = {
      get x(): number {
        throw new Error('boom');
      },
      y: 0,
      z: 0,
    };
    const p = at(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      expect(() => h.fx.spawn('impactMetal', bomb)).not.toThrow();
      expect(() => h.fx.tracer(bomb, p)).not.toThrow();
      expect(h.fx.beam(bomb, p, { kind: 'rail' })).toBe(DEAD_BEAM);
      expect(h.fx.telegraph({ kind: 'ring', position: bomb, radius: 1, seconds: 1 })).toBe(DEAD_TELEGRAPH);
      expect(h.fx.attachTrail('rocket', bomb as unknown as THREE.Vector3)).toBe(DEAD_TRAIL);
      expect(() => h.fx.decal('scorch', bomb, p)).not.toThrow();
      expect(() => h.fx.damageNumber(bomb, 5)).not.toThrow();
      expect(() => h.fx.lightFlash(bomb, 0xffffff, 1, 5, 1)).not.toThrow();
      expect(() => h.fx.lightningBolt(bomb, p)).not.toThrow();
    }
    expect(h.errors.length).toBe(9);
    expect(h.errors.every((e) => e.source === 'fx')).toBe(true);
    // The system keeps working.
    h.fx.spawn('impactMetal', p);
    expect(h.fx.stats.particles).toBeGreaterThan(0);
  });

  it('keeps the other subsystems alive when one of them breaks in update', () => {
    const h = harness();
    const trail = at(0, 1, 0);
    h.fx.attachTrail('rocket', trail);
    h.fx.spawn('explosionSmall', at(0, 0, 0));
    // The trail's vector turns hostile: reading it throws from inside update().
    Object.defineProperty(trail, 'x', {
      get(): number {
        throw new Error('bad vector');
      },
    });
    expect(() => h.step(0.5)).not.toThrow();
    expect(h.errors.length).toBe(1);
    expect(h.errors[0]?.source).toBe('fx');
    // Particles still simulate and end.
    h.step(3);
    expect(h.fx.stats.particles).toBe(0);
    // A reset brings the broken subsystem back.
    h.fx.reset();
    const fresh = at(0, 1, 0);
    expect(h.fx.attachTrail('rocket', fresh).active).toBe(true);
    for (let i = 0; i < 10; i++) {
      fresh.x += 1;
      h.step(1 / 60);
    }
    expect(h.drawn('fx-ribbons')).toBeGreaterThan(0);
  });

  it('does not allocate per spawn or per frame in steady state', () => {
    const h = harness();
    const p = at(0, 0, 0);
    const opts = { radius: 5, normal: at(0, 1, 0), dir: at(1, 0, 0), velocity: at(0, 0, 0) };
    const mover = at(0, 2, 0);
    h.fx.attachTrail('rocket', mover);
    h.fx.beam(p, at(9, 1, 0), { kind: 'sweep', seconds: 0 });
    h.fx.telegraph({ kind: 'shock', position: p, radius: 3, seconds: 0 });
    const cycle = (n: number): void => {
      for (let i = 0; i < n; i++) {
        h.fx.spawn('explosionLarge', p, opts);
        h.fx.spawn('impactMetal', p, opts);
        h.fx.tracer(p, at(40, 1, 0));
        h.fx.lightFlash(p, 0xffffff, 1, 6, 0.1);
        h.fx.damageNumber(p, 12, { targetId: 1 });
        h.fx.lightningBolt(at(0, 30, 0), p);
        mover.x += 0.7;
        h.step(1 / 60);
      }
    };
    cycle(200);
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) return;
    const heap = (): number => (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;
    gc();
    const before = heap();
    cycle(600);
    gc();
    const grown = heap() - before;
    // 600 frames with ~120 spawned particles each: any per-particle or per-spawn garbage would show.
    expect(grown).toBeLessThan(600 * 1024);
  });
});
