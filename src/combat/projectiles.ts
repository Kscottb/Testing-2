/**
 * Projectile simulation: pooled up to MAX_PROJECTILES, each on its own clock, swept against the world
 * and hostile targets every step (no tunnelling), with bounces, rolling, fuses, homing, landing
 * prediction, shoot-down, and every sound and effect that belongs to a shell in flight or to its impact
 * on the world. The meshes are drawn by visuals.ts from the state kept here.
 */
import * as THREE from 'three';
import { COL, MAX_PROJECTILES } from '../core/constants';
import {
  clearDamageInfo,
  clearDamageResult,
  clearFxOptions,
  makeDamageInfo,
  makeDamageResult,
  makeFxOptions,
  makeRayHit,
  makeShotHit,
  makeSoundOptions,
} from '../core/make';
import { clamp, lerp } from '../core/math';
import { PROJECTILES } from '../data/projectiles';
import type {
  DamageInfo,
  DamageResult,
  DamageSource,
  DamageType,
  ExplosionOptions,
  ExplosionVisual,
  Faction,
  GameContext,
  HitSphere,
  HitTarget,
  LoopHandle,
  LoopOptions,
  ProjectileDef,
  ProjectileKind,
  ProjectileOptions,
  SurfaceType,
  TelegraphHandle,
  TelegraphOptions,
  TrailHandle,
  Vec3Like,
} from '../core/types';
import type { ExplosionQueue } from './explosions';
import { IO_DISTANCE, IO_LIMIT, IO_PAD } from './targets';
import type { TargetRegistry } from './targets';
import {
  BOUNCE,
  BOUNDS_MARGIN,
  IMPACT_LOOKS,
  PROJECTILE_DEFAULTS,
  SHOOTABLE_SPHERE_SCALE,
  SHOOTDOWN,
  SURFACE_FX,
  SURFACE_SOUND,
  WHIZ,
  projectileAccent,
} from './tuning';

/** In flight · rolling along a floor after its last hop · lying still until the fuse ends. */
export const FLYING = 0;
export const ROLLING = 1;
export const RESTING = 2;

type MutableTarget = { -readonly [K in keyof HitTarget]: HitTarget[K] };

/** One pooled projectile. visuals.ts reads it; only this module writes it. */
export interface Projectile {
  alive: boolean;
  id: number;
  kind: ProjectileKind;
  def: Readonly<ProjectileDef>;
  faction: Faction;
  ownerId: number;
  damage: number;
  type: DamageType;
  weapon: DamageSource | null;
  splashRadius: number;
  splashDamage: number;
  /** NaN = the explosion default. */
  selfDamageMul: number;
  friendlyFire: boolean;
  creditPlayer: boolean;
  gravity: number;
  bounce: number;
  fuse: number;
  homing: number;
  targetId: number;
  radius: number;
  lifetime: number;
  /** Direct-hit impulse, and the impulse of its blast (NaN = the explosion default). */
  knockback: number;
  blastKnockback: number;
  critScale: number;
  visual: ExplosionVisual;
  playerClock: boolean;
  /** Accent colour in the colour script (engine glow, bolt colour, plasma blast tint). */
  accent: number;

  /** Simulated position and velocity. */
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  /** Last unit heading (kept when the shell stops). */
  readonly dir: THREE.Vector3;
  /** Where it is DRAWN: blends from the visual origin onto `pos`. Trails and loops follow this vector. */
  readonly drawPos: THREE.Vector3;
  readonly visualOffset: THREE.Vector3;
  /** Seconds on its own clock, launch speed, metres travelled. */
  age: number;
  speed: number;
  travelled: number;
  state: number;
  /** Cosmetic: phase 0..1 and tumble axis. */
  seed: number;
  readonly spinAxis: THREE.Vector3;
  lastBounceAt: number;
  whizzed: boolean;
  whistled: boolean;
  /** Predicted seconds until it lands (0 = no prediction). */
  flightTime: number;
  loopRetryAt: number;
  trail: TrailHandle;
  loop: LoopHandle;
  telegraph: TelegraphHandle;
  /** Hit target of a shootable kind (registered while alive). */
  readonly sphere: HitSphere;
  readonly target: MutableTarget;
}

export interface ProjectileSystem {
  /** Live projectiles in launch order (entries with alive === false are skipped by readers). */
  readonly live: readonly Projectile[];
  readonly count: number;
  spawn(opts: ProjectileOptions): number;
  remove(id: number, detonate: boolean): boolean;
  clear(faction?: Faction): void;
  /** Advance every projectile one substep: `dt` is the world clock, the player's read ctx.time.playerDt. */
  update(dt: number): void;
}

const NO_TRAIL: TrailHandle = Object.freeze({ active: false, detach(): void {} });
const NO_LOOP: LoopHandle = Object.freeze({
  active: false,
  setPosition(): void {},
  setVolume(): void {},
  setPitch(): void {},
  stop(): void {},
});
const NO_TELEGRAPH: TelegraphHandle = Object.freeze({
  active: false,
  setPosition(): void {},
  setRadius(): void {},
  setProgress(): void {},
  cancel(): void {},
});

const UP: Vec3Like = { x: 0, y: 1, z: 0 };
const DOWN: Vec3Like = { x: 0, y: -1, z: 0 };
/** Bounces resolved within one step before the leftover time is dropped. */
const MAX_CONTACTS_PER_STEP = 4;
/** A blast sits this far off the surface its shell burst on, so its cover rays start in free air. */
const SURFACE_NUDGE = 0.08;
/** Chord length of the landing prediction in seconds, and how far ahead it looks. */
const PREDICT_STEP = 1 / 30;
const PREDICT_SECONDS = 12;
/** Seconds between two attempts to (re)acquire a fly loop that audio could not give. */
const LOOP_RETRY = 0.5;
/** The travelling light of the newest player rocket (keyed pooled light): intensity, reach, fade. */
const ROCKET_LIGHT_INTENSITY = 1.1;
const ROCKET_LIGHT_RADIUS = 7;
const ROCKET_LIGHT_SECONDS = 0.12;
/**
 * Number exchange between the stepping helpers. An optimised call that is not inlined boxes every
 * fractional argument, so the per-projectile hot path hands its numbers over through this array.
 */
const S_DT_WORLD = 0;
const S_DT_PLAYER = 1;
const S_TIME = 2;
const S_TRAVEL = 3;
/** Invalid requests are reported at most this often per kind of mistake (a caller bug must not end the run). */
const MAX_INVALID_REPORTS = 3;

export function createProjectileSystem(
  ctx: GameContext,
  registry: TargetRegistry,
  explosions: ExplosionQueue,
  applyDamage: (target: HitTarget, info: DamageInfo) => DamageResult,
): ProjectileSystem {
  const live: Projectile[] = [];
  const free: Projectile[] = [];
  const byId = new Map<number, Projectile>();
  let count = 0;
  /** Inside a pass over `live`: removals only mark, the list is compacted afterwards. */
  let iterating = false;
  let dirty = false;
  /** The newest live rocket of the player: it carries the one travelling light (0 = none). */
  let litId = 0;
  let invalidReports = 0;

  const io = registry.io;
  const s = new Float64Array(4);
  const rayHit = makeRayHit();
  const shot = makeShotHit();
  const info = makeDamageInfo();
  const shootResult = makeDamageResult();
  const fxOpts = makeFxOptions();
  const soundOpts = makeSoundOptions();
  const loopOpts: LoopOptions = { position: undefined, volume: 1, pitch: 1, fadeIn: 0.05, priority: 1, owner: 0 };
  const telegraphOpts: TelegraphOptions = { kind: 'mortar', position: new THREE.Vector3(), radius: 1, seconds: 0, owner: 0 };
  const blastOpts: ExplosionOptions & { position: THREE.Vector3 } = {
    position: new THREE.Vector3(),
    radius: 1,
    damage: 0,
    faction: 'neutral',
  };
  const seg = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  const simPos = new THREE.Vector3();
  const simVel = new THREE.Vector3();
  const landing = new THREE.Vector3();

  const reportInvalid = (what: string): void => {
    if (invalidReports++ < MAX_INVALID_REPORTS) ctx.game.reportError('combat:spawnProjectile', new Error(what));
  };

  // --- pool ----------------------------------------------------------------------------------------

  const create = (): Projectile => {
    const pos = new THREE.Vector3();
    const sphere: HitSphere = { center: pos, radius: 0.3, part: 'body', enabled: true };
    const p = {
      alive: false,
      id: 0,
      kind: 'rocket',
      def: PROJECTILES.rocket,
      faction: 'neutral',
      ownerId: 0,
      damage: 0,
      type: 'explosion',
      weapon: null,
      splashRadius: 0,
      splashDamage: 0,
      selfDamageMul: NaN,
      friendlyFire: false,
      creditPlayer: false,
      gravity: 0,
      bounce: 0,
      fuse: 0,
      homing: 0,
      targetId: 0,
      radius: 0.2,
      lifetime: PROJECTILE_DEFAULTS.lifetime,
      knockback: 0,
      blastKnockback: NaN,
      critScale: 1,
      visual: 'none',
      playerClock: false,
      accent: 0xffffff,
      pos,
      vel: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0, -1),
      drawPos: new THREE.Vector3(),
      visualOffset: new THREE.Vector3(),
      age: 0,
      speed: 0,
      travelled: 0,
      state: FLYING,
      seed: 0,
      spinAxis: new THREE.Vector3(1, 0, 0),
      lastBounceAt: -1,
      whizzed: false,
      whistled: false,
      flightTime: 0,
      loopRetryAt: 0,
      trail: NO_TRAIL,
      loop: NO_LOOP,
      telegraph: NO_TELEGRAPH,
      sphere,
      target: null as unknown as MutableTarget,
    } as Projectile;
    (p as { target: MutableTarget }).target = {
      id: 0,
      faction: 'neutral',
      alive: false,
      center: pos,
      boundRadius: 0.3,
      spheres: [sphere],
      takeDamage: (damage) => shootDown(p, damage),
      enemy: null,
    };
    return p;
  };
  // Every slot exists up front; a few spares cover shells replaced while a pass is still running.
  for (let i = 0; i < MAX_PROJECTILES + 8; i++) free.push(create());

  const compact = (): void => {
    if (!dirty) return;
    dirty = false;
    let kept = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i] as Projectile;
      if (p.alive) live[kept++] = p;
      else free.push(p);
    }
    live.length = kept;
  };

  /** Take a projectile out of play for any reason: everything attached to it ends with it. */
  const remove = (p: Projectile): void => {
    if (!p.alive) return;
    p.alive = false;
    count--;
    dirty = true;
    byId.delete(p.id);
    if (litId === p.id) litId = 0;
    p.trail = NO_TRAIL;
    p.loop = NO_LOOP;
    p.telegraph = NO_TELEGRAPH;
    if (p.def.shootable) {
      p.target.alive = false;
      registry.unregister(p.id);
    }
    // Trail, landing marker, fly loop and whistle are all bound to the projectile id.
    ctx.fx.cancelOwner(p.id);
    ctx.audio.stopOwner(p.id);
    if (!iterating) compact();
  };

  // --- blasts and impacts ----------------------------------------------------------------------------

  /** Queue the blast of a shell where it is (on `surface` when it burst on the world). */
  const queueBlast = (p: Projectile, excludeId: number, surface: Vec3Like | null, boxId: number): void => {
    const o = blastOpts;
    o.position.copy(p.pos);
    if (surface) o.position.addScaledVector(surface as THREE.Vector3, SURFACE_NUDGE);
    o.radius = p.splashRadius;
    o.damage = p.splashDamage;
    o.edgeFalloff = undefined;
    o.faction = p.faction;
    o.ownerId = p.ownerId;
    o.excludeId = excludeId;
    o.selfDamageMul = Number.isNaN(p.selfDamageMul) ? undefined : p.selfDamageMul;
    o.friendlyFire = p.friendlyFire;
    o.creditPlayer = p.creditPlayer;
    o.type = p.type;
    o.weapon = p.weapon;
    o.knockback = Number.isNaN(p.blastKnockback) ? undefined : p.blastKnockback;
    o.lineOfSight = true;
    o.visual = p.visual;
    explosions.enqueue(o, surface ?? undefined, surface ? boxId : -1, p.visual === 'plasma' ? p.accent : 0);
  };

  /** The mark a shell without splash leaves on the world. */
  const worldImpact = (p: Projectile, at: Vec3Like, n: THREE.Vector3, boxId: number, surface: SurfaceType): void => {
    const look = IMPACT_LOOKS[p.kind];
    // An energy surface (a gate) answers with its own shimmer whatever struck it.
    const flavoured = look.fx !== null && surface !== 'energy';
    const o = clearFxOptions(fxOpts);
    o.normal.copy(n);
    o.dir.copy(n);
    o.scale = look.fxScale;
    if (flavoured) o.color = p.accent;
    ctx.fx.spawn(flavoured && look.fx ? look.fx : SURFACE_FX[surface], at, o);

    soundOpts.volume = look.volume;
    soundOpts.pitch = look.pitch;
    soundOpts.delay = 0;
    soundOpts.priority = 1;
    soundOpts.owner = 0;
    ctx.audio.playAt(flavoured && look.sound ? look.sound : SURFACE_SOUND[surface], at, soundOpts);

    ctx.fx.decal(look.decal, at, n, look.decalSize, boxId);
    if (look.lightIntensity > 0) {
      point.copy(at as THREE.Vector3).addScaledVector(n, 0.25);
      ctx.fx.lightFlash(point, p.accent, look.lightIntensity, look.lightRadius, look.lightSeconds);
    }
  };

  /** The shell reached a hostile target (`shot` holds the contact): direct hit, then its blast. */
  const strikeTarget = (p: Projectile): void => {
    const struck = shot.target;
    if (!struck) return;
    const struckId = struck.id;
    if (p.damage > 0) {
      clearDamageInfo(info);
      info.amount = p.damage;
      info.type = p.type;
      info.faction = p.faction;
      info.sourceId = p.ownerId;
      info.weapon = p.weapon;
      info.part = shot.part;
      info.sphereIndex = shot.sphereIndex;
      info.critScale = p.critScale;
      info.knockback = p.knockback;
      info.creditPlayer = p.creditPlayer;
      info.point.copy(shot.point);
      info.dir.copy(p.dir);
      applyDamage(struck, info);
      // The victim's death may have cleared the field (a boss going down takes enemy fire with it).
      if (!p.alive) return;
    }
    // The struck target already took its direct hit: it is excluded from the splash (no double dip).
    // A shell without direct damage (a grenade) has nothing to double: its blast is all the target gets.
    if (p.splashRadius > 0) queueBlast(p, p.damage > 0 ? struckId : 0, null, -1);
    remove(p);
  };

  /** The shell reached world geometry and does not bounce. */
  const strikeWorld = (p: Projectile, n: THREE.Vector3, boxId: number, surface: SurfaceType): void => {
    if (p.splashRadius > 0) queueBlast(p, 0, n, boxId);
    else worldImpact(p, p.pos, n, boxId, surface);
    remove(p);
  };

  /** Hostile fire destroys a shootable projectile in flight: a small harmless burst, no blast of its own. */
  const shootDown = (p: Projectile, damage: DamageInfo): DamageResult => {
    clearDamageResult(shootResult, 'body');
    if (!p.alive) return shootResult;
    const hostile = damage.faction === 'neutral' || damage.faction !== p.faction;
    if (!hostile || !(damage.amount > 0)) return shootResult;
    shootResult.dealt = shootResult.healthDamage = damage.amount;
    shootResult.killed = true;
    if (!damage.silent) {
      const o = blastOpts;
      o.position.copy(p.pos);
      o.radius = SHOOTDOWN.radius;
      o.damage = 0;
      o.knockback = 0;
      o.edgeFalloff = undefined;
      o.faction = p.faction;
      o.ownerId = 0;
      o.excludeId = 0;
      o.selfDamageMul = undefined;
      o.friendlyFire = false;
      o.creditPlayer = false;
      o.type = undefined;
      o.weapon = null;
      o.lineOfSight = false;
      o.visual = 'small';
      explosions.enqueue(o);
    }
    remove(p);
    return shootResult;
  };

  // --- flight ------------------------------------------------------------------------------------------
  // The helpers below run for every projectile in every substep: scalar maths on plain fields, their
  // numbers handed over through `s` and the registry's `io` (see S_*), integer ray lengths.

  /** Turn the velocity toward the homing target by at most `homing * s[S_TIME]` radians at constant speed. */
  const steer = (p: Projectile): void => {
    const target = p.targetId !== 0 ? registry.get(p.targetId) : undefined;
    if (!target || !target.alive) return;
    const c = target.center;
    let wx = c.x - p.pos.x;
    let wy = c.y - p.pos.y;
    let wz = c.z - p.pos.z;
    const range = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!(range > 1e-4)) return;
    wx /= range;
    wy /= range;
    wz /= range;
    const v = p.vel;
    const d = p.dir;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (speed > 1e-6) {
      d.x = v.x / speed;
      d.y = v.y / speed;
      d.z = v.z / speed;
    }
    const cos = d.x * wx + d.y * wy + d.z * wz;
    const angle = Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos);
    const turn = p.homing * (s[S_TIME] as number);
    if (angle <= turn || angle < 1e-5) {
      d.x = wx;
      d.y = wy;
      d.z = wz;
    } else {
      // Rotation axis = dir x want; dead astern any perpendicular will do to start the turn.
      let ax = d.y * wz - d.z * wy;
      let ay = d.z * wx - d.x * wz;
      let az = d.x * wy - d.y * wx;
      let len = Math.sqrt(ax * ax + ay * ay + az * az);
      if (len < 1e-6) {
        if (Math.abs(d.y) < 0.9) {
          ax = -d.z;
          ay = 0;
          az = d.x;
        } else {
          ax = 0;
          ay = d.z;
          az = -d.y;
        }
        len = Math.sqrt(ax * ax + ay * ay + az * az);
      }
      ax /= len;
      ay /= len;
      az /= len;
      // Rodrigues with the axis perpendicular to dir: dir' = dir cos(turn) + (axis x dir) sin(turn).
      const cosT = Math.cos(turn);
      const sinT = Math.sin(turn);
      const nx = d.x * cosT + (ay * d.z - az * d.y) * sinT;
      const ny = d.y * cosT + (az * d.x - ax * d.z) * sinT;
      const nz = d.z * cosT + (ax * d.y - ay * d.x) * sinT;
      const norm = Math.sqrt(nx * nx + ny * ny + nz * nz);
      d.x = nx / norm;
      d.y = ny / norm;
      d.z = nz / norm;
    }
    v.x = d.x * p.speed;
    v.y = d.y * p.speed;
    v.z = d.z * p.speed;
  };

  /**
   * 'bulletWhiz': an enemy shell passes its closest point to the eye, within reach, on the stretch of
   * s[S_TRAVEL] metres along `seg` that it is about to fly without hitting anything.
   */
  const trackWhiz = (p: Projectile): void => {
    if (p.whizzed || p.faction !== 'enemy' || p.bounce > 0) return;
    const player = ctx.player;
    if (!player.alive || ctx.game.mode !== 'playing') return;
    const eye = player.eye;
    const ex = eye.x - p.pos.x;
    const ey = eye.y - p.pos.y;
    const ez = eye.z - p.pos.z;
    const along = ex * seg.x + ey * seg.y + ez * seg.z;
    if (!(along > 0) || along > (s[S_TRAVEL] as number)) return;
    const miss2 = ex * ex + ey * ey + ez * ez - along * along;
    if (miss2 >= WHIZ.radius * WHIZ.radius) return;
    const speed = p.vel.length();
    if (speed < WHIZ.minSpeed) return;
    p.whizzed = true;
    point.set(p.pos.x + seg.x * along, p.pos.y + seg.y * along, p.pos.z + seg.z * along);
    soundOpts.volume = lerp(1, 0.45, Math.sqrt(Math.max(0, miss2)) / WHIZ.radius);
    soundOpts.pitch = clamp(speed / 32, 0.8, 1.3);
    soundOpts.delay = 0;
    soundOpts.priority = 1;
    soundOpts.owner = 0;
    ctx.audio.playAt('bulletWhiz', point, soundOpts);
  };

  const bounceFeedback = (p: Projectile, n: THREE.Vector3, impact: number): void => {
    if (impact < BOUNCE.feedbackSpeed || p.age - p.lastBounceAt < BOUNCE.feedbackInterval) return;
    p.lastBounceAt = p.age;
    point.copy(p.pos).addScaledVector(n, -p.radius);
    const o = clearFxOptions(fxOpts);
    o.normal.copy(n);
    o.dir.copy(n);
    o.scale = clamp(impact / 8, 0.5, 1.5);
    ctx.fx.spawn('grenadeBounce', point, o);
    soundOpts.volume = clamp(impact / 9, 0.3, 1);
    soundOpts.pitch = clamp(1.15 - impact * 0.02, 0.85, 1.15);
    soundOpts.delay = 0;
    soundOpts.priority = 1;
    soundOpts.owner = 0;
    ctx.audio.playAt('grenadeBounce', point, soundOpts);
  };

  /** Reflect off a surface with restitution and friction; a slow floor contact ends the hopping. */
  const bounceOff = (p: Projectile, n: THREE.Vector3): void => {
    const v = p.vel;
    const vn = v.dot(n);
    if (vn >= 0) return;
    const impact = -vn;
    // Tangential part keeps a share (friction), the normal part comes back scaled by the restitution.
    v.addScaledVector(n, -vn).multiplyScalar(BOUNCE.tangentKeep);
    const rebound = impact * p.bounce;
    bounceFeedback(p, n, impact);
    if (n.y > BOUNCE.floorNormalY && rebound < BOUNCE.settleSpeed) {
      v.y = 0;
      p.state = v.x * v.x + v.z * v.z > BOUNCE.restSpeed * BOUNCE.restSpeed ? ROLLING : RESTING;
      if (p.state === RESTING) v.set(0, 0, 0);
      return;
    }
    v.addScaledVector(n, rebound);
  };

  /** Ballistic flight over s[S_TIME] seconds, swept against the world and hostile targets. */
  const fly = (p: Projectile): void => {
    const collision = ctx.collision;
    const g = p.gravity;
    const v = p.vel;
    const pos = p.pos;
    let t = s[S_TIME] as number;
    for (let contact = 0; contact < MAX_CONTACTS_PER_STEP && t > 1e-7 && p.state === FLYING; contact++) {
      // The exact parabola over t, flown as one chord (a few millimetres off at 30 Hz).
      let dx = v.x * t;
      let dy = v.y * t - 0.5 * g * t * t;
      let dz = v.z * t;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(len > 1e-7)) {
        v.y -= g * t;
        break;
      }
      dx /= len;
      dy /= len;
      dz /= len;
      seg.x = dx;
      seg.y = dy;
      seg.z = dz;

      // World: a bouncing shell touches a surface one radius early, everything else is a point. The ray
      // is cast a whole number of metres long (an integer needs no boxing) and cut back to `len` here.
      const pad = p.bounce > 0 ? p.radius : 0;
      // "Never" is spelled as a numeric literal in this file: a fraction that shares a variable with the
      // global `Infinity` (or any constant the optimiser must load) gets boxed.
      let worldAt = 1e30;
      let boxId = -1;
      let surface: SurfaceType = 'metal';
      if (collision.raycast(pos, seg, (len + pad * 3 + 1) | 0, COL.PROJECTILE, rayHit)) {
        let at = rayHit.distance;
        if (pad > 0) {
          const n = rayHit.normal;
          const cos = -(dx * n.x + dy * n.y + dz * n.z);
          if (cos > 1e-4) at = Math.max(0, at - pad / cos);
        }
        if (at <= len) {
          worldAt = at;
          boxId = rayHit.boxId;
          surface = rayHit.surface;
          normal.copy(rayHit.normal);
        }
      }

      const reach = worldAt < len ? worldAt : len;
      io[IO_LIMIT] = reach;
      io[IO_PAD] = p.radius;
      if (registry.sweep(pos, seg, p.faction, p.ownerId, p.id, shot)) {
        const targetAt = io[IO_DISTANCE] as number;
        pos.x += dx * targetAt;
        pos.y += dy * targetAt;
        pos.z += dz * targetAt;
        p.travelled += targetAt;
        v.y -= g * t * (targetAt / len);
        p.dir.copy(seg);
        strikeTarget(p);
        return;
      }

      s[S_TRAVEL] = reach;
      trackWhiz(p);
      pos.x += dx * reach;
      pos.y += dy * reach;
      pos.z += dz * reach;
      p.travelled += reach;
      p.dir.copy(seg);
      if (worldAt <= len) {
        const used = t * (worldAt / len);
        v.y -= g * used;
        if (p.bounce > 0) {
          bounceOff(p, normal);
          t -= used;
          continue;
        }
        strikeWorld(p, normal, boxId, surface);
        return;
      }
      v.y -= g * t;
      t = 0;
    }
  };

  /** Rolling along a floor for s[S_TIME] seconds: friction, walls, ledges, and anything hostile in the way. */
  const roll = (p: Projectile): void => {
    const collision = ctx.collision;
    const time = s[S_TIME] as number;
    const v = p.vel;
    const speed = Math.sqrt(v.x * v.x + v.z * v.z);
    if (speed < BOUNCE.restSpeed) {
      v.set(0, 0, 0);
      p.state = RESTING;
      return;
    }
    // The floor ended (a ledge): it flies again.
    if (!collision.raycast(p.pos, DOWN, 1, COL.PROJECTILE, rayHit) || rayHit.distance > p.radius + 0.15) {
      p.state = FLYING;
      fly(p);
      return;
    }
    const next = Math.max(0, speed - BOUNCE.rollDecel * time);
    let travel = (speed + next) * 0.5 * time;
    seg.set(v.x / speed, 0, v.z / speed);
    let hitWall = false;
    if (collision.raycast(p.pos, seg, (travel + p.radius + 1) | 0, COL.PROJECTILE, rayHit)) {
      const cos = -(seg.x * rayHit.normal.x + seg.z * rayHit.normal.z);
      const at = cos > 1e-4 ? Math.max(0, rayHit.distance - p.radius / cos) : rayHit.distance;
      if (at <= travel) {
        travel = at;
        hitWall = true;
        normal.copy(rayHit.normal);
      }
    }
    io[IO_LIMIT] = travel;
    io[IO_PAD] = p.radius;
    if (registry.sweep(p.pos, seg, p.faction, p.ownerId, p.id, shot)) {
      p.pos.addScaledVector(seg, io[IO_DISTANCE] as number);
      p.dir.copy(seg);
      strikeTarget(p);
      return;
    }
    p.pos.addScaledVector(seg, travel);
    p.travelled += travel;
    p.dir.copy(seg);
    v.set(seg.x * next, 0, seg.z * next);
    if (hitWall) {
      const vn = v.dot(normal);
      if (vn < 0) {
        bounceFeedback(p, normal, -vn);
        v.addScaledVector(normal, -(1 + p.bounce) * vn);
        v.y = 0;
      }
    }
  };

  const outOfBounds = (p: Projectile): boolean => {
    const b = ctx.world.bounds;
    const q = p.pos;
    return (
      q.x < b.minX - BOUNDS_MARGIN.side ||
      q.x > b.maxX + BOUNDS_MARGIN.side ||
      q.z < b.minZ - BOUNDS_MARGIN.side ||
      q.z > b.maxZ + BOUNDS_MARGIN.side ||
      q.y < b.minY - BOUNDS_MARGIN.below ||
      q.y > b.maxY + BOUNDS_MARGIN.above
    );
  };

  /** One simulation step of one projectile on its own clock (s[S_DT_WORLD] / s[S_DT_PLAYER]). May remove it. */
  const step = (p: Projectile): void => {
    const dt = (p.playerClock ? s[S_DT_PLAYER] : s[S_DT_WORLD]) as number;
    if (!(dt > 0)) return;
    // The step ends exactly where a fuse or the lifetime does, whatever the frame rate.
    let time = dt;
    let ends = 0;
    const fuseLeft = p.fuse > 0 ? p.fuse - p.age : 1e30;
    const lifeLeft = p.lifetime - p.age;
    if (fuseLeft <= time && fuseLeft <= lifeLeft) {
      time = Math.max(0, fuseLeft);
      ends = 1;
    } else if (lifeLeft <= time) {
      time = Math.max(0, lifeLeft);
      ends = 2;
    }

    if (time > 0) {
      s[S_TIME] = time;
      if (p.state === FLYING) {
        if (p.homing > 0) steer(p);
        fly(p);
      } else if (p.state === ROLLING) {
        roll(p);
      } else {
        // Lying still: did something hostile walk into it?
        io[IO_LIMIT] = 1e-3;
        io[IO_PAD] = p.radius;
        if (registry.sweep(p.pos, UP, p.faction, p.ownerId, p.id, shot)) strikeTarget(p);
      }
      if (!p.alive) return;
      p.age += time;
    }
    const q = p.pos;
    const v = p.vel;
    if (!Number.isFinite(q.x + q.y + q.z + v.x + v.y + v.z)) {
      throw new Error(`projectile ${p.id} left the number line`);
    }
    if (ends === 1) {
      if (p.splashRadius > 0) queueBlast(p, 0, null, -1);
      remove(p);
    } else if (ends === 2 || outOfBounds(p)) {
      remove(p);
    }
  };

  // --- everything that follows a shell in flight -------------------------------------------------------

  const acquireLoop = (p: Projectile): void => {
    const id = p.def.loop;
    if (!id || p.loop.active) return;
    if (!ctx.audio.unlocked) return;
    loopOpts.position = p.drawPos;
    loopOpts.volume = 1;
    loopOpts.pitch = 1;
    loopOpts.fadeIn = 0.04;
    loopOpts.priority = p.faction === 'player' ? 2 : 1;
    loopOpts.owner = p.id;
    p.loop = ctx.audio.loop(id, loopOpts);
  };

  /** Refresh the drawn position and whatever is attached to it. Runs every substep, also with dt 0. */
  const attend = (p: Projectile): void => {
    // Blend from the visual origin onto the simulated path (smoothstep over the first moments of flight).
    const draw = p.drawPos;
    const pos = p.pos;
    if (p.age >= PROJECTILE_DEFAULTS.visualBlend) {
      draw.x = pos.x;
      draw.y = pos.y;
      draw.z = pos.z;
    } else {
      const k = p.age / PROJECTILE_DEFAULTS.visualBlend;
      const blend = 1 - k * k * (3 - 2 * k);
      const offset = p.visualOffset;
      draw.x = pos.x + offset.x * blend;
      draw.y = pos.y + offset.y * blend;
      draw.z = pos.z + offset.z * blend;
    }

    if (p.loop.active) {
      p.loop.setPosition(draw);
    } else if (p.def.loop && p.age >= p.loopRetryAt) {
      p.loopRetryAt = p.age + LOOP_RETRY;
      acquireLoop(p);
    }
    if (p.kind === 'mortar' && !p.whistled && p.state === FLYING && p.vel.y < 0) {
      p.whistled = true;
      soundOpts.volume = 1;
      soundOpts.pitch = 1;
      soundOpts.delay = 0;
      soundOpts.priority = 2;
      soundOpts.owner = p.id;
      ctx.audio.playAt('mortarWhistle', draw, soundOpts);
    }
    // A telegraph on the world clock runs by itself; one that belongs to a player-clock shell is driven.
    if (p.playerClock && p.flightTime > 0 && p.telegraph.active) p.telegraph.setProgress(clamp(p.age / p.flightTime, 0, 1));
    if (p.id === litId) {
      ctx.fx.lightFlash(draw, p.accent, ROCKET_LIGHT_INTENSITY, ROCKET_LIGHT_RADIUS, ROCKET_LIGHT_SECONDS, p.id);
    }
  };

  /**
   * Where and when the shell first meets the world on its ballistic path (homing ignored); the point is
   * dropped onto the floor below when it would strike a wall. Returns the flight time, or 0 for none.
   */
  const predictLanding = (p: Projectile): number => {
    const collision = ctx.collision;
    simPos.copy(p.pos);
    simVel.copy(p.vel);
    const g = p.gravity;
    const horizon = Math.min(PREDICT_SECONDS, p.lifetime, p.fuse > 0 ? p.fuse : 1e30);
    const floor = ctx.world.bounds.minY - BOUNDS_MARGIN.below;
    let t = 0;
    let found = false;
    let wall = false;
    while (t < horizon && simPos.y > floor) {
      const h = Math.min(PREDICT_STEP, horizon - t);
      let dx = simVel.x * h;
      let dy = simVel.y * h - 0.5 * g * h * h;
      let dz = simVel.z * h;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(len > 1e-7)) break;
      dx /= len;
      dy /= len;
      dz /= len;
      if (collision.raycast(simPos, seg.set(dx, dy, dz), len, COL.PROJECTILE, rayHit)) {
        landing.copy(rayHit.point);
        wall = rayHit.normal.y < BOUNCE.floorNormalY;
        if (wall) landing.addScaledVector(rayHit.normal, 0.3);
        t += h * (rayHit.distance / len);
        found = true;
        break;
      }
      simPos.set(simPos.x + dx * len, simPos.y + dy * len, simPos.z + dz * len);
      simVel.y -= g * h;
      t += h;
    }
    if (!found) {
      // A fuse that ends in the air: the burst happens above this point.
      if (!(p.fuse > 0) || t < horizon - 1e-6) return 0;
      landing.copy(simPos);
      wall = true;
    }
    if (wall) {
      const ground = collision.groundHeight(landing.x, landing.z, landing.y + 0.05, COL.PROJECTILE);
      if (Number.isFinite(ground)) landing.y = ground;
    }
    return t;
  };

  const system: ProjectileSystem = {
    live,
    get count(): number {
      return count;
    },
    spawn(opts: ProjectileOptions): number {
      const def = PROJECTILES[opts.kind] as ProjectileDef | undefined;
      if (!def) {
        reportInvalid(`unknown projectile kind "${String(opts.kind)}"`);
        return 0;
      }
      const { position, velocity } = opts;
      if (!Number.isFinite(position.x + position.y + position.z + velocity.x + velocity.y + velocity.z)) {
        reportInvalid(`${opts.kind}: non-finite position or velocity`);
        return 0;
      }
      if (!Number.isFinite(opts.damage)) {
        reportInvalid(`${opts.kind}: non-finite damage`);
        return 0;
      }
      // Full house: the oldest shell makes room, silently.
      if (count >= MAX_PROJECTILES) {
        for (let i = 0; i < live.length; i++) {
          const oldest = live[i] as Projectile;
          if (oldest.alive) {
            remove(oldest);
            break;
          }
        }
      }
      const p = free.pop() ?? create();
      const id = ctx.nextId();
      const finite = (value: number | undefined, fallback: number): number =>
        value !== undefined && Number.isFinite(value) ? value : fallback;

      p.alive = true;
      p.id = id;
      p.kind = opts.kind;
      p.def = def;
      p.faction = opts.faction;
      p.ownerId = opts.ownerId;
      p.damage = Math.max(0, opts.damage);
      p.type = opts.type ?? def.type;
      p.weapon = opts.weapon ?? null;
      p.splashRadius = Math.max(0, finite(opts.splashRadius, 0));
      p.splashDamage = Math.max(0, finite(opts.splashDamage, p.damage));
      p.selfDamageMul = finite(opts.selfDamageMul, NaN);
      p.friendlyFire = opts.friendlyFire ?? false;
      p.creditPlayer = opts.creditPlayer ?? false;
      p.gravity = finite(opts.gravity, 0);
      p.bounce = clamp(finite(opts.bounce, 0), 0, 1);
      p.fuse = Math.max(0, finite(opts.fuse, 0));
      p.homing = Math.max(0, finite(opts.homing, 0));
      p.targetId = opts.targetId ?? (opts.faction === 'enemy' ? ctx.player.targetId : 0);
      p.radius = Math.max(0, finite(opts.radius, def.radius));
      p.lifetime = Math.max(0, finite(opts.lifetime, PROJECTILE_DEFAULTS.lifetime));
      p.knockback = Math.max(0, finite(opts.knockback, 0));
      p.blastKnockback = finite(opts.knockback, NaN);
      p.critScale = finite(opts.critScale, 1);
      p.visual = opts.visual ?? def.visual;
      p.playerClock = (opts.clock ?? (opts.faction === 'player' ? 'player' : 'world')) === 'player';
      p.accent = projectileAccent(opts.kind, opts.faction);

      p.pos.set(position.x, position.y, position.z);
      p.vel.set(velocity.x, velocity.y, velocity.z);
      p.speed = p.vel.length();
      if (p.speed > 1e-6) p.dir.copy(p.vel).multiplyScalar(1 / p.speed);
      else p.dir.set(0, 0, -1);
      // A muzzle can poke through the wall its shooter is hugging. The shell never starts beyond that
      // wall: it is put back in front of it, where its first step strikes it.
      const shooter = opts.ownerId !== 0 ? registry.get(opts.ownerId) : undefined;
      if (shooter) {
        // From the shooter's axis at muzzle height (so firing over low cover stays possible).
        point.set(shooter.center.x, position.y, shooter.center.z);
        seg.set(position.x - point.x, 0, position.z - point.z);
        const out = seg.length();
        if (out > 0.05 && Number.isFinite(out)) {
          seg.multiplyScalar(1 / out);
          if (ctx.collision.raycast(point, seg, out, COL.PROJECTILE, rayHit)) {
            p.pos.copy(rayHit.point).addScaledVector(seg, -0.02);
          }
        }
      }
      const origin = opts.visualOrigin;
      if (origin && Number.isFinite(origin.x + origin.y + origin.z)) {
        p.visualOffset.set(origin.x - p.pos.x, origin.y - p.pos.y, origin.z - p.pos.z);
      } else {
        p.visualOffset.set(0, 0, 0);
      }
      p.drawPos.copy(p.pos).add(p.visualOffset);
      p.age = 0;
      p.travelled = 0;
      p.state = FLYING;
      p.seed = ctx.cosmeticRng.next();
      const spin = p.seed * Math.PI * 2;
      p.spinAxis.set(Math.cos(spin), 0.35, Math.sin(spin)).normalize();
      p.lastBounceAt = -1;
      p.whizzed = false;
      p.whistled = false;
      p.flightTime = 0;
      p.loopRetryAt = LOOP_RETRY;
      p.trail = NO_TRAIL;
      p.loop = NO_LOOP;
      p.telegraph = NO_TELEGRAPH;

      live.push(p);
      byId.set(id, p);
      count++;

      if (def.shootable) {
        p.sphere.radius = p.radius * SHOOTABLE_SPHERE_SCALE;
        p.target.id = id;
        p.target.faction = p.faction;
        p.target.boundRadius = p.sphere.radius;
        p.target.alive = true;
        registry.register(p.target);
      }
      // Trail and loop follow the DRAWN position, so they leave the muzzle with the shell.
      if (def.trail) p.trail = ctx.fx.attachTrail(def.trail, p.drawPos, p.accent, id);
      acquireLoop(p);
      const marker = finite(opts.landingTelegraph, 0);
      if (marker > 0) {
        p.flightTime = predictLanding(p);
        if (p.flightTime > 0) {
          const o = telegraphOpts;
          o.kind = 'mortar';
          (o.position as THREE.Vector3).copy(landing);
          o.radius = marker;
          o.seconds = p.playerClock ? 0 : p.flightTime;
          o.owner = id;
          p.telegraph = ctx.fx.telegraph(o);
        }
      }
      if (opts.kind === 'rocket' && p.faction === 'player') litId = id;
      return id;
    },

    remove(id: number, detonate: boolean): boolean {
      const p = byId.get(id);
      if (!p || !p.alive) return false;
      if (detonate && p.splashRadius > 0) queueBlast(p, 0, null, -1);
      remove(p);
      return true;
    },

    clear(faction?: Faction): void {
      const outer = iterating;
      iterating = true;
      for (let i = 0; i < live.length; i++) {
        const p = live[i] as Projectile;
        if (p.alive && (faction === undefined || p.faction === faction)) remove(p);
      }
      iterating = outer;
      if (!iterating) compact();
    },

    update(dt: number): void {
      s[S_DT_WORLD] = dt;
      s[S_DT_PLAYER] = ctx.time.playerDt;
      // Shells launched during this pass (by something that died in it) wait for the next substep.
      const n = live.length;
      iterating = true;
      try {
        for (let i = 0; i < n; i++) {
          const p = live[i] as Projectile;
          if (!p.alive) continue;
          try {
            step(p);
            if (p.alive) attend(p);
          } catch (error) {
            // One broken shell must not take the frame down: report it, drop it, carry on.
            ctx.game.reportError(`projectile:${p.kind}`, error);
            remove(p);
          }
        }
      } finally {
        iterating = false;
        compact();
      }
    },
  };
  return system;
}
