/**
 * CollisionWorld: static axis-aligned boxes behind a uniform XZ grid broadphase.
 *
 *   - moveAndSlide is a true swept "collide and slide": the whole delta is swept against the nearby
 *     boxes, the body stops flush on the first face it meets, the blocked axis is removed and the rest
 *     of the move continues. Nothing is sub-stepped, so no speed can tunnel.
 *   - Contact tolerances make seams invisible: a body may sink up to ENTER into a face before a sweep
 *     reports it, and only counts as overlapping a box sideways once it is deeper than SKIN. Resting
 *     contacts are exact (flush), so neighbouring coplanar boxes never present an edge to catch on.
 *   - Step-up lifts the body, advances it and drops it back onto the ledge (several steps per move);
 *     step-down is a final downward sweep that keeps the body glued to descending stairs.
 *   - Every query runs on typed-array scratch state ("registers"): no objects, closures or boxed
 *     numbers are created per call.
 */
import type * as THREE from 'three';
import { COL } from '../core/constants';
import type {
  Aabb,
  BoxDesc,
  CollisionBox,
  CollisionWorld,
  MoveResult,
  RayHit,
  SurfaceType,
  Vec3Like,
} from '../core/types';

/** Penetration deeper than this counts as overlapping (touching faces never overlap). */
const SKIN = 1e-4;
/** A sweep reports a face once the body would be this deep in it; the body is then placed flush. */
const ENTER = SKIN * 0.5;
/** A floor this close under the feet counts as ground even without snapDown. */
const GROUND_PROBE = 0.02;
/** Boxes are at least this thick on every axis (degenerate plates would vanish inside the tolerances). */
const MIN_THICKNESS = 1e-3;
/** Smallest body extent accepted by moveAndSlide. */
const MIN_EXTENT = 1e-3;
/** Coordinates and deltas beyond these are refused / clamped instead of propagated. */
const MAX_COORD = 1e7;
const MAX_DELTA = 1000;
const MAX_STEP_HEIGHT = 4;
/** Ledges climbed within one move (a dash up a flight of stairs crosses several treads). */
const MAX_STEPS = 6;
const MAX_SLIDE_ITERATIONS = 3 + MAX_STEPS * 2 + 2;
/** A step is only taken when it gains at least this much ground, and may borrow this much to land on it. */
const MIN_STEP_ADVANCE = 4 * SKIN;
/** When embedded in geometry, prefer rising onto a floor this close over a shorter sideways push. */
const DEPENETRATE_UP_BIAS = 0.25;
/** A ray that starts this close inside a face and heads inward hits it at distance 0. */
const RAY_SURFACE_EPS = 1e-5;
/** Direction components below this are treated as parallel to the slab. */
const RAY_PARALLEL = 1e-12;
/** lineOfSight ignores this last bit of the segment so a target resting on a surface stays visible. */
const LOS_END_EPS = 1e-3;
/** Broadphase tuning. */
const GRID_MIN_CELL = 2;
const GRID_MAX_CELL = 16;
const GRID_MAX_CELLS = 65536;
const GRID_PAD = 1e-3;
/** Query stamps stay small integers. */
const MAX_QUERY_ID = 0x3fffffff;

// Scratch registers (indices into one Float64Array): hot paths never pass or return fractional numbers
// through function calls, they read and write these slots instead.
const R_PX = 0;
const R_PY = 1;
const R_PZ = 2;
const R_HW = 3;
const R_H = 4;
const R_DX = 5;
const R_DY = 6;
const R_DZ = 7;
const R_T = 8;
const R_RX = 9;
const R_RY = 10;
const R_RZ = 11;
const R_SU = 12;
const R_SD = 13;
const Q_X0 = 14;
const Q_Y0 = 15;
const Q_Z0 = 16;
const Q_X1 = 17;
const Q_Y1 = 18;
const Q_Z1 = 19;
const RAY_OX = 20;
const RAY_OY = 21;
const RAY_OZ = 22;
const RAY_DX = 23;
const RAY_DY = 24;
const RAY_DZ = 25;
const RAY_MAX = 26;
const RAY_T = 27;
const REGISTER_COUNT = 28;

interface MutableBox {
  id: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  flags: number;
  surface: SurfaceType;
  tag: string;
  decals: boolean;
  enabled: boolean;
}

/** Finite coordinate or 0 (NaN), clamped to the supported range. */
function sanitizeCoord(v: number): number {
  if (!(v === v)) return 0;
  return v > MAX_COORD ? MAX_COORD : v < -MAX_COORD ? -MAX_COORD : v;
}

function growFloat(source: Float64Array, capacity: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(capacity);
  next.set(source);
  return next;
}

export function createCollisionWorld(): CollisionWorld {
  const boxes: MutableBox[] = [];
  const tagIndex = new Map<string, number[]>();
  const bounds: Aabb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  let version = 0;

  // Structure-of-arrays copy of the boxes for the hot loops.
  let count = 0;
  let capacity = 256;
  let bMinX = new Float64Array(capacity);
  let bMinY = new Float64Array(capacity);
  let bMinZ = new Float64Array(capacity);
  let bMaxX = new Float64Array(capacity);
  let bMaxY = new Float64Array(capacity);
  let bMaxZ = new Float64Array(capacity);
  let bFlags = new Int32Array(capacity);
  let bOn = new Uint8Array(capacity);
  let stamp = new Int32Array(capacity);
  let queryId = 0;

  // Uniform XZ grid (CSR layout): cellItems[cellStart[c] .. cellStart[c + 1]) are the boxes touching cell c.
  let gridDirty = true;
  let gCols = 1;
  let gRows = 1;
  let gMinX = 0;
  let gMinZ = 0;
  let gMaxX = 0;
  let gMaxZ = 0;
  let gCell = GRID_MIN_CELL;
  let gInv = 1 / GRID_MIN_CELL;
  let cellStart = new Int32Array(2);
  let cellItems = new Int32Array(0);

  // Scratch state.
  const f = new Float64Array(REGISTER_COUNT);
  let cand = new Int32Array(64);
  let candCount = 0;
  let hitAxis = -1;
  let hitBox = -1;
  let rayAxis = 0;
  let raySign = 0;
  let rayBox = -1;
  let moveSignX = 1;
  let moveSignZ = 1;
  let res: MoveResult | null = null;

  const growStorage = (): void => {
    capacity *= 2;
    bMinX = growFloat(bMinX, capacity);
    bMinY = growFloat(bMinY, capacity);
    bMinZ = growFloat(bMinZ, capacity);
    bMaxX = growFloat(bMaxX, capacity);
    bMaxY = growFloat(bMaxY, capacity);
    bMaxZ = growFloat(bMaxZ, capacity);
    const flags = new Int32Array(capacity);
    flags.set(bFlags);
    bFlags = flags;
    const on = new Uint8Array(capacity);
    on.set(bOn);
    bOn = on;
    stamp = new Int32Array(capacity);
    queryId = 0;
  };

  /** Recompute the bounds and the broadphase grid from scratch. */
  const rebuild = (): void => {
    gridDirty = false;
    if (count === 0) {
      bounds.minX = bounds.minY = bounds.minZ = bounds.maxX = bounds.maxY = bounds.maxZ = 0;
      gCols = gRows = 1;
      gMinX = gMinZ = gMaxX = gMaxZ = 0;
      gCell = GRID_MIN_CELL;
      gInv = 1 / gCell;
      cellStart = new Int32Array(2);
      cellItems = new Int32Array(0);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let b = 0; b < count; b++) {
      if (bMinX[b] < minX) minX = bMinX[b];
      if (bMinY[b] < minY) minY = bMinY[b];
      if (bMinZ[b] < minZ) minZ = bMinZ[b];
      if (bMaxX[b] > maxX) maxX = bMaxX[b];
      if (bMaxY[b] > maxY) maxY = bMaxY[b];
      if (bMaxZ[b] > maxZ) maxZ = bMaxZ[b];
    }
    bounds.minX = minX;
    bounds.minY = minY;
    bounds.minZ = minZ;
    bounds.maxX = maxX;
    bounds.maxY = maxY;
    bounds.maxZ = maxZ;

    // Cell size: about four box centres per cell on average, within sane limits.
    const extentX = Math.max(maxX - minX, GRID_MIN_CELL);
    const extentZ = Math.max(maxZ - minZ, GRID_MIN_CELL);
    let cell = Math.sqrt((extentX * extentZ) / count) * 2;
    cell = cell < GRID_MIN_CELL ? GRID_MIN_CELL : cell > GRID_MAX_CELL ? GRID_MAX_CELL : cell;
    while (Math.ceil(extentX / cell) * Math.ceil(extentZ / cell) > GRID_MAX_CELLS) cell *= 2;
    gCell = cell;
    gInv = 1 / cell;
    gMinX = minX - GRID_PAD;
    gMinZ = minZ - GRID_PAD;
    gCols = Math.max(1, Math.ceil((extentX + 2 * GRID_PAD) / cell));
    gRows = Math.max(1, Math.ceil((extentZ + 2 * GRID_PAD) / cell));
    gMaxX = gMinX + gCols * cell;
    gMaxZ = gMinZ + gRows * cell;

    const cells = gCols * gRows;
    const starts = new Int32Array(cells + 1);
    const lastCol = gCols - 1;
    const lastRow = gRows - 1;
    const cellOf = (v: number, origin: number, last: number): number => {
      const c = Math.floor((v - origin) * gInv);
      return c < 0 ? 0 : c > last ? last : c;
    };
    for (let b = 0; b < count; b++) {
      const x0 = cellOf(bMinX[b] - GRID_PAD, gMinX, lastCol);
      const x1 = cellOf(bMaxX[b] + GRID_PAD, gMinX, lastCol);
      const z0 = cellOf(bMinZ[b] - GRID_PAD, gMinZ, lastRow);
      const z1 = cellOf(bMaxZ[b] + GRID_PAD, gMinZ, lastRow);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) starts[cz * gCols + cx + 1]++;
      }
    }
    for (let c = 0; c < cells; c++) starts[c + 1] += starts[c];
    const items = new Int32Array(starts[cells]);
    const cursor = starts.slice(0, cells);
    for (let b = 0; b < count; b++) {
      const x0 = cellOf(bMinX[b] - GRID_PAD, gMinX, lastCol);
      const x1 = cellOf(bMaxX[b] + GRID_PAD, gMinX, lastCol);
      const z0 = cellOf(bMinZ[b] - GRID_PAD, gMinZ, lastRow);
      const z1 = cellOf(bMaxZ[b] + GRID_PAD, gMinZ, lastRow);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) items[cursor[cz * gCols + cx]++] = b;
      }
    }
    cellStart = starts;
    cellItems = items;
  };

  const nextQuery = (): number => {
    if (queryId >= MAX_QUERY_ID) {
      stamp.fill(0);
      queryId = 0;
    }
    return ++queryId;
  };

  /**
   * Collect the enabled boxes matching `mask` that touch the region in Q_X0..Q_Z1 into `cand`.
   * Every sweep of one moveAndSlide call runs against this list only.
   */
  const gather = (mask: number): void => {
    candCount = 0;
    if (count === 0) return;
    const x0 = f[Q_X0];
    const y0 = f[Q_Y0];
    const z0 = f[Q_Z0];
    const x1 = f[Q_X1];
    const y1 = f[Q_Y1];
    const z1 = f[Q_Z1];
    if (x1 < gMinX || x0 > gMaxX || z1 < gMinZ || z0 > gMaxZ) return;
    const lastCol = gCols - 1;
    const lastRow = gRows - 1;
    let cx0 = Math.floor((x0 - gMinX) * gInv);
    let cx1 = Math.floor((x1 - gMinX) * gInv);
    let cz0 = Math.floor((z0 - gMinZ) * gInv);
    let cz1 = Math.floor((z1 - gMinZ) * gInv);
    cx0 = cx0 < 0 ? 0 : cx0 > lastCol ? lastCol : cx0;
    cx1 = cx1 < 0 ? 0 : cx1 > lastCol ? lastCol : cx1;
    cz0 = cz0 < 0 ? 0 : cz0 > lastRow ? lastRow : cz0;
    cz1 = cz1 < 0 ? 0 : cz1 > lastRow ? lastRow : cz1;
    const q = nextQuery();
    for (let cz = cz0; cz <= cz1; cz++) {
      let cell = cz * gCols + cx0;
      for (let cx = cx0; cx <= cx1; cx++, cell++) {
        const end = cellStart[cell + 1];
        for (let i = cellStart[cell]; i < end; i++) {
          const b = cellItems[i];
          if (stamp[b] === q) continue;
          stamp[b] = q;
          if (bOn[b] === 0 || (bFlags[b] & mask) === 0) continue;
          if (bMinX[b] > x1 || bMaxX[b] < x0 || bMinY[b] > y1 || bMaxY[b] < y0 || bMinZ[b] > z1 || bMaxZ[b] < z0) {
            continue;
          }
          if (candCount === cand.length) {
            const bigger = new Int32Array(cand.length * 2);
            bigger.set(cand);
            cand = bigger;
          }
          cand[candCount++] = b;
        }
      }
    }
  };

  /** Region a move can touch: the swept body plus the step-up lift above and the snap reach below. */
  const setMoveRegion = (): void => {
    const hw = f[R_HW];
    const dx = f[R_RX];
    const dy = f[R_RY];
    const dz = f[R_RZ];
    const su = f[R_SU];
    const sd = f[R_SD];
    // Every step may borrow MIN_STEP_ADVANCE beyond the requested delta, rise by up to the step
    // height and come down up to the snap reach lower than it started; the final snap adds one more.
    const pad = MIN_STEP_ADVANCE * (MAX_STEPS + 1) + 4 * SKIN;
    const below = sd * (MAX_STEPS + 1) + GROUND_PROBE + pad;
    const above = su * (MAX_STEPS + 1) + pad;
    f[Q_X0] = f[R_PX] - hw + (dx < 0 ? dx : 0) - pad;
    f[Q_X1] = f[R_PX] + hw + (dx > 0 ? dx : 0) + pad;
    f[Q_Z0] = f[R_PZ] - hw + (dz < 0 ? dz : 0) - pad;
    f[Q_Z1] = f[R_PZ] + hw + (dz > 0 ? dz : 0) + pad;
    f[Q_Y0] = f[R_PY] + (dy < 0 ? dy : 0) - below;
    f[Q_Y1] = f[R_PY] + f[R_H] + (dy > 0 ? dy : 0) + above;
  };

  /**
   * Sweep the body (R_PX.., R_HW, R_H) by (R_DX, R_DY, R_DZ) against the candidates.
   * Writes the fraction of the delta that can be travelled to R_T and the face that stops it to
   * hitAxis (0 = X, 1 = Y, 2 = Z, -1 = nothing) / hitBox.
   *
   * Per axis a box is "entered" when the leading face is ENTER deep and "left" when the trailing face
   * is within SKIN of the far side. A body already deeper than SKIN on every axis ignores the box (it
   * was either pushed out before the sweep or is hopelessly stuck and must be able to walk out).
   */
  const sweep = (): void => {
    const dx = f[R_DX];
    const dy = f[R_DY];
    const dz = f[R_DZ];
    const hw = f[R_HW];
    const a0x = f[R_PX] - hw;
    const a1x = f[R_PX] + hw;
    const a0y = f[R_PY];
    const a1y = a0y + f[R_H];
    const a0z = f[R_PZ] - hw;
    const a1z = f[R_PZ] + hw;
    let best = Infinity;
    let bestAxis = -1;
    let bestBox = -1;

    for (let i = 0; i < candCount; i++) {
      const b = cand[i];
      let enter = -Infinity;
      let exit = Infinity;
      let axis = -1;
      let te: number;
      let tx: number;

      // Y first: on an exact tie the vertical face wins, so a floor edge reads as ground, not as a wall.
      let lo = bMinY[b];
      let hi = bMaxY[b];
      if (dy > 0) {
        if (hi - a0y <= SKIN) continue;
        te = (lo + ENTER - a1y) / dy;
        if (te < 0) te = a1y - lo <= SKIN ? 0 : -Infinity;
        tx = (hi - SKIN - a0y) / dy;
        if (te > enter) {
          enter = te;
          axis = 1;
        }
        if (tx < exit) exit = tx;
      } else if (dy < 0) {
        if (a1y - lo <= SKIN) continue;
        te = (hi - ENTER - a0y) / dy;
        if (te < 0) te = hi - a0y <= SKIN ? 0 : -Infinity;
        tx = (lo + SKIN - a1y) / dy;
        if (te > enter) {
          enter = te;
          axis = 1;
        }
        if (tx < exit) exit = tx;
      } else if (a1y - lo <= SKIN || hi - a0y <= SKIN) continue;

      lo = bMinX[b];
      hi = bMaxX[b];
      if (dx > 0) {
        if (hi - a0x <= SKIN) continue;
        te = (lo + ENTER - a1x) / dx;
        if (te < 0) te = a1x - lo <= SKIN ? 0 : -Infinity;
        tx = (hi - SKIN - a0x) / dx;
        if (te > enter) {
          enter = te;
          axis = 0;
        }
        if (tx < exit) exit = tx;
      } else if (dx < 0) {
        if (a1x - lo <= SKIN) continue;
        te = (hi - ENTER - a0x) / dx;
        if (te < 0) te = hi - a0x <= SKIN ? 0 : -Infinity;
        tx = (lo + SKIN - a1x) / dx;
        if (te > enter) {
          enter = te;
          axis = 0;
        }
        if (tx < exit) exit = tx;
      } else if (a1x - lo <= SKIN || hi - a0x <= SKIN) continue;

      lo = bMinZ[b];
      hi = bMaxZ[b];
      if (dz > 0) {
        if (hi - a0z <= SKIN) continue;
        te = (lo + ENTER - a1z) / dz;
        if (te < 0) te = a1z - lo <= SKIN ? 0 : -Infinity;
        tx = (hi - SKIN - a0z) / dz;
        if (te > enter) {
          enter = te;
          axis = 2;
        }
        if (tx < exit) exit = tx;
      } else if (dz < 0) {
        if (a1z - lo <= SKIN) continue;
        te = (hi - ENTER - a0z) / dz;
        if (te < 0) te = hi - a0z <= SKIN ? 0 : -Infinity;
        tx = (lo + SKIN - a1z) / dz;
        if (te > enter) {
          enter = te;
          axis = 2;
        }
        if (tx < exit) exit = tx;
      } else if (a1z - lo <= SKIN || hi - a0z <= SKIN) continue;

      // enter === -Infinity: overlapping on every axis already (or not moving at all).
      if (enter === -Infinity || enter >= exit || enter > 1 || enter >= best) continue;
      best = enter;
      bestAxis = axis;
      bestBox = b;
    }

    hitAxis = bestAxis;
    hitBox = bestBox;
    if (bestBox < 0) {
      f[R_T] = 1;
      return;
    }
    // Fraction that brings the leading face exactly flush with the real face (0 when already touching).
    let t: number;
    if (bestAxis === 0) t = (dx > 0 ? bMinX[bestBox] - a1x : bMaxX[bestBox] - a0x) / dx;
    else if (bestAxis === 1) t = (dy > 0 ? bMinY[bestBox] - a1y : bMaxY[bestBox] - a0y) / dy;
    else t = (dz > 0 ? bMinZ[bestBox] - a1z : bMaxZ[bestBox] - a0z) / dz;
    f[R_T] = t > 0 ? (t < 1 ? t : 1) : 0;
  };

  /** Advance the body by the fraction found by sweep() and put it exactly flush on the face it hit. */
  const applySweep = (): void => {
    const t = f[R_T];
    f[R_PX] += f[R_DX] * t;
    f[R_PY] += f[R_DY] * t;
    f[R_PZ] += f[R_DZ] * t;
    const b = hitBox;
    if (hitAxis === 0) {
      if (t > 0) f[R_PX] = f[R_DX] > 0 ? bMinX[b] - f[R_HW] : bMaxX[b] + f[R_HW];
    } else if (hitAxis === 1) {
      // Feet always rest exactly on the top; a head only snaps under a ceiling it actually reached.
      if (f[R_DY] < 0) f[R_PY] = bMaxY[b];
      else if (t > 0) f[R_PY] = bMinY[b] - f[R_H];
    } else if (hitAxis === 2) {
      if (t > 0) f[R_PZ] = f[R_DZ] > 0 ? bMinZ[b] - f[R_HW] : bMaxZ[b] + f[R_HW];
    }
  };

  /**
   * Push the body out of every candidate it is embedded in (deeper than SKIN on all axes) along the
   * axis of least penetration. Returns true when the position changed. A conflict that cannot be
   * resolved (wedged between two boxes) restores the position: those boxes are then ignored by the
   * sweeps so the body can still walk out.
   */
  const depenetrate = (): boolean => {
    const sx = f[R_PX];
    const sy = f[R_PY];
    const sz = f[R_PZ];
    const hw = f[R_HW];
    const h = f[R_H];
    let moved = false;
    for (let pass = 0; pass < 4; pass++) {
      let any = false;
      for (let i = 0; i < candCount; i++) {
        const b = cand[i];
        const xp = bMaxX[b] - (f[R_PX] - hw);
        const xn = f[R_PX] + hw - bMinX[b];
        if (xp <= SKIN || xn <= SKIN) continue;
        const yp = bMaxY[b] - f[R_PY];
        const yn = f[R_PY] + h - bMinY[b];
        if (yp <= SKIN || yn <= SKIN) continue;
        const zp = bMaxZ[b] - (f[R_PZ] - hw);
        const zn = f[R_PZ] + hw - bMinZ[b];
        if (zp <= SKIN || zn <= SKIN) continue;
        any = true;
        moved = true;
        if (yp <= DEPENETRATE_UP_BIAS) {
          f[R_PY] = bMaxY[b];
          continue;
        }
        let depth = yp;
        let dir = 0;
        if (yn < depth) {
          depth = yn;
          dir = 1;
        }
        if (xp < depth) {
          depth = xp;
          dir = 2;
        }
        if (xn < depth) {
          depth = xn;
          dir = 3;
        }
        if (zp < depth) {
          depth = zp;
          dir = 4;
        }
        if (zn < depth) dir = 5;
        if (dir === 0) f[R_PY] = bMaxY[b];
        else if (dir === 1) f[R_PY] = bMinY[b] - h;
        else if (dir === 2) f[R_PX] = bMaxX[b] + hw;
        else if (dir === 3) f[R_PX] = bMinX[b] - hw;
        else if (dir === 4) f[R_PZ] = bMaxZ[b] + hw;
        else f[R_PZ] = bMinZ[b] - hw;
      }
      if (!any) return moved;
    }
    f[R_PX] = sx;
    f[R_PY] = sy;
    f[R_PZ] = sz;
    return false;
  };

  /**
   * The body was just stopped by a low obstacle along `axis` (0 = X, 2 = Z): lift it by up to R_SU,
   * carry the remaining horizontal move forward and bring it back down. Succeeds only when that gains
   * ground along the blocked axis; otherwise the body is restored.
   */
  const tryStep = (axis: number): boolean => {
    const out = res as MoveResult;
    const sx = f[R_PX];
    const sy = f[R_PY];
    const sz = f[R_PZ];
    const su = f[R_SU];

    // 1. Lift (a ceiling may shorten it).
    f[R_DX] = 0;
    f[R_DY] = su;
    f[R_DZ] = 0;
    sweep();
    applySweep();
    const lift = f[R_PY] - sy;
    if (lift <= 2 * SKIN) {
      f[R_PY] = sy;
      return false;
    }

    // 2. Advance. A hit at the very end of a move leaves almost nothing to advance with, so the step
    //    may borrow a fraction of a millimetre: enough to stand on the ledge instead of stalling at it.
    let ax = f[R_RX];
    let az = f[R_RZ];
    if (axis === 0) {
      if (ax * moveSignX < MIN_STEP_ADVANCE) ax = moveSignX * MIN_STEP_ADVANCE;
    } else if (az * moveSignZ < MIN_STEP_ADVANCE) az = moveSignZ * MIN_STEP_ADVANCE;
    let sideAxis = -1;
    let sideBox = -1;
    for (let i = 0; i < 3; i++) {
      if (ax === 0 && az === 0) break;
      f[R_DX] = ax;
      f[R_DY] = 0;
      f[R_DZ] = az;
      sweep();
      applySweep();
      if (hitAxis < 0) {
        ax = 0;
        az = 0;
        break;
      }
      const k = 1 - f[R_T];
      ax *= k;
      az *= k;
      // Blocked again along the stepped axis (the next riser): the main loop continues from here.
      if (hitAxis === axis) break;
      // Blocked sideways while raised: slide along it.
      sideAxis = hitAxis;
      sideBox = hitBox;
      if (hitAxis === 0) ax = 0;
      else az = 0;
    }
    const progress = axis === 0 ? (f[R_PX] - sx) * moveSignX : (f[R_PZ] - sz) * moveSignZ;
    if (progress <= 2 * SKIN) {
      f[R_PX] = sx;
      f[R_PY] = sy;
      f[R_PZ] = sz;
      return false;
    }

    // 3. Come back down: onto the ledge, or onto whatever lies within the snap reach below the old
    //    height. With nothing there (a low rim with a drop behind it, cleared in one stride) the body
    //    hopped the obstacle and is left in mid-air at the height it came from, free to fall.
    f[R_DX] = 0;
    f[R_DY] = -(lift + f[R_SD]);
    f[R_DZ] = 0;
    sweep();
    if (hitAxis === 1) {
      applySweep();
      const rise = f[R_PY] - sy;
      if (rise > 0) out.stepped += rise;
      else if (rise < -SKIN) out.snapped -= rise;
      if (f[R_RY] < 0) f[R_RY] = 0;
    } else {
      f[R_PY] = sy;
    }
    f[R_RX] = ax;
    f[R_RZ] = az;
    if (sideAxis === 0) {
      out.hitX = true;
      out.wallBoxId = sideBox;
    } else if (sideAxis === 2) {
      out.hitZ = true;
      out.wallBoxId = sideBox;
    }
    return true;
  };

  const moveAndSlide = (
    pos: THREE.Vector3,
    halfWidth: number,
    height: number,
    delta: Vec3Like,
    mask: number,
    stepUp: number,
    snapDown: number,
    out: MoveResult,
  ): MoveResult => {
    out.grounded = false;
    out.hitX = false;
    out.hitZ = false;
    out.hitCeiling = false;
    out.stepped = 0;
    out.snapped = 0;
    out.groundBoxId = -1;
    out.groundSurface = 'metal';
    out.wallBoxId = -1;

    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    // Refuse to propagate garbage: a non-finite or absurd position is left alone and reported airborne.
    if (!(Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD && Math.abs(z) <= MAX_COORD)) return out;

    // Clamp with Math.min / Math.max, never with `v > MAX ? MAX : v`: a conditional that selects
    // between a raw double and a module constant makes the optimiser keep the value as a tagged
    // number whenever it cannot fold the constant (as soon as a second world exists), and that boxes
    // dx, dy and dz on the heap on every single call. NaN falls through both and is zeroed after.
    let dx = Math.min(Math.max(delta.x, -MAX_DELTA), MAX_DELTA);
    let dy = Math.min(Math.max(delta.y, -MAX_DELTA), MAX_DELTA);
    let dz = Math.min(Math.max(delta.z, -MAX_DELTA), MAX_DELTA);
    if (dx !== dx) dx = 0;
    if (dy !== dy) dy = 0;
    if (dz !== dz) dz = 0;
    let su = Math.min(Math.max(stepUp, 0), MAX_STEP_HEIGHT);
    let sd = Math.min(Math.max(snapDown, 0), MAX_STEP_HEIGHT);
    if (su !== su) su = 0;
    if (sd !== sd) sd = 0;

    if (gridDirty) rebuild();
    f[R_PX] = x;
    f[R_PY] = y;
    f[R_PZ] = z;
    // Degenerate or NaN body sizes fall back to the smallest extent (two stores, for the same reason).
    f[R_HW] = MIN_EXTENT;
    f[R_H] = MIN_EXTENT;
    if (halfWidth > MIN_EXTENT) f[R_HW] = halfWidth;
    if (height > MIN_EXTENT) f[R_H] = height;
    f[R_RX] = dx;
    f[R_RY] = dy;
    f[R_RZ] = dz;
    f[R_SU] = su;
    f[R_SD] = sd;
    moveSignX = dx < 0 ? -1 : 1;
    moveSignZ = dz < 0 ? -1 : 1;
    res = out;

    setMoveRegion();
    gather(mask);
    // Embedded in geometry (teleport, spawn, a gate closing on the body): get out first. A push can
    // leave the gathered region, hence the re-gather.
    for (let round = 0; round < 3 && candCount > 0 && depenetrate(); round++) {
      setMoveRegion();
      gather(mask);
    }

    if (candCount === 0) {
      f[R_PX] += dx;
      f[R_PY] += dy;
      f[R_PZ] += dz;
    } else {
      let steps = 0;
      for (let iter = 0; iter < MAX_SLIDE_ITERATIONS; iter++) {
        const rx = f[R_RX];
        const ry = f[R_RY];
        const rz = f[R_RZ];
        if (rx === 0 && ry === 0 && rz === 0) break;
        f[R_DX] = rx;
        f[R_DY] = ry;
        f[R_DZ] = rz;
        sweep();
        applySweep();
        const axis = hitAxis;
        if (axis < 0) break;
        const b = hitBox;
        const k = 1 - f[R_T];
        f[R_RX] = rx * k;
        f[R_RY] = ry * k;
        f[R_RZ] = rz * k;
        if (axis === 1) {
          if (ry > 0) out.hitCeiling = true;
          f[R_RY] = 0;
        } else {
          // Only obstacles whose top is within reach can be stepped onto; walls skip the attempt.
          if (su > 0 && steps < MAX_STEPS && bMaxY[b] - f[R_PY] <= su + SKIN && tryStep(axis)) {
            steps++;
            continue;
          }
          if (axis === 0) {
            out.hitX = true;
            f[R_RX] = 0;
          } else {
            out.hitZ = true;
            f[R_RZ] = 0;
          }
          out.wallBoxId = b;
        }
      }

      // Ground state: the same downward sweep that would stop a fall decides "standing", so the two
      // can never disagree (no jitter on edges). With snapDown it also keeps the feet on descending
      // stairs. A move that travels upward is airborne by definition.
      if (dy <= 0) {
        f[R_DX] = 0;
        f[R_DY] = -Math.max(sd, GROUND_PROBE);
        f[R_DZ] = 0;
        sweep();
        if (hitAxis === 1) {
          const b = hitBox;
          const drop = f[R_PY] - bMaxY[b];
          if (drop > SKIN) out.snapped += drop;
          f[R_PY] = bMaxY[b];
          out.grounded = true;
          out.groundBoxId = b;
          out.groundSurface = (boxes[b] as MutableBox).surface;
        }
      }
    }

    res = null;
    pos.x = f[R_PX];
    pos.y = f[R_PY];
    pos.z = f[R_PZ];
    return out;
  };

  /** Slab-test the boxes of one grid cell against the ray in RAY_*; keeps the nearest hit in RAY_T. */
  const rayCell = (cell: number, mask: number, q: number): void => {
    const ox = f[RAY_OX];
    const oy = f[RAY_OY];
    const oz = f[RAY_OZ];
    const dx = f[RAY_DX];
    const dy = f[RAY_DY];
    const dz = f[RAY_DZ];
    const px = dx > RAY_PARALLEL || dx < -RAY_PARALLEL;
    const py = dy > RAY_PARALLEL || dy < -RAY_PARALLEL;
    const pz = dz > RAY_PARALLEL || dz < -RAY_PARALLEL;
    const ix = px ? 1 / dx : 0;
    const iy = py ? 1 / dy : 0;
    const iz = pz ? 1 / dz : 0;
    let best = f[RAY_T];
    const end = cellStart[cell + 1];
    for (let i = cellStart[cell]; i < end; i++) {
      const b = cellItems[i];
      if (stamp[b] === q) continue;
      stamp[b] = q;
      if (bOn[b] === 0 || (bFlags[b] & mask) === 0) continue;
      let tmin = -Infinity;
      let tmax = Infinity;
      let axis = 0;
      let t1: number;
      let t2: number;
      // A ray parallel to a slab is inside it on the half-open range [min, max): a ray skimming a top
      // or far face misses the box, and two boxes sharing a face never leave a crack between them.
      if (px) {
        t1 = (bMinX[b] - ox) * ix;
        t2 = (bMaxX[b] - ox) * ix;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        tmin = t1;
        tmax = t2;
      } else if (ox < bMinX[b] || ox >= bMaxX[b]) continue;
      if (py) {
        t1 = (bMinY[b] - oy) * iy;
        t2 = (bMaxY[b] - oy) * iy;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = 1;
        }
        if (t2 < tmax) tmax = t2;
      } else if (oy < bMinY[b] || oy >= bMaxY[b]) continue;
      if (pz) {
        t1 = (bMinZ[b] - oz) * iz;
        t2 = (bMaxZ[b] - oz) * iz;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = 2;
        }
        if (t2 < tmax) tmax = t2;
      } else if (oz < bMinZ[b] || oz >= bMaxZ[b]) continue;

      if (tmin > tmax) continue;
      if (tmin < 0) {
        // Origin inside the box: ignored, unless it sits on the entry face itself and heads inward.
        if (tmin < -RAY_SURFACE_EPS || tmax <= 0) continue;
        tmin = 0;
      }
      if (tmin >= best) continue;
      best = tmin;
      rayBox = b;
      rayAxis = axis;
      raySign = (axis === 0 ? dx : axis === 1 ? dy : dz) > 0 ? -1 : 1;
    }
    f[RAY_T] = best;
  };

  /**
   * Nearest hit of the ray in RAY_OX..RAY_MAX: walks the grid cells along the ray front to back and
   * stops as soon as the next cell starts beyond the best hit. Returns the box or -1; RAY_T holds the
   * distance, rayAxis / raySign the face.
   */
  const castRay = (mask: number): number => {
    rayBox = -1;
    if (count === 0) return -1;
    const ox = f[RAY_OX];
    const oz = f[RAY_OZ];
    const dx = f[RAY_DX];
    const dz = f[RAY_DZ];
    const maxDist = f[RAY_MAX];
    if (!(maxDist > 0) || !(ox === ox && oz === oz && f[RAY_OY] === f[RAY_OY])) return -1;
    if (!(dx === dx && dz === dz && f[RAY_DY] === f[RAY_DY])) return -1;
    f[RAY_T] = maxDist;

    // Clip the ray to the grid rectangle.
    const px = dx > RAY_PARALLEL || dx < -RAY_PARALLEL;
    const pz = dz > RAY_PARALLEL || dz < -RAY_PARALLEL;
    const ix = px ? 1 / dx : 0;
    const iz = pz ? 1 / dz : 0;
    let t0 = 0;
    let t1 = maxDist;
    if (px) {
      let ta = (gMinX - ox) * ix;
      let tb = (gMaxX - ox) * ix;
      if (ta > tb) {
        const t = ta;
        ta = tb;
        tb = t;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else if (ox < gMinX || ox > gMaxX) return -1;
    if (pz) {
      let ta = (gMinZ - oz) * iz;
      let tb = (gMaxZ - oz) * iz;
      if (ta > tb) {
        const t = ta;
        ta = tb;
        tb = t;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    } else if (oz < gMinZ || oz > gMaxZ) return -1;
    if (t0 > t1) return -1;

    const lastCol = gCols - 1;
    const lastRow = gRows - 1;
    let cx = Math.floor((ox + dx * t0 - gMinX) * gInv);
    let cz = Math.floor((oz + dz * t0 - gMinZ) * gInv);
    cx = cx < 0 ? 0 : cx > lastCol ? lastCol : cx;
    cz = cz < 0 ? 0 : cz > lastRow ? lastRow : cz;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    let tMaxX = px ? (gMinX + (cx + (dx > 0 ? 1 : 0)) * gCell - ox) * ix : Infinity;
    let tMaxZ = pz ? (gMinZ + (cz + (dz > 0 ? 1 : 0)) * gCell - oz) * iz : Infinity;
    const tDeltaX = px ? gCell * (ix < 0 ? -ix : ix) : Infinity;
    const tDeltaZ = pz ? gCell * (iz < 0 ? -iz : iz) : Infinity;
    const q = nextQuery();
    for (;;) {
      rayCell(cz * gCols + cx, mask, q);
      const tNext = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tNext > t1 || tNext > f[RAY_T]) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        if (cx < 0 || cx > lastCol) break;
        tMaxX += tDeltaX;
      } else {
        cz += stepZ;
        if (cz < 0 || cz > lastRow) break;
        tMaxZ += tDeltaZ;
      }
    }
    return rayBox;
  };

  const raycast = (origin: Vec3Like, dir: Vec3Like, maxDist: number, mask: number, out: RayHit): boolean => {
    if (gridDirty) rebuild();
    f[RAY_OX] = origin.x;
    f[RAY_OY] = origin.y;
    f[RAY_OZ] = origin.z;
    f[RAY_DX] = dir.x;
    f[RAY_DY] = dir.y;
    f[RAY_DZ] = dir.z;
    f[RAY_MAX] = maxDist;
    const b = castRay(mask);
    if (b < 0) return false;
    const t = f[RAY_T];
    out.distance = t;
    // Plain field writes: a Vector3.set() call that the optimiser declines to inline would box its
    // three arguments.
    const point = out.point;
    point.x = origin.x + dir.x * t;
    point.y = origin.y + dir.y * t;
    point.z = origin.z + dir.z * t;
    const normal = out.normal;
    normal.x = rayAxis === 0 ? raySign : 0;
    normal.y = rayAxis === 1 ? raySign : 0;
    normal.z = rayAxis === 2 ? raySign : 0;
    out.boxId = b;
    out.surface = (boxes[b] as MutableBox).surface;
    return true;
  };

  const lineOfSight = (a: Vec3Like, b: Vec3Like, mask: number = COL.SIGHT): boolean => {
    if (gridDirty) rebuild();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > LOS_END_EPS)) return true;
    f[RAY_OX] = a.x;
    f[RAY_OY] = a.y;
    f[RAY_OZ] = a.z;
    f[RAY_DX] = dx / len;
    f[RAY_DY] = dy / len;
    f[RAY_DZ] = dz / len;
    f[RAY_MAX] = len - LOS_END_EPS;
    return castRay(mask) < 0;
  };

  /**
   * Shared scan of the grid cells under the region Q_X0..Q_Z1 for boxes that overlap it deeper than
   * SKIN. `collect === null` returns the lowest overlapping id (or -1); otherwise the ids are written
   * to the front of `collect` in ascending order and their count is returned (the caller trims).
   */
  const scanOverlap = (mask: number, collect: number[] | null): number => {
    if (count === 0) return collect ? 0 : -1;
    const x0 = f[Q_X0];
    const y0 = f[Q_Y0];
    const z0 = f[Q_Z0];
    const x1 = f[Q_X1];
    const y1 = f[Q_Y1];
    const z1 = f[Q_Z1];
    if (!(x1 >= gMinX && x0 <= gMaxX && z1 >= gMinZ && z0 <= gMaxZ)) return collect ? 0 : -1;
    const lastCol = gCols - 1;
    const lastRow = gRows - 1;
    let cx0 = Math.floor((x0 - gMinX) * gInv);
    let cx1 = Math.floor((x1 - gMinX) * gInv);
    let cz0 = Math.floor((z0 - gMinZ) * gInv);
    let cz1 = Math.floor((z1 - gMinZ) * gInv);
    cx0 = cx0 < 0 ? 0 : cx0 > lastCol ? lastCol : cx0;
    cx1 = cx1 < 0 ? 0 : cx1 > lastCol ? lastCol : cx1;
    cz0 = cz0 < 0 ? 0 : cz0 > lastRow ? lastRow : cz0;
    cz1 = cz1 < 0 ? 0 : cz1 > lastRow ? lastRow : cz1;
    const q = nextQuery();
    let lowest = -1;
    let found = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      let cell = cz * gCols + cx0;
      for (let cx = cx0; cx <= cx1; cx++, cell++) {
        const end = cellStart[cell + 1];
        for (let i = cellStart[cell]; i < end; i++) {
          const b = cellItems[i];
          if (stamp[b] === q) continue;
          stamp[b] = q;
          if (bOn[b] === 0 || (bFlags[b] & mask) === 0) continue;
          if (
            x0 < bMaxX[b] - SKIN &&
            x1 > bMinX[b] + SKIN &&
            y0 < bMaxY[b] - SKIN &&
            y1 > bMinY[b] + SKIN &&
            z0 < bMaxZ[b] - SKIN &&
            z1 > bMinZ[b] + SKIN
          ) {
            if (collect) {
              // Sorted insertion over the caller's existing slots: the array only grows when it must.
              let j = found++;
              if (j === collect.length) collect.push(b);
              while (j > 0 && (collect[j - 1] as number) > b) {
                collect[j] = collect[j - 1] as number;
                j--;
              }
              collect[j] = b;
            } else if (lowest < 0 || b < lowest) lowest = b;
          }
        }
      }
    }
    return collect ? found : lowest;
  };

  const setQueryBox = (box: Aabb): void => {
    f[Q_X0] = box.minX;
    f[Q_Y0] = box.minY;
    f[Q_Z0] = box.minZ;
    f[Q_X1] = box.maxX;
    f[Q_Y1] = box.maxY;
    f[Q_Z1] = box.maxZ;
  };

  const setBoxEnabled = (b: MutableBox, enabled: boolean): void => {
    if (b.enabled === enabled) return;
    b.enabled = enabled;
    bOn[b.id] = enabled ? 1 : 0;
    version++;
  };

  const world: CollisionWorld = {
    addBox(desc: BoxDesc): number {
      let minX = sanitizeCoord(Math.min(desc.minX, desc.maxX));
      let minY = sanitizeCoord(Math.min(desc.minY, desc.maxY));
      let minZ = sanitizeCoord(Math.min(desc.minZ, desc.maxZ));
      let maxX = sanitizeCoord(Math.max(desc.minX, desc.maxX));
      let maxY = sanitizeCoord(Math.max(desc.minY, desc.maxY));
      let maxZ = sanitizeCoord(Math.max(desc.minZ, desc.maxZ));
      if (maxX - minX < MIN_THICKNESS) {
        const c = (minX + maxX) * 0.5;
        minX = c - MIN_THICKNESS * 0.5;
        maxX = c + MIN_THICKNESS * 0.5;
      }
      if (maxY - minY < MIN_THICKNESS) {
        const c = (minY + maxY) * 0.5;
        minY = c - MIN_THICKNESS * 0.5;
        maxY = c + MIN_THICKNESS * 0.5;
      }
      if (maxZ - minZ < MIN_THICKNESS) {
        const c = (minZ + maxZ) * 0.5;
        minZ = c - MIN_THICKNESS * 0.5;
        maxZ = c + MIN_THICKNESS * 0.5;
      }
      const id = count;
      if (id === capacity) growStorage();
      const flags = desc.flags ?? COL.SOLID;
      const tag = desc.tag ?? '';
      boxes.push({
        id,
        minX,
        minY,
        minZ,
        maxX,
        maxY,
        maxZ,
        flags,
        surface: desc.surface ?? 'metal',
        tag,
        decals: desc.decals ?? true,
        enabled: true,
      });
      bMinX[id] = minX;
      bMinY[id] = minY;
      bMinZ[id] = minZ;
      bMaxX[id] = maxX;
      bMaxY[id] = maxY;
      bMaxZ[id] = maxZ;
      bFlags[id] = flags;
      bOn[id] = 1;
      count++;
      let tagged = tagIndex.get(tag);
      if (!tagged) {
        tagged = [];
        tagIndex.set(tag, tagged);
      }
      tagged.push(id);
      gridDirty = true;
      version++;
      return id;
    },
    finalize(): void {
      rebuild();
      version++;
    },
    clear(): void {
      boxes.length = 0;
      tagIndex.clear();
      count = 0;
      rebuild();
      version++;
    },
    setEnabled(id: number, enabled: boolean): void {
      const b = boxes[id];
      if (b) setBoxEnabled(b, enabled);
    },
    setEnabledByTag(tag: string, enabled: boolean): number {
      const tagged = tagIndex.get(tag);
      if (!tagged) return 0;
      for (let i = 0; i < tagged.length; i++) setBoxEnabled(boxes[tagged[i] as number] as MutableBox, enabled);
      return tagged.length;
    },
    get boxes(): readonly CollisionBox[] {
      return boxes;
    },
    bounds,
    get version(): number {
      return version;
    },
    moveAndSlide,
    raycast,
    lineOfSight,
    overlapBox(box: Aabb, mask: number): number {
      if (gridDirty) rebuild();
      setQueryBox(box);
      return scanOverlap(mask, null);
    },
    overlapBoxAll(box: Aabb, mask: number, out: number[]): number {
      if (gridDirty) rebuild();
      setQueryBox(box);
      const found = scanOverlap(mask, out);
      if (out.length !== found) out.length = found;
      return found;
    },
    overlapSphere(center: Vec3Like, radius: number, mask: number): boolean {
      if (gridDirty) rebuild();
      if (count === 0 || !(radius > 0)) return false;
      const x = center.x;
      const y = center.y;
      const z = center.z;
      if (!(x + radius >= gMinX && x - radius <= gMaxX && z + radius >= gMinZ && z - radius <= gMaxZ)) return false;
      const lastCol = gCols - 1;
      const lastRow = gRows - 1;
      let cx0 = Math.floor((x - radius - gMinX) * gInv);
      let cx1 = Math.floor((x + radius - gMinX) * gInv);
      let cz0 = Math.floor((z - radius - gMinZ) * gInv);
      let cz1 = Math.floor((z + radius - gMinZ) * gInv);
      cx0 = cx0 < 0 ? 0 : cx0 > lastCol ? lastCol : cx0;
      cx1 = cx1 < 0 ? 0 : cx1 > lastCol ? lastCol : cx1;
      cz0 = cz0 < 0 ? 0 : cz0 > lastRow ? lastRow : cz0;
      cz1 = cz1 < 0 ? 0 : cz1 > lastRow ? lastRow : cz1;
      const r2 = radius * radius;
      const q = nextQuery();
      for (let cz = cz0; cz <= cz1; cz++) {
        let cell = cz * gCols + cx0;
        for (let cx = cx0; cx <= cx1; cx++, cell++) {
          const end = cellStart[cell + 1];
          for (let i = cellStart[cell]; i < end; i++) {
            const b = cellItems[i];
            if (stamp[b] === q) continue;
            stamp[b] = q;
            if (bOn[b] === 0 || (bFlags[b] & mask) === 0) continue;
            const ex = x < bMinX[b] ? bMinX[b] - x : x > bMaxX[b] ? x - bMaxX[b] : 0;
            const ey = y < bMinY[b] ? bMinY[b] - y : y > bMaxY[b] ? y - bMaxY[b] : 0;
            const ez = z < bMinZ[b] ? bMinZ[b] - z : z > bMaxZ[b] ? z - bMaxZ[b] : 0;
            if (ex * ex + ey * ey + ez * ez < r2) return true;
          }
        }
      }
      return false;
    },
    groundHeight(x: number, z: number, maxY: number, mask: number): number {
      if (gridDirty) rebuild();
      if (count === 0 || !(x >= gMinX && x <= gMaxX && z >= gMinZ && z <= gMaxZ)) return -Infinity;
      let cx = Math.floor((x - gMinX) * gInv);
      let cz = Math.floor((z - gMinZ) * gInv);
      cx = cx > gCols - 1 ? gCols - 1 : cx;
      cz = cz > gRows - 1 ? gRows - 1 : cz;
      const cell = cz * gCols + cx;
      // A top within SKIN above maxY still counts: feet resting on a surface see that surface.
      const limit = maxY + SKIN;
      let top = -Infinity;
      const end = cellStart[cell + 1];
      for (let i = cellStart[cell]; i < end; i++) {
        const b = cellItems[i];
        if (bOn[b] === 0 || (bFlags[b] & mask) === 0) continue;
        if (x < bMinX[b] || x > bMaxX[b] || z < bMinZ[b] || z > bMaxZ[b]) continue;
        const t = bMaxY[b];
        if (t <= limit && t > top) top = t;
      }
      return top;
    },
  };
  return world;
}
