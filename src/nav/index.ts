/**
 * NavGrid: a 2.5D walkability grid (one floor height per cell) built from the collision world.
 *
 *   - Build: every cell gets the box tops under its centre as floor candidates; a candidate survives
 *     when nothing is buried in it and an agent (radius + height) fits on it. A flood fill from the
 *     seeds picks, per cell, the candidate that can be stepped onto from a walkable neighbour, and the
 *     passage between two neighbouring cells is itself checked against the solids (a thin wall on a
 *     cell border separates the cells). The result is an 8-bit link mask per cell.
 *   - Flow field: bucketed integer Dijkstra (Dial) over the link masks, cheap enough to rebuild
 *     whenever the target changes cell. Sampling steers toward the farthest point of the downhill
 *     chain that can be walked to in a straight line with the agent's radius to spare (the target
 *     itself when it is in plain view), so agents cut corners smoothly instead of zig-zagging along
 *     the 8 grid directions, and never brush a wall corner on the way.
 *   - Paths: A* with the same integer costs, then string pulling with the same "wide" line test.
 *   - Hot queries keep their state in typed-array registers and write results field by field:
 *     nothing is allocated per call, whatever the optimiser decides to inline.
 */
import * as THREE from 'three';
import { COL, ZONE_IDS } from '../core/constants';
import type { Aabb, CollisionWorld, NavBuildHints, NavGrid, NavPath, Rng, Vec3Like, ZoneId } from '../core/types';

/** 8 neighbours: E, W, S, N, SE, NE, SW, NW (dx, dz); bit k of a link mask is direction k. */
const NDX = [1, -1, 0, 0, 1, 1, -1, -1];
const NDZ = [0, 0, 1, -1, 1, -1, 1, -1];
const BIT_E = 1;
const BIT_W = 2;
const BIT_S = 4;
const BIT_N = 8;
const BIT_SE = 16;
const BIT_NE = 32;
const BIT_SW = 64;
const BIT_NW = 128;
const ALL_LINKS = 255;

/** Integer step costs of the flow field (17 / 12 = 1.4167, within 0.2 % of sqrt 2). */
const COST_ORTH = 12;
const COST_DIAG = 17;
/** Circular bucket count of the Dial queue: one more than the largest step cost. */
const BUCKETS = COST_DIAG + 1;
const UNREACHED = 0x3fffffff;

const MAX_CANDIDATES = 4;
/** Largest grid edge in cells (the flow field keeps BUCKETS ints per cell: 19 MB at 512 x 512). */
const MAX_GRID_DIM = 512;
/** Vertical / horizontal tolerances of the build (metres). */
const EPS_Y = 1e-3;
const EPS_XZ = 1e-4;
/** A seed picks the floor candidate closest to its height within this distance. */
const SEED_HEIGHT_TOLERANCE = 2;
/** Cells walked along the downhill chain when looking for a straight shortcut. */
const LOOKAHEAD = 24;
/** Snap radii (metres): flow target, off-mesh agents, path end points. */
const TARGET_SNAP_RADIUS = 4;
const OFF_MESH_RADIUS = 3;
const PATH_SNAP_RADIUS = 3;
const ANNULUS_TRIES = 24;
/** How far past a cell border (in cells) the flow aims when it sends an agent through its middle. */
const PORTAL_OVERSHOOT = 0.05;
/** Positions further than this many cells from the grid origin are treated as garbage. */
const MAX_CELL_COORD = 1e9;

// Scratch registers (indices into one Float64Array) for the hot queries.
const L_AX = 0;
const L_AZ = 1;
const L_BX = 2;
const L_BZ = 3;
const N_X = 4;
const N_Z = 5;
const N_R = 6;
const F_AIMX = 7;
const F_AIMZ = 8;
const REGISTER_COUNT = 9;

/** nearestScan modes. */
const ANY_WALKABLE = 0;
const FLOW_REACHABLE = 1;

/**
 * Binary min-heap of (key, cell) pairs on growable typed arrays (A* open list). Keys are small
 * integers so that they cross the call boundary without being boxed.
 */
class MinHeap {
  private keys = new Int32Array(1024);
  private cells = new Int32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(key: number, cell: number): void {
    if (this.size === this.keys.length) {
      const k = new Int32Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const c = new Int32Array(this.size * 2);
      c.set(this.cells);
      this.cells = c;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.cells[i] = this.cells[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.cells[i] = cell;
  }

  pop(): number {
    const top = this.cells[0];
    const n = --this.size;
    if (n > 0) {
      const key = this.keys[n];
      const cell = this.cells[n];
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= n) break;
        if (child + 1 < n && this.keys[child + 1] < this.keys[child]) child++;
        if (this.keys[child] >= key) break;
        this.keys[i] = this.keys[child];
        this.cells[i] = this.cells[child];
        i = child;
      }
      this.keys[i] = key;
      this.cells[i] = cell;
    }
    return top;
  }
}

export function createNavGrid(): NavGrid {
  let cols = 0;
  let rows = 0;
  let cellCount = 0;
  let cellSize = 1;
  let inv = 1;
  let originX = 0;
  let originZ = 0;
  let maxStep = 0.75;
  /** Fraction of a cell: a "wide" line passing this close to a cell corner needs that corner open. */
  let wideMargin = 0.4;
  let version = 0;

  let base = new Uint8Array(0); // walkable in the built grid
  let blocked = new Uint8Array(0); // blocked by setRegionWalkable
  let height = new Float64Array(0);
  let zone = new Int8Array(0);
  let links = new Uint8Array(0); // static link mask from the geometry
  let eff = new Uint8Array(0); // links that are open right now (regions applied)
  let effVersion = -1;
  let region = new Int32Array(0);
  let regionVersion = -1;
  let work = new Int32Array(0); // flood-fill stack / queue

  // Flow field.
  let dist = new Int32Array(0);
  let next = new Int32Array(0);
  let bucketData = new Int32Array(0);
  const bucketSize = new Int32Array(BUCKETS);
  let flowTarget = -1;
  let flowVersion = -1;
  let flowValid = false;
  const chain = new Int32Array(LOOKAHEAD);

  // A* scratch.
  let gScore = new Int32Array(0);
  let cameFrom = new Int32Array(0);
  let stamp = new Int32Array(0);
  let closed = new Uint8Array(0);
  let generation = 0;
  const heap = new MinHeap();
  let cellPath = new Int32Array(256);

  const g = new Float64Array(REGISTER_COUNT);
  let scanExact = false;

  const walk = (c: number): boolean => base[c] === 1 && blocked[c] === 0;

  const cellAt = (x: number, z: number): number => {
    const fx = (x - originX) * inv;
    const fz = (z - originZ) * inv;
    if (!(fx >= 0 && fz >= 0 && fx < cols && fz < rows)) return -1;
    return Math.floor(fz) * cols + Math.floor(fx);
  };

  /** Cell containing the position in (N_X, N_Z), or -1 outside the grid. */
  const cellUnder = (): number => {
    const fx = (g[N_X] - originX) * inv;
    const fz = (g[N_Z] - originZ) * inv;
    if (!(fx >= 0 && fz >= 0 && fx < cols && fz < rows)) return -1;
    return Math.floor(fz) * cols + Math.floor(fx);
  };

  /** Apply the dynamic region blocks to the static link masks. */
  const refreshEff = (): void => {
    effVersion = version;
    const orthSE = BIT_E | BIT_S;
    const orthNE = BIT_E | BIT_N;
    const orthSW = BIT_W | BIT_S;
    const orthNW = BIT_W | BIT_N;
    for (let c = 0; c < cellCount; c++) {
      if (base[c] === 0 || blocked[c] === 1) {
        eff[c] = 0;
        continue;
      }
      const m = links[c];
      let e = 0;
      if ((m & BIT_E) !== 0 && blocked[c + 1] === 0) e |= BIT_E;
      if ((m & BIT_W) !== 0 && blocked[c - 1] === 0) e |= BIT_W;
      if ((m & BIT_S) !== 0 && blocked[c + cols] === 0) e |= BIT_S;
      if ((m & BIT_N) !== 0 && blocked[c - cols] === 0) e |= BIT_N;
      // A diagonal needs both orthogonal corners open too: no cutting past a closed gate.
      if ((m & BIT_SE) !== 0 && (e & orthSE) === orthSE && blocked[c + cols + 1] === 0) e |= BIT_SE;
      if ((m & BIT_NE) !== 0 && (e & orthNE) === orthNE && blocked[c - cols + 1] === 0) e |= BIT_NE;
      if ((m & BIT_SW) !== 0 && (e & orthSW) === orthSW && blocked[c + cols - 1] === 0) e |= BIT_SW;
      if ((m & BIT_NW) !== 0 && (e & orthNW) === orthNW && blocked[c - cols - 1] === 0) e |= BIT_NW;
      eff[c] = e;
    }
  };

  /** Label connected components (diagonals never connect more than the orthogonal links do). */
  const ensureRegions = (): void => {
    if (regionVersion === version) return;
    if (effVersion !== version) refreshEff();
    regionVersion = version;
    region.fill(-1);
    let label = 0;
    for (let start = 0; start < cellCount; start++) {
      if (region[start] !== -1 || !walk(start)) continue;
      region[start] = label;
      let top = 0;
      work[top++] = start;
      while (top > 0) {
        const c = work[--top];
        const e = eff[c];
        if ((e & BIT_E) !== 0 && region[c + 1] === -1) {
          region[c + 1] = label;
          work[top++] = c + 1;
        }
        if ((e & BIT_W) !== 0 && region[c - 1] === -1) {
          region[c - 1] = label;
          work[top++] = c - 1;
        }
        if ((e & BIT_S) !== 0 && region[c + cols] === -1) {
          region[c + cols] = label;
          work[top++] = c + cols;
        }
        if ((e & BIT_N) !== 0 && region[c - cols] === -1) {
          region[c - cols] = label;
          work[top++] = c - cols;
        }
      }
      label++;
    }
  };

  /**
   * Nearest cell centre to (N_X, N_Z) within N_R metres that is walkable (ANY_WALKABLE) or walkable
   * and connected to the flow target (FLOW_REACHABLE). The cell containing the point wins outright;
   * scanExact then says so (positions never travel through call arguments here: a helper taking
   * coordinates would have them boxed whenever it is not inlined).
   */
  const nearestScan = (mode: number): number => {
    const fx = (g[N_X] - originX) * inv;
    const fz = (g[N_Z] - originZ) * inv;
    scanExact = false;
    // NaN, infinities and coordinates too large to count cells with have no nearest cell.
    if (!(fx > -MAX_CELL_COORD && fx < MAX_CELL_COORD && fz > -MAX_CELL_COORD && fz < MAX_CELL_COORD)) return -1;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    if (cx >= 0 && cz >= 0 && cx < cols && cz < rows) {
      const c = cz * cols + cx;
      if (walk(c) && (mode === ANY_WALKABLE || dist[c] < UNREACHED)) {
        scanExact = true;
        return c;
      }
    }
    const maxCells = g[N_R] * inv;
    if (!(maxCells > 0)) return -1;
    // Rings of cells around the point, clipped to the grid: only the rings that touch it are visited,
    // so a far-away point or an absurd radius costs at most one pass over the grid.
    const lastCol = cols - 1;
    const lastRow = rows - 1;
    const first = Math.max(1, -cx, cx - lastCol, -cz, cz - lastRow);
    const last = Math.min(Math.ceil(maxCells) + 1, Math.max(cx, lastCol - cx, cz, lastRow - cz));
    let best = -1;
    let bestD = maxCells * maxCells;
    for (let r = first; r <= last; r++) {
      // No centre of ring r can be closer than r - 0.5 cells.
      const lower = r - 0.5;
      if (lower * lower > bestD) break;
      const z0 = cz - r > 0 ? cz - r : 0;
      const z1 = cz + r < lastRow ? cz + r : lastRow;
      const x0 = cx - r > 0 ? cx - r : 0;
      const x1 = cx + r < lastCol ? cx + r : lastCol;
      for (let nz = z0; nz <= z1; nz++) {
        // Top and bottom rows of the ring are scanned in full, the rows between only at both ends.
        const full = nz === cz - r || nz === cz + r;
        const stride = full ? 1 : 2 * r;
        for (let nx = full ? x0 : cx - r; nx <= x1; nx += stride) {
          if (nx < 0) continue;
          const c = nz * cols + nx;
          if (!walk(c) || (mode !== ANY_WALKABLE && dist[c] >= UNREACHED)) continue;
          const ox = nx + 0.5 - fx;
          const oz = nz + 0.5 - fz;
          const d = ox * ox + oz * oz;
          if (d < bestD || (d === bestD && best < 0)) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    return best;
  };

  /**
   * Walk the segment (L_AX, L_AZ) -> (L_BX, L_BZ) cell by cell and require an open link for every
   * crossing. `wide` additionally requires the diagonal neighbour to be open whenever the segment
   * crosses a cell border close to a corner, which keeps agents with a body off wall corners.
   */
  const lineWalk = (wide: boolean): boolean => {
    const ax = (g[L_AX] - originX) * inv;
    const az = (g[L_AZ] - originZ) * inv;
    const bx = (g[L_BX] - originX) * inv;
    const bz = (g[L_BZ] - originZ) * inv;
    if (!(ax >= 0 && az >= 0 && ax < cols && az < rows && bx >= 0 && bz >= 0 && bx < cols && bz < rows)) return false;
    let cx = Math.floor(ax);
    let cz = Math.floor(az);
    const ex = Math.floor(bx);
    const ez = Math.floor(bz);
    let c = cz * cols + cx;
    if (!walk(c)) return false;
    if (cx === ex && cz === ez) return true;
    if (effVersion !== version) refreshEff();

    const ddx = bx - ax;
    const ddz = bz - az;
    const stepX = ex > cx ? 1 : ex < cx ? -1 : 0;
    const stepZ = ez > cz ? 1 : ez < cz ? -1 : 0;
    let tMaxX = stepX !== 0 ? ((stepX > 0 ? cx + 1 : cx) - ax) / ddx : Infinity;
    let tMaxZ = stepZ !== 0 ? ((stepZ > 0 ? cz + 1 : cz) - az) / ddz : Infinity;
    const tDeltaX = stepX !== 0 ? stepX / ddx : Infinity;
    const tDeltaZ = stepZ !== 0 ? stepZ / ddz : Infinity;
    const margin = wide ? wideMargin : -1;
    const bitX = stepX > 0 ? BIT_E : BIT_W;
    const bitZ = stepZ > 0 ? BIT_S : BIT_N;
    const stepC = stepZ * cols;

    while (cx !== ex || cz !== ez) {
      const e = eff[c];
      if (cz === ez || (cx !== ex && tMaxX < tMaxZ - 1e-9)) {
        // Cross the border to the next column.
        if ((e & bitX) === 0) return false;
        if (margin > 0) {
          const along = az + ddz * tMaxX - cz;
          if (along < margin) {
            if ((e & (stepX > 0 ? BIT_NE : BIT_NW)) === 0) return false;
          } else if (along > 1 - margin && (e & (stepX > 0 ? BIT_SE : BIT_SW)) === 0) return false;
        }
        cx += stepX;
        c += stepX;
        tMaxX += tDeltaX;
      } else if (cx === ex || tMaxZ < tMaxX - 1e-9) {
        // Cross the border to the next row.
        if ((e & bitZ) === 0) return false;
        if (margin > 0) {
          const along = ax + ddx * tMaxZ - cx;
          if (along < margin) {
            if ((e & (stepZ > 0 ? BIT_SW : BIT_NW)) === 0) return false;
          } else if (along > 1 - margin && (e & (stepZ > 0 ? BIT_SE : BIT_NE)) === 0) return false;
        }
        cz += stepZ;
        c += stepC;
        tMaxZ += tDeltaZ;
      } else {
        // Exactly through a corner: a diagonal move.
        const bit = stepX > 0 ? (stepZ > 0 ? BIT_SE : BIT_NE) : stepZ > 0 ? BIT_SW : BIT_NW;
        if ((e & bit) === 0) return false;
        cx += stepX;
        cz += stepZ;
        c += stepX + stepC;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      }
    }
    return true;
  };

  /** Dial's algorithm from flowTarget over the open links: integer distances, parent = next cell downhill. */
  const computeFlow = (): void => {
    flowVersion = version;
    flowValid = false;
    dist.fill(UNREACHED);
    next.fill(-1);
    if (flowTarget < 0 || flowTarget >= cellCount || !walk(flowTarget)) return;
    if (effVersion !== version) refreshEff();
    flowValid = true;
    bucketSize.fill(0);
    const n = cellCount;
    const w = cols;
    dist[flowTarget] = 0;
    bucketData[0] = flowTarget;
    bucketSize[0] = 1;
    let pending = 1;
    for (let d = 0; pending > 0; d++) {
      const bi = d % BUCKETS;
      const size = bucketSize[bi];
      if (size === 0) continue;
      const off = bi * n;
      const dOrth = d + COST_ORTH;
      const dDiag = d + COST_DIAG;
      const bOrth = dOrth % BUCKETS;
      const bDiag = dDiag % BUCKETS;
      // Steps cost 12..17, so nothing is ever pushed into the bucket being drained.
      for (let i = 0; i < size; i++) {
        const c = bucketData[off + i];
        if (dist[c] !== d) continue; // superseded by a shorter route
        const e = eff[c];
        let nb: number;
        if ((e & BIT_E) !== 0 && dOrth < dist[(nb = c + 1)]) {
          dist[nb] = dOrth;
          next[nb] = c;
          bucketData[bOrth * n + bucketSize[bOrth]++] = nb;
          pending++;
        }
        if ((e & BIT_W) !== 0 && dOrth < dist[(nb = c - 1)]) {
          dist[nb] = dOrth;
          next[nb] = c;
          bucketData[bOrth * n + bucketSize[bOrth]++] = nb;
          pending++;
        }
        if ((e & BIT_S) !== 0 && dOrth < dist[(nb = c + w)]) {
          dist[nb] = dOrth;
          next[nb] = c;
          bucketData[bOrth * n + bucketSize[bOrth]++] = nb;
          pending++;
        }
        if ((e & BIT_N) !== 0 && dOrth < dist[(nb = c - w)]) {
          dist[nb] = dOrth;
          next[nb] = c;
          bucketData[bOrth * n + bucketSize[bOrth]++] = nb;
          pending++;
        }
        if ((e & BIT_SE) !== 0 && dDiag < dist[(nb = c + w + 1)]) {
          dist[nb] = dDiag;
          next[nb] = c;
          bucketData[bDiag * n + bucketSize[bDiag]++] = nb;
          pending++;
        }
        if ((e & BIT_NE) !== 0 && dDiag < dist[(nb = c - w + 1)]) {
          dist[nb] = dDiag;
          next[nb] = c;
          bucketData[bDiag * n + bucketSize[bDiag]++] = nb;
          pending++;
        }
        if ((e & BIT_SW) !== 0 && dDiag < dist[(nb = c + w - 1)]) {
          dist[nb] = dDiag;
          next[nb] = c;
          bucketData[bDiag * n + bucketSize[bDiag]++] = nb;
          pending++;
        }
        if ((e & BIT_NW) !== 0 && dDiag < dist[(nb = c - w - 1)]) {
          dist[nb] = dDiag;
          next[nb] = c;
          bucketData[bDiag * n + bucketSize[bDiag]++] = nb;
          pending++;
        }
      }
      pending -= size;
      bucketSize[bi] = 0;
    }
  };

  /** True when a current flow field exists (recomputing it if a region toggle made it stale). */
  const ensureFlow = (): boolean => {
    if (flowTarget < 0) return false;
    if (flowVersion !== version) computeFlow();
    return flowValid;
  };

  /** Next free waypoint of a path buffer (grown on demand); the caller fills it in. */
  const nextPoint = (out: NavPath): THREE.Vector3 => {
    if (out.count >= out.points.length) out.points.push(new THREE.Vector3());
    return out.points[out.count++] as THREE.Vector3;
  };

  const grid: NavGrid = {
    build(collision: CollisionWorld, hints: NavBuildHints): void {
      cellSize = hints.cellSize > 0 ? hints.cellSize : 1;
      inv = 1 / cellSize;
      maxStep = hints.maxStep > 0 ? hints.maxStep : 0;
      const agentR = hints.agentRadius > 0 ? hints.agentRadius : 0;
      const agentH = hints.agentHeight > 0 ? hints.agentHeight : 1;
      originX = hints.bounds.minX;
      originZ = hints.bounds.minZ;
      const spanX = Math.ceil((hints.bounds.maxX - originX) * inv - 1e-6);
      const spanZ = Math.ceil((hints.bounds.maxZ - originZ) * inv - 1e-6);
      cols = spanX >= 1 ? Math.min(spanX, MAX_GRID_DIM) : 1;
      rows = spanZ >= 1 ? Math.min(spanZ, MAX_GRID_DIM) : 1;
      const n = cols * rows;
      cellCount = n;
      wideMargin = Math.min(0.45, Math.max(0.1, agentR * inv));

      base = new Uint8Array(n);
      blocked = new Uint8Array(n);
      height = new Float64Array(n);
      zone = new Int8Array(n).fill(-1);
      links = new Uint8Array(n);
      eff = new Uint8Array(n);
      region = new Int32Array(n).fill(-1);
      work = new Int32Array(n);
      dist = new Int32Array(n).fill(UNREACHED);
      next = new Int32Array(n).fill(-1);
      bucketData = new Int32Array(n * BUCKETS);
      gScore = new Int32Array(n);
      cameFrom = new Int32Array(n);
      stamp = new Int32Array(n);
      closed = new Uint8Array(n);
      generation = 0;
      flowTarget = -1;
      flowValid = false;

      // --- 1. Solids: enabled ENEMY-blocking boxes minus the ignored tags (gates). ---
      const ignore = new Set(hints.ignoreTags);
      const source = collision.boxes;
      const sMinX = new Float64Array(source.length);
      const sMinY = new Float64Array(source.length);
      const sMinZ = new Float64Array(source.length);
      const sMaxX = new Float64Array(source.length);
      const sMaxY = new Float64Array(source.length);
      const sMaxZ = new Float64Array(source.length);
      let solids = 0;
      for (const b of source) {
        if (!b.enabled || (b.flags & COL.ENEMY) === 0 || ignore.has(b.tag)) continue;
        sMinX[solids] = b.minX;
        sMinY[solids] = b.minY;
        sMinZ[solids] = b.minZ;
        sMaxX[solids] = b.maxX;
        sMaxY[solids] = b.maxY;
        sMaxZ[solids] = b.maxZ;
        solids++;
      }

      // --- 2. Buckets: per cell, the solids within agent radius of the cell rectangle. ---
      const pad = agentR + 0.01;
      const bStart = new Int32Array(n + 1);
      const rangeOf = (s: number, out: Int32Array): boolean => {
        const x0 = Math.floor((sMinX[s] - pad - originX) * inv);
        const x1 = Math.floor((sMaxX[s] + pad - originX) * inv);
        const z0 = Math.floor((sMinZ[s] - pad - originZ) * inv);
        const z1 = Math.floor((sMaxZ[s] + pad - originZ) * inv);
        if (x1 < 0 || z1 < 0 || x0 >= cols || z0 >= rows) return false;
        out[0] = x0 < 0 ? 0 : x0;
        out[1] = x1 >= cols ? cols - 1 : x1;
        out[2] = z0 < 0 ? 0 : z0;
        out[3] = z1 >= rows ? rows - 1 : z1;
        return true;
      };
      const range = new Int32Array(4);
      for (let s = 0; s < solids; s++) {
        if (!rangeOf(s, range)) continue;
        for (let cz = range[2]; cz <= range[3]; cz++) {
          for (let cx = range[0]; cx <= range[1]; cx++) bStart[cz * cols + cx + 1]++;
        }
      }
      for (let c = 0; c < n; c++) bStart[c + 1] += bStart[c];
      const bItems = new Int32Array(bStart[n]);
      const cursor = bStart.slice(0, n);
      for (let s = 0; s < solids; s++) {
        if (!rangeOf(s, range)) continue;
        for (let cz = range[2]; cz <= range[3]; cz++) {
          for (let cx = range[0]; cx <= range[1]; cx++) bItems[cursor[cz * cols + cx]++] = s;
        }
      }

      const centreX = (c: number): number => originX + ((c % cols) + 0.5) * cellSize;
      const centreZ = (c: number): number => originZ + (Math.floor(c / cols) + 0.5) * cellSize;

      // --- 3. Hard-blocked regions never get a floor. ---
      const hardBlocked = new Uint8Array(n);
      for (const area of hints.blocked) {
        const x0 = Math.max(0, Math.floor((area.minX - originX) * inv - 0.5));
        const x1 = Math.min(cols - 1, Math.ceil((area.maxX - originX) * inv - 0.5));
        const z0 = Math.max(0, Math.floor((area.minZ - originZ) * inv - 0.5));
        const z1 = Math.min(rows - 1, Math.ceil((area.maxZ - originZ) * inv - 0.5));
        for (let cz = z0; cz <= z1; cz++) {
          for (let cx = x0; cx <= x1; cx++) {
            const c = cz * cols + cx;
            const px = centreX(c);
            const pz = centreZ(c);
            if (px >= area.minX && px <= area.maxX && pz >= area.minZ && pz <= area.maxZ) hardBlocked[c] = 1;
          }
        }
      }

      // --- 4. Floor candidates: box tops under the cell centre an agent can stand on. ---
      const cand = new Float64Array(n * MAX_CANDIDATES);
      const candCount = new Uint8Array(n);
      /** Nothing buried in the floor at the centre, and the agent volume above it is free. */
      const standable = (c: number, px: number, pz: number, top: number, self: number): boolean => {
        for (let j = bStart[c]; j < bStart[c + 1]; j++) {
          const o = bItems[j];
          if (o === self) continue;
          const oTop = sMaxY[o];
          if (oTop <= top + EPS_Y) continue; // at or below this floor
          const oBottom = sMinY[o];
          if (oBottom <= top + EPS_Y && px >= sMinX[o] && px <= sMaxX[o] && pz >= sMinZ[o] && pz <= sMaxZ[o]) {
            return false; // the floor continues inside another box here
          }
          // Obstacles up to maxStep high are steppable and do not take the space away.
          if (
            oTop > top + maxStep + EPS_Y &&
            oBottom < top + agentH - EPS_Y &&
            px + agentR > sMinX[o] + EPS_XZ &&
            px - agentR < sMaxX[o] - EPS_XZ &&
            pz + agentR > sMinZ[o] + EPS_XZ &&
            pz - agentR < sMaxZ[o] - EPS_XZ
          ) {
            return false;
          }
        }
        return true;
      };
      for (let c = 0; c < n; c++) {
        if (hardBlocked[c] === 1) continue;
        const px = centreX(c);
        const pz = centreZ(c);
        for (let i = bStart[c]; i < bStart[c + 1]; i++) {
          const s = bItems[i];
          if (px < sMinX[s] || px > sMaxX[s] || pz < sMinZ[s] || pz > sMaxZ[s]) continue;
          const top = sMaxY[s];
          const have = candCount[c];
          if (have >= MAX_CANDIDATES) break;
          let duplicate = false;
          for (let k = 0; k < have; k++) {
            if (Math.abs(cand[c * MAX_CANDIDATES + k] - top) <= EPS_Y) duplicate = true;
          }
          if (duplicate || !standable(c, px, pz, top, s)) continue;
          cand[c * MAX_CANDIDATES + have] = top;
          candCount[c] = have + 1;
        }
      }

      // --- 5. Passage tests between neighbouring cells. ---
      /** Is the box [x0,x1] x [z0,z1] free of solids between floorY + maxStep and floorY + agentH? */
      const regionFree = (a: number, b: number, x0: number, x1: number, z0: number, z1: number, floorY: number): boolean => {
        const lo = floorY + maxStep + EPS_Y;
        const hi = floorY + agentH - EPS_Y;
        for (let pass = 0; pass < 2; pass++) {
          const c = pass === 0 ? a : b;
          for (let j = bStart[c]; j < bStart[c + 1]; j++) {
            const o = bItems[j];
            if (sMaxY[o] > lo && sMinY[o] < hi && sMaxX[o] > x0 && sMinX[o] < x1 && sMaxZ[o] > z0 && sMinZ[o] < z1) {
              return false;
            }
          }
        }
        return true;
      };
      /** Can the agent slide from the centre of `a` to the centre of the orthogonal neighbour `b`? */
      const edgeFree = (a: number, b: number, floorY: number): boolean => {
        const ax = centreX(a);
        const az = centreZ(a);
        const bx = centreX(b);
        const bz = centreZ(b);
        const reach = agentR - EPS_XZ;
        return regionFree(
          a,
          b,
          Math.min(ax, bx) - reach,
          Math.max(ax, bx) + reach,
          Math.min(az, bz) - reach,
          Math.max(az, bz) + reach,
          floorY,
        );
      };

      // --- 6. Flood fill from the seeds: only floors that can be stepped onto become walkable. ---
      const queue = work;
      let tail = 0;
      const pickSeed = (c: number, wantY: number): boolean => {
        let bestI = -1;
        let bestD = SEED_HEIGHT_TOLERANCE;
        for (let i = 0; i < candCount[c]; i++) {
          const d = Math.abs(cand[c * MAX_CANDIDATES + i] - wantY);
          if (d <= bestD) {
            bestD = d;
            bestI = i;
          }
        }
        if (bestI < 0) return false;
        base[c] = 1;
        height[c] = cand[c * MAX_CANDIDATES + bestI];
        queue[tail++] = c;
        return true;
      };
      for (const seed of hints.seeds) {
        const fx = (seed.x - originX) * inv;
        const fz = (seed.z - originZ) * inv;
        if (!(fx === fx && fz === fz)) continue;
        const sx = Math.floor(fx);
        const sz = Math.floor(fz);
        // The seed cell itself, else the closest standable cell in a small neighbourhood.
        let seeded = false;
        for (let r = 0; r <= 2 && !seeded; r++) {
          for (let dz = -r; dz <= r && !seeded; dz++) {
            for (let dx = -r; dx <= r && !seeded; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const nx = sx + dx;
              const nz = sz + dz;
              if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
              const c = nz * cols + nx;
              seeded = base[c] === 1 || pickSeed(c, seed.y);
            }
          }
        }
      }
      for (let head = 0; head < tail; head++) {
        const c = queue[head];
        const cx = c % cols;
        const cz = (c - cx) / cols;
        const hc = height[c];
        for (let k = 0; k < 4; k++) {
          const nx = cx + (NDX[k] as number);
          const nz = cz + (NDZ[k] as number);
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
          const nb = nz * cols + nx;
          if (base[nb] === 1) continue;
          let bestI = -1;
          let bestD = maxStep + 1e-6;
          for (let i = 0; i < candCount[nb]; i++) {
            const top = cand[nb * MAX_CANDIDATES + i];
            const d = Math.abs(top - hc);
            if (d <= bestD && edgeFree(c, nb, Math.max(top, hc))) {
              bestD = d;
              bestI = i;
            }
          }
          if (bestI < 0) continue;
          base[nb] = 1;
          height[nb] = cand[nb * MAX_CANDIDATES + bestI];
          queue[tail++] = nb;
        }
      }

      // --- 7. Link masks. ---
      const stepOk = (a: number, b: number): boolean => Math.abs(height[a] - height[b]) <= maxStep + 1e-6;
      for (let c = 0; c < n; c++) {
        if (base[c] === 0) continue;
        const cx = c % cols;
        if (cx + 1 < cols && base[c + 1] === 1 && stepOk(c, c + 1) && edgeFree(c, c + 1, Math.max(height[c], height[c + 1]))) {
          links[c] |= BIT_E;
          links[c + 1] |= BIT_W;
        }
        if (c + cols < n && base[c + cols] === 1 && stepOk(c, c + cols) && edgeFree(c, c + cols, Math.max(height[c], height[c + cols]))) {
          links[c] |= BIT_S;
          links[c + cols] |= BIT_N;
        }
      }
      // A diagonal is open when both L-shaped detours are, and the little square between the four
      // agent footprints (only there when the cell is wider than the agent) holds no pole.
      const hole = cellSize - 2 * agentR;
      const diagonalFree = (a: number, b: number, corner1: number, corner2: number): boolean => {
        if (!stepOk(a, b)) return false;
        if (hole <= 2 * EPS_XZ) return true;
        const floorY = Math.max(height[a], height[b], height[corner1], height[corner2]);
        const x0 = Math.min(centreX(a), centreX(b)) + agentR;
        const z0 = Math.min(centreZ(a), centreZ(b)) + agentR;
        return regionFree(a, b, x0 + EPS_XZ, x0 + hole - EPS_XZ, z0 + EPS_XZ, z0 + hole - EPS_XZ, floorY);
      };
      for (let c = 0; c < n; c++) {
        if (base[c] === 0) continue;
        const m = links[c];
        if ((m & BIT_E) === 0) continue;
        const east = c + 1;
        // South-east: c -> E -> S and c -> S -> E.
        if ((m & BIT_S) !== 0) {
          const south = c + cols;
          const se = south + 1;
          if ((links[east] & BIT_S) !== 0 && (links[south] & BIT_E) !== 0 && diagonalFree(c, se, east, south)) {
            links[c] |= BIT_SE;
            links[se] |= BIT_NW;
          }
        }
        // North-east: c -> E -> N and c -> N -> E.
        if ((m & BIT_N) !== 0) {
          const north = c - cols;
          const ne = north + 1;
          if ((links[east] & BIT_N) !== 0 && (links[north] & BIT_E) !== 0 && diagonalFree(c, ne, east, north)) {
            links[c] |= BIT_NE;
            links[ne] |= BIT_SW;
          }
        }
      }

      // --- 8. Zone labels (first match wins). ---
      for (let c = 0; c < n; c++) {
        const px = centreX(c);
        const pz = centreZ(c);
        for (const z of hints.zones) {
          if (px >= z.aabb.minX && px <= z.aabb.maxX && pz >= z.aabb.minZ && pz <= z.aabb.maxZ) {
            zone[c] = ZONE_IDS.indexOf(z.id);
            break;
          }
        }
      }

      version++;
      effVersion = -1;
      regionVersion = -1;
      flowVersion = -1;
      for (const closedRegion of hints.closedRegions) grid.setRegionWalkable(closedRegion, false);
    },

    get cols(): number {
      return cols;
    },
    get rows(): number {
      return rows;
    },
    get cellSize(): number {
      return cellSize;
    },
    get originX(): number {
      return originX;
    },
    get originZ(): number {
      return originZ;
    },
    get version(): number {
      return version;
    },

    cellAt,
    cellCenter(cell: number, out: THREE.Vector3): THREE.Vector3 {
      // Plain field writes throughout this file: Vector3.set() boxes its arguments whenever the
      // optimiser declines to inline it.
      if (!(cell >= 0 && cell < cellCount)) {
        out.x = originX;
        out.y = 0;
        out.z = originZ;
        return out;
      }
      const cx = cell % cols;
      const cz = (cell - cx) / cols;
      out.x = originX + (cx + 0.5) * cellSize;
      out.y = height[cell];
      out.z = originZ + (cz + 0.5) * cellSize;
      return out;
    },
    isWalkable(x: number, z: number): boolean {
      const c = cellAt(x, z);
      return c >= 0 && walk(c);
    },
    heightAt(x: number, z: number, fallback = 0): number {
      const c = cellAt(x, z);
      return c >= 0 && walk(c) ? height[c] : fallback;
    },
    zoneAt(x: number, z: number): ZoneId | null {
      const c = cellAt(x, z);
      if (c < 0) return null;
      const i = zone[c];
      return i >= 0 ? (ZONE_IDS[i] as ZoneId) : null;
    },
    nearestWalkable(pos: Vec3Like, maxRadius: number, out: THREE.Vector3): boolean {
      g[N_X] = pos.x;
      g[N_Z] = pos.z;
      g[N_R] = maxRadius;
      const c = nearestScan(ANY_WALKABLE);
      if (c < 0) return false;
      grid.cellCenter(c, out);
      return true;
    },
    setRegionWalkable(area: Aabb, walkable: boolean): void {
      const value = walkable ? 0 : 1;
      const x0 = Math.max(0, Math.floor((area.minX - originX) * inv - 0.5));
      const x1 = Math.min(cols - 1, Math.ceil((area.maxX - originX) * inv - 0.5));
      const z0 = Math.max(0, Math.floor((area.minZ - originZ) * inv - 0.5));
      const z1 = Math.min(rows - 1, Math.ceil((area.maxZ - originZ) * inv - 0.5));
      let changed = false;
      for (let cz = z0; cz <= z1; cz++) {
        const pz = originZ + (cz + 0.5) * cellSize;
        if (pz < area.minZ || pz > area.maxZ) continue;
        for (let cx = x0; cx <= x1; cx++) {
          const px = originX + (cx + 0.5) * cellSize;
          if (px < area.minX || px > area.maxX) continue;
          const c = cz * cols + cx;
          if (blocked[c] !== value) {
            blocked[c] = value;
            changed = true;
          }
        }
      }
      if (changed) version++;
    },
    isReachable(a: Vec3Like, b: Vec3Like): boolean {
      g[N_X] = a.x;
      g[N_Z] = a.z;
      g[N_R] = PATH_SNAP_RADIUS;
      const ca = nearestScan(ANY_WALKABLE);
      if (ca < 0) return false;
      g[N_X] = b.x;
      g[N_Z] = b.z;
      const cb = nearestScan(ANY_WALKABLE);
      if (cb < 0) return false;
      ensureRegions();
      return region[ca] === region[cb];
    },

    updateFlowField(target: Vec3Like): boolean {
      g[N_X] = target.x;
      g[N_Z] = target.z;
      g[N_R] = TARGET_SNAP_RADIUS;
      const cell = nearestScan(ANY_WALKABLE);
      // A target far from any floor (falling, out of bounds) keeps the last valid field alive.
      if (cell < 0) return false;
      if (scanExact) {
        g[F_AIMX] = target.x;
        g[F_AIMZ] = target.z;
      } else {
        const cx = cell % cols;
        g[F_AIMX] = originX + (cx + 0.5) * cellSize;
        g[F_AIMZ] = originZ + ((cell - cx) / cols + 0.5) * cellSize;
      }
      if (cell === flowTarget && flowVersion === version) return false;
      flowTarget = cell;
      computeFlow();
      return true;
    },
    sampleFlow(pos: Vec3Like, out: THREE.Vector3): boolean {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      if (!ensureFlow()) return false;
      const x = pos.x;
      const z = pos.z;
      const fx = (x - originX) * inv;
      const fz = (z - originZ) * inv;
      if (!(fx === fx && fz === fz)) return false;
      let tx: number;
      let tz: number;
      const inside = fx >= 0 && fz >= 0 && fx < cols && fz < rows;
      const c = inside ? Math.floor(fz) * cols + Math.floor(fx) : -1;
      if (c < 0 || !walk(c)) {
        // Off the mesh (shoved into a blocked cell, standing in a closed gate): head back to the
        // nearest cell that leads to the target.
        g[N_X] = x;
        g[N_Z] = z;
        g[N_R] = OFF_MESH_RADIUS;
        const back = nearestScan(FLOW_REACHABLE);
        if (back < 0) return false;
        const bx = back % cols;
        tx = originX + (bx + 0.5) * cellSize;
        tz = originZ + ((back - bx) / cols + 0.5) * cellSize;
      } else if (dist[c] >= UNREACHED) {
        return false;
      } else if (c === flowTarget) {
        tx = g[F_AIMX];
        tz = g[F_AIMZ];
      } else {
        g[L_AX] = x;
        g[L_AZ] = z;
        g[L_BX] = g[F_AIMX];
        g[L_BZ] = g[F_AIMZ];
        if (lineWalk(true)) {
          // The target is in plain view: walk straight at it.
          tx = g[F_AIMX];
          tz = g[F_AIMZ];
        } else {
          // Follow the downhill chain and aim at the farthest link reachable in a straight line.
          let count = 0;
          let cursor = c;
          while (count < LOOKAHEAD) {
            const n = next[cursor];
            if (n < 0) break;
            chain[count++] = n;
            if (n === flowTarget) break;
            cursor = n;
          }
          if (count === 0) return false;
          let pick = 0;
          if (count > 1) {
            let hi = count - 1;
            let aim = chain[hi];
            let ax = aim % cols;
            g[L_BX] = aim === flowTarget ? g[F_AIMX] : originX + (ax + 0.5) * cellSize;
            g[L_BZ] = aim === flowTarget ? g[F_AIMZ] : originZ + ((aim - ax) / cols + 0.5) * cellSize;
            if (lineWalk(true)) pick = hi;
            else {
              // Bisect between the visible near end and the hidden far end.
              let lo = 0;
              while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                aim = chain[mid];
                ax = aim % cols;
                g[L_BX] = originX + (ax + 0.5) * cellSize;
                g[L_BZ] = originZ + ((aim - ax) / cols + 0.5) * cellSize;
                if (lineWalk(true)) lo = mid;
                else hi = mid;
              }
              pick = lo;
            }
          }
          const aim = chain[pick];
          const ax = aim % cols;
          const az = (aim - ax) / cols;
          tx = originX + (ax + 0.5) * cellSize;
          tz = originZ + (az + 0.5) * cellSize;
          if (pick > 0) {
            if (aim === flowTarget) {
              tx = g[F_AIMX];
              tz = g[F_AIMZ];
            }
          } else {
            // Only the next cell is left. Its centre is fine when it can be walked to with clearance
            // (the target, when it lies in that cell, is already known not to be). Otherwise the
            // agent sits too close to a corner for any straight shot: cross into the next cell
            // through the middle of the shared border (the shared corner for a diagonal step).
            let direct = aim !== flowTarget;
            if (direct) {
              g[L_BX] = tx;
              g[L_BZ] = tz;
              direct = lineWalk(true);
            }
            if (!direct) {
              const cx = c % cols;
              const cz = (c - cx) / cols;
              const reach = (0.5 + PORTAL_OVERSHOOT) * cellSize;
              tx = originX + (cx + 0.5) * cellSize + (ax - cx) * reach;
              tz = originZ + (cz + 0.5) * cellSize + (az - cz) * reach;
            }
          }
        }
      }
      const dx = tx - x;
      const dz = tz - z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-6) {
        out.x = dx / len;
        out.z = dz / len;
      }
      return true;
    },
    flowDistance(pos: Vec3Like): number {
      if (!ensureFlow()) return Infinity;
      // On the mesh: the cell under the position (Infinity when it cannot reach the target). Off the
      // mesh: measured from the cell sampleFlow steers back to.
      g[N_X] = pos.x;
      g[N_Z] = pos.z;
      let c = cellUnder();
      if (c < 0 || !walk(c)) {
        g[N_R] = OFF_MESH_RADIUS;
        c = nearestScan(FLOW_REACHABLE);
      }
      if (c < 0 || dist[c] >= UNREACHED) return Infinity;
      return (dist[c] * cellSize) / COST_ORTH;
    },

    findPath(from: Vec3Like, to: Vec3Like, out: NavPath): boolean {
      out.count = 0;
      g[N_X] = from.x;
      g[N_Z] = from.z;
      g[N_R] = PATH_SNAP_RADIUS;
      const start = nearestScan(ANY_WALKABLE);
      if (start < 0) return false;
      const startWasExact = scanExact;
      g[N_X] = to.x;
      g[N_Z] = to.z;
      const goal = nearestScan(ANY_WALKABLE);
      if (goal < 0) return false;
      const goalWasExact = scanExact;
      ensureRegions();
      if (region[start] !== region[goal]) return false;

      // --- A* over the open links: the integer step costs of the flow field, octile heuristic. ---
      if (++generation >= UNREACHED) {
        stamp.fill(0);
        generation = 1;
      }
      const goalX = goal % cols;
      const goalZ = (goal - goalX) / cols;
      const extra = COST_DIAG - COST_ORTH;
      heap.clear();
      stamp[start] = generation;
      closed[start] = 0;
      gScore[start] = 0;
      cameFrom[start] = -1;
      heap.push(0, start);
      let found = false;
      while (heap.size > 0) {
        const c = heap.pop();
        if (c === goal) {
          found = true;
          break;
        }
        if (closed[c] === 1) continue;
        closed[c] = 1;
        const e = eff[c];
        const gc = gScore[c];
        const cx = c % cols;
        const cz = (c - cx) / cols;
        for (let k = 0; k < 8; k++) {
          if ((e & (1 << k)) === 0) continue;
          const dx = NDX[k] as number;
          const dz = NDZ[k] as number;
          const nb = c + dz * cols + dx;
          if (stamp[nb] !== generation) {
            stamp[nb] = generation;
            closed[nb] = 0;
            gScore[nb] = UNREACHED;
          }
          if (closed[nb] === 1) continue;
          const cost = gc + (k < 4 ? COST_ORTH : COST_DIAG);
          if (cost >= gScore[nb]) continue;
          gScore[nb] = cost;
          cameFrom[nb] = c;
          let hx = cx + dx - goalX;
          let hz = cz + dz - goalZ;
          if (hx < 0) hx = -hx;
          if (hz < 0) hz = -hz;
          heap.push(cost + COST_ORTH * (hx > hz ? hx : hz) + extra * (hx < hz ? hx : hz), nb);
        }
      }
      if (!found) return false;

      // --- Reconstruct start -> goal. ---
      let length = 0;
      for (let c = goal; c !== -1; c = cameFrom[c]) length++;
      if (length > cellPath.length) cellPath = new Int32Array(Math.max(length, cellPath.length * 2));
      let write = length;
      for (let c = goal; c !== -1; c = cameFrom[c]) cellPath[--write] = c;

      // --- String pulling. Candidates are every cell centre of the path, then the end point. From
      //     the last kept point (the anchor) take the end if it is in plain view, otherwise the
      //     farthest candidate that is, found by bisection: the candidate right after the anchor is
      //     always visible, so every round keeps one waypoint and moves on. ---
      const startCX = start % cols;
      g[L_AX] = startWasExact ? from.x : originX + (startCX + 0.5) * cellSize;
      g[L_AZ] = startWasExact ? from.z : originZ + ((start - startCX) / cols + 0.5) * cellSize;
      const endX = goalWasExact ? to.x : originX + (goalX + 0.5) * cellSize;
      const endZ = goalWasExact ? to.z : originZ + (goalZ + 0.5) * cellSize;
      let anchor = -1;
      for (;;) {
        g[L_BX] = endX;
        g[L_BZ] = endZ;
        if (lineWalk(true)) break;
        let lo = anchor + 1;
        let hi = length;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          const cell = cellPath[mid];
          const cx = cell % cols;
          g[L_BX] = originX + (cx + 0.5) * cellSize;
          g[L_BZ] = originZ + ((cell - cx) / cols + 0.5) * cellSize;
          if (lineWalk(true)) lo = mid;
          else hi = mid;
        }
        const cell = cellPath[lo];
        const cx = cell % cols;
        const corner = nextPoint(out);
        corner.x = originX + (cx + 0.5) * cellSize;
        corner.y = height[cell];
        corner.z = originZ + ((cell - cx) / cols + 0.5) * cellSize;
        g[L_AX] = corner.x;
        g[L_AZ] = corner.z;
        anchor = lo;
        // The goal cell's own centre always sees the end point: the next round ends the loop.
      }
      const last = nextPoint(out);
      last.x = endX;
      last.y = height[goal];
      last.z = endZ;
      return true;
    },
    randomPointInAnnulus(center: Vec3Like, minRadius: number, maxRadius: number, rng: Rng, out: THREE.Vector3): boolean {
      g[N_X] = center.x;
      g[N_Z] = center.z;
      g[N_R] = PATH_SNAP_RADIUS;
      const origin = nearestScan(ANY_WALKABLE);
      if (origin < 0) return false;
      ensureRegions();
      const lo = minRadius > 0 ? minRadius : 0;
      const hi = maxRadius > lo ? maxRadius : lo;
      for (let i = 0; i < ANNULUS_TRIES; i++) {
        const angle = rng.range(0, Math.PI * 2);
        const radius = Math.sqrt(rng.range(lo * lo, hi * hi));
        let x = center.x + Math.cos(angle) * radius;
        let z = center.z + Math.sin(angle) * radius;
        g[N_X] = x;
        g[N_Z] = z;
        const c = cellUnder();
        if (c < 0 || !walk(c) || region[c] !== region[origin]) continue;
        if (eff[c] !== ALL_LINKS) {
          // Next to an obstacle or a ledge only the cell centre is known to have clearance.
          const cx = c % cols;
          x = originX + (cx + 0.5) * cellSize;
          z = originZ + ((c - cx) / cols + 0.5) * cellSize;
          const d = Math.hypot(x - center.x, z - center.z);
          if (d < lo || d > hi) continue;
        }
        out.x = x;
        out.y = height[c];
        out.z = z;
        return true;
      }
      return false;
    },
    isLineWalkable(a: Vec3Like, b: Vec3Like): boolean {
      g[L_AX] = a.x;
      g[L_AZ] = a.z;
      g[L_BX] = b.x;
      g[L_BZ] = b.z;
      return lineWalk(false);
    },
  };
  return grid;
}
