/**
 * Hit-target registry and the ray queries against it: nearest hit, piercing trace, swept sphere
 * (thick ray) and radius query. Pure geometry: nothing here applies damage or plays feedback, and no
 * query allocates.
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
  // Outside the sphere and heading away from it.
  if (c > 0 && along < 0) return -1;
  const disc = along * along - c;
  if (!(disc >= 0)) return -1;
  const t = along - Math.sqrt(disc);
  if (t <= 0) return 0;
  return t <= limit ? t : -1;
}

const ZERO: Vec3Like = { x: 0, y: 0, z: 0 };
const DOWN: Vec3Like = { x: 0, y: -1, z: 0 };

/** Reset a ShotHit to "nothing within maxDist". */
export function clearShotHit(out: ShotHit, origin: Vec3Like, dir: Vec3Like, maxDist: number): ShotHit {
  out.kind = 'none';
  out.distance = maxDist;
  out.point.set(origin.x + dir.x * maxDist, origin.y + dir.y * maxDist, origin.z + dir.z * maxDist);
  out.normal.set(-dir.x, -dir.y, -dir.z);
  out.target = null;
  out.part = 'body';
  out.sphereIndex = -1;
  out.surface = 'metal';
  out.boxId = -1;
  return out;
}

export function copyShotHit(out: ShotHit, from: ShotHit): ShotHit {
  out.kind = from.kind;
  out.distance = from.distance;
  out.point.copy(from.point);
  out.normal.copy(from.normal);
  out.target = from.target;
  out.part = from.part;
  out.sphereIndex = from.sphereIndex;
  out.surface = from.surface;
  out.boxId = from.boxId;
  return out;
}

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

  /**
   * Nearest hostile target sphere entered by the ray within `limit`. `pad` thickens the ray for the
   * target tests. Fills `out` (kind 'target') and returns the distance, or returns -1 and leaves `out`
   * untouched. `faction` / `ignoreId` as in TraceOptions.
   */
  sweep(
    origin: Vec3Like,
    dir: Vec3Like,
    limit: number,
    pad: number,
    faction: Faction,
    ignoreId: number,
    out: ShotHit,
  ): number;
  traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: ShotHit): boolean;
  tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: PierceResult): number;
  queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number;
}

/** Radius around target.center that encloses every sphere (never less than the owner's boundRadius). */
function measureReach(target: HitTarget): number {
  let reach = target.boundRadius;
  const c = target.center;
  const spheres = target.spheres;
  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i] as HitSphere;
    const dx = s.center.x - c.x;
    const dy = s.center.y - c.y;
    const dz = s.center.z - c.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) + s.radius;
    if (r > reach) reach = r;
  }
  // A target whose spheres are not posed yet (or broken) is never culled by the broad phase.
  return reach >= 0 ? reach : Infinity;
}

/** `collision` is read lazily: the world fills it after the systems were constructed. */
export function createTargetRegistry(collision: () => CollisionWorld): TargetRegistry {
  const list: HitTarget[] = [];
  /** Broad-phase radius per entry of `list`. */
  const reach: number[] = [];
  const byId = new Map<number, HitTarget>();
  const rayHit = makeRayHit();
  /** Sphere index found by the last nearestSphere() call. */
  let foundIndex = -1;

  /** Entry distance into the nearest enabled sphere of one target (or -1); the index goes to foundIndex. */
  const nearestSphere = (
    target: HitTarget,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    limit: number,
    pad: number,
  ): number => {
    const spheres = target.spheres;
    let best = -1;
    let bestLimit = limit;
    for (let i = 0; i < spheres.length; i++) {
      const s = spheres[i] as HitSphere;
      if (!s.enabled) continue;
      const t = raySphere(ox, oy, oz, dx, dy, dz, s.center.x, s.center.y, s.center.z, s.radius + pad, bestLimit);
      // Strictly nearer only: of two spheres entered at the same distance the first one listed wins.
      if (t < 0 || (best >= 0 && t >= best)) continue;
      best = t;
      bestLimit = t;
      foundIndex = i;
    }
    return best;
  };

  const fillTargetHit = (
    out: ShotHit,
    target: HitTarget,
    sphereIndex: number,
    t: number,
    origin: Vec3Like,
    dir: Vec3Like,
    pad: number,
  ): void => {
    const sphere = target.spheres[sphereIndex] as HitSphere;
    const c = sphere.center;
    // Where the ray is when it touches the (possibly thickened) sphere.
    let nx = origin.x + dir.x * t - c.x;
    let ny = origin.y + dir.y * t - c.y;
    let nz = origin.z + dir.z * t - c.z;
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
    out.normal.set(nx, ny, nz);
    if (pad > 0 && len > sphere.radius) {
      // A thick ray touches the real surface at the point nearest to its axis: that is where the hit is.
      out.point.set(c.x + nx * sphere.radius, c.y + ny * sphere.radius, c.z + nz * sphere.radius);
    } else {
      out.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
    }
  };

  const isHostile = (target: HitTarget, faction: Faction, ignoreId: number): boolean =>
    target.alive && target.id !== ignoreId && (faction === 'neutral' || target.faction !== faction);

  const sweep = (
    origin: Vec3Like,
    dir: Vec3Like,
    limit: number,
    pad: number,
    faction: Faction,
    ignoreId: number,
    out: ShotHit,
  ): number => {
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    let best = -1;
    let bestLimit = limit;
    let bestTarget: HitTarget | null = null;
    let bestIndex = -1;
    for (let i = 0; i < list.length; i++) {
      const target = list[i] as HitTarget;
      if (!isHostile(target, faction, ignoreId)) continue;
      const c = target.center;
      if (raySphere(ox, oy, oz, dx, dy, dz, c.x, c.y, c.z, (reach[i] as number) + pad, bestLimit) < 0) continue;
      const t = nearestSphere(target, ox, oy, oz, dx, dy, dz, bestLimit, pad);
      // Of two targets entered at the same distance the one registered first wins.
      if (t < 0 || (best >= 0 && t >= best)) continue;
      best = t;
      bestLimit = t;
      bestTarget = target;
      bestIndex = foundIndex;
    }
    if (bestTarget) fillTargetHit(out, bestTarget, bestIndex, best, origin, dir, pad);
    return best;
  };

  /** A ray the queries can work with: finite origin and direction, a positive finite length. */
  const validRay = (origin: Vec3Like, dir: Vec3Like, maxDist: number): boolean =>
    maxDist > 0 && Number.isFinite(maxDist + origin.x + origin.y + origin.z + dir.x + dir.y + dir.z);
  /** The answer to a broken ray: nothing, at the origin (or at zero when even that is not a point). */
  const clearInvalid = (out: ShotHit, origin: Vec3Like): void => {
    clearShotHit(out, ZERO, DOWN, 0);
    if (Number.isFinite(origin.x + origin.y + origin.z)) out.point.set(origin.x, origin.y, origin.z);
  };

  const registry: TargetRegistry = {
    list,
    register(target: HitTarget): void {
      const existing = byId.get(target.id);
      if (existing) {
        // Same id again: the new entry takes the place (and the order) of the previous one.
        const i = list.indexOf(existing);
        list[i] = target;
        reach[i] = measureReach(target);
      } else {
        list.push(target);
        reach.push(measureReach(target));
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
      for (let i = 0; i < list.length; i++) reach[i] = measureReach(list[i] as HitTarget);
    },
    sweep,

    traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: ShotHit): boolean {
      if (!validRay(origin, dir, maxDist)) {
        clearInvalid(out, origin);
        return false;
      }
      clearShotHit(out, origin, dir, maxDist);
      const mask = opts.worldMask ?? COL.PROJECTILE;
      let limit = maxDist;
      if (mask !== 0 && collision().raycast(origin, dir, maxDist, mask, rayHit)) {
        out.kind = 'world';
        out.distance = limit = rayHit.distance;
        out.point.copy(rayHit.point);
        out.normal.copy(rayHit.normal);
        out.surface = rayHit.surface;
        out.boxId = rayHit.boxId;
      }
      sweep(origin, dir, limit, opts.radius ?? 0, opts.faction, opts.ignoreId ?? 0, out);
      return out.kind !== 'none';
    },

    tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: PierceResult): number {
      out.count = 0;
      out.hitWorld = false;
      out.boxId = -1;
      out.surface = 'metal';
      if (!validRay(origin, dir, maxDist)) {
        out.endNormal.set(0, 1, 0);
        if (Number.isFinite(origin.x + origin.y + origin.z)) out.end.set(origin.x, origin.y, origin.z);
        else out.end.set(0, 0, 0);
        return 0;
      }
      out.endNormal.set(-dir.x, -dir.y, -dir.z);
      const mask = opts.worldMask ?? COL.PROJECTILE;
      let limit = maxDist;
      if (mask !== 0 && collision().raycast(origin, dir, maxDist, mask, rayHit)) {
        limit = rayHit.distance;
        out.hitWorld = true;
        out.boxId = rayHit.boxId;
        out.surface = rayHit.surface;
        out.endNormal.copy(rayHit.normal);
      }
      out.end.set(origin.x + dir.x * limit, origin.y + dir.y * limit, origin.z + dir.z * limit);

      const hits = out.hits;
      const capacity = hits.length;
      if (capacity === 0) return 0;
      const pad = opts.radius ?? 0;
      const ignoreId = opts.ignoreId ?? 0;
      const ox = origin.x;
      const oy = origin.y;
      const oz = origin.z;
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        const target = list[i] as HitTarget;
        if (!isHostile(target, opts.faction, ignoreId)) continue;
        const c = target.center;
        if (raySphere(ox, oy, oz, dir.x, dir.y, dir.z, c.x, c.y, c.z, (reach[i] as number) + pad, limit) < 0) continue;
        const t = nearestSphere(target, ox, oy, oz, dir.x, dir.y, dir.z, limit, pad);
        if (t < 0) continue;
        let slot: number;
        if (count < capacity) {
          slot = count++;
        } else if (t < (hits[capacity - 1] as ShotHit).distance) {
          // More targets on the line than the result can hold: the farthest one gives way.
          slot = capacity - 1;
        } else {
          continue;
        }
        fillTargetHit(hits[slot] as ShotHit, target, foundIndex, t, origin, dir, pad);
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
