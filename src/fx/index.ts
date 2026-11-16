/**
 * FX system: every transient visual in world space — particles, tracers, beams, lightning bolts,
 * telegraphs, decals, trails, damage numbers, weather with the ambient storm — and the fixed pool of
 * point lights. Eight instanced batches in total; every pool is allocated in init() and nothing
 * allocates per spawn or per frame afterwards.
 *
 * Clocks: world-clock effects advance with the scaled dt handed to update(), effects created with clock
 * 'player' (and the damage numbers, which are the player's own hit feedback) with ctx.time.playerDt.
 * GPU buffers are written once per frame, in lateUpdate() of the frame's last substep; FX never reads
 * ctx.camera on the CPU.
 */
import * as THREE from 'three';
import { COL, FX_CAPS, FX_STREAM_IDS, RENDER_ORDER } from '../core/constants';
import { PALETTE } from '../core/palette';
import type {
  BeamHandle,
  BeamOptions,
  DamageNumberOptions,
  DecalKind,
  FxId,
  FxSpawnOptions,
  FxStats,
  FxSystem,
  GameContext,
  LightningOptions,
  QualityParams,
  TelegraphHandle,
  TelegraphOptions,
  TimeOfDayId,
  TracerOptions,
  TrailHandle,
  TrailKind,
  Vec3Like,
  WeatherId,
} from '../core/types';
import { QUALITY } from '../data/quality';
import { TIME_OF_DAY } from '../data/timeOfDay';
import { ATLAS_SIZE, DIGIT_ATLAS_H, DIGIT_ATLAS_W, DIGIT_CELL_W, DIGIT_OUTLINE_EDGE, buildDigitAtlas, buildSpriteAtlas } from './atlas';
import { Bolts } from './bolts';
import { DECAL_STRIDE, NUMBER_STRIDE, PARTICLE_STRIDE, RIBBON_STRIDE, STREAK_STRIDE, TELEGRAPH_STRIDE } from './consts';
import { Decals } from './decals';
import { Emitter } from './emit';
import { InstancedBatch, fxMaterial, makeQuad } from './gpu';
import type { SharedUniforms } from './gpu';
import { DEAD_BEAM, DEAD_TELEGRAPH, DEAD_TRAIL } from './handles';
import { FALLBACK_RECIPE, LIBRARY, TRAIL_PUFFS } from './library';
import { LightPool } from './lights';
import { DamageNumbers } from './numbers';
import { bakeRamps } from './ramps';
import { RibbonWriter } from './ribbons';
import {
  DECAL_FRAGMENT,
  DECAL_VERTEX,
  NUMBER_FRAGMENT,
  NUMBER_VERTEX,
  PARTICLE_FRAGMENT,
  PARTICLE_VERTEX,
  RIBBON_FRAGMENT,
  RIBBON_VERTEX,
  STREAK_FRAGMENT,
  STREAK_VERTEX,
  TELEGRAPH_FRAGMENT,
  TELEGRAPH_VERTEX,
} from './shaders';
import { ParticleSim } from './sim';
import { Beams, Tracers } from './streaks';
import { Telegraphs } from './telegraphs';
import { TRAIL_KINDS, Trails } from './trails';
import { Weather, isWeatherId } from './weather';

/** Streak instances: one per tracer, up to three per beam (core + two end glows), one head glow per trail. */
const STREAK_CAPACITY = FX_CAPS.tracers + FX_CAPS.beams * 3 + FX_CAPS.trails;
/** Ribbon segments: every trail at full length plus every bolt with all its branches. */
const RIBBON_CAPACITY = FX_CAPS.trails * 20 + FX_CAPS.bolts * 62;
/** Glyph instances: five digits per number. */
const NUMBER_CAPACITY = FX_CAPS.damageNumbers * 5;
/** Decal pool: the largest maxDecals of any quality preset. */
const DECAL_CAPACITY = Math.max(...Object.values(QUALITY).map((q) => q.maxDecals));
/** Normalised intensity, reach and minimum seconds of the pooled light at the far end of a bolt. */
const BOLT_LIGHT = 2.5;
const BOLT_LIGHT_RADIUS = 14;
/** Tracer colour of shots that belong to nobody. */
const NEUTRAL_TRACER = 0xffe9c2;

const STREAMS: ReadonlySet<string> = new Set<string>(FX_STREAM_IDS);

/** Everything init() builds; null before init() and after dispose(). */
interface Runtime {
  root: THREE.Group;
  shared: SharedUniforms;
  textures: THREE.Texture[];
  materials: THREE.ShaderMaterial[];
  batches: InstancedBatch[];
  particlesAdd: InstancedBatch;
  particlesAlpha: InstancedBatch;
  streaks: InstancedBatch;
  ribbons: InstancedBatch;
  telegraphBatch: InstancedBatch;
  decalBatch: InstancedBatch;
  numberBatch: InstancedBatch;
  sim: ParticleSim;
  emitter: Emitter;
  tracers: Tracers;
  beams: Beams;
  bolts: Bolts;
  ribbon: RibbonWriter;
  trails: Trails;
  telegraphs: Telegraphs;
  decals: Decals;
  numbers: DamageNumbers;
  lights: LightPool;
  weather: Weather;
  /** The simulation steps of update(), one per subsystem (world dt, player dt). */
  steps: ((dt: number, playerDt: number) => void)[];
}

/** Names of Runtime.steps, for error reports. */
const STEP_NAMES = ['particles', 'tracers', 'beams', 'bolts', 'trails', 'telegraphs', 'numbers', 'lights', 'decals', 'weather'];

function dataTexture(data: Uint8Array, width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Clamp a clock delta: never negative, never NaN, never a huge jump. */
function delta(dt: number): number {
  return dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;
}

export function createFxSystem(ctx: GameContext): FxSystem {
  let rt: Runtime | null = null;
  /** Live counters: read straight from the pools, so they are right at any moment. */
  const stats: FxStats = {
    get particles(): number {
      return rt ? rt.sim.count : 0;
    },
    get decals(): number {
      return rt ? rt.decals.count : 0;
    },
    get beams(): number {
      return rt ? rt.beams.count : 0;
    },
    get telegraphs(): number {
      return rt ? rt.telegraphs.count : 0;
    },
    get trails(): number {
      return rt ? rt.trails.count : 0;
    },
    get lights(): number {
      return rt ? rt.lights.lit : 0;
    },
    batches: 0,
  };
  /** Seconds of world time since the last clear(): the time base of decals and shader animation. */
  let time = 0;
  let particleScale = 1;
  /** Something changed since the buffers were last written. */
  let dirty = false;
  /** Bit i set: step i of Runtime.steps threw and is skipped until the next reset. */
  let broken = 0;
  const reported = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  const tmpColor = new THREE.Color();
  const puffAt = new THREE.Vector3();
  const boltOptions: LightningOptions = { light: false };

  /** Contain an error at the boundary: reported once per entry point, never rethrown. */
  const fail = (where: string, error: unknown): void => {
    if (reported.has(where)) return;
    reported.add(where);
    try {
      ctx.game.reportError('fx', error);
    } catch {
      // Reporting must never throw either.
    }
  };

  // --- construction -----------------------------------------------------------------------------
  const build = (): Runtime => {
    const root = new THREE.Group();
    root.name = 'fx';

    // The fixed light pool: created once, never added, removed or hidden afterwards.
    const pointLights: THREE.PointLight[] = [];
    for (let i = 0; i < FX_CAPS.lights; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.name = `fx-light-${i}`;
      light.castShadow = false;
      light.position.set(0, -1000, 0);
      pointLights.push(light);
      root.add(light);
    }

    const atlas = dataTexture(buildSpriteAtlas(), ATLAS_SIZE, ATLAS_SIZE);
    atlas.name = 'fx-atlas';
    const digits = dataTexture(buildDigitAtlas(), DIGIT_ATLAS_W, DIGIT_ATLAS_H);
    digits.name = 'fx-digits';
    const shared: SharedUniforms = {
      uTime: { value: 0 },
      uViewport: { value: new THREE.Vector2(Math.max(ctx.render.width, 320), Math.max(ctx.render.height, 240)) },
      uLight: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    };
    const quad = makeQuad();

    const particleUniforms = (lit: number): Record<string, THREE.IUniform> => ({
      uAtlas: { value: atlas },
      uLight: shared.uLight,
      uViewport: shared.uViewport,
      uLit: { value: lit },
    });
    const matParticlesAdd = fxMaterial({ name: 'fx-particles-add', vertex: PARTICLE_VERTEX, fragment: PARTICLE_FRAGMENT, blend: 'add', uniforms: particleUniforms(0) });
    const matParticlesAlpha = fxMaterial({ name: 'fx-particles-alpha', vertex: PARTICLE_VERTEX, fragment: PARTICLE_FRAGMENT, blend: 'over', uniforms: particleUniforms(1) });
    const matStreaks = fxMaterial({
      name: 'fx-streaks', vertex: STREAK_VERTEX, fragment: STREAK_FRAGMENT, blend: 'add',
      uniforms: { uTime: shared.uTime, uViewport: shared.uViewport },
    });
    const matRibbons = fxMaterial({ name: 'fx-ribbons', vertex: RIBBON_VERTEX, fragment: RIBBON_FRAGMENT, blend: 'add', uniforms: { uViewport: shared.uViewport } });
    const matTelegraphs = fxMaterial({
      name: 'fx-telegraphs', vertex: TELEGRAPH_VERTEX, fragment: TELEGRAPH_FRAGMENT, blend: 'over', polygonOffset: true,
      uniforms: { uTime: shared.uTime },
    });
    const matDecals = fxMaterial({
      name: 'fx-decals', vertex: DECAL_VERTEX, fragment: DECAL_FRAGMENT, blend: 'over', polygonOffset: true,
      uniforms: { uTime: shared.uTime, uLight: shared.uLight },
    });
    const matNumbers = fxMaterial({
      name: 'fx-numbers', vertex: NUMBER_VERTEX, fragment: NUMBER_FRAGMENT, blend: 'over', depthTest: false, fog: false,
      uniforms: {
        uDigits: { value: digits },
        // Glyph height in metres up close, as a fraction of the view depth far away, cell width in UV,
        // outline edge of the distance field.
        uDigit: { value: new THREE.Vector4(0.3, 0.04, DIGIT_CELL_W / DIGIT_ATLAS_W, DIGIT_OUTLINE_EDGE) },
      },
    });

    const particleLayout = [['aPosSize', 4], ['aAxisRot', 4], ['aColor', 4], ['aMisc', 4]] as const;
    const particlesAlpha = new InstancedBatch('fx-particles-alpha', FX_CAPS.particles, PARTICLE_STRIDE, particleLayout, matParticlesAlpha, RENDER_ORDER.FX_ALPHA, quad);
    const particlesAdd = new InstancedBatch('fx-particles-add', FX_CAPS.particles, PARTICLE_STRIDE, particleLayout, matParticlesAdd, RENDER_ORDER.FX_ADDITIVE, quad);
    const streaks = new InstancedBatch(
      'fx-streaks', STREAK_CAPACITY, STREAK_STRIDE,
      [['aFrom', 4], ['aTo', 4], ['aColor', 4], ['aParams', 4]], matStreaks, RENDER_ORDER.BEAM, quad,
    );
    const ribbons = new InstancedBatch(
      'fx-ribbons', RIBBON_CAPACITY, RIBBON_STRIDE,
      [['aA', 4], ['aTA', 4], ['aB', 4], ['aTB', 4], ['aCA', 4], ['aCB', 4]], matRibbons, RENDER_ORDER.FX_ADDITIVE, quad,
    );
    const telegraphBatch = new InstancedBatch(
      'fx-telegraphs', FX_CAPS.telegraphs, TELEGRAPH_STRIDE,
      [['aCenter', 4], ['aColor', 4], ['aParams', 4]], matTelegraphs, RENDER_ORDER.TELEGRAPH, quad,
    );
    const decalBatch = new InstancedBatch(
      'fx-decals', DECAL_CAPACITY, DECAL_STRIDE,
      [['aPosSize', 4], ['aNormalRot', 4], ['aKind', 4], ['aClipMin', 3], ['aClipMax', 3]], matDecals, RENDER_ORDER.DECAL, quad,
    );
    const numberBatch = new InstancedBatch(
      'fx-numbers', NUMBER_CAPACITY, NUMBER_STRIDE,
      [['aAnchor', 4], ['aGlyph', 4], ['aColor', 4]], matNumbers, RENDER_ORDER.DAMAGE_NUMBER, quad,
    );
    const batches = [decalBatch, telegraphBatch, particlesAlpha, streaks, ribbons, particlesAdd, numberBatch];
    for (const batch of batches) root.add(batch.mesh);

    const rng = ctx.cosmeticRng;
    const sim = new ParticleSim(FX_CAPS.particles, bakeRamps());
    const emitter = new Emitter(sim, rng, (x, y, z) => ctx.collision.groundHeight(x, z, y, COL.PROJECTILE));
    const trails = new Trails(FX_CAPS.trails, (kind, x, y, z) => {
      const puff = TRAIL_PUFFS[TRAIL_KINDS[kind] as TrailKind];
      if (!puff || !emitter.begin(puffAt.set(x, y, z), undefined, false)) return;
      emitter.particleScale = particleScale;
      emitter.size(1);
      emitter.emit(puff, 1);
    });
    const weather = new Weather(ctx, atlas, shared, quad, (from, to, width, branches, seconds) => {
      boltOptions.width = width;
      boltOptions.branches = branches;
      boltOptions.seconds = seconds;
      boltOptions.light = false;
      boltOptions.color = undefined;
      system.lightningBolt(from, to, boltOptions);
    });
    root.add(weather.mesh);

    const tracers = new Tracers(FX_CAPS.tracers);
    const beams = new Beams(FX_CAPS.beams);
    const bolts = new Bolts(FX_CAPS.bolts);
    const telegraphs = new Telegraphs(FX_CAPS.telegraphs);
    const decals = new Decals(DECAL_CAPACITY, rng);
    const numbers = new DamageNumbers(FX_CAPS.damageNumbers, rng);
    const lights = new LightPool(pointLights, FX_CAPS.keyedLights);
    // Same order as STEP_NAMES. Damage numbers are the player's own hit feedback: player clock.
    const steps: ((dt: number, playerDt: number) => void)[] = [
      (dt, playerDt) => sim.update(dt, playerDt),
      (dt, playerDt) => tracers.update(dt, playerDt),
      (dt, playerDt) => beams.update(dt, playerDt),
      (dt) => bolts.update(dt),
      (dt) => trails.update(dt),
      (dt) => telegraphs.update(dt),
      (_dt, playerDt) => numbers.update(playerDt),
      (dt) => lights.update(dt),
      () => decals.update(time, ctx.collision),
      (dt) => weather.update(dt),
    ];

    return {
      root,
      shared,
      textures: [atlas, digits],
      materials: [matParticlesAdd, matParticlesAlpha, matStreaks, matRibbons, matTelegraphs, matDecals, matNumbers],
      batches,
      particlesAdd,
      particlesAlpha,
      streaks,
      ribbons,
      telegraphBatch,
      decalBatch,
      numberBatch,
      sim,
      emitter,
      tracers,
      beams,
      bolts,
      ribbon: new RibbonWriter(ribbons.data),
      trails,
      telegraphs,
      decals,
      numbers,
      lights,
      weather,
      steps,
    };
  };

  // --- quality, weather, events -------------------------------------------------------------------
  /** A preset only changes the active caps and densities: nothing is allocated or disposed. */
  const applyQuality = (params: Readonly<QualityParams>): void => {
    const r = rt;
    if (!r) return;
    const scale = Number.isFinite(params.particleScale) ? Math.min(Math.max(params.particleScale, 0), 2) : 1;
    particleScale = scale;
    r.sim.setCap(Math.round(FX_CAPS.particles * Math.min(Math.max(scale, 0.25), 1)));
    r.decals.setCap(params.maxDecals);
    r.weather.setQuality(params.weatherScale);
    dirty = true;
  };

  /** Weather follows the time of day: TIME_OF_DAY[id].weather (snap = no cross-fade). */
  const syncWeather = (id: TimeOfDayId, snap: boolean): void => {
    const r = rt;
    if (!r) return;
    const def = TIME_OF_DAY[id];
    r.weather.set(def ? def.weather : 'clear', 1);
    if (snap) r.weather.snap();
  };

  // --- per-frame ----------------------------------------------------------------------------------
  /** Write every instance buffer and the shared uniforms (once per rendered frame). */
  const flush = (r: Runtime): void => {
    dirty = false;
    r.sim.write(r.particlesAdd.data, r.particlesAlpha.data);
    r.particlesAdd.commit(r.sim.addCount);
    r.particlesAlpha.commit(r.sim.alphaCount);

    r.ribbon.reset();
    r.bolts.write(r.ribbon);
    let streakCount = r.tracers.write(r.streaks.data, 0);
    streakCount = r.beams.write(r.streaks.data, streakCount);
    streakCount = r.trails.write(r.ribbon, r.streaks.data, streakCount);
    r.streaks.commit(streakCount);
    r.ribbons.commit(r.ribbon.count);

    r.telegraphBatch.commit(r.telegraphs.write(r.telegraphBatch.data));
    if (r.decals.dirty) r.decalBatch.commit(r.decals.write(r.decalBatch.data));
    r.numberBatch.commit(r.numbers.write(r.numberBatch.data));

    r.shared.uTime.value = time;
    // Matte things (smoke, dust, debris, decal chips) take the colour of the scene light.
    const lighting = ctx.render.lighting;
    const boost = 1 + 2.5 * lighting.flash;
    const ambient = lighting.ambientIntensity * 0.55;
    const sun = lighting.sunIntensity * 0.2;
    r.shared.uLight.value.set(
      Math.min(Math.max((lighting.ambientColor.r * ambient + lighting.sunColor.r * sun) * boost, 0.03), 2.5),
      Math.min(Math.max((lighting.ambientColor.g * ambient + lighting.sunColor.g * sun) * boost, 0.03), 2.5),
      Math.min(Math.max((lighting.ambientColor.b * ambient + lighting.sunColor.b * sun) * boost, 0.03), 2.5),
    );

    let drawn = r.weather.visible ? 1 : 0;
    for (let i = 0; i < r.batches.length; i++) if ((r.batches[i] as InstancedBatch).count > 0) drawn++;
    stats.batches = drawn;
  };

  const clearAll = (r: Runtime): void => {
    r.sim.clear();
    r.tracers.clear();
    r.beams.clear();
    r.bolts.clear();
    r.trails.clear();
    r.telegraphs.clear();
    r.decals.clear();
    r.numbers.clear();
    r.lights.clear();
    r.ribbon.reset();
    // Nothing of the cleared effects may be drawn again, even if no update follows before the next draw.
    for (const batch of r.batches) batch.hide();
    r.decals.dirty = false;
    time = 0;
    r.shared.uTime.value = 0;
    dirty = false;
    stats.batches = r.weather.visible ? 1 : 0;
  };

  const system: FxSystem = {
    stats,

    get weather(): WeatherId {
      return rt ? rt.weather.id : 'clear';
    },

    spawn(id: FxId, position: Vec3Like, opts?: FxSpawnOptions): void {
      const r = rt;
      if (!r) return;
      try {
        const emitter = r.emitter;
        if (!emitter.begin(position, opts, STREAMS.has(id))) return;
        emitter.particleScale = particleScale;
        (LIBRARY[id] ?? FALLBACK_RECIPE)(emitter);
        dirty = true;
      } catch (error) {
        fail('spawn', error);
      }
    },

    tracer(from: Vec3Like, to: Vec3Like, opts?: TracerOptions): void {
      const r = rt;
      if (!r) return;
      try {
        const faction = opts?.faction ?? 'player';
        const fallback = faction === 'player' ? PALETTE.player : faction === 'enemy' ? PALETTE.enemy : NEUTRAL_TRACER;
        const color = opts?.color !== undefined && Number.isFinite(opts.color) ? opts.color : fallback;
        r.tracers.add(from, to, color, opts?.speed ?? 320, opts?.width ?? 0.035, opts?.clock === 'player');
        dirty = true;
      } catch (error) {
        fail('tracer', error);
      }
    },

    beam(from: Vec3Like, to: Vec3Like, opts: BeamOptions): BeamHandle {
      const r = rt;
      if (!r) return DEAD_BEAM;
      try {
        const handle = r.beams.create(from, to, opts.kind, opts.color, opts.width, opts.seconds, opts.clock === 'player', opts.owner ?? 0, ctx.cosmeticRng.next() * 6.2831853);
        dirty = true;
        return handle;
      } catch (error) {
        fail('beam', error);
        return DEAD_BEAM;
      }
    },

    decal(kind: DecalKind, position: Vec3Like, normal: Vec3Like, size?: number, boxId?: number): void {
      const r = rt;
      if (!r) return;
      try {
        r.decals.add(kind, position, normal, size, boxId, ctx.collision, time);
        dirty = true;
      } catch (error) {
        fail('decal', error);
      }
    },

    damageNumber(position: Vec3Like, amount: number, opts?: DamageNumberOptions): void {
      const r = rt;
      if (!r || !ctx.settings.data.damageNumbers) return;
      try {
        r.numbers.add(position, amount, opts?.crit === true, opts?.shield === true, opts?.kill === true, opts?.targetId ?? 0);
        dirty = true;
      } catch (error) {
        fail('damageNumber', error);
      }
    },

    lightFlash(position: Vec3Like, color: number, intensity: number, radius: number, seconds: number, key?: number): void {
      const r = rt;
      if (!r) return;
      try {
        const k = key !== undefined && Number.isFinite(key) ? key : 0;
        r.lights.flash(position.x, position.y, position.z, Number.isFinite(color) ? color : 0xffffff, intensity, radius, seconds, k, ctx.settings.data.reduceFlashes);
      } catch (error) {
        fail('lightFlash', error);
      }
    },

    telegraph(opts: TelegraphOptions): TelegraphHandle {
      const r = rt;
      if (!r) return DEAD_TELEGRAPH;
      try {
        const handle = r.telegraphs.create(opts, ctx.cosmeticRng.next());
        dirty = true;
        return handle;
      } catch (error) {
        fail('telegraph', error);
        return DEAD_TELEGRAPH;
      }
    },

    lightningBolt(from: Vec3Like, to: Vec3Like, opts?: LightningOptions): void {
      const r = rt;
      if (!r) return;
      try {
        const reduce = ctx.settings.data.reduceFlashes;
        const color = opts?.color !== undefined && Number.isFinite(opts.color) ? opts.color : PALETTE.lightning;
        const seconds = opts?.seconds !== undefined && Number.isFinite(opts.seconds) && opts.seconds > 0 ? opts.seconds : 0.22;
        tmpColor.setHex(color & 0xffffff);
        const seed = Math.floor(ctx.cosmeticRng.next() * 0xffffffff);
        // Reduce flashes: the bolt fades once instead of strobing.
        r.bolts.add(from, to, tmpColor.r, tmpColor.g, tmpColor.b, opts?.width ?? 0.25, opts?.branches ?? 3, seconds, !reduce, seed);
        if (opts?.light ?? true) {
          r.lights.flash(to.x, to.y, to.z, color, BOLT_LIGHT, BOLT_LIGHT_RADIUS, Math.max(seconds, 0.18), 0, reduce);
        }
        dirty = true;
      } catch (error) {
        fail('lightningBolt', error);
      }
    },

    attachTrail(kind: TrailKind, position: THREE.Vector3, color?: number, owner?: number): TrailHandle {
      const r = rt;
      if (!r) return DEAD_TRAIL;
      try {
        const handle = r.trails.attach(kind, position, color, owner ?? 0);
        dirty = true;
        return handle;
      } catch (error) {
        fail('attachTrail', error);
        return DEAD_TRAIL;
      }
    },

    cancelOwner(ownerId: number): void {
      const r = rt;
      if (!r || !Number.isFinite(ownerId) || ownerId === 0) return;
      try {
        r.beams.cancelOwner(ownerId);
        r.telegraphs.cancelOwner(ownerId);
        r.trails.cancelOwner(ownerId);
        dirty = true;
      } catch (error) {
        fail('cancelOwner', error);
      }
    },

    setWeather(id: WeatherId, intensity?: number): void {
      const r = rt;
      if (!r) return;
      try {
        if (!isWeatherId(id)) return;
        // A call from outside (debug, tools) also switches the ambient storm on in test mode.
        r.weather.external = true;
        r.weather.set(id, intensity ?? 1);
      } catch (error) {
        fail('setWeather', error);
      }
    },

    clear(): void {
      const r = rt;
      if (!r) return;
      try {
        clearAll(r);
      } catch (error) {
        fail('clear', error);
      }
    },

    init(): void {
      if (rt) return;
      rt = build();
      ctx.scene.add(rt.root);
      unsubscribe.push(
        ctx.events.on('timeOfDay:changed', (e) => syncWeather(e.id, false)),
        ctx.events.on('quality:changed', (e) => applyQuality(e.params)),
        ctx.events.on('view:resize', (e) => {
          if (rt && e.width > 0 && e.height > 0) rt.shared.uViewport.value.set(e.width, e.height);
        }),
      );
      applyQuality(ctx.render.qualityParams);
      // Never rely on 'timeOfDay:changed' for the initial state.
      syncWeather(ctx.render.timeOfDay, true);
      rt.weather.update(0);
      flush(rt);
      // One program per batch, compiled now so nothing compiles mid-fight.
      ctx.render.warm(rt.root);
    },

    reset(): void {
      const r = rt;
      if (!r) return;
      broken = 0;
      clearAll(r);
      r.weather.resetStorm();
      syncWeather(ctx.render.timeOfDay, true);
      r.weather.update(0);
    },

    update(dt: number): void {
      const r = rt;
      if (!r) return;
      const wdt = delta(dt);
      const pdt = delta(ctx.time.playerDt);
      time += wdt;
      // One broken subsystem costs that subsystem, not the others: it is reported once and skipped
      // until the next reset.
      const steps = r.steps;
      for (let i = 0; i < steps.length; i++) {
        if ((broken & (1 << i)) !== 0) continue;
        try {
          (steps[i] as (dt: number, playerDt: number) => void)(wdt, pdt);
        } catch (error) {
          broken |= 1 << i;
          fail(`update:${STEP_NAMES[i]}`, error);
        }
      }
      dirty = true;
    },

    lateUpdate(): void {
      const r = rt;
      if (!r || !dirty) return;
      // GPU buffers are written once per frame: after the last system of the last substep.
      if (ctx.time.substep < ctx.time.substeps - 1) return;
      try {
        flush(r);
      } catch (error) {
        fail('flush', error);
      }
    },

    dispose(): void {
      const r = rt;
      if (!r) return;
      for (const off of unsubscribe) off();
      unsubscribe.length = 0;
      ctx.scene.remove(r.root);
      for (const batch of r.batches) batch.dispose();
      for (const material of r.materials) material.dispose();
      for (const texture of r.textures) texture.dispose();
      r.weather.dispose();
      rt = null;
      stats.batches = 0;
    },
  };
  return system;
}
