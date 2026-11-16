/**
 * Explosions: a FIFO queue of blast requests, resolved from combat.update only — radial damage with
 * falloff measured to the bounding sphere, cover test, faction rules — and the whole audiovisual package
 * of each blast (fx recipe sized to the radius, ground ring, scorch, sound, light, shake, rumble, and the
 * close-range treatment).
 */
import * as THREE from 'three';
import { COL } from '../core/constants';
import { clearDamageInfo, clearFxOptions, makeDamageInfo, makeFxOptions, makeRayHit, makeSoundOptions } from '../core/make';
import { clamp, clamp01 } from '../core/math';
import type {
  DamageInfo,
  DamageResult,
  DamageSource,
  DamageType,
  ExplosionOptions,
  ExplosionVisual,
  Faction,
  GameContext,
  HitTarget,
  Vec3Like,
} from '../core/types';
import type { TargetRegistry } from './targets';
import { BLAST_DEFAULTS, BLAST_FEEL, BLAST_LOOKS, MAX_BLASTS_PER_UPDATE, factionAccent } from './tuning';
import type { BlastLook } from './tuning';

/** A queued blast: ExplosionOptions with every default filled in, plus what combat itself knows about it. */
interface Blast {
  readonly position: THREE.Vector3;
  radius: number;
  damage: number;
  edgeFalloff: number;
  faction: Faction;
  ownerId: number;
  excludeId: number;
  selfDamageMul: number;
  friendlyFire: boolean;
  creditPlayer: boolean;
  type: DamageType;
  weapon: DamageSource | null;
  knockback: number;
  lineOfSight: boolean;
  visual: ExplosionVisual;
  /** The surface a projectile burst on (boxId -1 = unknown: probe for the nearest one). */
  readonly surfaceNormal: THREE.Vector3;
  surfaceBoxId: number;
  /** Accent override for light and fx tint (0 = none). */
  tint: number;
}

export interface ExplosionQueue {
  /**
   * Queue a blast (everything is copied). `surfaceNormal` + `surfaceBoxId` name the world surface a
   * projectile burst on, `tint` overrides the accent of the look. Invalid requests are refused: false.
   */
  enqueue(opts: ExplosionOptions, surfaceNormal?: Vec3Like, surfaceBoxId?: number, tint?: number): boolean;
  /** Resolve queued blasts in FIFO order, including ones queued meanwhile, up to the cap; returns how many. */
  resolve(): number;
  /** Forget every queued blast. */
  clear(): void;
}

const UP: Vec3Like = { x: 0, y: 1, z: 0 };
const DOWN: Vec3Like = { x: 0, y: -1, z: 0 };
/** Directions probed for the nearest surface of an airborne blast (after straight down). */
const PROBES: readonly Vec3Like[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
];
const INITIAL_CAPACITY = 64;

function makeBlast(): Blast {
  return {
    position: new THREE.Vector3(),
    radius: 0,
    damage: 0,
    edgeFalloff: BLAST_DEFAULTS.edgeFalloff,
    faction: 'neutral',
    ownerId: 0,
    excludeId: 0,
    selfDamageMul: BLAST_DEFAULTS.selfDamageMul,
    friendlyFire: false,
    creditPlayer: false,
    type: 'explosion',
    weapon: null,
    knockback: BLAST_DEFAULTS.knockback,
    lineOfSight: true,
    visual: 'small',
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    surfaceBoxId: -1,
    tint: 0,
  };
}

function copyBlast(to: Blast, from: Blast): Blast {
  to.position.copy(from.position);
  to.radius = from.radius;
  to.damage = from.damage;
  to.edgeFalloff = from.edgeFalloff;
  to.faction = from.faction;
  to.ownerId = from.ownerId;
  to.excludeId = from.excludeId;
  to.selfDamageMul = from.selfDamageMul;
  to.friendlyFire = from.friendlyFire;
  to.creditPlayer = from.creditPlayer;
  to.type = from.type;
  to.weapon = from.weapon;
  to.knockback = from.knockback;
  to.lineOfSight = from.lineOfSight;
  to.visual = from.visual;
  to.surfaceNormal.copy(from.surfaceNormal);
  to.surfaceBoxId = from.surfaceBoxId;
  to.tint = from.tint;
  return to;
}

/**
 * @param applyDamage combat's one damage entry point (so splash hits are routed and recorded like any other)
 */
export function createExplosionQueue(
  ctx: GameContext,
  registry: TargetRegistry,
  applyDamage: (target: HitTarget, info: DamageInfo) => DamageResult,
): ExplosionQueue {
  /** Ring buffer: `count` blasts starting at `head`. */
  let ring: Blast[] = [];
  for (let i = 0; i < INITIAL_CAPACITY; i++) ring.push(makeBlast());
  let head = 0;
  let count = 0;

  /** The blast being resolved (a copy: its ring slot may be reused by a chain reaction meanwhile). */
  const current = makeBlast();
  const victims: HitTarget[] = [];
  const victimScale: number[] = [];
  const info = makeDamageInfo();
  const rayHit = makeRayHit();
  const fxOpts = makeFxOptions();
  const soundOpts = makeSoundOptions();
  const sightOrigin = new THREE.Vector3();
  const sample = new THREE.Vector3();
  const surfacePoint = new THREE.Vector3();
  const surfaceNormal = new THREE.Vector3();
  const lightPoint = new THREE.Vector3();
  const probeFrom = new THREE.Vector3();
  const probeDir = new THREE.Vector3();

  const grow = (): void => {
    const next: Blast[] = [];
    for (let i = 0; i < count; i++) next.push(ring[(head + i) % ring.length] as Blast);
    for (let i = count; i < ring.length * 2; i++) next.push(makeBlast());
    ring = next;
    head = 0;
  };

  /**
   * How much of the blast one target takes by faction: 0 = none, 1 = all, in between = the self-damage
   * share of the player caught in his own blast.
   */
  const share = (b: Blast, target: HitTarget): number => {
    // An enemy instigator never damages itself, whatever faction its blast was filed under.
    if (target.id === b.ownerId && target.faction !== 'player') return 0;
    if (b.faction === 'neutral' || target.faction !== b.faction) return 1;
    if (b.faction === 'player') return b.selfDamageMul;
    // An enemy blast among enemies: only with friendly fire.
    return b.friendlyFire ? 1 : 0;
  };

  /** Is any part of the target exposed to the blast (not behind solid cover)? */
  const exposed = (b: Blast, target: HitTarget): boolean => {
    const collision = ctx.collision;
    const c = target.center;
    if (collision.lineOfSight(b.position, c, COL.PROJECTILE)) return true;
    if (collision.lineOfSight(sightOrigin, c, COL.PROJECTILE)) return true;
    sample.set(c.x, c.y + target.boundRadius * 0.6, c.z);
    return collision.lineOfSight(sightOrigin, sample, COL.PROJECTILE);
  };

  const dealDamage = (b: Blast): void => {
    // A blast without damage and without push is presentation only (a projectile that was shot down).
    if (b.damage <= 0 && b.knockback <= 0) return;
    const list = registry.list;
    const p = b.position;
    // Snapshot first: a victim that dies unregisters itself (and may queue the next blast) mid-loop.
    victims.length = 0;
    victimScale.length = 0;
    for (let i = 0; i < list.length; i++) {
      const target = list[i] as HitTarget;
      if (!target.alive || target.id === b.excludeId) continue;
      const scale = share(b, target);
      if (scale <= 0) continue;
      const reach = b.radius + target.boundRadius;
      const dx = target.center.x - p.x;
      const dy = target.center.y - p.y;
      const dz = target.center.z - p.z;
      if (!(dx * dx + dy * dy + dz * dz <= reach * reach)) continue;
      victims.push(target);
      victimScale.push(scale);
    }
    if (victims.length === 0) return;

    if (b.lineOfSight) {
      // Lift the origin a little (headroom permitting) so a kerb next to a shell on the floor is no cover.
      const up = ctx.collision.raycast(p, UP, BLAST_FEEL.sightLift + 0.05, COL.PROJECTILE, rayHit)
        ? Math.max(0, rayHit.distance - 0.05)
        : BLAST_FEEL.sightLift;
      sightOrigin.set(p.x, p.y + up, p.z);
    }

    for (let i = 0; i < victims.length; i++) {
      const target = victims[i] as HitTarget;
      // Killed or removed by an earlier victim of this same blast.
      if (!target.alive || !registry.has(target)) continue;
      if (b.lineOfSight && !exposed(b, target)) continue;
      const c = target.center;
      let dx = c.x - p.x;
      let dy = c.y - p.y;
      let dz = c.z - p.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 1e-5) {
        dx /= dist;
        dy /= dist;
        dz /= dist;
      } else {
        dx = 0;
        dy = 1;
        dz = 0;
      }
      // Falloff is measured to the bounding sphere, so big targets are not short-changed.
      const d = Math.max(0, dist - target.boundRadius);
      const k = 1 - (1 - b.edgeFalloff) * clamp01(d / b.radius);
      const amount = b.damage * k * (victimScale[i] as number);
      const knockback = b.knockback * k;
      if (amount <= 0 && knockback <= 0) continue;
      clearDamageInfo(info);
      info.amount = amount;
      info.type = b.type;
      info.faction = b.faction;
      info.sourceId = b.ownerId;
      info.weapon = b.weapon;
      info.splash = true;
      info.creditPlayer = b.creditPlayer;
      info.knockback = knockback;
      info.dir.set(dx, dy, dz);
      // The side of the victim that faces the blast.
      const inset = Math.min(target.boundRadius * 0.5, dist);
      info.point.set(c.x - dx * inset, c.y - dy * inset, c.z - dz * inset);
      applyDamage(target, info);
    }
    victims.length = 0;
  };

  /** Nearest world surface within `reach` of the blast into surfacePoint / surfaceNormal; returns its box or -1. */
  const findSurface = (b: Blast, reach: number): number => {
    const collision = ctx.collision;
    const p = b.position;
    if (b.surfaceBoxId >= 0) {
      surfaceNormal.copy(b.surfaceNormal);
      // The blast sits a hair off the surface it burst on.
      probeDir.copy(surfaceNormal).negate();
      if (collision.raycast(p, probeDir, 0.5, COL.PROJECTILE, rayHit)) surfacePoint.copy(rayHit.point);
      else surfacePoint.copy(p);
      return b.surfaceBoxId;
    }
    probeFrom.set(p.x, p.y + 0.05, p.z);
    if (collision.raycast(probeFrom, DOWN, reach + 0.05, COL.PROJECTILE, rayHit)) {
      surfacePoint.copy(rayHit.point);
      surfaceNormal.copy(rayHit.normal);
      return rayHit.boxId;
    }
    let best = -1;
    let bestDist = reach;
    for (let i = 0; i < PROBES.length; i++) {
      if (!collision.raycast(p, PROBES[i] as Vec3Like, bestDist, COL.PROJECTILE, rayHit)) continue;
      bestDist = rayHit.distance;
      best = rayHit.boxId;
      surfacePoint.copy(rayHit.point);
      surfaceNormal.copy(rayHit.normal);
    }
    return best;
  };

  /** Blasts already presented in this resolve() call: a chain rings out as a ripple, not one clipped thud. */
  let presented = 0;

  const present = (b: Blast): void => {
    if (b.visual === 'none') return;
    const look: BlastLook = BLAST_LOOKS[b.visual];
    const { fx, audio, player } = ctx;
    const p = b.position;
    const accent = b.tint !== 0 ? b.tint : factionAccent(b.faction);

    // --- surface: scorch, and the ground ring when the floor is close ------------------------------
    const reach = Math.min(b.radius * BLAST_FEEL.groundReachScale, BLAST_FEEL.groundReachMax);
    const boxId = findSurface(b, reach);
    const onSurface = boxId >= 0;
    const o = clearFxOptions(fxOpts);
    o.radius = b.radius;
    if (onSurface) {
      o.normal.copy(surfaceNormal);
      o.dir.copy(surfaceNormal);
    }
    if (b.tint !== 0) o.color = b.tint;
    fx.spawn(look.fx, p, o);

    // The recipe draws its own ring where it bursts. A burst in the air whose blast still reaches the
    // floor gets the ground ring on top: that is where the damage arrives down there.
    if (look.ring && !(onSurface && surfaceNormal.y > 0.7)) {
      probeFrom.set(p.x, p.y + 0.05, p.z);
      const drop = b.radius * BLAST_FEEL.ringMaxHeight;
      if (
        ctx.collision.raycast(probeFrom, DOWN, drop + 0.05, COL.PROJECTILE, rayHit) &&
        rayHit.distance - 0.05 >= b.radius * BLAST_FEEL.ringMinHeight
      ) {
        const ring = clearFxOptions(fxOpts);
        ring.radius = b.radius;
        if (b.tint !== 0) ring.color = b.tint;
        fx.spawn('shockwaveRing', rayHit.point, ring);
      }
    }
    if (onSurface) {
      const size = clamp(b.radius * look.decalScale, BLAST_FEEL.decalMin, BLAST_FEEL.decalMax);
      fx.decal(look.decal, surfacePoint, surfaceNormal, size, boxId);
    }

    // --- light: out of the surface, so it lights the room and not the inside of the floor ------------
    lightPoint.copy(p);
    if (onSurface) lightPoint.addScaledVector(surfaceNormal, Math.min(0.6, b.radius * 0.15));
    fx.lightFlash(
      lightPoint,
      look.lightColor !== 0 ? look.lightColor : accent,
      look.lightIntensity,
      clamp(b.radius * look.lightReach, 4, 30),
      look.lightSeconds,
    );

    // --- sound: the distant variant far from the listener, arriving at the speed of sound ------------
    const listener = ctx.camera.position;
    const heardFrom = listener.distanceTo(p);
    const distant = heardFrom > BLAST_FEEL.distantFrom;
    soundOpts.volume = Math.max(0.5, 1 - 0.08 * presented);
    soundOpts.pitch = 1;
    soundOpts.owner = 0;
    soundOpts.priority = distant ? 1 : look.priority;
    soundOpts.delay = presented * 0.035 + (distant ? Math.min(0.6, heardFrom / 343) : 0);
    audio.playAt(distant ? 'explosionDistant' : look.sound, p, soundOpts);
    presented++;

    // --- body: shake and rumble through the player ---------------------------------------------------
    player.addShakeAt(p, look.trauma, Math.max(b.radius * look.shakeReach, BLAST_FEEL.minShakeReach));
    const playing = ctx.game.mode === 'playing' && player.alive;
    if (playing) {
      const felt = player.eye.distanceTo(p);
      if (felt < BLAST_FEEL.rumbleRange) {
        ctx.input.rumble(look.rumble * (1 - felt / BLAST_FEEL.rumbleRange), look.rumbleSeconds);
      }
    }

    // --- close to the viewer: chromatic kick, screen flash, a beat of hit-stop -----------------------
    const closeness = clamp01(1 - heardFrom / (b.radius * BLAST_FEEL.closeScale + BLAST_FEEL.closeBase));
    if (closeness <= 0) return;
    const post = ctx.render.post;
    post.chromaticBoost = Math.max(post.chromaticBoost, closeness * look.chroma);
    if (closeness > BLAST_FEEL.flashFrom && ctx.collision.lineOfSight(lightPoint, listener, COL.SIGHT)) {
      ctx.render.screenFlash(look.flashColor, closeness * look.flash);
    }
    if (look.hitstop > 0 && playing && closeness > BLAST_FEEL.hitstopFrom) ctx.time.hitstop(look.hitstop * closeness);
  };

  return {
    enqueue(opts: ExplosionOptions, normal?: Vec3Like, boxId = -1, tint = 0): boolean {
      const { x, y, z } = opts.position;
      const radius = opts.radius;
      const damage = opts.damage;
      const valid = Number.isFinite(x + y + z) && radius > 0 && Number.isFinite(radius) && damage >= 0 && Number.isFinite(damage);
      if (!valid) return false;
      if (count === ring.length) grow();
      const b = ring[(head + count) % ring.length] as Blast;
      count++;
      b.position.set(x, y, z);
      b.radius = radius;
      b.damage = damage;
      const edge = opts.edgeFalloff ?? BLAST_DEFAULTS.edgeFalloff;
      b.edgeFalloff = Number.isFinite(edge) ? clamp01(edge) : BLAST_DEFAULTS.edgeFalloff;
      b.faction = opts.faction;
      b.ownerId = opts.ownerId ?? 0;
      b.excludeId = opts.excludeId ?? 0;
      const self = opts.selfDamageMul ?? BLAST_DEFAULTS.selfDamageMul;
      b.selfDamageMul = self > 0 && Number.isFinite(self) ? self : 0;
      b.friendlyFire = opts.friendlyFire ?? false;
      b.creditPlayer = opts.creditPlayer ?? false;
      b.type = opts.type ?? 'explosion';
      b.weapon = opts.weapon ?? null;
      const knockback = opts.knockback ?? BLAST_DEFAULTS.knockback;
      b.knockback = knockback >= 0 && Number.isFinite(knockback) ? knockback : 0;
      b.lineOfSight = opts.lineOfSight ?? true;
      b.visual = opts.visual ?? (radius < BLAST_DEFAULTS.largeFromRadius ? 'small' : 'large');
      if (normal && boxId >= 0) {
        b.surfaceNormal.set(normal.x, normal.y, normal.z);
        b.surfaceBoxId = boxId;
      } else {
        b.surfaceNormal.set(0, 1, 0);
        b.surfaceBoxId = -1;
      }
      b.tint = tint;
      return true;
    },

    resolve(): number {
      let resolved = 0;
      presented = 0;
      while (resolved < MAX_BLASTS_PER_UPDATE && count > 0) {
        // Out of the queue BEFORE it resolves: whatever happens inside, this blast never comes back.
        const b = copyBlast(current, ring[head] as Blast);
        head = (head + 1) % ring.length;
        count--;
        resolved++;
        present(b);
        dealDamage(b);
      }
      return resolved;
    },

    clear(): void {
      head = 0;
      count = 0;
      // Also ends the damage loop of a blast that is being resolved right now.
      victims.length = 0;
    },
  };
}
