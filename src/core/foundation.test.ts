/**
 * Contract tests for the foundation: they exercise the INTERFACES from core/types.ts, so they keep
 * passing when the baseline physics / nav implementations are replaced by hardened ones.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createNavGrid } from '../nav';
import { createCollisionWorld } from '../physics';
import { COL } from './constants';
import { createEventBus } from './events';
import { makeModifiers, makeMoveResult, makeNavPath, makeRayHit, resetModifiers } from './make';
import { angleDelta, damp, dirToPitch, dirToYaw, safeNormalize, wrapAngle, yawPitchToDir } from './math';
import { Pool } from './pool';
import { createRng } from './rng';
import { createSettings } from './settings';
import { createStorage } from './storage';
import { createTime } from './time';
import type { CollisionWorld, NavBuildHints } from './types';

const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => ({
  minX,
  minY,
  minZ,
  maxX,
  maxY,
  maxZ,
});

/** 40 x 40 m floor (top at y = 0) with a wall, a 0.4 m step, a 1 m ledge and a gate. */
function testWorld(): CollisionWorld {
  const world = createCollisionWorld();
  world.addBox(box(-20, -1, -20, 20, 0, 20));
  world.addBox({ ...box(5, 0, -20, 6, 3, 10), tag: 'wall' });
  world.addBox(box(-10, 0, -10, -6, 0.4, -6));
  world.addBox(box(-10, 0, 6, -6, 1, 10));
  world.addBox({ ...box(5, 0, 10, 6, 3, 14), flags: COL.GATE, tag: 'gate:test' });
  world.addBox({ ...box(5, 0, 14, 6, 3, 20), tag: 'wall' });
  world.finalize();
  return world;
}

function testHints(): NavBuildHints {
  return {
    bounds: box(-20, -1, -20, 20, 10, 20),
    cellSize: 1,
    zones: [
      { id: 'deck', aabb: box(-20, -1, -20, 5.5, 10, 20) },
      { id: 'refinery', aabb: box(5.5, -1, -20, 20, 10, 20) },
    ],
    blocked: [],
    ignoreTags: ['gate:test'],
    closedRegions: [box(5, 0, 10, 6, 3, 14)],
    seeds: [{ x: 0, y: 0, z: 0 }],
    maxStep: 0.75,
    agentHeight: 1.6,
    agentRadius: 0.4,
  };
}

describe('events', () => {
  it('delivers in order, supports once/off and unsubscribing during emit', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const offA = bus.on('overclock:end', () => {
      seen.push('a');
      offA();
    });
    bus.once('overclock:end', () => seen.push('once'));
    bus.on('overclock:end', () => seen.push('b'));
    bus.emit('overclock:end', {});
    bus.emit('overclock:end', {});
    expect(seen).toEqual(['a', 'once', 'b', 'b']);
  });

  it('contains handler exceptions', () => {
    const errors: string[] = [];
    const bus = createEventBus((name) => errors.push(name));
    let reached = false;
    bus.on('overclock:ready', () => {
      throw new Error('boom');
    });
    bus.on('overclock:ready', () => {
      reached = true;
    });
    expect(() => bus.emit('overclock:ready', {})).not.toThrow();
    expect(reached).toBe(true);
    expect(errors).toEqual(['overclock:ready']);
  });
});

describe('time', () => {
  it('uses the minimum scale, hard-freezes at 0 and expires timed requests', () => {
    const time = createTime();
    time.setScale('overclock', 0.4);
    time.setScale('slowmo', 0.25, 0.1);
    time.advance(1 / 60, true, true);
    expect(time.scale).toBeCloseTo(0.25);
    expect(time.dt).toBeCloseTo(0.25 / 60);
    expect(time.unscaledDt).toBeCloseTo(1 / 60);
    for (let i = 0; i < 10; i++) time.advance(1 / 60, true, true);
    expect(time.scale).toBeCloseTo(0.4);
    time.setScale('perkSelect', 0);
    time.advance(1 / 60, true, true);
    expect(time.dt).toBe(0);
    expect(time.unscaledDt).toBe(0);
    time.clearScale('perkSelect');
    time.clearScale('overclock');
    time.hitstop(0.05);
    time.advance(1 / 60, true, true);
    expect(time.scale).toBeCloseTo(0.05);
    const before = time.now;
    time.advance(1 / 60, false, false);
    expect(time.now).toBe(before);
    time.reset();
    expect(time.now).toBe(0);
    expect(time.getScale('hitstop')).toBe(1);
  });
});

describe('rng / pool / math / settings', () => {
  it('rng is deterministic and in range', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) {
      const v = a.next();
      expect(v).toBe(b.next());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    for (let i = 0; i < 100; i++) {
      const n = a.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('pool recycles and caps', () => {
    let created = 0;
    const pool = new Pool(() => ({ n: created++ }), 2);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.acquire()).toBeNull();
    expect(pool.count).toBe(2);
    expect(pool.release(a as { n: number })).toBe(true);
    expect(pool.release(a as { n: number })).toBe(false);
    expect(pool.acquire()).toBe(a);
    pool.releaseAll();
    expect(pool.count).toBe(0);
    expect(b).not.toBeNull();
    expect(created).toBe(2);
  });

  it('angles and directions follow the contract (yaw 0 = -Z, +yaw = left, +pitch = up)', () => {
    const v = new THREE.Vector3();
    yawPitchToDir(0, 0, v);
    expect(v.z).toBeCloseTo(-1);
    yawPitchToDir(Math.PI / 2, 0, v);
    expect(v.x).toBeCloseTo(-1);
    yawPitchToDir(0, Math.PI / 4, v);
    expect(v.y).toBeGreaterThan(0);
    expect(dirToYaw(-1, 0)).toBeCloseTo(Math.PI / 2);
    expect(dirToPitch(0, 1, -1)).toBeCloseTo(Math.PI / 4);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(damp(0, 10, 5, 0)).toBe(0);
    const zero = new THREE.Vector3();
    expect(safeNormalize(zero)).toBe(0);
    expect(Number.isFinite(zero.x + zero.y + zero.z)).toBe(true);
    expect(zero.length()).toBeCloseTo(1);
  });

  it('settings clamp, persist and emit; modifiers reset', () => {
    const bus = createEventBus();
    const storage = createStorage('test:');
    const settings = createSettings(storage, bus);
    const changed: string[] = [];
    bus.on('settings:changed', (e) => changed.push(e.key));
    settings.set('fov', 500);
    expect(settings.data.fov).toBe(100);
    settings.set('fov', 100);
    expect(changed).toEqual(['fov']);
    expect(createSettings(storage, bus).data.fov).toBe(100);
    const mods = makeModifiers();
    mods.damageMul = 9;
    expect(resetModifiers(mods).damageMul).toBe(1);
  });
});

describe('collision world', () => {
  const world = testWorld();
  const out = makeMoveResult();

  it('stands, slides along walls and reports hits', () => {
    const pos = new THREE.Vector3(0, 0.5, 0);
    world.moveAndSlide(pos, 0.35, 1.8, { x: 0, y: -2, z: 0 }, COL.PLAYER, 0.45, 0, out);
    expect(pos.y).toBeCloseTo(0);
    expect(out.grounded).toBe(true);
    pos.set(4, 0, 0);
    world.moveAndSlide(pos, 0.35, 1.8, { x: 3, y: 0, z: 1 }, COL.PLAYER, 0.45, 0.45, out);
    expect(pos.x).toBeCloseTo(5 - 0.35);
    expect(pos.z).toBeCloseTo(1);
    expect(out.hitX).toBe(true);
    expect(out.hitZ).toBe(false);
    expect(out.grounded).toBe(true);
  });

  it('steps up low ledges, refuses tall ones, snaps down stairs', () => {
    const pos = new THREE.Vector3(-5, 0, -8);
    world.moveAndSlide(pos, 0.35, 1.8, { x: -1.5, y: 0, z: 0 }, COL.PLAYER, 0.45, 0.45, out);
    expect(pos.y).toBeCloseTo(0.4);
    expect(out.stepped).toBeCloseTo(0.4);
    expect(out.grounded).toBe(true);
    world.moveAndSlide(pos, 0.35, 1.8, { x: 3, y: 0, z: 0 }, COL.PLAYER, 0.45, 0.45, out);
    expect(pos.y).toBeCloseTo(0);
    expect(out.grounded).toBe(true);
    pos.set(-5, 0, 8);
    world.moveAndSlide(pos, 0.35, 1.8, { x: -1.5, y: 0, z: 0 }, COL.PLAYER, 0.45, 0.45, out);
    expect(pos.y).toBeCloseTo(0);
    expect(pos.x).toBeCloseTo(-6 + 0.35);
    expect(out.hitX).toBe(true);
  });

  it('does not tunnel at high speed and never returns NaN', () => {
    const pos = new THREE.Vector3(0, 0, 0);
    world.moveAndSlide(pos, 0.35, 1.8, { x: 30, y: 0, z: 0 }, COL.PLAYER, 0, 0, out);
    expect(pos.x).toBeLessThanOrEqual(5 - 0.35 + 1e-6);
    pos.set(0, 10, 0);
    world.moveAndSlide(pos, 0.35, 1.8, { x: 0, y: -40, z: 0 }, COL.PLAYER, 0, 0, out);
    expect(pos.y).toBeCloseTo(0);
    world.moveAndSlide(pos, 0.35, 1.8, { x: Number.NaN, y: 0, z: 0 }, COL.PLAYER, 0, 0, out);
    expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
  });

  it('raycasts with normals, masks and toggles', () => {
    const hit = makeRayHit();
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50, COL.PROJECTILE, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(5);
    expect(hit.normal.x).toBeCloseTo(-1);
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 50, COL.PROJECTILE, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(5);
    expect(hit.normal.y).toBeCloseTo(1);
    // The gate blocks bodies and shots but not sight.
    expect(world.lineOfSight({ x: 0, y: 1, z: 12 }, { x: 10, y: 1, z: 12 }, COL.SIGHT)).toBe(true);
    expect(world.lineOfSight({ x: 0, y: 1, z: 12 }, { x: 10, y: 1, z: 12 }, COL.PROJECTILE)).toBe(false);
    expect(world.setEnabledByTag('gate:test', false)).toBe(1);
    expect(world.lineOfSight({ x: 0, y: 1, z: 12 }, { x: 10, y: 1, z: 12 }, COL.PROJECTILE)).toBe(true);
    world.setEnabledByTag('gate:test', true);
    expect(world.groundHeight(-8, -8, 10, COL.PLAYER)).toBeCloseTo(0.4);
    expect(world.groundHeight(100, 100, 10, COL.PLAYER)).toBe(-Infinity);
    expect(world.overlapBox(box(4.5, 1, 0, 5.5, 2, 1), COL.ANY)).toBeGreaterThanOrEqual(0);
    expect(world.overlapBox(box(0, 1, 0, 1, 2, 1), COL.ANY)).toBe(-1);
    expect(world.overlapSphere({ x: 4.8, y: 1, z: 0 }, 0.5, COL.ANY)).toBe(true);
  });
});

describe('nav grid', () => {
  const world = testWorld();
  const nav = createNavGrid();
  nav.build(world, testHints());
  const out = new THREE.Vector3();

  it('labels walkability, heights and zones', () => {
    expect(nav.isWalkable(0.5, 0.5)).toBe(true);
    expect(nav.isWalkable(5.5, 0.5)).toBe(false);
    expect(nav.heightAt(-8.5, -8.5)).toBeCloseTo(0.4);
    // The 1 m ledge top is not reachable by stepping: unwalkable.
    expect(nav.isWalkable(-8.5, 8.5)).toBe(false);
    expect(nav.zoneAt(0.5, 0.5)).toBe('deck');
    expect(nav.zoneAt(10.5, 0.5)).toBe('refinery');
    expect(nav.cellAt(1000, 0)).toBe(-1);
  });

  it('respects gates for reachability, paths and the flow field', () => {
    const a = { x: 0.5, y: 0, z: 0.5 };
    const b = { x: 12.5, y: 0, z: 0.5 };
    const path = makeNavPath();
    expect(nav.isReachable(a, b)).toBe(false);
    expect(nav.findPath(a, b, path)).toBe(false);
    nav.updateFlowField(b);
    expect(nav.sampleFlow(a, out)).toBe(false);
    expect(nav.flowDistance(a)).toBe(Infinity);

    nav.setRegionWalkable(box(5, 0, 10, 6, 3, 14), true);
    expect(nav.isReachable(a, b)).toBe(true);
    expect(nav.findPath(a, b, path)).toBe(true);
    expect(path.count).toBeGreaterThanOrEqual(2);
    const last = path.points[path.count - 1] as THREE.Vector3;
    expect(last.x).toBeCloseTo(12.5);
    expect(last.z).toBeCloseTo(0.5);
    expect(nav.updateFlowField(b)).toBe(true);
    expect(nav.updateFlowField(b)).toBe(false);
    expect(nav.sampleFlow(a, out)).toBe(true);
    expect(out.length()).toBeCloseTo(1);
    const d = nav.flowDistance(a);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(40);

    // Walking along the flow field arrives at the target.
    const p = new THREE.Vector3(a.x, 0, a.z);
    for (let i = 0; i < 600 && p.distanceTo(b as THREE.Vector3) > 0.6; i++) {
      if (!nav.sampleFlow(p, out)) break;
      p.addScaledVector(out, 0.1);
    }
    expect(p.distanceTo(b as THREE.Vector3)).toBeLessThan(0.7);

    expect(nav.isLineWalkable(a, { x: 3.5, y: 0, z: 3.5 })).toBe(true);
    expect(nav.isLineWalkable(a, b)).toBe(false);
    const rng = createRng(7);
    expect(nav.randomPointInAnnulus(a, 3, 8, rng, out)).toBe(true);
    const r = Math.hypot(out.x - a.x, out.z - a.z);
    expect(r).toBeGreaterThanOrEqual(3 - 1e-6);
    expect(r).toBeLessThanOrEqual(8 + 1e-6);
    expect(nav.nearestWalkable({ x: 5.5, y: 0, z: 0.5 }, 3, out)).toBe(true);
  });
});
