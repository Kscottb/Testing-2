/**
 * NavGrid tests. A hand-built level (two rooms, an S-shaped corridor, a terrace reached by stairs,
 * two gates) is checked cell by cell against an independent reference that derives walkability,
 * heights and links from collision queries; flow fields are checked against a reference shortest-path
 * search; crowds of agents are stepped along the field; plus paths, sampling, toggles, performance and
 * allocation.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { COL } from '../core/constants';
import { makeMoveResult, makeNavPath } from '../core/make';
import { createRng } from '../core/rng';
import type { Aabb, BoxDesc, CollisionWorld, NavBuildHints, NavGrid, Rng, Vec3Like } from '../core/types';
import { createCollisionWorld } from '../physics';
import { ALLOC_LIMIT_BYTES, WARM_UP_CALLS, boxOneNumberPerCall, bytesPerCall } from '../physics/heapmeter';
import { createNavGrid } from './index';

// Brute-force references and crowd simulations on a machine shared with other jobs: no test here is
// allowed to fail because it was starved of CPU for a few seconds.
vi.setConfig({ testTimeout: 120_000 });

const box = (
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  extra: Partial<BoxDesc> = {},
): BoxDesc => ({ minX, minY, minZ, maxX, maxY, maxZ, ...extra });

const v = (x: number, z: number, y = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Neighbour k of a cell: E, W, S, N, SE, NE, SW, NW. */
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];

// ---------------------------------------------------------------------------------------------------
// The test level (60 x 40 m, 1 m cells)
//
//   room A (west)  |  corridor: door -> east -> south -> east  |  room B (east)
//   x -29..-10     |  x -9..9                                  |  x 10..29
//
// Room B is split by an inner wall (z 0..1) with a gated shortcut and an open passage at its far end;
// its north half holds a 2 m terrace reached by a flight of stairs.
// ---------------------------------------------------------------------------------------------------

const GATE_AB: Aabb = box(9, 0, 10, 10, 4, 14);
const GATE_B: Aabb = box(12, 0, 0, 15, 4, 1);
const TERRACE = { x: 24.3, y: 2, z: -13.6 };

function levelWorld(): CollisionWorld {
  const w = createCollisionWorld();
  w.addBox(box(-30, -1, -20, 30, 0, 20));
  // Outer walls.
  w.addBox(box(-30, 0, -20, 30, 4, -19));
  w.addBox(box(-30, 0, 19, 30, 4, 20));
  w.addBox(box(-30, 0, -20, -29, 4, 20));
  w.addBox(box(29, 0, -20, 30, 4, 20));
  // Room A | corridor wall with a 3 m doorway (z -3..0).
  w.addBox(box(-10, 0, -19, -9, 4, -3));
  w.addBox(box(-10, 0, 0, -9, 4, 19));
  // Corridor blocks: leg 1 runs east (z -4..0), leg 2 south (x -1..3), leg 3 east (z 10..14).
  w.addBox(box(-9, 0, -19, 9, 4, -4));
  w.addBox(box(-9, 0, 0, -1, 4, 19));
  w.addBox(box(3, 0, -4, 9, 4, 10));
  w.addBox(box(-1, 0, 14, 9, 4, 19));
  // Corridor | room B wall; the gate fills its only opening.
  w.addBox(box(9, 0, -19, 10, 4, 10));
  w.addBox(box(9, 0, 14, 10, 4, 19));
  w.addBox({ ...GATE_AB, flags: COL.GATE, tag: 'gate:ab', surface: 'energy' });
  // Room B inner wall: gated shortcut at x 12..15, open passage at x 26..29.
  w.addBox(box(10, 0, 0, 12, 4, 1));
  w.addBox(box(15, 0, 0, 26, 4, 1));
  w.addBox({ ...GATE_B, flags: COL.GATE, tag: 'gate:b', surface: 'energy' });
  // Terrace (2 m) and its stairs: 10 treads of 0.4 m with a 0.2 m rise, climbing toward +x.
  w.addBox(box(20, 0, -19, 29, 2, -8));
  for (let i = 0; i < 10; i++) w.addBox(box(16 + 0.4 * i, 0, -14, 20, 0.2 * (i + 1), -11));
  // Room A furniture.
  w.addBox(box(-20, 0, -10, -19, 4, -9)); // pillar filling one cell
  w.addBox(box(-25, 0, 5, -23, 1, 7)); // crate: its top is out of stepping reach
  w.addBox(box(-18, 0, 8, -14, 0.4, 12)); // low platform: one step up
  w.addBox(box(-22.05, 0, -6, -21.95, 3, 0)); // thin wall exactly on a cell border
  w.addBox(box(-27, 1.2, -15, -25, 1.5, -12)); // beam too low to walk under
  w.addBox(box(-27, 1.7, -10, -25, 2, -8)); // beam high enough
  w.addBox(box(-29, 0, 13, -25, 3, 14)); // sealed closet (three walls + the outer wall)
  w.addBox(box(-26, 0, 14, -25, 3, 17));
  w.addBox(box(-29, 0, 17, -25, 3, 18));
  w.addBox(box(-16, 0, -17, -13, 3, -15, { flags: COL.ENEMY_CLIP }));
  w.addBox(box(-13, 0, -17, -11, 3, -15, { flags: COL.PLAYER_CLIP }));
  w.addBox(box(-24, 0, -4, -23, 4, -3)); // two pillars touching at a corner
  w.addBox(box(-23, 0, -3, -22, 4, -2));
  w.finalize();
  return w;
}

function levelHints(over: Partial<NavBuildHints> = {}): NavBuildHints {
  return {
    bounds: box(-30, -1, -20, 30, 10, 20),
    cellSize: 1,
    zones: [
      { id: 'deck', aabb: box(-30, -1, -20, -9.5, 10, 20) },
      { id: 'refinery', aabb: box(-9.5, -1, -20, 9.5, 10, 20) },
      { id: 'spire', aabb: box(9.5, -1, -20, 30, 10, 20) },
    ],
    blocked: [box(-20, -1, 14, -17, 1, 17)],
    ignoreTags: ['gate:ab', 'gate:b'],
    closedRegions: [GATE_AB, GATE_B],
    seeds: [{ x: -20, y: 0, z: 0 }],
    maxStep: 0.75,
    agentHeight: 1.6,
    agentRadius: 0.4,
    ...over,
  };
}

/** The level with both gates open in the nav grid. */
function openLevel(): NavGrid {
  const nav = createNavGrid();
  nav.build(levelWorld(), levelHints());
  nav.setRegionWalkable(GATE_AB, true);
  nav.setRegionWalkable(GATE_B, true);
  return nav;
}

/** A 150 x 90 m arena scattered with ground-standing boxes (low steps, crates, walls) and high beams. */
function clutterWorld(seed: number, count: number, halfX = 75, halfZ = 45): CollisionWorld {
  const rng = createRng(seed);
  const w = createCollisionWorld();
  w.addBox(box(-halfX, -1, -halfZ, halfX, 0, halfZ));
  for (let i = 0; i < count; i++) {
    const x = rng.range(-halfX + 2, halfX - 2);
    const z = rng.range(-halfZ + 2, halfZ - 2);
    if (Math.abs(x) < 4 && Math.abs(z) < 4) continue;
    const kind = rng.int(0, 4);
    const w2 = (kind === 3 ? rng.range(2, 7) : rng.range(0.4, 1.6)) / 2;
    const d2 = (kind === 4 ? rng.range(2, 7) : rng.range(0.4, 1.6)) / 2;
    if (kind === 0) w.addBox(box(x - w2 * 2, 0, z - d2 * 2, x + w2 * 2, rng.range(0.15, 0.6), z + d2 * 2));
    else if (kind === 1) w.addBox(box(x - w2, rng.range(2.4, 3), z - d2, x + w2, 3.4, z + d2));
    else w.addBox(box(x - w2, 0, z - d2, x + w2, rng.range(1.2, 4), z + d2));
  }
  w.finalize();
  return w;
}

function clutterHints(halfX = 75, halfZ = 45): NavBuildHints {
  return {
    bounds: box(-halfX, -1, -halfZ, halfX, 10, halfZ),
    cellSize: 1,
    zones: [],
    blocked: [],
    ignoreTags: [],
    closedRegions: [],
    seeds: [{ x: 0, y: 0, z: 0 }],
    maxStep: 0.75,
    agentHeight: 1.6,
    agentRadius: 0.4,
  };
}

// ---------------------------------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------------------------------

const centreX = (nav: NavGrid, cell: number): number => nav.originX + ((cell % nav.cols) + 0.5) * nav.cellSize;
const centreZ = (nav: NavGrid, cell: number): number => nav.originZ + (Math.floor(cell / nav.cols) + 0.5) * nav.cellSize;

function walkableCells(nav: NavGrid): number[] {
  const cells: number[] = [];
  for (let c = 0; c < nav.cols * nav.rows; c++) if (nav.isWalkable(centreX(nav, c), centreZ(nav, c))) cells.push(c);
  return cells;
}

/** A random point strictly inside a random walkable cell. */
function randomWalkablePoint(nav: NavGrid, cells: readonly number[], rng: Rng, out: THREE.Vector3): THREE.Vector3 {
  const c = rng.pick(cells);
  const x = centreX(nav, c) + rng.range(-0.45, 0.45) * nav.cellSize;
  const z = centreZ(nav, c) + rng.range(-0.45, 0.45) * nav.cellSize;
  return out.set(x, nav.heightAt(x, z), z);
}

/** True when every point of the segment a -> b has floor `margin` metres to its east, west, south and north. */
function keepsClear(nav: NavGrid, a: Vec3Like, b: Vec3Like, margin: number): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.02));
  for (let s = 0; s <= n; s++) {
    const x = a.x + ((b.x - a.x) * s) / n;
    const z = a.z + ((b.z - a.z) * s) / n;
    if (!nav.isWalkable(x + margin, z) || !nav.isWalkable(x - margin, z) || !nav.isWalkable(x, z + margin) || !nav.isWalkable(x, z - margin)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Independent reference: the grid the contract describes, derived from collision queries
// ---------------------------------------------------------------------------------------------------

interface Reference {
  cols: number;
  rows: number;
  walkable: Uint8Array;
  height: Float64Array;
  /** Bit k set: the link toward neighbour k is open. */
  links: Uint8Array;
}

function reference(world: CollisionWorld, hints: NavBuildHints, closed: readonly Aabb[]): Reference {
  const cs = hints.cellSize;
  const r = hints.agentRadius;
  const ox = hints.bounds.minX;
  const oz = hints.bounds.minZ;
  const cols = Math.ceil((hints.bounds.maxX - ox) / cs - 1e-6);
  const rows = Math.ceil((hints.bounds.maxZ - oz) / cs - 1e-6);
  const n = cols * rows;
  const TOL = 1e-3;
  const cx = (c: number): number => ox + ((c % cols) + 0.5) * cs;
  const cz = (c: number): number => oz + (Math.floor(c / cols) + 0.5) * cs;
  const inside = (a: Aabb, x: number, z: number): boolean => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ;

  // The ignored tags (gates) do not exist for the base grid.
  const hidden = world.boxes.filter((b) => b.enabled && hints.ignoreTags.includes(b.tag));
  for (const b of hidden) world.setEnabled(b.id, false);
  const solids = world.boxes.filter((b) => b.enabled && (b.flags & COL.ENEMY) !== 0);
  const probe = box(0, 0, 0, 0, 0, 0);
  /** Nothing an agent cannot step over between floorY + maxStep and floorY + agentHeight. */
  const free = (x0: number, x1: number, z0: number, z1: number, floorY: number): boolean => {
    probe.minX = x0;
    probe.maxX = x1;
    probe.minZ = z0;
    probe.maxZ = z1;
    probe.minY = floorY + hints.maxStep + TOL;
    probe.maxY = floorY + hints.agentHeight - TOL;
    return world.overlapBox(probe, COL.ENEMY) === -1;
  };
  const passage = (a: number, b: number, floorY: number): boolean =>
    free(Math.min(cx(a), cx(b)) - r, Math.max(cx(a), cx(b)) + r, Math.min(cz(a), cz(b)) - r, Math.max(cz(a), cz(b)) + r, floorY);

  // Floor candidates per cell: box tops under the centre that are not buried and leave room to stand.
  const tops: number[][] = [];
  for (let c = 0; c < n; c++) {
    const x = cx(c);
    const z = cz(c);
    const list: number[] = [];
    if (!hints.blocked.some((a) => inside(a, x, z))) {
      for (const b of solids) {
        if (!inside(b, x, z)) continue;
        const top = b.maxY;
        if (list.some((t) => Math.abs(t - top) <= TOL)) continue;
        const buried = solids.some((o) => o !== b && inside(o, x, z) && o.minY <= top + TOL && o.maxY > top + TOL);
        if (!buried && free(x - r, x + r, z - r, z + r, top)) list.push(top);
      }
    }
    tops.push(list);
  }

  // Flood fill from the seeds across steppable height differences.
  const walkable = new Uint8Array(n);
  const height = new Float64Array(n);
  const queue: number[] = [];
  for (const seed of hints.seeds) {
    const col = Math.floor((seed.x - ox) / cs);
    const row = Math.floor((seed.z - oz) / cs);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    const c = row * cols + col;
    let best = Infinity;
    for (const top of tops[c] as number[]) {
      if (Math.abs(top - seed.y) < Math.abs(best - seed.y)) best = top;
    }
    if (best === Infinity || walkable[c] === 1) continue;
    walkable[c] = 1;
    height[c] = best;
    queue.push(c);
  }
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head] as number;
    for (let k = 0; k < 4; k++) {
      const col = (c % cols) + (DX[k] as number);
      const row = Math.floor(c / cols) + (DZ[k] as number);
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const nb = row * cols + col;
      if (walkable[nb] === 1) continue;
      let best = Infinity;
      for (const top of tops[nb] as number[]) {
        const d = Math.abs(top - (height[c] as number));
        if (d <= hints.maxStep + 1e-6 && d < Math.abs(best - (height[c] as number)) && passage(c, nb, Math.max(top, height[c] as number))) {
          best = top;
        }
      }
      if (best === Infinity) continue;
      walkable[nb] = 1;
      height[nb] = best;
      queue.push(nb);
    }
  }

  // Static links, then the dynamic region blocks.
  const orth = new Uint8Array(n);
  const stepOk = (a: number, b: number): boolean => Math.abs((height[a] as number) - (height[b] as number)) <= hints.maxStep + 1e-6;
  for (let c = 0; c < n; c++) {
    if (walkable[c] === 0) continue;
    for (let k = 0; k < 4; k++) {
      const col = (c % cols) + (DX[k] as number);
      const row = Math.floor(c / cols) + (DZ[k] as number);
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const nb = row * cols + col;
      if (walkable[nb] === 1 && stepOk(c, nb) && passage(c, nb, Math.max(height[c] as number, height[nb] as number))) {
        orth[c] = (orth[c] as number) | (1 << k);
      }
    }
  }
  const blocked = new Uint8Array(n);
  for (let c = 0; c < n; c++) if (closed.some((a) => inside(a, cx(c), cz(c)))) blocked[c] = 1;
  const open = (a: number, k: number): boolean => {
    if (((orth[a] as number) & (1 << k)) === 0) return false;
    const b = a + (DZ[k] as number) * cols + (DX[k] as number);
    return blocked[a] === 0 && blocked[b] === 0;
  };
  const hole = cs - 2 * r;
  const links = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (walkable[c] === 0 || blocked[c] === 1) continue;
    for (let k = 0; k < 4; k++) if (open(c, k)) links[c] = (links[c] as number) | (1 << k);
    for (let k = 4; k < 8; k++) {
      const kx = (DX[k] as number) > 0 ? 0 : 1; // E or W
      const kz = (DZ[k] as number) > 0 ? 2 : 3; // S or N
      if (!open(c, kx) || !open(c, kz)) continue;
      const side = c + (DX[k] as number);
      const up = c + (DZ[k] as number) * cols;
      const d = up + (DX[k] as number);
      // Both L-shaped detours must be open, and no pole may stand between the four footprints.
      if (!open(side, kz) || !open(up, kx) || !stepOk(c, d)) continue;
      if (hole > 2e-4) {
        const x0 = Math.min(cx(c), cx(d)) + r;
        const z0 = Math.min(cz(c), cz(d)) + r;
        const floorY = Math.max(height[c] as number, height[d] as number, height[side] as number, height[up] as number);
        if (!free(x0, x0 + hole, z0, z0 + hole, floorY)) continue;
      }
      links[c] = (links[c] as number) | (1 << k);
    }
  }
  for (let c = 0; c < n; c++) if (blocked[c] === 1) walkable[c] = 0;

  for (const b of hidden) world.setEnabled(b.id, true);
  return { cols, rows, walkable, height, links };
}

/** Compare every cell and every link of `nav` with the reference; throws on the first mismatch. */
function expectMatchesReference(nav: NavGrid, ref: Reference): void {
  expect(nav.cols).toBe(ref.cols);
  expect(nav.rows).toBe(ref.rows);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let walkable = 0;
  let linkCount = 0;
  for (let c = 0; c < ref.cols * ref.rows; c++) {
    const x = centreX(nav, c);
    const z = centreZ(nav, c);
    const at = `cell ${c} (${x}, ${z})`;
    if (nav.isWalkable(x, z) !== (ref.walkable[c] === 1)) throw new Error(`${at}: walkable ${nav.isWalkable(x, z)}, reference ${ref.walkable[c]}`);
    if (ref.walkable[c] === 0) continue;
    walkable++;
    if (Math.abs(nav.heightAt(x, z, -99) - (ref.height[c] as number)) > 1e-9) throw new Error(`${at}: height ${nav.heightAt(x, z, -99)}, reference ${ref.height[c]}`);
    a.set(x, 0, z);
    for (let k = 0; k < 8; k++) {
      b.set(x + (DX[k] as number) * nav.cellSize, 0, z + (DZ[k] as number) * nav.cellSize);
      const expected = ((ref.links[c] as number) & (1 << k)) !== 0;
      if (nav.isLineWalkable(a, b) !== expected) throw new Error(`${at}: link ${k} is ${!expected}, reference ${expected}`);
      if (expected) linkCount++;
    }
  }
  expect(walkable).toBeGreaterThan(0);
  expect(linkCount).toBeGreaterThan(walkable);
}

/** Shortest walking distance (in metres) from every cell to `target` over the reference links. */
function referenceDistances(ref: Reference, target: number, cellSize: number): Float64Array {
  const dist = new Float64Array(ref.cols * ref.rows).fill(Infinity);
  if (ref.walkable[target] === 0) return dist;
  dist[target] = 0;
  const queue = [target];
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head] as number;
    for (let k = 0; k < 8; k++) {
      if (((ref.links[c] as number) & (1 << k)) === 0) continue;
      const nb = c + (DZ[k] as number) * ref.cols + (DX[k] as number);
      const d = (dist[c] as number) + (k < 4 ? cellSize : cellSize * Math.SQRT2);
      if (d < (dist[nb] as number) - 1e-9) {
        dist[nb] = d;
        queue.push(nb);
      }
    }
  }
  return dist;
}

/**
 * The flow field of `nav` (already updated toward the centre of `target`) must give every cell the
 * reference distance. The field uses integer step costs 12 / 17, i.e. a diagonal of 1.4167 instead of
 * 1.4142: at most 0.18 % long.
 */
function expectFlowMatches(nav: NavGrid, ref: Reference, target: number): number {
  const dist = referenceDistances(ref, target, nav.cellSize);
  const p = new THREE.Vector3();
  let reachable = 0;
  for (let c = 0; c < ref.cols * ref.rows; c++) {
    p.set(centreX(nav, c), 0, centreZ(nav, c));
    const expected = ref.walkable[c] === 1 ? (dist[c] as number) : Infinity;
    if (ref.walkable[c] === 0) continue; // off-mesh positions are covered separately
    const got = nav.flowDistance(p);
    if (expected === Infinity ? got !== Infinity : !(got >= expected - 1e-9 && got <= expected * 1.002 + 1e-9)) {
      throw new Error(`target ${target}, cell ${c} (${p.x}, ${p.z}): flow distance ${got}, reference ${expected}`);
    }
    if (expected !== Infinity) reachable++;
  }
  return reachable;
}

// ---------------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------------

interface WalkStats {
  arrived: boolean;
  steps: number;
  travelled: number;
  /** Steps whose direction reversed against the previous one (dot < 0). */
  reversals: number;
  /** Most reversals inside any window of 12 consecutive steps. */
  reversalBurst: number;
  /** Left turn directly followed by a right turn (or vice versa), both sharper than 3 degrees. */
  zigzags: number;
  /** Largest amount the flow distance ever rose above its running minimum (metres). */
  regress: number;
  /** Smallest drop of the flow distance over any stretch of PROGRESS_WINDOW metres walked en route. */
  slowestWindow: number;
}

const scratchDir = new THREE.Vector3();
/** Metres of walking over which progress toward the target is judged (several cells: the flow distance is per cell). */
const PROGRESS_WINDOW = 5;

/**
 * Step a point agent along sampleFlow until it is within `arriveRadius` of `target`. Throws when it
 * ever stands in an unwalkable cell or the field gives up on it.
 */
function followFlow(nav: NavGrid, p: THREE.Vector3, target: Vec3Like, step: number, maxSteps: number, arriveRadius = 0.25): WalkStats {
  const stats: WalkStats = { arrived: false, steps: 0, travelled: 0, reversals: 0, reversalBurst: 0, zigzags: 0, regress: 0, slowestWindow: Infinity };
  const progressWindow = Math.ceil(PROGRESS_WINDOW / step);
  const history: number[] = [];
  const reversalSteps: number[] = [];
  let px = 0;
  let pz = 0;
  let lastTurn = 0;
  let best = nav.flowDistance(p);
  for (let i = 0; i < maxSteps; i++) {
    if (Math.hypot(p.x - target.x, p.z - target.z) <= arriveRadius) {
      stats.arrived = true;
      break;
    }
    if (!nav.sampleFlow(p, scratchDir)) throw new Error(`step ${i}: no flow at (${p.x}, ${p.z})`);
    const len = Math.hypot(scratchDir.x, scratchDir.z);
    if (scratchDir.y !== 0 || Math.abs(len - 1) > 1e-9) throw new Error(`step ${i}: direction (${scratchDir.toArray().join(', ')}) is not a unit XZ vector`);
    if (i > 0) {
      const dot = scratchDir.x * px + scratchDir.z * pz;
      const turn = Math.atan2(px * scratchDir.z - pz * scratchDir.x, dot);
      if (dot < 0) {
        stats.reversals++;
        reversalSteps.push(i);
        let burst = 0;
        for (let k = reversalSteps.length - 1; k >= 0 && i - (reversalSteps[k] as number) < 12; k--) burst++;
        if (burst > stats.reversalBurst) stats.reversalBurst = burst;
      }
      if (Math.abs(turn) > 0.05 && Math.abs(lastTurn) > 0.05 && turn * lastTurn < 0) stats.zigzags++;
      lastTurn = turn;
    }
    px = scratchDir.x;
    pz = scratchDir.z;
    // Never overshoot the target itself.
    const reach = Math.min(step, Math.hypot(p.x - target.x, p.z - target.z));
    p.x += scratchDir.x * reach;
    p.z += scratchDir.z * reach;
    stats.travelled += reach;
    stats.steps++;
    if (!nav.isWalkable(p.x, p.z)) throw new Error(`step ${i}: walked into the unwalkable cell at (${p.x}, ${p.z})`);
    const d = nav.flowDistance(p);
    if (d - best > stats.regress) stats.regress = d - best;
    if (d < best) best = d;
    history.push(d);
    if (history.length > progressWindow) {
      const drop = (history[history.length - 1 - progressWindow] as number) - d;
      if (drop < stats.slowestWindow) stats.slowestWindow = drop;
    }
  }
  p.y = nav.heightAt(p.x, p.z, p.y);
  return stats;
}

// ---------------------------------------------------------------------------------------------------

describe('build', () => {
  const world = levelWorld();
  const nav = createNavGrid();
  nav.build(world, levelHints());
  const out = new THREE.Vector3();

  it('sizes the grid from the hint bounds and maps positions to cells', () => {
    expect(nav.cols).toBe(60);
    expect(nav.rows).toBe(40);
    expect(nav.cellSize).toBe(1);
    expect(nav.originX).toBe(-30);
    expect(nav.originZ).toBe(-20);
    expect(nav.cellAt(-30, -20)).toBe(0);
    expect(nav.cellAt(-29.01, -19.5)).toBe(0);
    expect(nav.cellAt(-29, -19.5)).toBe(1);
    expect(nav.cellAt(29.999, 19.999)).toBe(60 * 40 - 1);
    expect(nav.cellAt(0.5, 0.5)).toBe(20 * 60 + 30);
    for (const [x, z] of [
      [30, 0],
      [0, 20],
      [-30.001, 0],
      [0, -20.001],
      [1e9, 0],
      [Number.NaN, 0],
      [0, Number.NaN],
      [Infinity, 0],
    ] as const) {
      expect(nav.cellAt(x, z)).toBe(-1);
      expect(nav.isWalkable(x, z)).toBe(false);
      expect(nav.heightAt(x, z, 7)).toBe(7);
      expect(nav.zoneAt(x, z)).toBe(null);
    }
    expect(nav.cellCenter(nav.cellAt(-20, 0), out).toArray()).toEqual([-19.5, 0, 0.5]);
    expect(nav.cellCenter(nav.cellAt(24.2, -13.1), out).toArray()).toEqual([24.5, 2, -13.5]);
    // Not walkable: still the centre, at height 0. Out of range: the grid origin.
    expect(nav.cellCenter(nav.cellAt(0.5, -10.5), out).toArray()).toEqual([0.5, 0, -10.5]);
    expect(nav.cellCenter(-1, out).toArray()).toEqual([-30, 0, -20]);
    expect(nav.cellCenter(60 * 40, out).toArray()).toEqual([-30, 0, -20]);

    // Bounds that are not a multiple of the cell size are covered by a partial last cell.
    const odd = createNavGrid();
    odd.build(world, levelHints({ bounds: box(-10.2, -1, -6, 10.3, 5, 5.5), cellSize: 2 }));
    expect([odd.cols, odd.rows, odd.cellSize, odd.originX, odd.originZ]).toEqual([11, 6, 2, -10.2, -6]);
    expect(odd.cellAt(-10.2, -6)).toBe(0);
    expect(odd.cellAt(10.25, 5.4)).toBe(11 * 6 - 1);
  });

  it('labels the cells the level was designed with', () => {
    // Room A floor, the seed cell.
    expect(nav.isWalkable(-20, 0)).toBe(true);
    expect(nav.heightAt(-20, 0, 5)).toBe(0);
    // The pillar fills one cell; its eight neighbours keep half a metre of clearance.
    expect(nav.isWalkable(-19.5, -9.5)).toBe(false);
    for (let k = 0; k < 8; k++) expect(nav.isWalkable(-19.5 + (DX[k] as number), -9.5 + (DZ[k] as number))).toBe(true);
    // Crate top: one metre is not a step.
    expect(nav.isWalkable(-24.5, 5.5)).toBe(false);
    expect(nav.heightAt(-24.5, 5.5, 7)).toBe(7);
    expect(nav.heightAt(-24.5, 5.5)).toBe(0);
    // Low platform: a step up, walkable at its own height.
    expect(nav.isWalkable(-15.5, 9.5)).toBe(true);
    expect(nav.heightAt(-15.5, 9.5)).toBe(0.4);
    // Beams: 1.2 m of head room is too little, 1.7 m is enough for a 1.6 m agent.
    expect(nav.isWalkable(-25.5, -13.5)).toBe(false);
    expect(nav.isWalkable(-25.5, -8.5)).toBe(true);
    expect(nav.heightAt(-25.5, -8.5, 9)).toBe(0);
    // The sealed closet has a floor but no way in.
    expect(nav.isWalkable(-27.5, 15.5)).toBe(false);
    // ENEMY_CLIP volumes keep the grid out, PLAYER_CLIP volumes do not exist for it.
    expect(nav.isWalkable(-14.5, -15.5)).toBe(false);
    expect(nav.isWalkable(-11.5, -15.5)).toBe(true);
    // The blocked hint region (cell centres inside it).
    expect(nav.isWalkable(-18.5, 15.5)).toBe(false);
    expect(nav.isWalkable(-16.5, 15.5)).toBe(true);
    // Thin wall on a border: the cells on both sides stay walkable.
    expect(nav.isWalkable(-22.5, -3.5)).toBe(true);
    expect(nav.isWalkable(-21.5, -3.5)).toBe(true);
    // Stairs: one height per cell, the tread under the cell centre.
    const stairHeights = [16.5, 17.5, 18.5, 19.5, 20.5].map((x) => nav.heightAt(x, -12.5, -1));
    expect(stairHeights[0]).toBeCloseTo(0.4, 9);
    expect(stairHeights[1]).toBeCloseTo(0.8, 9);
    expect(stairHeights[2]).toBeCloseTo(1.4, 9);
    expect(stairHeights[3]).toBeCloseTo(1.8, 9);
    expect(stairHeights[4]).toBe(2);
    expect(nav.heightAt(TERRACE.x, TERRACE.z, -1)).toBe(2);
    // Gates: the floor under a gate is part of the base grid, the closed region blocks it.
    expect(nav.isWalkable(9.5, 12.5)).toBe(false);
    expect(nav.isWalkable(13.5, 0.5)).toBe(false);
    expect(nav.isWalkable(8.5, 12.5)).toBe(true);
    expect(nav.isWalkable(20, 10)).toBe(true);
  });

  it('labels zones by rectangle, first match first', () => {
    expect(nav.zoneAt(-20, 0)).toBe('deck');
    expect(nav.zoneAt(-9.6, -1)).toBe('deck'); // cell centre -9.5 lies on the shared edge: first zone wins
    expect(nav.zoneAt(-8.5, -1)).toBe('refinery');
    expect(nav.zoneAt(0.5, -10.5)).toBe('refinery'); // solid cells are labelled too
    expect(nav.zoneAt(20, 10)).toBe('spire');
    const partial = createNavGrid();
    partial.build(world, levelHints({ zones: [{ id: 'spire', aabb: box(-25, -1, -5, -15, 10, 5) }] }));
    expect(partial.zoneAt(-20, 0)).toBe('spire');
    expect(partial.zoneAt(-20, 10)).toBe(null);
    expect(partial.zoneAt(20, 0)).toBe(null);
  });

  it('matches an independent reference built from collision queries: walkability, heights, links', () => {
    expectMatchesReference(nav, reference(world, levelHints(), [GATE_AB, GATE_B]));
    const open = createNavGrid();
    open.build(world, levelHints({ closedRegions: [] }));
    expectMatchesReference(open, reference(world, levelHints(), []));
    // The gates are ignored by tag, not by their current state in the collision world.
    world.setEnabledByTag('gate:ab', false);
    const rebuilt = createNavGrid();
    rebuilt.build(world, levelHints({ closedRegions: [GATE_B] }));
    world.setEnabledByTag('gate:ab', true);
    expectMatchesReference(rebuilt, reference(world, levelHints(), [GATE_B]));
  });

  it('matches the reference with other agent sizes, step heights and cell sizes', () => {
    for (const over of [
      { agentRadius: 0.2 },
      { agentRadius: 0.49 },
      { agentRadius: 0 },
      { agentHeight: 1.1 },
      { agentHeight: 2.2 },
      { maxStep: 0.3 },
      { maxStep: 1.1 },
      { cellSize: 0.5 },
      { cellSize: 2, seeds: [{ x: -19, y: 0, z: 1 }] },
    ] satisfies Partial<NavBuildHints>[]) {
      const hints = levelHints(over);
      const grid = createNavGrid();
      grid.build(world, hints);
      try {
        expectMatchesReference(grid, reference(world, hints, [GATE_AB, GATE_B]));
      } catch (error) {
        throw new Error(`${JSON.stringify(over)}: ${(error as Error).message}`);
      }
    }
  });

  it('matches the reference on cluttered arenas', () => {
    for (const seed of [11, 12, 13]) {
      const arena = clutterWorld(seed, 260, 40, 25);
      const hints = clutterHints(40, 25);
      const grid = createNavGrid();
      grid.build(arena, hints);
      try {
        expectMatchesReference(grid, reference(arena, hints, []));
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
      expect(walkableCells(grid).length).toBeGreaterThan(2000);
    }
  });

  it('needs the agent radius of clearance from walls and the agent height under ceilings', () => {
    const build = (...boxes: BoxDesc[]): NavGrid => {
      const w = createCollisionWorld();
      w.addBox(box(-5, -1, -5, 5, 0, 5));
      for (const b of boxes) w.addBox(b);
      w.finalize();
      const grid = createNavGrid();
      grid.build(w, { ...clutterHints(5, 5), seeds: [{ x: -3.5, y: 0, z: -3.5 }] });
      return grid;
    };
    // A wall reaching 0.05 m into the cell leaves 0.45 m to its centre; 0.15 m leaves 0.35 m.
    expect(build(box(1, 0, -5, 2.05, 3, 3)).isWalkable(2.5, 0.5)).toBe(true);
    expect(build(box(1, 0, -5, 2.15, 3, 3)).isWalkable(2.5, 0.5)).toBe(false);
    expect(build(box(1, 0, -5, 2.15, 3, 3)).isWalkable(3.5, 0.5)).toBe(true);
    expect(build(box(1, 0, -5, 2.1, 3, 3)).isWalkable(2.5, 0.5)).toBe(true); // touching is not overlapping
    // Ceilings.
    expect(build(box(-5, 1.55, 0, 5, 2, 5)).isWalkable(0.5, 2.5)).toBe(false);
    expect(build(box(-5, 1.65, 0, 5, 2, 5)).isWalkable(0.5, 2.5)).toBe(true);
    expect(build(box(-5, 1.6, 0, 5, 2, 5)).isWalkable(0.5, 2.5)).toBe(true);
    // A pole thinner than a cell blocks only the cells whose centre it comes within 0.4 m of.
    const pole = build(box(0.45, 0, 0.45, 0.55, 3, 0.55));
    expect(pole.isWalkable(0.5, 0.5)).toBe(false);
    expect(pole.isWalkable(1.5, 0.5)).toBe(true);
    // ... and a pole on a cell corner blocks none, but closes the diagonals through that corner.
    const corner = build(box(0.95, 0, 0.95, 1.05, 3, 1.05));
    for (const [x, z] of [[0.5, 0.5], [1.5, 0.5], [0.5, 1.5], [1.5, 1.5]] as const) expect(corner.isWalkable(x, z)).toBe(true);
    expect(corner.isLineWalkable(v(0.5, 0.5), v(1.5, 1.5))).toBe(false);
    expect(corner.isLineWalkable(v(1.5, 0.5), v(0.5, 1.5))).toBe(false);
    expect(corner.isLineWalkable(v(0.5, 0.5), v(1.5, 0.5))).toBe(true);
    expect(corner.isLineWalkable(v(-1.5, -1.5), v(-0.5, -0.5))).toBe(true);
    // A kerb an agent can step over does not take the cell away, whatever its position.
    const kerb = build(box(0.3, 0, -5, 0.6, 0.5, 5));
    expect(kerb.isWalkable(0.5, 0.5)).toBe(true);
    expect(kerb.heightAt(0.5, 0.5)).toBe(0.5);
    expect(kerb.isLineWalkable(v(-0.5, 0.5), v(1.5, 0.5))).toBe(true);
  });

  it('keeps everything that is not connected to a seed out of the grid', () => {
    const count = (grid: NavGrid): number => walkableCells(grid).length;
    const base = count(nav);
    expect(base).toBeGreaterThan(900);
    // No seeds: nothing.
    const empty = createNavGrid();
    empty.build(world, levelHints({ seeds: [] }));
    expect(count(empty)).toBe(0);
    // A seed in the closet adds exactly its 3 x 3 cells; one on the crate adds the 2 x 2 top.
    const closet = createNavGrid();
    closet.build(world, levelHints({ seeds: [{ x: -20, y: 0, z: 0 }, { x: -27.5, y: 0, z: 15.5 }, { x: -24.5, y: 1, z: 5.5 }] }));
    expect(count(closet)).toBe(base + 9 + 4);
    expect(closet.isWalkable(-27.5, 15.5)).toBe(true);
    expect(closet.heightAt(-24.5, 5.5)).toBe(1);
    expect(closet.isReachable(v(-20, 0), v(-27.5, 15.5))).toBe(false);
    expect(closet.isReachable(v(-27.5, 15.5), v(-28.5, 14.5))).toBe(true);
    expect(closet.isReachable(v(-24.5, 5.5), v(-23.5, 6.5))).toBe(true);
    expect(closet.isReachable(v(-24.5, 5.5), v(-22.5, 6.5))).toBe(false);
    // A seed floating above the floor or sitting in a wall snaps to the nearest floor.
    for (const seed of [{ x: -20, y: 1.5, z: 0 }, { x: -29.5, y: 0, z: 0.5 }, { x: -19.5, y: 0, z: -9.5 }]) {
      const grid = createNavGrid();
      grid.build(world, levelHints({ seeds: [seed] }));
      expect(count(grid)).toBe(base);
    }
    // Seeds that cannot stand anywhere near are ignored.
    const lost = createNavGrid();
    lost.build(world, levelHints({ seeds: [{ x: 0.5, y: 0, z: -12.5 }, { x: 500, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 0 }] }));
    expect(count(lost)).toBe(0);
  });

  it('rebuilds from scratch', () => {
    const grid = createNavGrid();
    expect([grid.cols, grid.rows, grid.version]).toEqual([0, 0, 0]);
    expect(grid.isWalkable(0, 0)).toBe(false);
    expect(grid.sampleFlow(v(0, 0), out)).toBe(false);
    expect(grid.flowDistance(v(0, 0))).toBe(Infinity);
    grid.build(world, levelHints({ closedRegions: [] }));
    const v1 = grid.version;
    expect(v1).toBeGreaterThan(0);
    expect(grid.updateFlowField(TERRACE)).toBe(true);
    expect(grid.sampleFlow(v(-20, 0), out)).toBe(true);
    // A different world and different hints: nothing of the old grid or its flow field survives.
    const arena = clutterWorld(5, 30, 10, 10);
    grid.build(arena, clutterHints(10, 10));
    expect(grid.version).toBeGreaterThan(v1);
    expect([grid.cols, grid.rows, grid.originX, grid.originZ]).toEqual([20, 20, -10, -10]);
    expect(grid.sampleFlow(v(0, 0), out)).toBe(false);
    expect(grid.flowDistance(v(0, 0))).toBe(Infinity);
    expectMatchesReference(grid, reference(arena, clutterHints(10, 10), []));
    expect(grid.updateFlowField(v(0.5, 0.5))).toBe(true);
    expect(grid.flowDistance(v(3.5, 0.5))).toBeGreaterThan(0);
  });
});

describe('step connectivity', () => {
  const world = levelWorld();
  const nav = openLevel();

  it('connects cells across steppable height differences only', () => {
    // Onto the 0.4 m platform and off it again.
    expect(nav.isLineWalkable(v(-18.5, 9.5), v(-17.5, 9.5))).toBe(true);
    expect(nav.isLineWalkable(v(-20.5, 10.5), v(-12.5, 10.5))).toBe(true);
    // Not onto the 1 m crate.
    expect(nav.isLineWalkable(v(-25.5, 5.5), v(-24.5, 5.5))).toBe(false);
    expect(nav.isLineWalkable(v(-26.5, 5.5), v(-21.5, 5.5))).toBe(false);
    // Up the stairs and across the terrace in one line.
    expect(nav.isLineWalkable(v(14.5, -12.5), v(26.5, -12.5))).toBe(true);
    expect(nav.isReachable(v(-20, 0), TERRACE)).toBe(true);
    // Never across the terrace edge: 2 m down to the floor on the south and west sides.
    expect(nav.isWalkable(24.5, -8.5)).toBe(true);
    expect(nav.isWalkable(24.5, -7.5)).toBe(true);
    expect(nav.isLineWalkable(v(24.5, -8.5), v(24.5, -7.5))).toBe(false);
    expect(nav.isLineWalkable(v(20.5, -16.5), v(19.5, -16.5))).toBe(false);
    expect(nav.isLineWalkable(v(20.5, -9.5), v(19.5, -8.5))).toBe(false);
    // From the side, only the lowest stair cell (0.4 m) can be stepped onto.
    expect(nav.isLineWalkable(v(16.5, -14.5), v(16.5, -13.5))).toBe(true);
    expect(nav.isLineWalkable(v(17.5, -14.5), v(17.5, -13.5))).toBe(false);
    expect(nav.isLineWalkable(v(19.5, -10.5), v(19.5, -11.5))).toBe(false);
  });

  it('follows the maxStep hint', () => {
    const strict = createNavGrid();
    strict.build(world, levelHints({ maxStep: 0.3, closedRegions: [] }));
    expect(strict.isWalkable(-15.5, 9.5)).toBe(false); // 0.4 m platform
    expect(strict.isWalkable(16.5, -12.5)).toBe(false); // stair cells differ by 0.4 - 0.6 m
    expect(strict.isWalkable(TERRACE.x, TERRACE.z)).toBe(false);
    expect(strict.isWalkable(20, 10)).toBe(true);
    const generous = createNavGrid();
    generous.build(world, levelHints({ maxStep: 1.05, closedRegions: [] }));
    expect(generous.isWalkable(-24.5, 5.5)).toBe(true); // the 1 m crate is a step now
    expect(generous.heightAt(-24.5, 5.5)).toBe(1);
    expect(generous.isLineWalkable(v(-25.5, 5.5), v(-24.5, 5.5))).toBe(true);
  });

  it('lets a thin wall on a cell border separate the cells', () => {
    expect(nav.isLineWalkable(v(-22.5, -3.5), v(-21.5, -3.5))).toBe(false);
    expect(nav.isLineWalkable(v(-22.5, -3.5), v(-21.5, -2.5))).toBe(false);
    expect(nav.isLineWalkable(v(-22.5, -5.5), v(-21.5, -5.5))).toBe(false);
    // Past its ends the border is open.
    expect(nav.isLineWalkable(v(-22.5, 0.5), v(-21.5, 0.5))).toBe(true);
    expect(nav.isLineWalkable(v(-22.5, -6.5), v(-21.5, -6.5))).toBe(true);
    // The wall ends flush with the row border at z = 0: no squeezing diagonally past its tip.
    expect(nav.isLineWalkable(v(-22.5, -0.5), v(-21.5, 0.5))).toBe(false);
    expect(nav.isReachable(v(-22.5, -3.5), v(-21.5, -3.5))).toBe(true);
    const path = makeNavPath();
    expect(nav.findPath(v(-22.5, -3.5), v(-21.5, -3.5), path)).toBe(true);
    let length = Math.hypot((path.points[0] as THREE.Vector3).x + 22.5, (path.points[0] as THREE.Vector3).z + 3.5);
    for (let i = 1; i < path.count; i++) length += (path.points[i] as THREE.Vector3).distanceTo(path.points[i - 1] as THREE.Vector3);
    expect(length).toBeGreaterThan(6);
  });

  it('never cuts a corner diagonally', () => {
    // Between two pillars that touch at a corner.
    expect(nav.isWalkable(-22.5, -3.5)).toBe(true);
    expect(nav.isWalkable(-23.5, -2.5)).toBe(true);
    expect(nav.isLineWalkable(v(-22.5, -3.5), v(-23.5, -2.5))).toBe(false);
    // Past the corner of a single pillar.
    expect(nav.isLineWalkable(v(-20.5, -9.5), v(-19.5, -10.5))).toBe(false);
    expect(nav.isLineWalkable(v(-20.5, -9.5), v(-19.5, -8.5))).toBe(false);
    expect(nav.isLineWalkable(v(-20.5, -10.5), v(-19.5, -10.5))).toBe(true);
    // Around a doorway jamb.
    expect(nav.isLineWalkable(v(-10.5, -3.5), v(-9.5, -2.5))).toBe(false);
    expect(nav.isLineWalkable(v(-10.5, -2.5), v(-9.5, -2.5))).toBe(true);
  });
});

describe('isLineWalkable and nearestWalkable', () => {
  const nav = openLevel();
  const out = new THREE.Vector3();

  it('walks straight lines cell by cell', () => {
    // Across open floor at any angle, in both directions.
    expect(nav.isLineWalkable(v(-28.2, 0.3), v(-11.4, 11.8))).toBe(true);
    expect(nav.isLineWalkable(v(-11.4, 11.8), v(-28.2, 0.3))).toBe(true);
    expect(nav.isLineWalkable(v(-28.5, 2.5), v(-10.5, 2.5))).toBe(true);
    expect(nav.isLineWalkable(v(-12.5, -18.5), v(-12.5, 18.5))).toBe(true);
    // Through the pillar, through a wall, into a wall.
    expect(nav.isLineWalkable(v(-25.5, -9.5), v(-15.5, -9.4))).toBe(false);
    expect(nav.isLineWalkable(v(-12.5, 5.5), v(-5.5, -2.5))).toBe(false);
    expect(nav.isLineWalkable(v(-12.5, 5.5), v(-9.5, 5.5))).toBe(false);
    // Through the doorway and down the corridor.
    expect(nav.isLineWalkable(v(-14.5, -1.5), v(2.5, -1.5))).toBe(true);
    // A segment inside one cell.
    expect(nav.isLineWalkable(v(-20.1, 0.1), v(-20.9, 0.9))).toBe(true);
    expect(nav.isLineWalkable(v(-20.5, 0.5), v(-20.5, 0.5))).toBe(true);
    // Starting or ending off the mesh, outside the grid, or with garbage.
    expect(nav.isLineWalkable(v(-19.5, -9.5), v(-18.5, -9.5))).toBe(false);
    expect(nav.isLineWalkable(v(-19.5, -9.5), v(-19.4, -9.4))).toBe(false);
    expect(nav.isLineWalkable(v(-28.5, 0.5), v(-31, 0.5))).toBe(false);
    expect(nav.isLineWalkable(v(-31, 0.5), v(-28.5, 0.5))).toBe(false);
    expect(nav.isLineWalkable(v(Number.NaN, 0.5), v(-28.5, 0.5))).toBe(false);
    expect(nav.isLineWalkable(v(-28.5, 0.5), v(-28.5, Number.NaN))).toBe(false);
  });

  it('agrees with a dense sampling of the segment', () => {
    const rng = createRng(31);
    const cells = walkableCells(nav);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let clear = 0;
    for (let i = 0; i < 3000; i++) {
      randomWalkablePoint(nav, cells, rng, a);
      b.set(a.x + rng.range(-9, 9), 0, a.z + rng.range(-9, 9));
      const got = nav.isLineWalkable(a, b);
      // Necessary condition: every sample of the segment lies in a walkable cell.
      let allWalkable = true;
      const n = Math.ceil(a.distanceTo(b) * 40);
      for (let s = 0; s <= n && allWalkable; s++) {
        const t = n === 0 ? 0 : s / n;
        allWalkable = nav.isWalkable(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      }
      if (got && !allWalkable) throw new Error(`segment ${i}: reported walkable through an unwalkable cell`);
      // Symmetric.
      if (nav.isLineWalkable(b, a) !== got) throw new Error(`segment ${i}: not symmetric`);
      if (got) clear++;
    }
    expect(clear).toBeGreaterThan(500);
    expect(clear).toBeLessThan(2800);
  });

  it('finds the nearest walkable cell centre within the radius', () => {
    // Already on a walkable cell: that cell.
    expect(nav.nearestWalkable(v(-20.2, 0.9), 3, out)).toBe(true);
    expect(out.toArray()).toEqual([-20.5, 0, 0.5]);
    expect(nav.nearestWalkable(v(-20.2, 0.9), 0, out)).toBe(true);
    // Inside the pillar: the neighbour on the side the point leans to.
    expect(nav.nearestWalkable(v(-19.1, -9.4), 3, out)).toBe(true);
    expect(out.toArray()).toEqual([-18.5, 0, -9.5]);
    expect(nav.nearestWalkable(v(-19.6, -9.9), 3, out)).toBe(true);
    expect(out.toArray()).toEqual([-19.5, 0, -10.5]);
    // On the crate: down to the floor next to it; the result carries the floor height.
    expect(nav.nearestWalkable({ x: -24.9, y: 1, z: 6.1 }, 3, out)).toBe(true);
    expect(out.toArray()).toEqual([-25.5, 0, 6.5]);
    expect(nav.nearestWalkable(v(16.4, -12.6), 1, out)).toBe(true);
    expect(out.x).toBe(16.5);
    expect(out.y).toBeCloseTo(0.4, 9);
    // Deep inside the corridor block: 3.5 m from the nearest floor.
    expect(nav.nearestWalkable(v(0.5, -7.5), 3, out)).toBe(false);
    expect(nav.nearestWalkable(v(0.5, -7.5), 4, out)).toBe(true);
    expect(out.toArray()).toEqual([0.5, 0, -3.5]);
    // The radius is measured to the cell centre.
    expect(nav.nearestWalkable(v(-19.1, -9.4), 0.5, out)).toBe(false);
    expect(nav.nearestWalkable(v(-19.1, -9.4), 0.61, out)).toBe(true);
    // Outside the grid, far away, garbage.
    expect(nav.nearestWalkable(v(-31.5, 0.5), 4, out)).toBe(true);
    expect(out.toArray()).toEqual([-28.5, 0, 0.5]);
    expect(nav.nearestWalkable(v(-100, 0), 5, out)).toBe(false);
    expect(nav.nearestWalkable(v(Number.NaN, 0), 5, out)).toBe(false);
    expect(nav.nearestWalkable(v(-19.5, -9.5), Number.NaN, out)).toBe(false);
    expect(nav.nearestWalkable(v(-19.5, -9.5), -1, out)).toBe(false);
    // An absurd radius or distance costs one pass over the grid, not a walk to infinity.
    expect(nav.nearestWalkable(v(-19.5, -9.5), 1e12, out)).toBe(true);
    expect(nav.nearestWalkable(v(1e7, 0.5), Infinity, out)).toBe(true);
    expect(out.toArray()).toEqual([28.5, 0, 0.5]);
    expect(nav.nearestWalkable(v(1e300, -1e300), 1e308, out)).toBe(false);
    expect(nav.nearestWalkable(v(Infinity, 0), Infinity, out)).toBe(false);
    const empty = createNavGrid();
    empty.build(levelWorld(), levelHints({ seeds: [] }));
    expect(empty.nearestWalkable(v(0, 0), 1e12, out)).toBe(false);
    expect(createNavGrid().nearestWalkable(v(0, 0), 1e12, out)).toBe(false);
  });

  it('nearestWalkable agrees with a brute-force search', () => {
    const rng = createRng(77);
    const cells = walkableCells(nav);
    const p = new THREE.Vector3();
    let found = 0;
    for (let i = 0; i < 2000; i++) {
      p.set(rng.range(-34, 34), 0, rng.range(-24, 24));
      const radius = rng.range(0.2, 6);
      let best = Infinity;
      for (const c of cells) {
        const d = Math.hypot(centreX(nav, c) - p.x, centreZ(nav, c) - p.z);
        if (d < best) best = d;
      }
      const inCell = nav.isWalkable(p.x, p.z);
      const got = nav.nearestWalkable(p, radius, out);
      if (got !== (inCell || best <= radius)) throw new Error(`point ${i} (${p.x}, ${p.z}) radius ${radius}: ${got}, nearest centre at ${best}`);
      if (!got) continue;
      found++;
      expect(nav.isWalkable(out.x, out.z)).toBe(true);
      const d = Math.hypot(out.x - p.x, out.z - p.z);
      if (inCell) expect(nav.cellAt(out.x, out.z)).toBe(nav.cellAt(p.x, p.z));
      else expect(d).toBeCloseTo(best, 9);
    }
    expect(found).toBeGreaterThan(1000);
  });
});

describe('gates and regions', () => {
  it('blocks and unblocks the cells whose centre lies inside the region', () => {
    const nav = createNavGrid();
    nav.build(levelWorld(), levelHints({ closedRegions: [] }));
    const base = walkableCells(nav).length;
    let version = nav.version;
    // Centres on the region edge count as inside.
    nav.setRegionWalkable(box(-25.5, 0, -18.5, -23.5, 5, -17.5), false);
    expect(nav.version).toBe(version + 1);
    expect(walkableCells(nav).length).toBe(base - 6);
    for (const x of [-25.5, -24.5, -23.5]) for (const z of [-18.5, -17.5]) expect(nav.isWalkable(x, z)).toBe(false);
    expect(nav.isWalkable(-26.5, -18.5)).toBe(true);
    expect(nav.isWalkable(-24.5, -16.5)).toBe(true);
    // No slipping diagonally past a corner of the blocked block, although both cells are free.
    expect(nav.isLineWalkable(v(-26.5, -17.5), v(-25.5, -16.5))).toBe(false);
    expect(nav.isLineWalkable(v(-22.5, -17.5), v(-23.5, -16.5))).toBe(false);
    expect(nav.isLineWalkable(v(-26.5, -16.5), v(-22.5, -16.5))).toBe(true);
    expectMatchesReference(nav, reference(levelWorld(), levelHints(), [box(-25.5, 0, -18.5, -23.5, 5, -17.5)]));
    // Blocking again changes nothing, including the version.
    version = nav.version;
    nav.setRegionWalkable(box(-25.5, 0, -18.5, -23.5, 5, -17.5), false);
    expect(nav.version).toBe(version);
    // A region between cell centres touches no cell.
    nav.setRegionWalkable(box(-15.4, 0, -5.4, -14.6, 5, -4.6), false);
    nav.setRegionWalkable(box(100, 0, 100, 200, 5, 200), false);
    expect(nav.version).toBe(version);
    expect(walkableCells(nav).length).toBe(base - 6);
    // Unblock part of it.
    nav.setRegionWalkable(box(-25.5, 0, -18.5, -24.5, 5, -18.5), true);
    expect(nav.version).toBe(version + 1);
    expect(walkableCells(nav).length).toBe(base - 4);
    // Unblocking never invents floor: walls and the closet stay out.
    version = nav.version;
    nav.setRegionWalkable(box(-30, 0, -20, 30, 5, 20), true);
    expect(nav.version).toBe(version + 1);
    expect(walkableCells(nav).length).toBe(base);
    expect(nav.isLineWalkable(v(-26.5, -17.5), v(-25.5, -16.5))).toBe(true);
    expect(nav.isWalkable(-29.5, 0.5)).toBe(false);
    expect(nav.isWalkable(-27.5, 15.5)).toBe(false);
    nav.setRegionWalkable(box(-30, 0, -20, 30, 5, 20), true);
    expect(nav.version).toBe(version + 1);
    // Blocked cells keep their height out of reach and their links closed, and open up again intact.
    nav.setRegionWalkable(box(-18, 0, 8, -14, 1, 12), false);
    expect(nav.heightAt(-15.5, 9.5, -7)).toBe(-7);
    expect(nav.isLineWalkable(v(-19.5, 9.5), v(-12.5, 9.5))).toBe(false);
    nav.setRegionWalkable(box(-18, 0, 8, -14, 1, 12), true);
    expect(nav.heightAt(-15.5, 9.5, -7)).toBe(0.4);
    expect(nav.isLineWalkable(v(-19.5, 9.5), v(-12.5, 9.5))).toBe(true);
  });

  it('opens and closes the way between the rooms', () => {
    const nav = createNavGrid();
    nav.build(levelWorld(), levelHints());
    const a = v(-20, 0);
    const corridor = v(5.5, 12.5);
    const south = v(20.5, 10.5);
    const north = v(13.5, -5.5);
    const path = makeNavPath();
    const out = new THREE.Vector3(9, 9, 9);

    expect(nav.isReachable(a, corridor)).toBe(true);
    expect(nav.isReachable(a, south)).toBe(false);
    expect(nav.isReachable(south, north)).toBe(true); // the long way round inside room B
    expect(nav.findPath(a, south, path)).toBe(false);
    expect(path.count).toBe(0);
    expect(nav.updateFlowField(south)).toBe(true);
    expect(nav.sampleFlow(a, out)).toBe(false);
    expect(out.toArray()).toEqual([0, 0, 0]);
    expect(nav.flowDistance(a)).toBe(Infinity);
    expect(nav.flowDistance(north)).toBeGreaterThan(26);
    expect(nav.isLineWalkable(v(8.5, 12.5), v(10.5, 12.5))).toBe(false);

    // Open the main gate: no updateFlowField needed, the stale field is rebuilt on demand.
    nav.setRegionWalkable(GATE_AB, true);
    expect(nav.isReachable(a, south)).toBe(true);
    expect(nav.findPath(a, south, path)).toBe(true);
    expect(nav.sampleFlow(a, out)).toBe(true);
    expect(out.length()).toBeCloseTo(1, 12);
    const far = nav.flowDistance(a);
    expect(far).toBeGreaterThan(45);
    expect(far).toBeLessThan(60);
    expect(nav.updateFlowField(south)).toBe(false); // already rebuilt by the sample
    expect(nav.isLineWalkable(v(8.5, 12.5), v(10.5, 12.5))).toBe(true);

    // The shortcut gate turns a long detour into a short hop.
    const detour = nav.flowDistance(north);
    nav.setRegionWalkable(GATE_B, true);
    expect(nav.updateFlowField(south)).toBe(true); // version changed, same target
    expect(nav.updateFlowField(south)).toBe(false);
    const hop = nav.flowDistance(north);
    expect(detour).toBeGreaterThan(26);
    expect(hop).toBeLessThan(19);
    nav.setRegionWalkable(GATE_B, false);
    expect(nav.flowDistance(north)).toBe(detour);

    // Close the main gate again: room A is cut off once more.
    nav.setRegionWalkable(GATE_AB, false);
    expect(nav.isReachable(a, south)).toBe(false);
    expect(nav.findPath(a, south, path)).toBe(false);
    expect(nav.sampleFlow(a, out)).toBe(false);
    expect(nav.flowDistance(a)).toBe(Infinity);
    expect(nav.flowDistance(north)).toBe(detour);
  });

  it('leads agents caught in a closing gate out on the side of the target', () => {
    const nav = openLevel();
    const out = new THREE.Vector3();
    const caught = v(9.6, 12.4);
    nav.updateFlowField(v(20.5, 10.5));
    expect(nav.sampleFlow(caught, out)).toBe(true);
    nav.setRegionWalkable(GATE_AB, false);
    expect(nav.isWalkable(caught.x, caught.z)).toBe(false);
    // Target in room B: out to the east. Target in room A: out to the west.
    expect(nav.sampleFlow(caught, out)).toBe(true);
    expect(out.x).toBeGreaterThan(0.9);
    expect(nav.flowDistance(caught)).toBeLessThan(15);
    nav.updateFlowField(v(-20, 0));
    expect(nav.sampleFlow(caught, out)).toBe(true);
    expect(out.x).toBeLessThan(-0.9);
    const p = caught.clone();
    for (let i = 0; i < 20 && !nav.isWalkable(p.x, p.z); i++) {
      expect(nav.sampleFlow(p, out)).toBe(true);
      p.addScaledVector(out, 0.12);
    }
    expect(nav.isWalkable(p.x, p.z)).toBe(true);
    expect(p.x).toBeLessThan(9);
    expect(followFlow(nav, p, v(-20, 0), 0.12, 1500).arrived).toBe(true);
  });
});

describe('flow field', () => {
  const world = levelWorld();
  const hints = levelHints();
  const out = new THREE.Vector3();

  it('gives every cell the shortest walking distance (reference search, many targets)', () => {
    const rng = createRng(4);
    for (const closed of [[], [GATE_B], [GATE_AB, GATE_B]] as Aabb[][]) {
      const nav = createNavGrid();
      nav.build(world, levelHints({ closedRegions: closed }));
      const ref = reference(world, hints, closed);
      const cells = walkableCells(nav);
      const targets = [nav.cellAt(TERRACE.x, TERRACE.z), nav.cellAt(-20, 0), nav.cellAt(1.5, 5.5), nav.cellAt(-15.5, 9.5), nav.cellAt(17.5, -12.5)];
      for (let i = 0; i < 12; i++) targets.push(rng.pick(cells));
      let reachable = 0;
      for (const target of targets) {
        nav.updateFlowField(v(centreX(nav, target), centreZ(nav, target)));
        reachable += expectFlowMatches(nav, ref, target);
      }
      expect(reachable).toBeGreaterThan(targets.length * 300);
    }
  });

  it('gives the shortest distance on cluttered arenas too', () => {
    const rng = createRng(8);
    for (const seed of [21, 22]) {
      const arena = clutterWorld(seed, 320, 40, 25);
      const nav = createNavGrid();
      nav.build(arena, clutterHints(40, 25));
      const ref = reference(arena, clutterHints(40, 25), []);
      const cells = walkableCells(nav);
      for (let i = 0; i < 8; i++) {
        const target = rng.pick(cells);
        nav.updateFlowField(v(centreX(nav, target), centreZ(nav, target)));
        expect(expectFlowMatches(nav, ref, target)).toBeGreaterThan(1500);
      }
    }
  });

  it('walks straight at a target in plain view, from anywhere and at any angle', () => {
    const nav = openLevel();
    const target = v(-14.3, -6.2);
    nav.updateFlowField(target);
    const rng = createRng(3);
    const p = new THREE.Vector3();
    let straight = 0;
    for (let i = 0; i < 400; i++) {
      p.set(rng.range(-28.5, -10.5), 0, rng.range(-18.5, 18.5));
      if (!nav.isWalkable(p.x, p.z)) continue;
      expect(nav.sampleFlow(p, out)).toBe(true);
      const d = Math.hypot(target.x - p.x, target.z - p.z);
      // Wherever the straight line is free with clearance to spare, the direction is exact: no
      // snapping to the 8 grid directions.
      let free = true;
      for (const [ox, oz] of [[0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]] as const) {
        free = free && nav.isLineWalkable(v(p.x + ox, p.z + oz), v(target.x + ox, target.z + oz));
      }
      if (!free) continue;
      straight++;
      expect(out.x).toBeCloseTo((target.x - p.x) / d, 9);
      expect(out.z).toBeCloseTo((target.z - p.z) / d, 9);
      expect(out.y).toBe(0);
    }
    expect(straight).toBeGreaterThan(200);
  });

  it('points straight at the target inside its cell and reports arrival as a zero vector', () => {
    const nav = openLevel();
    const target = v(-14.3, -6.2);
    nav.updateFlowField(target);
    expect(nav.sampleFlow(v(-14.9, -6.9), out)).toBe(true);
    expect(out.x).toBeCloseTo(0.6 / Math.hypot(0.6, 0.7), 9);
    expect(out.z).toBeCloseTo(0.7 / Math.hypot(0.6, 0.7), 9);
    out.set(5, 5, 5);
    expect(nav.sampleFlow(target, out)).toBe(true);
    expect(out.toArray()).toEqual([0, 0, 0]);
    expect(nav.flowDistance(target)).toBe(0);
    expect(nav.flowDistance(v(-14.9, -6.9))).toBe(0);
    expect(nav.flowDistance(v(-13.5, -6.5))).toBe(1);
    expect(nav.flowDistance(v(-13.5, -5.5))).toBeCloseTo(Math.SQRT2, 2);
  });

  it('routes around obstacles: every walkable cell reaches the target without detours', () => {
    const nav = openLevel();
    const p = new THREE.Vector3();
    for (const target of [v(TERRACE.x, TERRACE.z, 2), v(-27.5, -16.5), v(1.2, 7.7), v(-15.5, 9.5, 0.4)]) {
      nav.updateFlowField(target);
      let walked = 0;
      for (const c of walkableCells(nav)) {
        p.set(centreX(nav, c), 0, centreZ(nav, c));
        const d0 = nav.flowDistance(p);
        expect(d0).toBeLessThan(200);
        const stats = followFlow(nav, p, target, 0.25, 1200);
        if (!stats.arrived) throw new Error(`cell ${c}: did not arrive, stopped at (${p.x}, ${p.z})`);
        // The grid distance is an upper bound: cutting corners in straight lines is only shorter.
        if (stats.travelled > d0 + 1.5) throw new Error(`cell ${c}: walked ${stats.travelled} m for a flow distance of ${d0} m`);
        if (stats.reversalBurst > 1 || stats.regress > 1.5) throw new Error(`cell ${c}: oscillated (${JSON.stringify(stats)})`);
        walked++;
      }
      expect(walked).toBeGreaterThan(900);
    }
  });

  it('keeps the agent radius away from corners all the way', () => {
    const nav = openLevel();
    const rng = createRng(1234);
    const cells = walkableCells(nav);
    const p = new THREE.Vector3();
    const before = new THREE.Vector3();
    for (const target of [v(TERRACE.x, TERRACE.z), v(-27.5, -16.5), v(-23.5, -2.5)]) {
      nav.updateFlowField(target);
      for (let agent = 0; agent < 80; agent++) {
        nav.cellCenter(rng.pick(cells), p);
        for (let i = 0; i < 2000 && Math.hypot(p.x - target.x, p.z - target.z) > 0.6; i++) {
          expect(nav.sampleFlow(p, out)).toBe(true);
          before.copy(p);
          p.addScaledVector(out, 0.1);
          if (!keepsClear(nav, before, p, 0.3)) throw new Error(`agent ${agent}: cut a corner between (${before.x}, ${before.z}) and (${p.x}, ${p.z})`);
        }
        expect(Math.hypot(p.x - target.x, p.z - target.z)).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('snaps an off-mesh target to the nearest floor and ignores one that is nowhere near', () => {
    const nav = openLevel();
    const from = v(-20, 0);
    // Standing on the crate: the field leads to the floor cell next to it.
    expect(nav.updateFlowField({ x: -24.9, y: 1, z: 6.1 })).toBe(true);
    expect(nav.flowDistance(v(-25.5, 6.5))).toBe(0);
    const p = from.clone();
    expect(followFlow(nav, p, v(-25.5, 6.5), 0.12, 400).arrived).toBe(true);
    // Moving around on the crate without leaving the snapped cell does not rebuild anything.
    expect(nav.updateFlowField({ x: -24.8, y: 1, z: 6.3 })).toBe(false);
    // In the sealed closet (a floor, but not part of the grid): nearest cell outside its wall.
    expect(nav.updateFlowField(v(-27.5, 15.5))).toBe(true);
    expect(nav.flowDistance(from)).toBeLessThan(30);
    // Far from any floor (falling out of the world, deep inside a block): keep the last field.
    const before = nav.flowDistance(from);
    expect(nav.updateFlowField(v(0.5, -12.5))).toBe(false);
    expect(nav.updateFlowField(v(500, 500))).toBe(false);
    expect(nav.updateFlowField(v(Number.NaN, 0))).toBe(false);
    expect(nav.flowDistance(from)).toBe(before);
    expect(nav.sampleFlow(from, out)).toBe(true);
    // Within 4 m of the floor it snaps.
    expect(nav.updateFlowField(v(0.5, -7.5))).toBe(true);
    expect(nav.flowDistance(v(0.5, -3.5))).toBe(0);
  });

  it('only recomputes when the target cell or the grid changed', () => {
    const nav = openLevel();
    expect(nav.updateFlowField(v(-14.3, -6.2))).toBe(true);
    expect(nav.updateFlowField(v(-14.3, -6.2))).toBe(false);
    expect(nav.updateFlowField(v(-14.9, -6.9))).toBe(false); // same cell
    // ... but agents inside the cell aim at the new position.
    expect(nav.sampleFlow(v(-14.5, -6.5), out)).toBe(true);
    expect(out.x).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(out.z).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(nav.updateFlowField(v(-15.1, -6.9))).toBe(true); // next cell
    nav.setRegionWalkable(box(-25.5, 0, -18.5, -23.5, 5, -17.5), false);
    expect(nav.updateFlowField(v(-15.1, -6.9))).toBe(true);
    expect(nav.updateFlowField(v(-15.1, -6.9))).toBe(false);
    nav.setRegionWalkable(box(-25.5, 0, -18.5, -23.5, 5, -17.5), false); // no change
    expect(nav.updateFlowField(v(-15.1, -6.9))).toBe(false);
  });

  it('answers false for positions that cannot reach the target', () => {
    const nav = createNavGrid();
    nav.build(world, levelHints({ seeds: [{ x: -20, y: 0, z: 0 }, { x: -27.5, y: 0, z: 15.5 }] }));
    nav.updateFlowField(v(-20, 0));
    // Room B behind the closed gate, and the closet with its own seed.
    for (const p of [v(20.5, 10.5), v(-27.5, 15.5), v(TERRACE.x, TERRACE.z)]) {
      expect(nav.isWalkable(p.x, p.z)).toBe(true);
      out.set(3, 3, 3);
      expect(nav.sampleFlow(p, out)).toBe(false);
      expect(out.toArray()).toEqual([0, 0, 0]);
      expect(nav.flowDistance(p)).toBe(Infinity);
    }
    // Garbage and far away positions.
    for (const p of [v(Number.NaN, 0), v(0, Number.NaN), v(1e6, 0), v(0.5, -12.5)]) {
      out.set(3, 3, 3);
      expect(nav.sampleFlow(p, out)).toBe(false);
      expect(out.toArray()).toEqual([0, 0, 0]);
      expect(nav.flowDistance(p)).toBe(Infinity);
    }
  });

  it('steers agents standing in unwalkable cells back to the nearest cell that leads to the target', () => {
    const nav = openLevel();
    nav.updateFlowField(TERRACE);
    const p = new THREE.Vector3();
    const centre = new THREE.Vector3();
    let steered = 0;
    for (const [x, z] of [
      [-19.3, -9.6], // inside the pillar
      [-29.6, 3.3], // inside the west wall
      [-24.2, 5.8], // on the crate
      [-18.4, 15.6], // in the blocked hazard region
      [-26.2, -13.1], // under the low beam
      [-14.5, -16.2], // in the enemy clip volume
      [-9.6, 5.5], // in the wall between room A and the corridor
      [-31.5, 0.5], // outside the grid
    ] as const) {
      p.set(x, 0, z);
      expect(nav.isWalkable(x, z)).toBe(false);
      expect(nav.sampleFlow(p, out)).toBe(true);
      expect(out.length()).toBeCloseTo(1, 9);
      // It points at the centre of a walkable cell within 3 m, and walking there gets back on the mesh.
      expect(Number.isFinite(nav.flowDistance(p))).toBe(true);
      let steps = 0;
      for (; steps < 40 && !nav.isWalkable(p.x, p.z); steps++) {
        expect(nav.sampleFlow(p, out)).toBe(true);
        p.addScaledVector(out, 0.1);
      }
      expect(nav.isWalkable(p.x, p.z)).toBe(true);
      nav.cellCenter(nav.cellAt(p.x, p.z), centre);
      expect(Math.hypot(centre.x - x, centre.z - z)).toBeLessThanOrEqual(3);
      expect(followFlow(nav, p, TERRACE, 0.12, 2000).arrived).toBe(true);
      steered++;
    }
    expect(steered).toBe(8);
    // The steering goes by distance alone (the grid keeps no geometry): from inside the sealed closet
    // it points at the nearest cell of room A, straight through the closet wall.
    expect(nav.sampleFlow(v(-27.4, 15.2), out)).toBe(true);
    expect(out.z).toBeLessThan(-0.9);
    // Deep inside solid rock, or far outside the grid, there is no cell within 3 m: false.
    expect(nav.sampleFlow(v(0.5, -12.5), out)).toBe(false);
    expect(nav.sampleFlow(v(-36, 0.5), out)).toBe(false);
  });
});

describe('agents on the flow field', () => {
  it('60 agents dropped anywhere all reach the terrace: on the mesh, without oscillating', () => {
    const nav = openLevel();
    const cells = walkableCells(nav);
    for (const [seed, step] of [
      [1, 0.12],
      [2, 0.05],
      [3, 0.32],
    ] as const) {
      const rng = createRng(seed);
      nav.updateFlowField(TERRACE);
      const p = new THREE.Vector3();
      let longest = 0;
      let totalZigzags = 0;
      let totalSteps = 0;
      for (let agent = 0; agent < 60; agent++) {
        randomWalkablePoint(nav, cells, rng, p);
        const start = p.clone();
        const d0 = nav.flowDistance(p);
        expect(d0).toBeLessThan(140);
        const stats = followFlow(nav, p, TERRACE, step, Math.ceil(170 / step));
        const where = `seed ${seed} agent ${agent} from (${start.x.toFixed(2)}, ${start.z.toFixed(2)})`;
        if (!stats.arrived) throw new Error(`${where}: did not arrive, stopped at (${p.x}, ${p.z})`);
        if (stats.travelled > d0 + 1.5) throw new Error(`${where}: walked ${stats.travelled} m for a flow distance of ${d0} m`);
        // No oscillation: never two reversals close together, the distance to go never climbs back by
        // more than a cell and a half, and every few metres walked are real progress.
        if (stats.reversalBurst > 1) throw new Error(`${where}: reversed direction ${stats.reversalBurst} times within 12 steps`);
        if (stats.regress > 1.5) throw new Error(`${where}: flow distance climbed back by ${stats.regress} m`);
        if (stats.slowestWindow < PROGRESS_WINDOW * 0.5) throw new Error(`${where}: only ${stats.slowestWindow} m of progress in ${PROGRESS_WINDOW} m of walking`);
        expect(p.y).toBe(2);
        longest = Math.max(longest, stats.steps);
        totalZigzags += stats.zigzags;
        totalSteps += stats.steps;
      }
      // A few hundred steps at running pace.
      if (step === 0.12) {
        expect(longest).toBeGreaterThan(400);
        expect(longest).toBeLessThan(1200);
      }
      // Left-right-left wobble: at most a rare event at a corner, never a gait.
      expect(totalZigzags).toBeLessThan(totalSteps * 0.002 + 3);
    }
  });

  it('a closed gate holds back the agents behind it until it opens', () => {
    const nav = createNavGrid();
    nav.build(levelWorld(), levelHints({ closedRegions: [GATE_AB] }));
    nav.updateFlowField(TERRACE);
    const cells = walkableCells(nav);
    const rng = createRng(77);
    const dir = new THREE.Vector3();
    const agents: THREE.Vector3[] = [];
    for (let i = 0; i < 60; i++) agents.push(randomWalkablePoint(nav, cells, rng, new THREE.Vector3()));
    const waiting: THREE.Vector3[] = [];
    let arrived = 0;
    for (const p of agents) {
      if (p.x < 9) {
        // Rooms A and the corridor: no way through, the field says so and gives no direction.
        dir.set(1, 1, 1);
        expect(nav.sampleFlow(p, dir)).toBe(false);
        expect(dir.toArray()).toEqual([0, 0, 0]);
        expect(nav.flowDistance(p)).toBe(Infinity);
        waiting.push(p);
      } else {
        expect(followFlow(nav, p, TERRACE, 0.12, 1200).arrived).toBe(true);
        arrived++;
      }
    }
    expect(waiting.length).toBeGreaterThan(15);
    expect(arrived).toBeGreaterThan(15);
    // The gate opens: the very next sample leads through it, no explicit rebuild required.
    nav.setRegionWalkable(GATE_AB, true);
    for (const p of waiting) {
      const d0 = nav.flowDistance(p);
      expect(d0).toBeGreaterThan(15);
      const stats = followFlow(nav, p, TERRACE, 0.12, 1500);
      expect(stats.arrived).toBe(true);
      expect(stats.travelled).toBeLessThan(d0 + 1.5);
      expect(stats.reversalBurst).toBeLessThanOrEqual(1);
    }
    // And closes again behind them: whoever is dropped back in room A stays there.
    nav.setRegionWalkable(GATE_AB, false);
    expect(nav.sampleFlow(v(-20, 0), dir)).toBe(false);
    expect(nav.sampleFlow(v(20.5, 10.5), dir)).toBe(true);
  });

  it('60 agents reach targets all over the level and on cluttered arenas', () => {
    const scenarios: [NavGrid, number][] = [[openLevel(), 5]];
    for (const seed of [31, 32]) {
      const nav = createNavGrid();
      nav.build(clutterWorld(seed, 420), clutterHints());
      scenarios.push([nav, seed]);
    }
    for (const [nav, seed] of scenarios) {
      const rng = createRng(seed * 7919);
      const cells = walkableCells(nav);
      const target = new THREE.Vector3();
      const p = new THREE.Vector3();
      let zigzags = 0;
      let steps = 0;
      for (let round = 0; round < 6; round++) {
        randomWalkablePoint(nav, cells, rng, target);
        nav.updateFlowField(target);
        for (let agent = 0; agent < 60; agent++) {
          randomWalkablePoint(nav, cells, rng, p);
          const d0 = nav.flowDistance(p);
          if (d0 === Infinity) throw new Error(`seed ${seed}: walkable cell cut off from the target`);
          const start = p.clone();
          const stats = followFlow(nav, p, target, 0.125, Math.ceil((d0 + 10) / 0.125));
          const where = `seed ${seed} round ${round} agent ${agent} from (${start.x.toFixed(2)}, ${start.z.toFixed(2)}) to (${target.x.toFixed(2)}, ${target.z.toFixed(2)})`;
          if (!stats.arrived) throw new Error(`${where}: did not arrive, stopped at (${p.x}, ${p.z})`);
          if (stats.travelled > d0 + 1.5) throw new Error(`${where}: walked ${stats.travelled} m for a flow distance of ${d0} m`);
          if (stats.reversalBurst > 1 || stats.regress > 1.5) throw new Error(`${where}: oscillated (${JSON.stringify(stats)})`);
          zigzags += stats.zigzags;
          steps += stats.steps;
        }
      }
      expect(steps).toBeGreaterThan(20000);
      expect(zigzags).toBeLessThan(steps * 0.002 + 3);
    }
  });

  it('60 agents chase a moving target, the field following it cell by cell', () => {
    const nav = openLevel();
    const cells = walkableCells(nav);
    const rng = createRng(99);
    const agents: THREE.Vector3[] = [];
    for (let i = 0; i < 60; i++) agents.push(randomWalkablePoint(nav, cells, rng, new THREE.Vector3()));
    // The runner starts in room A and heads for the terrace along its own path, faster than nobody.
    const runner = v(-27.5, 10.5);
    const route = makeNavPath();
    expect(nav.findPath(runner, TERRACE, route)).toBe(true);
    let leg = 0;
    let rebuilds = 0;
    let frames = 0;
    const dir = new THREE.Vector3();
    for (; frames < 4000; frames++) {
      // Runner: 4 m/s at 60 Hz along the path.
      const next = route.points[leg] as THREE.Vector3;
      const d = Math.hypot(next.x - runner.x, next.z - runner.z);
      const runnerHome = leg === route.count - 1 && d < 0.07;
      if (d < 0.07) {
        if (leg < route.count - 1) leg++;
      } else {
        runner.x += ((next.x - runner.x) / d) * (4 / 60);
        runner.z += ((next.z - runner.z) / d) * (4 / 60);
      }
      expect(nav.isWalkable(runner.x, runner.z)).toBe(true);
      if (nav.updateFlowField(runner)) rebuilds++;
      // Agents: 7.5 m/s, stopping at arm's length.
      let close = 0;
      for (const p of agents) {
        const gap = Math.hypot(p.x - runner.x, p.z - runner.z);
        if (gap < 0.5) {
          close++;
          continue;
        }
        if (!nav.sampleFlow(p, dir)) throw new Error(`frame ${frames}: no flow at (${p.x}, ${p.z})`);
        p.addScaledVector(dir, Math.min(7.5 / 60, gap));
        if (!nav.isWalkable(p.x, p.z)) throw new Error(`frame ${frames}: agent left the mesh at (${p.x}, ${p.z})`);
      }
      if (close === agents.length && runnerHome) break;
    }
    expect(frames).toBeLessThan(4000);
    // One rebuild per cell the runner entered, not per frame.
    expect(rebuilds).toBeGreaterThan(60);
    expect(rebuilds).toBeLessThan(260);
    for (const p of agents) expect(Math.hypot(p.x - TERRACE.x, p.z - TERRACE.z)).toBeLessThan(0.7);
  });

  it('box-shaped agents driven by moveAndSlide follow the field through the real geometry', () => {
    // The nav clearance must be honest about the collision world: an agent as wide as the grid
    // assumes, pushed along the flow by the physics, never gets stuck on a corner or a stair.
    const world = levelWorld();
    world.setEnabledByTag('gate:ab', false);
    world.setEnabledByTag('gate:b', false);
    const nav = openLevel();
    nav.updateFlowField(TERRACE);
    const cells = walkableCells(nav);
    const rng = createRng(2024);
    const move = makeMoveResult();
    const dir = new THREE.Vector3();
    const delta = new THREE.Vector3();
    const p = new THREE.Vector3();
    const dt = 1 / 60;
    for (let agent = 0; agent < 60; agent++) {
      const c = rng.pick(cells);
      nav.cellCenter(c, p);
      const d0 = nav.flowDistance(p);
      let frames = 0;
      let stalled = 0;
      const limit = Math.ceil((d0 * 1.3 + 10) / (7.5 * dt));
      for (; frames < limit; frames++) {
        if (Math.hypot(p.x - TERRACE.x, p.z - TERRACE.z) < 0.5) break;
        if (!nav.sampleFlow(p, dir)) throw new Error(`agent ${agent} frame ${frames}: no flow at (${p.x}, ${p.y}, ${p.z})`);
        delta.set(dir.x * 7.5 * dt, -24 * dt * dt, dir.z * 7.5 * dt);
        const beforeX = p.x;
        const beforeZ = p.z;
        world.moveAndSlide(p, 0.4, 1.6, delta, COL.ENEMY, 0.75, 0.75, move);
        if (!move.grounded) throw new Error(`agent ${agent} frame ${frames}: left the ground at (${p.x}, ${p.y}, ${p.z})`);
        stalled = Math.hypot(p.x - beforeX, p.z - beforeZ) < 7.5 * dt * 0.3 ? stalled + 1 : 0;
        if (stalled > 20) throw new Error(`agent ${agent} frame ${frames}: stuck at (${p.x}, ${p.y}, ${p.z})`);
        // The grid height tracks the physical floor (stairs are one tread value per cell).
        if (Math.abs(nav.heightAt(p.x, p.z, p.y) - p.y) > 0.75) throw new Error(`agent ${agent}: grid height ${nav.heightAt(p.x, p.z)} vs body ${p.y}`);
      }
      if (frames >= limit) throw new Error(`agent ${agent}: did not arrive from cell ${c}, stopped at (${p.x}, ${p.y}, ${p.z})`);
      expect(p.y).toBe(2);
    }
  });
});

describe('findPath', () => {
  const nav = openLevel();
  const path = makeNavPath();
  const pathLength = (from: Vec3Like): number => {
    let length = Math.hypot((path.points[0] as THREE.Vector3).x - from.x, (path.points[0] as THREE.Vector3).z - from.z);
    for (let i = 1; i < path.count; i++) {
      length += Math.hypot((path.points[i] as THREE.Vector3).x - (path.points[i - 1] as THREE.Vector3).x, (path.points[i] as THREE.Vector3).z - (path.points[i - 1] as THREE.Vector3).z);
    }
    return length;
  };

  it('returns a single waypoint when the goal is in plain view', () => {
    const from = v(-28.2, 0.3);
    const to = v(-11.4, 11.8);
    expect(nav.findPath(from, to, path)).toBe(true);
    expect(path.count).toBe(1);
    expect((path.points[0] as THREE.Vector3).toArray()).toEqual([-11.4, 0, 11.8]);
    // Same cell, same point.
    expect(nav.findPath(from, v(-28.4, 0.6), path)).toBe(true);
    expect(path.count).toBe(1);
    expect((path.points[0] as THREE.Vector3).toArray()).toEqual([-28.4, 0, 0.6]);
    expect(nav.findPath(from, from, path)).toBe(true);
    expect(path.count).toBe(1);
  });

  it('threads the corridor with a handful of waypoints and carries floor heights', () => {
    const from = v(-20, 0);
    expect(nav.findPath(from, TERRACE, path)).toBe(true);
    // Door, two corridor corners, gate, shortcut gate, stairs: a string-pulled path, not a cell list.
    expect(path.count).toBeGreaterThanOrEqual(5);
    expect(path.count).toBeLessThanOrEqual(14);
    const last = path.points[path.count - 1] as THREE.Vector3;
    expect(last.toArray()).toEqual([TERRACE.x, 2, TERRACE.z]);
    for (let i = 0; i < path.count; i++) {
      const p = path.points[i] as THREE.Vector3;
      expect(nav.isWalkable(p.x, p.z)).toBe(true);
      expect(p.y).toBe(nav.heightAt(p.x, p.z, -1));
    }
    nav.updateFlowField(TERRACE);
    const grid = nav.flowDistance(from);
    const length = pathLength(from);
    expect(length).toBeLessThanOrEqual(grid + 1e-9);
    expect(length).toBeGreaterThan(grid * 0.85);
  });

  it('produces valid, near-optimal paths between random points', () => {
    const rng = createRng(606);
    const cells = walkableCells(nav);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    let waypoints = 0;
    for (let i = 0; i < 300; i++) {
      randomWalkablePoint(nav, cells, rng, from);
      randomWalkablePoint(nav, cells, rng, to);
      if (!nav.findPath(from, to, path)) throw new Error(`path ${i}: none from (${from.x}, ${from.z}) to (${to.x}, ${to.z})`);
      expect(path.count).toBeGreaterThanOrEqual(1);
      const last = path.points[path.count - 1] as THREE.Vector3;
      expect(last.x).toBe(to.x);
      expect(last.z).toBe(to.z);
      // Every leg is a straight walkable line.
      let prev: Vec3Like = from;
      for (let k = 0; k < path.count; k++) {
        const p = path.points[k] as THREE.Vector3;
        if (!nav.isLineWalkable(prev, p)) throw new Error(`path ${i}: leg ${k} from (${prev.x}, ${prev.z}) to (${p.x}, ${p.z}) is not walkable`);
        prev = p;
      }
      // No longer than the grid route, no shorter than the crow flies.
      nav.updateFlowField(to);
      const grid = nav.flowDistance(from);
      const length = pathLength(from);
      if (length > grid + 1.5 || length < from.distanceTo(to) - 1e-9) throw new Error(`path ${i}: length ${length}, grid distance ${grid}`);
      waypoints += path.count;
    }
    // Smoothing: a few corners per path on average.
    expect(waypoints / 300).toBeLessThan(8);
  });

  it('keeps the agent radius away from corners on every leg', () => {
    // Between cell centres (which have clearance by construction) no leg may graze a wall corner:
    // 0.3 m of floor on all four sides everywhere, where a bare line of sight would allow 0.
    const rng = createRng(909);
    const cells = walkableCells(nav);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    let turns = 0;
    for (let i = 0; i < 300; i++) {
      nav.cellCenter(rng.pick(cells), from);
      nav.cellCenter(rng.pick(cells), to);
      expect(nav.findPath(from, to, path)).toBe(true);
      let prev: Vec3Like = from;
      for (let k = 0; k < path.count; k++) {
        const p = path.points[k] as THREE.Vector3;
        if (!keepsClear(nav, prev, p, 0.3)) throw new Error(`path ${i}: leg ${k} from (${prev.x}, ${prev.z}) to (${p.x}, ${p.z}) cuts a corner`);
        prev = p;
      }
      turns += path.count - 1;
    }
    expect(turns).toBeGreaterThan(300);
  });

  it('snaps end points within 3 m of the mesh and fails beyond', () => {
    // From inside the pillar to the top of the crate: both ends snap to cell centres.
    expect(nav.findPath(v(-19.4, -9.8), { x: -24.9, y: 1, z: 6.1 }, path)).toBe(true);
    expect((path.points[path.count - 1] as THREE.Vector3).toArray()).toEqual([-25.5, 0, 6.5]);
    expect(nav.isLineWalkable(v(-19.5, -10.5), path.points[0] as THREE.Vector3)).toBe(true);
    // Unreachable or nowhere near: false, and the buffer reports no points.
    expect(nav.findPath(v(-20, 0), v(0.5, -12.5), path)).toBe(false);
    expect(path.count).toBe(0);
    expect(nav.findPath(v(0.5, -12.5), v(-20, 0), path)).toBe(false);
    expect(nav.findPath(v(-20, 0), v(Number.NaN, 0), path)).toBe(false);
    expect(nav.findPath(v(500, 0), v(-20, 0), path)).toBe(false);
    const gated = createNavGrid();
    gated.build(levelWorld(), levelHints());
    expect(gated.findPath(v(-20, 0), v(20.5, 10.5), path)).toBe(false);
    expect(path.count).toBe(0);
    expect(gated.findPath(v(20.5, 10.5), v(13.5, -5.5), path)).toBe(true);
  });

  it('reuses the path buffer and grows it only when it has to', () => {
    const small = makeNavPath(2);
    const first = small.points[0];
    const second = small.points[1];
    expect(nav.findPath(v(-20, 0), TERRACE, small)).toBe(true);
    expect(small.count).toBeGreaterThan(2);
    expect(small.points.length).toBeGreaterThanOrEqual(small.count);
    expect(small.points[0]).toBe(first);
    expect(small.points[1]).toBe(second);
    const grown = small.points.length;
    const third = small.points[2];
    expect(nav.findPath(v(-20, 0), TERRACE, small)).toBe(true);
    expect(small.points.length).toBe(grown);
    expect(small.points[2]).toBe(third);
    expect(nav.findPath(v(-20, 0), v(-21, 1), small)).toBe(true);
    expect(small.count).toBe(1);
    expect(small.points.length).toBe(grown);
  });
});

describe('randomPointInAnnulus', () => {
  const out = new THREE.Vector3();

  it('returns walkable, reachable points inside the ring, spread around it', () => {
    const nav = openLevel();
    const rng = createRng(17);
    for (const [center, lo, hi] of [
      [v(-20, 0), 3, 8],
      [v(-20, 0), 0, 2],
      [v(1, 5), 4, 12],
      [v(TERRACE.x, TERRACE.z), 2, 6],
      [v(20.5, 10.5), 10, 30],
      [v(-15.5, 9.5), 1, 1.5],
    ] as const) {
      const sectors = new Set<number>();
      let ok = 0;
      for (let i = 0; i < 200; i++) {
        if (!nav.randomPointInAnnulus(center, lo, hi, rng, out)) continue;
        ok++;
        const d = Math.hypot(out.x - center.x, out.z - center.z);
        if (d < lo - 1e-9 || d > hi + 1e-9) throw new Error(`distance ${d} outside [${lo}, ${hi}]`);
        if (!nav.isWalkable(out.x, out.z) || !nav.isReachable(center, out)) throw new Error(`(${out.x}, ${out.z}) is not a reachable floor point`);
        expect(out.y).toBe(nav.heightAt(out.x, out.z, -1));
        sectors.add(Math.floor(((Math.atan2(out.z - center.z, out.x - center.x) + Math.PI) / (2 * Math.PI)) * 8) % 8);
      }
      expect(ok).toBeGreaterThan(40);
      expect(sectors.size).toBeGreaterThanOrEqual(lo >= 10 ? 2 : 3);
    }
  });

  it('keeps clear of obstacles: points next to walls and ledges are cell centres', () => {
    const nav = openLevel();
    const rng = createRng(18);
    const center = v(-19.5, -8);
    let centres = 0;
    for (let i = 0; i < 400; i++) {
      if (!nav.randomPointInAnnulus(center, 0.5, 3, rng, out)) continue;
      // Within reach of the pillar (its face is 0.5 m from the neighbouring centres) a point must
      // be a cell centre; a free-standing point keeps at least half a cell of margin.
      const nearPillar = Math.abs(out.x + 19.5) < 1.5 && Math.abs(out.z + 9.5) < 1.5;
      if (nearPillar) {
        expect(Math.abs(out.x % 1)).toBeCloseTo(0.5, 9);
        expect(Math.abs(out.z % 1)).toBeCloseTo(0.5, 9);
        centres++;
      }
    }
    expect(centres).toBeGreaterThan(10);
  });

  it('respects gates and fails cleanly when there is nothing to find', () => {
    const nav = createNavGrid();
    nav.build(levelWorld(), levelHints());
    const rng = createRng(19);
    // From the corridor end next to the closed gate: never a point in room B.
    const center = v(7.5, 12.5);
    for (let i = 0; i < 300; i++) {
      if (nav.randomPointInAnnulus(center, 2, 9, rng, out)) expect(out.x).toBeLessThan(9);
    }
    nav.setRegionWalkable(GATE_AB, true);
    let beyond = 0;
    for (let i = 0; i < 300; i++) {
      if (nav.randomPointInAnnulus(center, 2, 9, rng, out) && out.x > 10) beyond++;
    }
    expect(beyond).toBeGreaterThan(20);
    // A ring that lies entirely in solid rock, an inverted ring, a centre off the mesh.
    let calls = 0;
    const counting: Rng = { ...rng, range: (min, max) => (calls++, rng.range(min, max)) };
    expect(nav.randomPointInAnnulus(v(-28.5, 0.5), 200, 300, counting, out)).toBe(false);
    expect(calls).toBe(48); // 24 tries, an angle and a radius each
    expect(nav.randomPointInAnnulus(v(0.5, -12.5), 0, 2, rng, out)).toBe(false);
    expect(nav.randomPointInAnnulus(v(Number.NaN, 0), 0, 2, rng, out)).toBe(false);
    // min > max collapses to the circle of radius min.
    let ring = 0;
    for (let i = 0; i < 50; i++) {
      if (!nav.randomPointInAnnulus(v(-20.5, 0.5), 5, 2, rng, out)) continue;
      ring++;
      expect(Math.hypot(out.x + 20.5, out.z - 0.5)).toBeCloseTo(5, 9);
    }
    expect(ring).toBeGreaterThan(10);
    // Deterministic for a given rng state.
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    nav.randomPointInAnnulus(v(-20, 0), 3, 8, createRng(5), a);
    nav.randomPointInAnnulus(v(-20, 0), 3, 8, createRng(5), b);
    expect(a.toArray()).toEqual(b.toArray());
  });
});

describe('performance', () => {
  const world = clutterWorld(99, 420);
  const hints = clutterHints();
  const nav = createNavGrid();
  nav.build(world, hints);
  const cells = walkableCells(nav);
  const rng = createRng(123);
  const starts: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) starts.push(randomWalkablePoint(nav, cells, rng, new THREE.Vector3()));
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const path = makeNavPath(64);

  const samples = (n: number): number => {
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const s = starts[i & 63] as THREE.Vector3;
      p.x = s.x + Math.cos(i * 0.37) * 0.3;
      p.z = s.z + Math.sin(i * 0.11) * 0.3;
      if (nav.sampleFlow(p, dir)) ok++;
    }
    return ok;
  };

  it('builds a 150 x 90 grid from hundreds of boxes in a few milliseconds', () => {
    expect([nav.cols, nav.rows]).toEqual([150, 90]);
    expect(cells.length).toBeGreaterThan(9000);
    const fresh = createNavGrid();
    fresh.build(world, hints);
    const t0 = performance.now();
    fresh.build(world, hints);
    const ms = performance.now() - t0;
    console.info(`[nav] build 150 x 90 from ${world.boxes.length} boxes: ${ms.toFixed(1)} ms`);
    // Measured around 30 ms; a level load can afford far more.
    expect(ms).toBeLessThan(600);
  });

  it('rebuilds the flow field of a 150 x 90 grid in well under 2 ms', () => {
    const target = new THREE.Vector3();
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      randomWalkablePoint(nav, cells, rng, target);
      const t0 = performance.now();
      const rebuilt = nav.updateFlowField(target);
      const ms = performance.now() - t0;
      if (rebuilt && i >= 100) times.push(ms);
    }
    times.sort((a, b) => a - b);
    const quartile = times[times.length >> 2] as number;
    const median = times[times.length >> 1] as number;
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    console.info(
      `[nav] flow field rebuild (150 x 90, ${cells.length} walkable cells): best quartile ${quartile.toFixed(3)} ms, median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`,
    );
    expect(times.length).toBeGreaterThan(250);
    // Target: under 2 ms, so the field can follow the player several times per second. Measured
    // around 0.35 ms. The target is asserted on the best quartile (what the code costs when the
    // shared machine lets it run) and the median gets a 25x margin for when it does not.
    expect(quartile).toBeLessThan(2);
    expect(median).toBeLessThan(10);
  });

  it('samples the field for 60 agents in a small fraction of a millisecond', () => {
    nav.updateFlowField(starts[0] as THREE.Vector3);
    samples(60000);
    const t0 = performance.now();
    const ok = samples(120000);
    const us = ((performance.now() - t0) * 1000) / 120000;
    console.info(`[nav] sampleFlow ${us.toFixed(3)} us/call (60 agents: ${((us * 60) / 1000).toFixed(3)} ms per frame)`);
    expect(ok).toBe(120000);
    // Measured around 1.3 us; 60 agents every frame must stay far below 1 ms.
    expect(us).toBeLessThan(15);
  });

  it('finds paths across the arena in a fraction of a millisecond', () => {
    let found = 0;
    for (let i = 0; i < 200; i++) if (nav.findPath(starts[i & 63] as THREE.Vector3, starts[(i * 7 + 3) & 63] as THREE.Vector3, path)) found++;
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) if (nav.findPath(starts[i & 63] as THREE.Vector3, starts[(i * 7 + 3) & 63] as THREE.Vector3, path)) found++;
    const us = ((performance.now() - t0) * 1000) / 1000;
    console.info(`[nav] findPath ${us.toFixed(1)} us/call`);
    expect(found).toBe(1200);
    expect(us).toBeLessThan(2500);
  });

  describe('heap allocation', () => {
    // A second grid: see the note in the physics suite (the queries must stay clean when the engine
    // cannot specialise the closures for a single instance).
    const decoy = createNavGrid();
    decoy.build(clutterWorld(1, 10, 6, 6), clutterHints(6, 6));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const moving = new THREE.Vector3();

    /**
     * Queries that take bare coordinates are called with integers here: a fractional number passed
     * to a call that is not inlined is boxed by the CALLER, which is not what this test is about.
     */
    const lookups = (n: number): number => {
      let hits = 0;
      for (let i = 0; i < n; i++) {
        const x = ((i * 7) % 150) - 75;
        const z = ((i * 13) % 90) - 45;
        if (nav.isWalkable(x, z)) hits++;
        if (nav.cellAt(x, z) >= 0) hits++;
        if (nav.zoneAt(x, z) === null) hits++;
      }
      return hits;
    };
    const lines = (n: number): number => {
      let clear = 0;
      for (let i = 0; i < n; i++) {
        if (nav.isLineWalkable(starts[i & 63] as THREE.Vector3, starts[(i * 5 + 1) & 63] as THREE.Vector3)) clear++;
        if (nav.isReachable(starts[i & 63] as THREE.Vector3, starts[(i * 3 + 2) & 63] as THREE.Vector3)) clear++;
      }
      return clear;
    };
    const nearest = (n: number): number => {
      let found = 0;
      for (let i = 0; i < n; i++) {
        const s = starts[i & 63] as THREE.Vector3;
        a.x = s.x + Math.cos(i * 0.7) * 2;
        a.z = s.z + Math.sin(i * 0.3) * 2;
        if (nav.nearestWalkable(a, 3, b)) found++;
      }
      return found;
    };
    /** The per-frame call of the enemy system: same cell most frames, a rebuild now and then. */
    const updates = (n: number): number => {
      let rebuilt = 0;
      for (let i = 0; i < n; i++) {
        const s = starts[(i >> 6) & 63] as THREE.Vector3;
        moving.x = s.x + Math.cos(i * 0.05) * 0.2;
        moving.z = s.z + Math.sin(i * 0.05) * 0.2;
        if (nav.updateFlowField(moving)) rebuilt++;
      }
      return rebuilt;
    };
    /** One short path (5 - 12 m, around whatever stands in between) per 10 calls. */
    const nearby: THREE.Vector3[] = [];
    for (const s of starts) {
      const goal = new THREE.Vector3();
      if (!nav.randomPointInAnnulus(s, 5, 12, rng, goal)) goal.copy(s);
      nearby.push(goal);
    }
    const paths = (n: number): number => {
      let found = 0;
      for (let i = 0; i < n; i += 10) {
        const k = (i / 10) & 63;
        if (nav.findPath(starts[k] as THREE.Vector3, nearby[k] as THREE.Vector3, path)) found++;
      }
      return found;
    };
    const distances = (n: number): number => {
      let reachable = 0;
      for (let i = 0; i < n; i++) if (nav.flowDistance(starts[i & 63] as THREE.Vector3) < 1e9) reachable++;
      return reachable;
    };
    const heights = (n: number): number => {
      let raised = 0;
      for (let i = 0; i < n; i++) if (nav.heightAt(((i * 7) % 150) - 75, ((i * 13) % 90) - 45, -1) > 0.1) raised++;
      return raised;
    };

    it('does not allocate in sampleFlow, lookups, line tests, nearest-cell search, flow updates or paths', () => {
      expect(decoy.cols).toBe(12);
      expect(boxOneNumberPerCall(WARM_UP_CALLS)).toBeTypeOf('number');
      const control = bytesPerCall(boxOneNumberPerCall);
      expect(control).toBeGreaterThan(8);
      expect(control).toBeLessThan(40);
      nav.updateFlowField(starts[0] as THREE.Vector3);
      const queries: [string, (n: number) => unknown, number][] = [
        ['sampleFlow', samples, WARM_UP_CALLS],
        ['isWalkable + cellAt + zoneAt', lookups, WARM_UP_CALLS],
        ['isLineWalkable + isReachable', lines, WARM_UP_CALLS],
        ['nearestWalkable', nearest, WARM_UP_CALLS],
        // A rebuild every 64 calls and a path every 10: their inner loops are hot long before this.
        ['updateFlowField (a rebuild per 64 calls)', updates, WARM_UP_CALLS / 4],
        ['findPath (per 10 calls)', paths, WARM_UP_CALLS / 4],
      ];
      for (const [, fn, warmUp] of queries) fn(warmUp);
      const report: string[] = [`control ${control.toFixed(2)}`];
      for (const [name, fn] of queries) {
        const bytes = bytesPerCall(fn);
        report.push(`${name} ${bytes.toFixed(2)}`);
        if (bytes >= ALLOC_LIMIT_BYTES) throw new Error(`${name} allocates about ${bytes.toFixed(1)} bytes per call`);
      }
      console.info(`[nav] heap bytes per call: ${report.join(', ')}`);
      expect(updates(640)).toBeGreaterThan(5);
      expect(paths(640)).toBe(64);
    });

    it('flowDistance and heightAt cost at most the boxing of their return value', () => {
      // Both hand a fractional number back through the call boundary, which the engine boxes (12-16
      // bytes) whenever it does not inline the call; nothing else may be allocated.
      nav.updateFlowField(starts[0] as THREE.Vector3);
      distances(WARM_UP_CALLS);
      heights(WARM_UP_CALLS);
      const distanceBytes = bytesPerCall(distances);
      const heightBytes = bytesPerCall(heights);
      console.info(`[nav] heap bytes per call: flowDistance ${distanceBytes.toFixed(2)}, heightAt ${heightBytes.toFixed(2)}`);
      expect(distanceBytes).toBeLessThan(20);
      expect(heightBytes).toBeLessThan(20);
      expect(distances(64)).toBe(64);
      expect(heights(13500)).toBeGreaterThan(100);
    });
  });
});
