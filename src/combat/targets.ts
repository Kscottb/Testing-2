/**
 * Hit-target registry and the ray queries against it: nearest hit, piercing trace, swept sphere
 * (thick ray) and radius query. Pure geometry: nothing here applies damage or plays feedback.
 *
 * No query allocates — not even a boxed number: an optimised call that is not inlined boxes every
 * fractional argument and return value, so the inner helpers exchange their numbers through one
 * Float64Array instead of parameters, and vectors are written field by field.
 */
import { COL } from '../core/constants';
import { makeRayHit } from '../core/make';
import type {
  CollisionWorld,
  Faction,
  HitSphere,
  HitTarget,
  PierceResult,
  ShotHit,
  TraceOptions,
  Vec3Like,
} from '../core/types';

/**
 * Distance along a ray at which it enters a sphere, or -1 when it misses or enters beyond `limit`.
 * `(dx, dy, dz)` must be unit length. A ray that starts inside the sphere enters at 0.
 * (The reference formula; the registry's loops carry their own inlined copy.)
 */
export function raySphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  limit: number,
): number {
  const mx = cx - ox;
  const my = cy - oy;
  const mz = cz - oz;
  const along = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c <= 0) return 0;
  // Outside the sphere and heading away from it.
  if (along < 0) return -1;
  const disc = along * along - c;
  if (!(disc >= 0)) return -1;
  const t = along - Math.sqrt(disc);
  return t <= limit ? t : -1;
}

/** Slots of TargetRegistry.io. */
export const IO_LIMIT = 0;
export const IO_PAD = 1;
export const IO_DISTANCE = 2;

export interface TargetRegistry {
  /** Registered targets in registration order (alive or not). Never mutate. */
  readonly list: readonly HitTarget[];
  register(target: HitTarget): void;
  /** Returns whether the id was registered. */
  unregister(id: number): boolean;
  get(id: number): HitTarget | undefined;
  /** True when exactly this object is the registered entry of its id. */
  has(target: HitTarget): boolean;
  clear(): void;
  /**
   * Re-measure the broad-phase radius of every target from its spheres as they are now. A trace never
   * trusts HitTarget.boundRadius alone: a weak point that pokes out of a bound that was set too small
   * must stay hittable.
   */
  refresh(): void;

  /** Number exchange of sweep(): write io[IO_LIMIT] and io[IO_PAD] before, read io[IO_DISTANCE] after. */
  readonly io: Float64Array;
  /**
   * Nearest hostile target sphere entered by the ray within io[IO_LIMIT], the ray thickened by
   * io[IO_PAD] for the target tests. On a hit fills `out` (kind 'target'), stores the distance in
   * io[IO_DISTANCE] and returns true; otherwise leaves `out` untouched. `faction` / `ignoreId` as in
   * TraceOptions; `selfId` is a second id to pass (the hit target of a shootable projectile itself).
   */
  sweep(origin: Vec3Like, dir: Vec3Like, faction: Faction, ignoreId: number, selfId: number, out: ShotHit): boolean;
  traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: ShotHit): boolean;
  tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: PierceResult): number;
  queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number;
}

/** `collision` is read lazily: the world fills it after the systems were constructed. */
export function createTargetRegistry(collision: () => CollisionWorld): TargetRegistry {
  const list: HitTarget[] = [];
  /** Broad-phase radius per entry of `list`. */
  const reach: number[] = [];
  const byId = new Map<number, HitTarget>();
  const rayHit = makeRayHit();
  const io = new Float64Array(3);
  /** Sphere index found by the last nearestOf() call. */
  let foundIndex = -1;

  /**
   * Measure reach[index]: the radius around the target's centre that encloses every sphere, never less
   * than the owner's boundRadius. (Written in place: a returned fraction would be boxed.)
   */
  const measure = (index: number): void => {
    const target = list[index] as HitTarget;
    let r = target.boundRadius;
    const c = target.center;
    const spheres = target.spheres;
    for (let i = 0; i < spheres.length; i++) {
      const sphere = spheres[i] as HitSphere;
      const sc = sphere.center;
      const dx = sc.x - c.x;
      const dy = sc.y - c.y;
      const dz = sc.z - c.z;
      const far = Math.sqrt(dx * dx + dy * dy + dz * dz) + sphere.radius;
      if (far > r) r = far;
    }
    // A target whose spheres are not posed yet (or broken) is never culled by the broad phase.
    // (A numeric literal on purpose: a fraction that shares a variable with the global `Infinity`, or
    // with any constant the optimiser has to load, gets boxed.)
    if (!(r >= 0) || r > 1e12) r = 1e12;
    reach[index] = r;
  };

  /**
   * Entry of the ray into the nearest enabled sphere of list[index] within io[IO_LIMIT]: true when
   * there is one, with its distance in io[IO_DISTANCE] and its index in foundIndex.
   */
  const nearestOf = (index: number, origin: Vec3Like, dir: Vec3Like): boolean => {
    const target = list[index] as HitTarget;
    const limit = io[IO_LIMIT] as number;
    const pad = io[IO_PAD] as number;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;

    // Broad phase: the sphere that encloses the whole target.
    const c = target.center;
    const bound = (reach[index] as number) + pad;
    let mx = c.x - ox;
    let my = c.y - oy;
    let mz = c.z - oz;
    let along = mx * dx + my * dy + mz * dz;
    let outside = mx * mx + my * my + mz * mz - bound * bound;
    if (outside > 0) {
      if (along < 0) return false;
      const disc = along * along - outside;
      if (!(disc >= 0) || along - Math.sqrt(disc) > limit) return false;
    }

    const spheres = target.spheres;
    let best = -1;
    let bestIndex = -1;
    let bestLimit = limit;
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i] as HitSphere;
      if (!s.enabled) continue;
      const sc = s.center;
      const r = s.radius + pad;
      mx = sc.x - ox;
      my = sc.y - oy;
      mz = sc.z - oz;
      along = mx * dx + my * dy + mz * dz;
      outside = mx * mx + my * my + mz * mz - r * r;
      let t = 0;
      if (outside > 0) {
        if (along < 0) continue;
        const disc = along * along - outside;
        if (!(disc >= 0)) continue;
        t = along - Math.sqrt(disc);
        if (t > bestLimit) continue;
      }
      // Strictly nearer only: of two spheres entered at the same distance the first one listed wins.
      if (bestIndex >= 0 && t >= best) continue;
      best = t;
      bestLimit = t;
      bestIndex = i;
    }
    if (bestIndex < 0) return false;
    io[IO_DISTANCE] = best;
    foundIndex = bestIndex;
    return true;
  };

  const isHostile = (target: HitTarget, faction: Faction, ignoreId: number): boolean =>
    target.alive && target.id !== ignoreId && (faction === 'neutral' || target.faction !== faction);

  /** Write a target hit at io[IO_DISTANCE] on sphere `sphereIndex` into `out`. */
  const fillTargetHit = (out: ShotHit, target: HitTarget, sphereIndex: number, origin: Vec3Like, dir: Vec3Like): void => {
    const t = io[IO_DISTANCE] as number;
    const pad = io[IO_PAD] as number;
    const sphere = target.spheres[sphereIndex] as HitSphere;
    const c = sphere.center;
    // Where the ray is when it touches the (possibly thickened) sphere.
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    let nx = px - c.x;
    let ny = py - c.y;
    let nz = pz - c.z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-6) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = -dir.x;
      ny = -dir.y;
      nz = -dir.z;
    }
    out.kind = 'target';
    out.distance = t;
    out.target = target;
    out.part = sphere.part;
    out.sphereIndex = sphereIndex;
    out.surface = 'metal';
    out.boxId = -1;
    const normal = out.normal;
    normal.x = nx;
    normal.y = ny;
    normal.z = nz;
    const point = out.point;
    if (pad > 0 && len > sphere.radius) {
      // A thick ray touches the real surface at the point nearest to its axis: that is where the hit is.
      point.x = c.x + nx * sphere.radius;
      point.y = c.y + ny * sphere.radius;
      point.z = c.z + nz * sphere.radius;
    } else {
      point.x = px;
      point.y = py;
      point.z = pz;
    }
  };

  const sweep = (origin: Vec3Like, dir: Vec3Like, faction: Faction, ignoreId: number, selfId: number, out: ShotHit): boolean => {
    let bestTarget: HitTarget | null = null;
    let bestIndex = -1;
    for (let i = 0; i < list.length; i++) {
      const target = list[i] as HitTarget;
      if (target.id === selfId || !isHostile(target, faction, ignoreId)) continue;
      if (!nearestOf(i, origin, dir)) continue;
      const t = io[IO_DISTANCE] as number;
      // Of two targets entered at the same distance the one registered first wins.
      if (bestTarget && t >= (io[IO_LIMIT] as number)) continue;
      bestTarget = target;
      bestIndex = foundIndex;
      io[IO_LIMIT] = t;
    }
    if (!bestTarget) return false;
    io[IO_DISTANCE] = io[IO_LIMIT] as number;
    fillTargetHit(out, bestTarget, bestIndex, origin, dir);
    return true;
  };

  /** A ray the queries can work with: finite origin and direction, a positive finite length. */
  const validRay = (origin: Vec3Like, dir: Vec3Like, maxDist: number): boolean =>
    maxDist > 0 && Number.isFinite(maxDist + origin.x + origin.y + origin.z + dir.x + dir.y + dir.z);

  /** `out` = nothing within `maxDist` (a broken ray: nothing at the origin, or at zero when even that is no point). */
  const clearShot = (out: ShotHit, origin: Vec3Like, dir: Vec3Like, maxDist: number, valid: boolean): void => {
    out.kind = 'none';
    out.target = null;
    out.part = 'body';
    out.sphereIndex = -1;
    out.surface = 'metal';
    out.boxId = -1;
    const point = out.point;
    const normal = out.normal;
    if (valid) {
      out.distance = maxDist;
      point.x = origin.x + dir.x * maxDist;
      point.y = origin.y + dir.y * maxDist;
      point.z = origin.z + dir.z * maxDist;
      normal.x = -dir.x;
      normal.y = -dir.y;
      normal.z = -dir.z;
    } else {
      const finite = Number.isFinite(origin.x + origin.y + origin.z);
      out.distance = 0;
      point.x = finite ? origin.x : 0;
      point.y = finite ? origin.y : 0;
      point.z = finite ? origin.z : 0;
      normal.x = 0;
      normal.y = 1;
      normal.z = 0;
    }
  };

  const registry: TargetRegistry = {
    list,
    io,
    register(target: HitTarget): void {
      const existing = byId.get(target.id);
      if (existing) {
        // Same id again: the new entry takes the place (and the order) of the previous one.
        const i = list.indexOf(existing);
        list[i] = target;
        measure(i);
      } else {
        list.push(target);
        reach.push(0.5);
        measure(list.length - 1);
      }
      byId.set(target.id, target);
    },
    unregister(id: number): boolean {
      const target = byId.get(id);
      if (!target) return false;
      byId.delete(id);
      const at = list.indexOf(target);
      // Keep registration order (it is the tie-break and the damage order of a blast).
      for (let i = at; i < list.length - 1; i++) {
        list[i] = list[i + 1] as HitTarget;
        reach[i] = reach[i + 1] as number;
      }
      list.length--;
      reach.length--;
      return true;
    },
    get: (id) => byId.get(id),
    has: (target) => byId.get(target.id) === target,
    clear(): void {
      list.length = 0;
      reach.length = 0;
      byId.clear();
    },
    refresh(): void {
      for (let i = 0; i < list.length; i++) measure(i);
    },
    sweep,

    traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: ShotHit): boolean {
      const valid = validRay(origin, dir, maxDist);
      clearShot(out, origin, dir, maxDist, valid);
      if (!valid) return false;
      const mask = opts.worldMask ?? COL.PROJECTILE;
      io[IO_LIMIT] = maxDist;
      if (mask !== 0 && collision().raycast(origin, dir, maxDist, mask, rayHit)) {
        io[IO_LIMIT] = out.distance = rayHit.distance;
        out.kind = 'world';
        out.point.copy(rayHit.point);
        out.normal.copy(rayHit.normal);
        out.surface = rayHit.surface;
        out.boxId = rayHit.boxId;
      }
      io[IO_PAD] = opts.radius ?? 0;
      sweep(origin, dir, opts.faction, opts.ignoreId ?? 0, 0, out);
      return out.kind !== 'none';
    },

    tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: PierceResult): number {
      out.count = 0;
      out.hitWorld = false;
      out.boxId = -1;
      out.surface = 'metal';
      const end = out.end;
      const endNormal = out.endNormal;
      if (!validRay(origin, dir, maxDist)) {
        const finite = Number.isFinite(origin.x + origin.y + origin.z);
        end.x = finite ? origin.x : 0;
        end.y = finite ? origin.y : 0;
        end.z = finite ? origin.z : 0;
        endNormal.x = 0;
        endNormal.y = 1;
        endNormal.z = 0;
        return 0;
      }
      const mask = opts.worldMask ?? COL.PROJECTILE;
      io[IO_LIMIT] = maxDist;
      if (mask !== 0 && collision().raycast(origin, dir, maxDist, mask, rayHit)) {
        io[IO_LIMIT] = rayHit.distance;
        out.hitWorld = true;
        out.boxId = rayHit.boxId;
        out.surface = rayHit.surface;
        endNormal.copy(rayHit.normal);
        end.copy(rayHit.point);
      } else {
        end.x = origin.x + dir.x * maxDist;
        end.y = origin.y + dir.y * maxDist;
        end.z = origin.z + dir.z * maxDist;
        endNormal.x = -dir.x;
        endNormal.y = -dir.y;
        endNormal.z = -dir.z;
      }
      io[IO_PAD] = opts.radius ?? 0;

      const hits = out.hits;
      const capacity = hits.length;
      if (capacity === 0) return 0;
      const ignoreId = opts.ignoreId ?? 0;
      const faction = opts.faction;
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        const target = list[i] as HitTarget;
        if (!isHostile(target, faction, ignoreId) || !nearestOf(i, origin, dir)) continue;
        let slot: number;
        if (count < capacity) {
          slot = count++;
        } else if ((io[IO_DISTANCE] as number) < (hits[capacity - 1] as ShotHit).distance) {
          // More targets on the line than the result can hold: the farthest one gives way.
          slot = capacity - 1;
        } else {
          continue;
        }
        fillTargetHit(hits[slot] as ShotHit, target, foundIndex, origin, dir);
        // Insertion sort by distance; equal distances keep registration order.
        for (let j = slot; j > 0 && (hits[j] as ShotHit).distance < (hits[j - 1] as ShotHit).distance; j--) {
          const swap = hits[j] as ShotHit;
          hits[j] = hits[j - 1] as ShotHit;
          hits[j - 1] = swap;
        }
      }
      out.count = count;
      return count;
    },

    queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number {
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const target = list[i] as HitTarget;
        if (!target.alive || (faction !== 'any' && target.faction !== faction)) continue;
        const c = target.center;
        const dx = c.x - center.x;
        const dy = c.y - center.y;
        const dz = c.z - center.z;
        const r = radius + target.boundRadius;
        if (dx * dx + dy * dy + dz * dz <= r * r) out[n++] = target;
      }
      out.length = n;
      return n;
    },
  };
  return registry;
}
