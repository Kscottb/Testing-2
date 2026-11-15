/**
 * CollisionWorld tests: bookkeeping, swept move-and-slide (seams, edges, steps, tunnelling, gates,
 * embedded starts), raycasts, overlap queries, and brute-force / performance / allocation checks on a
 * world of thousands of boxes.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { COL } from '../core/constants';
import { makeMoveResult, makeRayHit } from '../core/make';
import { createRng } from '../core/rng';
import type { Aabb, BoxDesc, CollisionWorld, MoveResult, Vec3Like } from '../core/types';
import { ALLOC_LIMIT_BYTES, WARM_UP_CALLS, boxOneNumberPerCall, bytesPerCall } from './heapmeter';
import { createCollisionWorld } from './index';

// Brute-force references and long random walks on a machine shared with other jobs: no test here is
// allowed to fail because it was starved of CPU for a few seconds.
vi.setConfig({ testTimeout: 120_000 });

const HW = 0.35;
const H = 1.8;
const STEP = 0.45;
const GRAVITY = 24;
const SKIN = 1e-4;

const box = (
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  extra: Partial<BoxDesc> = {},
): BoxDesc => ({ minX, minY, minZ, maxX, maxY, maxZ, ...extra });

function worldOf(...descs: BoxDesc[]): CollisionWorld {
  const world = createCollisionWorld();
  for (const d of descs) world.addBox(d);
  world.finalize();
  return world;
}

const FLOOR = box(-30, -1, -30, 30, 0, 30);

interface MoveOptions {
  stepUp?: number;
  snapDown?: number;
  mask?: number;
  hw?: number;
  h?: number;
}

const shared = makeMoveResult();
const deltaScratch = new THREE.Vector3();

function move(
  world: CollisionWorld,
  pos: THREE.Vector3,
  dx: number,
  dy: number,
  dz: number,
  o: MoveOptions = {},
): MoveResult {
  deltaScratch.set(dx, dy, dz);
  return world.moveAndSlide(pos, o.hw ?? HW, o.h ?? H, deltaScratch, o.mask ?? COL.PLAYER, o.stepUp ?? 0, o.snapDown ?? 0, shared);
}

/** Deepest overlap of the body with any matching box (0 when it only touches). */
function penetration(world: CollisionWorld, pos: Vec3Like, mask = COL.PLAYER, hw = HW, h = H): number {
  let worst = 0;
  for (const b of world.boxes) {
    if (!b.enabled || (b.flags & mask) === 0) continue;
    const px = Math.min(pos.x + hw - b.minX, b.maxX - (pos.x - hw));
    const py = Math.min(pos.y + h - b.minY, b.maxY - pos.y);
    const pz = Math.min(pos.z + hw - b.minZ, b.maxZ - (pos.z - hw));
    const p = Math.min(px, py, pz);
    if (p > worst) worst = p;
  }
  return worst;
}

/** 1 m floor tiles from -half to +half (top at y = 0), optionally with float noise on the tops. */
function tiledFloor(world: CollisionWorld, half: number, noise = 0): void {
  let i = 0;
  for (let z = -half; z < half; z++) {
    for (let x = -half; x < half; x++) {
      world.addBox(box(x, -1, z, x + 1, noise === 0 ? 0 : noise * ((i++ % 3) - 1), z + 1));
    }
  }
}

/** A solid flight of stairs climbing toward +x from x0: `count` treads of `tread` x `rise`, then a terrace. */
function stairs(world: CollisionWorld, x0: number, count: number, tread: number, rise: number, endX: number, halfDepth = 2): void {
  for (let i = 0; i < count; i++) {
    world.addBox(box(x0 + tread * i, 0, -halfDepth, endX, rise * (i + 1), halfDepth));
  }
}

interface RefHit {
  t: number;
  id: number;
  axis: number;
  sign: number;
}

/** Brute-force raycast with the documented semantics (reference for the grid traversal). */
function refRaycast(world: CollisionWorld, o: Vec3Like, d: Vec3Like, maxDist: number, mask: number): RefHit | null {
  let best: RefHit | null = null;
  let bestT = maxDist;
  const oo = [o.x, o.y, o.z];
  const dd = [d.x, d.y, d.z];
  for (const b of world.boxes) {
    if (!b.enabled || (b.flags & mask) === 0) continue;
    const lo = [b.minX, b.minY, b.minZ];
    const hi = [b.maxX, b.maxY, b.maxZ];
    let tmin = -Infinity;
    let tmax = Infinity;
    let axis = 0;
    let miss = false;
    for (let k = 0; k < 3; k++) {
      const dk = dd[k] as number;
      const ok = oo[k] as number;
      if (Math.abs(dk) > 1e-12) {
        let t1 = ((lo[k] as number) - ok) / dk;
        let t2 = ((hi[k] as number) - ok) / dk;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tmin) {
          tmin = t1;
          axis = k;
        }
        if (t2 < tmax) tmax = t2;
      } else if (ok < (lo[k] as number) || ok >= (hi[k] as number)) {
        miss = true;
        break;
      }
    }
    if (miss || tmin > tmax) continue;
    if (tmin < 0) {
      if (tmin < -1e-5 || tmax <= 0) continue;
      tmin = 0;
    }
    if (tmin >= bestT) continue;
    bestT = tmin;
    best = { t: tmin, id: b.id, axis, sign: (dd[axis] as number) > 0 ? -1 : 1 };
  }
  return best;
}

function refOverlap(world: CollisionWorld, q: Aabb, mask: number): number[] {
  const ids: number[] = [];
  for (const b of world.boxes) {
    if (!b.enabled || (b.flags & mask) === 0) continue;
    if (
      q.minX < b.maxX - SKIN &&
      q.maxX > b.minX + SKIN &&
      q.minY < b.maxY - SKIN &&
      q.maxY > b.minY + SKIN &&
      q.minZ < b.maxZ - SKIN &&
      q.maxZ > b.minZ + SKIN
    ) {
      ids.push(b.id);
    }
  }
  return ids;
}

function refSphere(world: CollisionWorld, c: Vec3Like, r: number, mask: number): boolean {
  for (const b of world.boxes) {
    if (!b.enabled || (b.flags & mask) === 0) continue;
    const dx = c.x - Math.max(b.minX, Math.min(b.maxX, c.x));
    const dy = c.y - Math.max(b.minY, Math.min(b.maxY, c.y));
    const dz = c.z - Math.max(b.minZ, Math.min(b.maxZ, c.z));
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}

function refGround(world: CollisionWorld, x: number, z: number, maxY: number, mask: number): number {
  let top = -Infinity;
  for (const b of world.boxes) {
    if (!b.enabled || (b.flags & mask) === 0) continue;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.maxY <= maxY + SKIN && b.maxY > top) top = b.maxY;
  }
  return top;
}

/** A 150 x 90 m arena filled with thousands of boxes: steps, blocks, beams, thin walls, mixed flags. */
function bigWorld(count: number, seed: number): CollisionWorld {
  const rng = createRng(seed);
  const world = createCollisionWorld();
  world.addBox(box(-75, -1, -45, 75, 0, 45));
  const flagChoices = [COL.SOLID, COL.SOLID, COL.SOLID, COL.GATE, COL.RAILING, COL.PLAYER_CLIP, COL.ENEMY_CLIP];
  while (world.boxes.length < count) {
    const x = rng.range(-73, 73);
    const z = rng.range(-43, 43);
    if (Math.abs(x) < 3 && Math.abs(z) < 3) continue;
    const kind = rng.int(0, 3);
    let w = rng.range(0.2, 1.2);
    let d = rng.range(0.2, 1.2);
    let y0 = 0;
    let y1 = rng.range(1, 4);
    if (kind === 0) y1 = rng.range(0.05, 0.45);
    else if (kind === 1) {
      y0 = rng.range(1, 3);
      y1 = y0 + rng.range(0.2, 1);
    } else if (kind === 2) {
      if (rng.chance(0.5)) w = 0.05;
      else d = 0.05;
    }
    world.addBox(box(x - w, y0, z - d, x + w, y1, z + d, { flags: rng.pick(flagChoices), tag: `k${kind}` }));
  }
  world.finalize();
  return world;
}

describe('collision world: bookkeeping', () => {
  it('stores boxes with defaults, normalised extents and stable ids', () => {
    const world = createCollisionWorld();
    const a = world.addBox(box(2, 3, 4, -2, -3, -4));
    const b = world.addBox(box(0, 0, 0, 1, 1, 1, { flags: COL.GATE, surface: 'energy', tag: 'gate:x' }));
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(world.boxes).toHaveLength(2);
    const first = world.boxes[0];
    expect(first).toMatchObject({ id: 0, minX: -2, minY: -3, minZ: -4, maxX: 2, maxY: 3, maxZ: 4 });
    expect(first).toMatchObject({ flags: COL.SOLID, surface: 'metal', tag: '', enabled: true });
    expect(world.boxes[1]).toMatchObject({ id: 1, flags: COL.GATE, surface: 'energy', tag: 'gate:x' });
  });

  it('computes bounds on finalize and resets them on clear', () => {
    const world = worldOf(box(-3, -1, -2, 4, 0, 5), box(10, 2, 1, 12, 9, 3));
    expect(world.bounds).toEqual({ minX: -3, minY: -1, minZ: -2, maxX: 12, maxY: 9, maxZ: 5 });
    const bounds = world.bounds;
    world.clear();
    expect(world.boxes).toHaveLength(0);
    expect(world.bounds).toBe(bounds);
    expect(world.bounds).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
    const hit = makeRayHit();
    expect(world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100, COL.ANY, hit)).toBe(false);
    expect(world.groundHeight(0, 0, 100, COL.ANY)).toBe(-Infinity);
    expect(world.overlapBox(box(-100, -100, -100, 100, 100, 100), COL.ANY)).toBe(-1);
    // The world is reusable after clear: ids restart at 0.
    expect(world.addBox(FLOOR)).toBe(0);
    world.finalize();
    expect(world.groundHeight(0, 0, 100, COL.ANY)).toBe(0);
  });

  it('bumps version on add, finalize, clear and real toggles only', () => {
    const world = createCollisionWorld();
    let v = world.version;
    const id = world.addBox(box(0, 0, 0, 1, 1, 1, { tag: 't' }));
    expect(world.version).toBeGreaterThan(v);
    v = world.version;
    world.finalize();
    expect(world.version).toBeGreaterThan(v);
    v = world.version;
    world.setEnabled(id, true);
    expect(world.version).toBe(v);
    world.setEnabled(id, false);
    expect(world.version).toBe(v + 1);
    expect(world.boxes[id]?.enabled).toBe(false);
    world.setEnabled(id, false);
    world.setEnabled(999, false);
    world.setEnabled(-1, true);
    expect(world.version).toBe(v + 1);
    expect(world.setEnabledByTag('t', true)).toBe(1);
    expect(world.version).toBe(v + 2);
    v = world.version;
    world.clear();
    expect(world.version).toBeGreaterThan(v);
  });

  it('toggles by exact tag and reports how many matched', () => {
    const world = worldOf(
      box(0, 0, 0, 1, 1, 1, { tag: 'gate:a' }),
      box(2, 0, 0, 3, 1, 1, { tag: 'gate:a' }),
      box(4, 0, 0, 5, 1, 1, { tag: 'gate:ab' }),
      box(6, 0, 0, 7, 1, 1),
    );
    expect(world.setEnabledByTag('gate:a', false)).toBe(2);
    expect(world.boxes.map((b) => b.enabled)).toEqual([false, false, true, true]);
    expect(world.setEnabledByTag('gate:a', false)).toBe(2);
    expect(world.setEnabledByTag('gate', false)).toBe(0);
    expect(world.setEnabledByTag('', false)).toBe(1);
    expect(world.boxes[3]?.enabled).toBe(false);
  });

  it('answers queries before finalize and after late additions', () => {
    const world = createCollisionWorld();
    world.addBox(FLOOR);
    const pos = new THREE.Vector3(0, 3, 0);
    expect(move(world, pos, 0, -10, 0).grounded).toBe(true);
    expect(pos.y).toBe(0);
    world.finalize();
    world.addBox(box(5, 0, -5, 6, 3, 5));
    const hit = makeRayHit();
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(5, 10);
    move(world, pos, 20, 0, 0);
    expect(pos.x).toBeCloseTo(5 - HW, 10);
  });

  it('thickens degenerate plates so they still collide', () => {
    const world = worldOf(box(-5, 0, -5, 5, 0, 5), box(3, 0, -5, 3, 4, 5));
    const pos = new THREE.Vector3(0, 2, 0);
    move(world, pos, 0, -10, 0);
    expect(pos.y).toBeCloseTo(0, 2);
    expect(shared.grounded).toBe(true);
    move(world, pos, 10, 0, 0);
    expect(pos.x).toBeLessThan(3);
    expect(shared.hitX).toBe(true);
  });
});

describe('moveAndSlide: basics', () => {
  it('falls, lands exactly on the surface and reports the ground box', () => {
    const world = worldOf(box(-10, -1, -10, 10, 0, 10, { surface: 'grate' }));
    const pos = new THREE.Vector3(1, 5, 2);
    const r = move(world, pos, 0, -20, 0);
    expect(pos.toArray()).toEqual([1, 0, 2]);
    expect(r).toMatchObject({ grounded: true, groundBoxId: 0, groundSurface: 'grate', hitX: false, hitZ: false });
    expect(r).toMatchObject({ hitCeiling: false, stepped: 0, snapped: 0, wallBoxId: -1 });
    expect(r).toBe(shared);
  });

  it('reports ground state for a zero delta without moving', () => {
    const world = worldOf(FLOOR);
    const pos = new THREE.Vector3(3, 0, -4);
    expect(move(world, pos, 0, 0, 0).grounded).toBe(true);
    expect(pos.toArray()).toEqual([3, 0, -4]);
    pos.set(3, 0.5, -4);
    const r = move(world, pos, 0, 0, 0);
    expect(r.grounded).toBe(false);
    expect(r.groundBoxId).toBe(-1);
    expect(pos.y).toBe(0.5);
    // A hair above the surface still counts as standing and comes to rest exactly on it.
    pos.set(3, 0.01, -4);
    expect(move(world, pos, 0, 0, 0).grounded).toBe(true);
    expect(pos.y).toBe(0);
  });

  it('is airborne while moving upward', () => {
    const world = worldOf(FLOOR);
    const pos = new THREE.Vector3(0, 0, 0);
    const r = move(world, pos, 0, 0.1, 0, { stepUp: STEP, snapDown: STEP });
    expect(r.grounded).toBe(false);
    expect(pos.y).toBeCloseTo(0.1, 12);
  });

  it('slides along walls on either axis and names the wall', () => {
    const world = worldOf(FLOOR, box(5, 0, -10, 6, 3, 10), box(-10, 0, 5, 10, 3, 6));
    const pos = new THREE.Vector3(4, 0, 0);
    let r = move(world, pos, 2, 0, 1);
    expect(pos.x).toBe(5 - HW);
    expect(pos.z).toBeCloseTo(1, 12);
    expect(r).toMatchObject({ hitX: true, hitZ: false, wallBoxId: 1, grounded: true });
    pos.set(0, 0, 4);
    r = move(world, pos, -1, 0, 3);
    expect(pos.z).toBe(5 - HW);
    expect(pos.x).toBeCloseTo(-1, 12);
    expect(r).toMatchObject({ hitX: false, hitZ: true, wallBoxId: 2 });
    // Negative directions.
    const world2 = worldOf(FLOOR, box(-6, 0, -10, -5, 3, 10), box(-10, 0, -6, 10, 3, -5));
    pos.set(0, 0, 0);
    r = move(world2, pos, -20, 0, -20);
    expect(pos.x).toBe(-5 + HW);
    expect(pos.z).toBe(-5 + HW);
    expect(r).toMatchObject({ hitX: true, hitZ: true });
  });

  it('stops in a corner on both axes', () => {
    const world = worldOf(FLOOR, box(5, 0, -10, 6, 3, 10), box(-10, 0, 5, 10, 3, 6));
    const pos = new THREE.Vector3(4.5, 0, 4.5);
    const r = move(world, pos, 1, 0, 1);
    expect(pos.x).toBe(5 - HW);
    expect(pos.z).toBe(5 - HW);
    expect(r.hitX && r.hitZ).toBe(true);
    expect(r.grounded).toBe(true);
  });

  it('bumps the head on a ceiling and reports it', () => {
    const world = worldOf(FLOOR, box(-10, 2.5, -10, 10, 3, 10));
    const pos = new THREE.Vector3(0, 0, 0);
    let r = move(world, pos, 0.3, 2, 0);
    expect(pos.y).toBe(2.5 - H);
    expect(pos.x).toBeCloseTo(0.3, 12);
    expect(r).toMatchObject({ hitCeiling: true, grounded: false, hitX: false });
    // Still pressed against it: reported again, no movement.
    r = move(world, pos, 0, 0.5, 0);
    expect(r.hitCeiling).toBe(true);
    expect(pos.y).toBe(2.5 - H);
    // Falling away is free.
    r = move(world, pos, 0, -0.2, 0);
    expect(r.hitCeiling).toBe(false);
    expect(pos.y).toBeCloseTo(2.5 - H - 0.2, 12);
  });

  it('flies freely where there is nothing', () => {
    const world = worldOf(box(0, 0, 0, 1, 1, 1));
    const pos = new THREE.Vector3(500, 40, -300);
    const r = move(world, pos, 3, -2, 1);
    expect(pos.toArray()).toEqual([503, 38, -299]);
    expect(r.grounded).toBe(false);
    const empty = createCollisionWorld();
    pos.set(0, 0, 0);
    expect(move(empty, pos, 1, 2, 3).grounded).toBe(false);
    expect(pos.toArray()).toEqual([1, 2, 3]);
  });

  it('respects the mask', () => {
    const world = worldOf(
      FLOOR,
      box(5, 0, -10, 6, 3, 10, { flags: COL.PLAYER_CLIP }),
      box(-6, 0, -10, -5, 3, 10, { flags: COL.ENEMY_CLIP }),
    );
    const pos = new THREE.Vector3(0, 0, 0);
    move(world, pos, 20, 0, 0, { mask: COL.PLAYER });
    expect(pos.x).toBe(5 - HW);
    pos.set(0, 0, 0);
    move(world, pos, 20, 0, 0, { mask: COL.ENEMY });
    expect(pos.x).toBeCloseTo(20, 12);
    pos.set(0, 0, 0);
    move(world, pos, -20, 0, 0, { mask: COL.ENEMY });
    expect(pos.x).toBe(-5 + HW);
    pos.set(0, 0, 0);
    move(world, pos, -20, 0, 0, { mask: COL.PLAYER });
    expect(pos.x).toBeCloseTo(-20, 12);
  });

  it('never produces NaN and refuses garbage input', () => {
    const world = worldOf(FLOOR, box(5, 0, -10, 6, 3, 10));
    const pos = new THREE.Vector3(0, 0, 0);
    let r = move(world, pos, Number.NaN, Number.NaN, Number.NaN);
    expect(pos.toArray()).toEqual([0, 0, 0]);
    expect(r.grounded).toBe(true);
    r = move(world, pos, Infinity, -Infinity, 0);
    expect(pos.x).toBe(5 - HW);
    expect(pos.y).toBe(0);
    expect(Number.isFinite(pos.z)).toBe(true);
    // Degenerate body sizes are clamped to something tiny but valid.
    pos.set(0, 1, 0);
    r = move(world, pos, 0, -5, 0, { hw: 0, h: -3 });
    expect(pos.y).toBe(0);
    r = move(world, pos, 1, 0, 0, { hw: Number.NaN, h: Number.NaN, stepUp: Number.NaN, snapDown: Number.NaN });
    expect(Number.isFinite(pos.x + pos.y + pos.z)).toBe(true);
    // A non-finite position is left alone and reported airborne.
    pos.set(Number.NaN, 0, 0);
    r = move(world, pos, 1, 0, 0);
    expect(Number.isNaN(pos.x)).toBe(true);
    expect(pos.y).toBe(0);
    expect(r.grounded).toBe(false);
    pos.set(0, Infinity, 0);
    r = move(world, pos, 1, 0, 0);
    expect(pos.x).toBe(0);
    expect(r.grounded).toBe(false);
  });
});

describe('moveAndSlide: tunnelling', () => {
  // Paper-thin geometry on every side of a 10 x 4 x 10 room.
  const room = (): CollisionWorld =>
    worldOf(
      box(-5, -0.02, -5, 5, 0, 5),
      box(-5, 4, -5, 5, 4.02, 5),
      box(5, -1, -6, 5.05, 5, 6),
      box(-5.05, -1, -6, -5, 5, 6),
      box(-6, -1, 5, 6, 5, 5.05),
      box(-6, -1, -5.05, 6, 5, -5),
    );

  it('never crosses a thin wall, whatever the start offset or the speed', () => {
    const world = room();
    const pos = new THREE.Vector3();
    for (const speed of [30, 60, 120, 1000, 30000]) {
      const step = speed / 30;
      for (let i = 0; i < 60; i++) {
        const start = 5 - HW - 0.002 - i * (Math.min(step, 4) / 60);
        pos.set(start, 0, 0);
        expect(move(world, pos, step, 0, 0).hitX).toBe(start + step > 5 - HW);
        expect(pos.x).toBeLessThanOrEqual(5 - HW);
        pos.set(-start, 0, 0);
        move(world, pos, -step, 0, 0);
        expect(pos.x).toBeGreaterThanOrEqual(-5 + HW);
        pos.set(0, 0, start);
        move(world, pos, 0, 0, step);
        expect(pos.z).toBeLessThanOrEqual(5 - HW);
        pos.set(0, 0, -start);
        move(world, pos, 0, 0, -step);
        expect(pos.z).toBeGreaterThanOrEqual(-5 + HW);
      }
    }
  });

  it('never crosses a thin floor or ceiling', () => {
    const world = room();
    const pos = new THREE.Vector3();
    for (const speed of [30, 60, 240, 5000]) {
      const step = speed / 30;
      for (let i = 1; i <= 40; i++) {
        pos.set(1, (i / 40) * Math.min(step, 2), -1);
        const down = move(world, pos, 0, -step, 0);
        expect(pos.y).toBe(0);
        expect(down.grounded).toBe(true);
        pos.set(1, 4 - H - (i / 41) * Math.min(step, 2), -1);
        const up = move(world, pos, 0, step, 0);
        expect(pos.y).toBe(4 - H);
        expect(up.hitCeiling).toBe(true);
      }
    }
  });

  it('stops a fast diagonal move at the first wall and keeps sliding along it', () => {
    const world = room();
    const pos = new THREE.Vector3(4, 0, 0);
    const r = move(world, pos, 2, 0, 2);
    expect(pos.x).toBe(5 - HW);
    expect(pos.z).toBeCloseTo(2, 12);
    expect(r).toMatchObject({ hitX: true, hitZ: false });
    pos.set(4, 0, 4);
    move(world, pos, 40, 0, 40);
    expect(pos.x).toBe(5 - HW);
    expect(pos.z).toBe(5 - HW);
  });

  it('keeps a body inside a closed room through 20 000 violent random moves', () => {
    const world = room();
    const rng = createRng(77);
    const pos = new THREE.Vector3(0, 0, 0);
    // A free move may end a fraction of the contact tolerance inside a face; never deeper.
    const limit = 5 - HW + SKIN;
    for (let i = 0; i < 20000; i++) {
      const speed = rng.range(0, 150);
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(-1.5, 1.5);
      const dt = rng.chance(0.5) ? 1 / 30 : 1 / 60;
      move(
        world,
        pos,
        Math.cos(yaw) * Math.cos(pitch) * speed * dt,
        Math.sin(pitch) * speed * dt,
        Math.sin(yaw) * Math.cos(pitch) * speed * dt,
        { stepUp: rng.chance(0.5) ? STEP : 0, snapDown: rng.chance(0.5) ? STEP : 0 },
      );
      if (Math.abs(pos.x) > limit || Math.abs(pos.z) > limit || pos.y < -SKIN || pos.y > 4 - H + SKIN) {
        throw new Error(`escaped at move ${i}: ${pos.toArray().join(', ')}`);
      }
    }
    expect(penetration(world, pos)).toBeLessThanOrEqual(SKIN);
  });
});

describe('moveAndSlide: seams between adjacent boxes', () => {
  for (const hz of [30, 60, 144, 1000]) {
    it(`walks across floor tiles at ${hz} Hz without ever catching an edge`, () => {
      const world = createCollisionWorld();
      tiledFloor(world, 10);
      world.finalize();
      const dt = 1 / hz;
      const vx = 4.1;
      const vz = 3.3;
      const pos = new THREE.Vector3(-8.3, 0, -7.9);
      const frames = Math.round(3 * hz);
      for (let i = 0; i < frames; i++) {
        const r = move(world, pos, vx * dt, -GRAVITY * dt * dt, vz * dt, { stepUp: STEP, snapDown: STEP });
        if (r.hitX || r.hitZ || !r.grounded || pos.y !== 0 || r.stepped !== 0 || r.snapped !== 0) {
          throw new Error(`frame ${i}: ${JSON.stringify(r)} y=${pos.y}`);
        }
      }
      expect(pos.x).toBeCloseTo(-8.3 + vx * 3, 9);
      expect(pos.z).toBeCloseTo(-7.9 + vz * 3, 9);
    });
  }

  it('walks every heading across tiles whose tops differ by float noise', () => {
    const world = createCollisionWorld();
    tiledFloor(world, 10, 1e-9);
    world.finalize();
    const pos = new THREE.Vector3();
    for (let a = 0; a < 64; a++) {
      const angle = (a / 64) * Math.PI * 2;
      pos.set(0.37, 0, -0.21);
      move(world, pos, 0, -0.01, 0);
      for (let i = 0; i < 120; i++) {
        const r = move(world, pos, Math.cos(angle) * 0.07, -0.0067, Math.sin(angle) * 0.07, { stepUp: STEP, snapDown: STEP });
        if (r.hitX || r.hitZ || !r.grounded || Math.abs(pos.y) > 1e-6) {
          throw new Error(`heading ${a} frame ${i}: ${JSON.stringify(r)} y=${pos.y}`);
        }
      }
      expect(Math.hypot(pos.x - 0.37, pos.z + 0.21)).toBeCloseTo(120 * 0.07, 6);
    }
  });

  it('slides along a wall built from many segments while pressing into it', () => {
    const world = createCollisionWorld();
    tiledFloor(world, 10);
    // Wall face at x = 5: 20 segments along z, 3 layers high.
    for (let z = -10; z < 10; z++) {
      for (let y = 0; y < 3; y++) world.addBox(box(5, y, z, 6, y + 1, z + 1));
    }
    world.finalize();
    const pos = new THREE.Vector3(4.5, 0, -8.123);
    const dz = 4 / 60;
    expect(move(world, pos, 1, -0.0067, 0).hitX).toBe(true);
    for (const dir of [1, -1]) {
      for (let i = 0; i < 200; i++) {
        const before = pos.z;
        const r = move(world, pos, 5 / 60, -0.0067, dir * dz, { stepUp: STEP, snapDown: STEP });
        if (!r.hitX || r.hitZ || pos.x !== 5 - HW || Math.abs(pos.z - before - dir * dz) > 1e-12 || pos.y !== 0) {
          throw new Error(`dir ${dir} frame ${i}: ${JSON.stringify(r)} pos=${pos.toArray().join(', ')}`);
        }
      }
    }
  });

  it('slides along a segmented wall on the Z axis and under a tiled ceiling', () => {
    const world = createCollisionWorld();
    tiledFloor(world, 10);
    for (let x = -10; x < 10; x++) world.addBox(box(x, 0, -6, x + 1, 3, -5));
    for (let z = -5; z < 10; z++) {
      for (let x = -10; x < 10; x++) world.addBox(box(x, H, z, x + 1, H + 1, z + 1));
    }
    world.finalize();
    // Exactly body-high corridor: floor and ceiling tiles both touch the body the whole way.
    const pos = new THREE.Vector3(-8.2, 0, -4);
    expect(move(world, pos, 0, -0.0067, -2).hitZ).toBe(true);
    for (let i = 0; i < 200; i++) {
      const before = pos.x;
      const r = move(world, pos, 0.08, -0.0067, -0.1, { stepUp: STEP, snapDown: STEP });
      if (!r.hitZ || r.hitX || pos.z !== -5 + HW || Math.abs(pos.x - before - 0.08) > 1e-12 || pos.y !== 0) {
        throw new Error(`frame ${i}: ${JSON.stringify(r)} pos=${pos.toArray().join(', ')}`);
      }
    }
    // Jumping in that corridor bumps the ceiling immediately and does not sink into it.
    const r = move(world, pos, 0.08, 0.2, 0);
    expect(r.hitCeiling).toBe(true);
    expect(pos.y).toBe(0);
  });
});

describe('moveAndSlide: edges and resting contact', () => {
  it('stands perfectly still on a ledge with most of the body overhanging', () => {
    const world = worldOf(box(-30, -6, -30, 30, -5, 30), box(0, 0, 0, 4, 1, 4));
    const pos = new THREE.Vector3(4.2, 1, 2);
    for (let i = 0; i < 600; i++) {
      const r = move(world, pos, 0, -0.0067, 0, { stepUp: STEP, snapDown: STEP });
      if (!r.grounded || pos.x !== 4.2 || pos.y !== 1 || pos.z !== 2) throw new Error(`frame ${i}: moved to ${pos.toArray().join(', ')}`);
    }
    // On the very corner as well.
    pos.set(4.3, 1, 4.3);
    for (let i = 0; i < 100; i++) expect(move(world, pos, 0, -0.0067, 0).grounded).toBe(true);
    expect(pos.toArray()).toEqual([4.3, 1, 4.3]);
  });

  it('agrees with itself on whether a sliver of overlap is support', () => {
    const world = worldOf(box(-30, -6, -30, 30, -5, 30), box(0, 0, 0, 4, 1, 4));
    for (const overlap of [-0.01, 0, 2e-5, 5e-5, 9e-5, 1.1e-4, 2e-4, 1e-3, 0.01]) {
      const pos = new THREE.Vector3(4 + HW - overlap, 1, 2);
      const first = move(world, pos, 0, -0.0067, 0).grounded;
      let y = pos.y;
      for (let i = 0; i < 50; i++) {
        const r = move(world, pos, 0, -0.0067, 0);
        // Grounded frames never sink; airborne frames always fall. Never a mix.
        if (first) {
          expect(r.grounded).toBe(true);
          expect(pos.y).toBe(1);
        } else if (pos.y > -5) {
          expect(pos.y).toBeLessThan(y);
        }
        y = pos.y;
      }
      expect(first).toBe(overlap > SKIN);
    }
  });

  it('holds a steady position while being pushed into a corner', () => {
    const world = worldOf(FLOOR, box(5, 0, -10, 6, 3, 10), box(-10, 0, 5, 10, 3, 6));
    const pos = new THREE.Vector3(4.4, 0, 4.4);
    for (let i = 0; i < 300; i++) {
      const r = move(world, pos, 0.1, -0.0067, 0.1, { stepUp: STEP, snapDown: STEP });
      if (i > 2 && (pos.x !== 5 - HW || pos.z !== 5 - HW || pos.y !== 0 || !r.grounded || !r.hitX || !r.hitZ)) {
        throw new Error(`frame ${i}: ${pos.toArray().join(', ')}`);
      }
    }
  });

  it('walks off a ledge and falls when nothing is within snap reach', () => {
    const world = worldOf(box(-30, -6, -30, 30, -5, 30), box(0, 0, 0, 4, 1, 4));
    const pos = new THREE.Vector3(3.5, 1, 2);
    let airborneAt = -1;
    for (let i = 0; i < 40 && airborneAt < 0; i++) {
      if (!move(world, pos, 0.1, -0.0067, 0, { stepUp: STEP, snapDown: STEP }).grounded) airborneAt = i;
    }
    // Support ends when the trailing edge leaves the platform: centre past 4 + HW.
    expect(pos.x).toBeGreaterThan(4 + HW - 1e-3);
    expect(pos.x).toBeLessThan(4 + HW + 0.11);
    expect(pos.y).toBeGreaterThan(0.9);
    move(world, pos, 0, -20, 0);
    expect(pos.y).toBe(-5);
  });
});

describe('moveAndSlide: step-up', () => {
  it('climbs a ledge of exactly the step height and reports the rise', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 6, STEP, 5));
    const pos = new THREE.Vector3(1, 0, 0);
    const r = move(world, pos, 1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBeCloseTo(2, 12);
    expect(pos.y).toBe(STEP);
    expect(r.stepped).toBeCloseTo(STEP, 12);
    expect(r).toMatchObject({ grounded: true, hitX: false, hitZ: false, groundBoxId: 1 });
  });

  it('refuses a ledge that is too high, and any ledge without stepUp', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 6, STEP + 0.01, 5), box(-6, 0, -5, -2, 0.05, 5));
    const pos = new THREE.Vector3(1, 0, 0);
    let r = move(world, pos, 1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBe(2 - HW);
    expect(pos.y).toBe(0);
    expect(r).toMatchObject({ hitX: true, stepped: 0, grounded: true, wallBoxId: 1 });
    pos.set(-1, 0, 0);
    r = move(world, pos, -1, 0, 0, { stepUp: 0, snapDown: STEP });
    expect(pos.x).toBe(-2 + HW);
    expect(r).toMatchObject({ hitX: true, stepped: 0 });
    // The same kerb is no obstacle with stepUp.
    r = move(world, pos, -1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.y).toBe(0.05);
    expect(r.hitX).toBe(false);
  });

  it('needs head room above the ledge', () => {
    const low = worldOf(FLOOR, box(2, 0, -5, 6, 0.4, 5), box(2, 2.0, -5, 6, 3, 5));
    const pos = new THREE.Vector3(1, 0, 0);
    let r = move(low, pos, 1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBe(2 - HW);
    expect(pos.y).toBe(0);
    expect(r.hitX).toBe(true);
    const high = worldOf(FLOOR, box(2, 0, -5, 6, 0.4, 5), box(2, 2.3, -5, 6, 3, 5));
    pos.set(1, 0, 0);
    r = move(high, pos, 1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.y).toBe(0.4);
    expect(r.hitX).toBe(false);
    // A ceiling right above the body shortens the lift: a 0.4 ledge cannot be reached with 0.2 of room.
    const tight = worldOf(FLOOR, box(2, 0, -5, 6, 0.4, 5), box(-5, H + 0.2, -5, 6, 4, 5));
    pos.set(1, 0, 0);
    r = move(tight, pos, 1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.y).toBe(0);
    expect(r.hitX).toBe(true);
  });

  it('walks up a whole flight of stairs without a single stall', () => {
    const world = createCollisionWorld();
    world.addBox(FLOOR);
    stairs(world, 2, 10, 0.3, 0.2, 12);
    world.finalize();
    for (const hz of [30, 60, 144]) {
      const pos = new THREE.Vector3(0, 0, 0.3);
      const dt = 1 / hz;
      let climbed = 0;
      let lastY = 0;
      for (let i = 0; pos.x < 8 && i < 2000; i++) {
        const r = move(world, pos, 6.5 * dt, -GRAVITY * dt * dt, 0, { stepUp: STEP, snapDown: STEP });
        if (r.hitX || !r.grounded || pos.y < lastY) throw new Error(`${hz} Hz frame ${i}: ${JSON.stringify(r)} at ${pos.toArray().join(', ')}`);
        climbed += r.stepped;
        lastY = pos.y;
      }
      expect(pos.y).toBeCloseTo(2, 9);
      expect(climbed).toBeCloseTo(2, 9);
      expect(pos.x).toBeGreaterThanOrEqual(8);
    }
  });

  it('crosses several treads in one fast move (dash up the stairs)', () => {
    const world = createCollisionWorld();
    world.addBox(FLOOR);
    stairs(world, 2, 10, 0.3, 0.2, 12);
    world.finalize();
    const pos = new THREE.Vector3(1.5, 0, 0);
    const r = move(world, pos, 0.8, -0.0267, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBeCloseTo(2.3, 9);
    expect(pos.y).toBeCloseTo(0.6, 9);
    expect(r.stepped).toBeCloseTo(0.6, 9);
    expect(r).toMatchObject({ hitX: false, grounded: true });
    // A full dash (0.16 s at 24 m/s) reaches the terrace.
    pos.set(1.5, 0, 0);
    for (let i = 0; i < 5; i++) expect(move(world, pos, 0.8, -0.0267, 0, { stepUp: STEP, snapDown: STEP }).hitX).toBe(false);
    expect(pos.x).toBeCloseTo(5.5, 9);
    expect(pos.y).toBeCloseTo(2, 9);
  });

  it('still climbs when the riser is reached at the very end of a move', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 6, 0.3, 5));
    for (const left of [0, 1e-9, 1e-6, 1e-5, 4e-5, 1e-4, 3e-4, 1e-3]) {
      const pos = new THREE.Vector3(2 - HW - 0.1 + left, 0, 0);
      // move() hands back one shared result object: read the first verdict before moving again.
      const firstHit = move(world, pos, 0.1, -0.0067, 0, { stepUp: STEP, snapDown: STEP }).hitX;
      const second = move(world, pos, 0.1, -0.0067, 0, { stepUp: STEP, snapDown: STEP });
      // Never reported as a wall hit (that would zero the mover's velocity), up within two frames.
      expect(firstHit || second.hitX).toBe(false);
      expect(pos.y).toBe(0.3);
      expect(second.grounded).toBe(true);
      expect(pos.x).toBeGreaterThan(2 - HW);
    }
  });

  it('steps up while sliding along a side wall', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 6, 0.4, 5), box(-5, 0, 1, 6, 3, 2));
    const pos = new THREE.Vector3(1.5, 0, 0.5);
    const r = move(world, pos, 1, 0, 1, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBeCloseTo(2.5, 9);
    expect(pos.z).toBe(1 - HW);
    expect(pos.y).toBe(0.4);
    expect(r).toMatchObject({ hitX: false, hitZ: true, grounded: true, wallBoxId: 2 });
  });

  it('mantles a ledge just above the feet while airborne, but not a higher one', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 6, 1, 5));
    const pos = new THREE.Vector3(1.5, 0.85, 0);
    let r = move(world, pos, 0.5, -0.01, 0, { stepUp: 0.2, snapDown: 0 });
    expect(pos.y).toBe(1);
    expect(pos.x).toBeCloseTo(2, 9);
    expect(r).toMatchObject({ grounded: true, hitX: false });
    pos.set(1.5, 0.7, 0);
    r = move(world, pos, 0.5, -0.01, 0, { stepUp: 0.2, snapDown: 0 });
    expect(pos.x).toBe(2 - HW);
    expect(pos.y).toBeCloseTo(0.69, 9);
    expect(r).toMatchObject({ grounded: false, hitX: true });
  });

  it('steps over a thin low kerb', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 2.1, 0.2, 5));
    const pos = new THREE.Vector3(0, 0, 0);
    let top = 0;
    for (let i = 0; i < 60; i++) {
      const r = move(world, pos, 6.5 / 60, -0.0067, 0, { stepUp: STEP, snapDown: STEP });
      if (r.hitX || !r.grounded) throw new Error(`frame ${i}: ${JSON.stringify(r)}`);
      top = Math.max(top, pos.y);
    }
    expect(top).toBe(0.2);
    expect(pos.y).toBe(0);
    expect(pos.x).toBeCloseTo(6.5, 6);
  });

  it('keeps upward momentum when a jump clips a ledge', () => {
    const world = worldOf(FLOOR, box(2, 0, -5, 6, 0.3, 5));
    const pos = new THREE.Vector3(1.5, 0.2, 0);
    const r = move(world, pos, 0.4, 0.1, 0, { stepUp: 0.2, snapDown: 0 });
    expect(pos.x).toBeCloseTo(1.9, 9);
    expect(pos.y).toBeGreaterThan(0.3);
    expect(r).toMatchObject({ grounded: false, hitX: false });
  });

  it('climbs and descends stairs diagonally without stalling or losing sideways speed', () => {
    const world = createCollisionWorld();
    world.addBox(FLOOR);
    stairs(world, 2, 10, 0.3, 0.2, 14, 16);
    world.finalize();
    for (const hz of [30, 60, 144]) {
      const dt = 1 / hz;
      for (const angle of [0.3, Math.PI / 4, 1.1]) {
        const vx = Math.cos(angle) * 6.5;
        const vz = Math.sin(angle) * 6.5;
        // Up.
        const pos = new THREE.Vector3(0.5, 0, -10);
        let frames = 0;
        for (; pos.x < 8 && frames < 3000; frames++) {
          const beforeZ = pos.z;
          const r = move(world, pos, vx * dt, -GRAVITY * dt * dt, vz * dt, { stepUp: STEP, snapDown: STEP });
          if (r.hitX || r.hitZ || !r.grounded || Math.abs(pos.z - beforeZ - vz * dt) > 1e-9) {
            throw new Error(`up ${hz} Hz angle ${angle} frame ${frames}: ${JSON.stringify(r)} at ${pos.toArray().join(', ')}`);
          }
        }
        expect(pos.y).toBeCloseTo(2, 9);
        // Every frame advanced the full stride (plus at most the step-up borrow).
        expect(pos.x - 0.5).toBeGreaterThanOrEqual(frames * vx * dt - 1e-6);
        expect(pos.x - 0.5).toBeLessThan(frames * vx * dt + 0.02);
        // And back down.
        pos.set(8, 2, -10);
        for (frames = 0; pos.x > 0.5 && frames < 3000; frames++) {
          const r = move(world, pos, -vx * dt, -GRAVITY * dt * dt, vz * dt, { stepUp: STEP, snapDown: STEP });
          if (r.hitX || r.hitZ || !r.grounded) {
            throw new Error(`down ${hz} Hz angle ${angle} frame ${frames}: ${JSON.stringify(r)} at ${pos.toArray().join(', ')}`);
          }
        }
        expect(pos.y).toBe(0);
        expect(8 - pos.x).toBeCloseTo(frames * vx * dt, 6);
      }
    }
  });

  it('hops a low rim with a drop behind it instead of stopping dead', () => {
    // A deck with a 0.2 m toe board along its edge and nothing within snap reach beyond it.
    const world = worldOf(box(-30, -9, -30, 30, -8, 30), box(-5, -1, -5, 1, 0, 5), box(1, -1, -5, 1.05, 0.2, 5));
    // One stride that carries the whole body past the rim: over it, back at deck height, in the air.
    const pos = new THREE.Vector3(0.2, 0, 0);
    let r = move(world, pos, 1.5, -0.0267, 0, { stepUp: STEP, snapDown: STEP });
    expect(r).toMatchObject({ hitX: false, grounded: false, stepped: 0, snapped: 0 });
    expect(pos.x).toBeCloseTo(1.7, 9);
    expect(pos.y).toBeLessThanOrEqual(0);
    expect(pos.y).toBeGreaterThan(-0.03);
    expect(penetration(world, pos)).toBe(0);
    r = move(world, pos, 0, -20, 0);
    expect(pos.y).toBe(-8);
    expect(r.grounded).toBe(true);
    // A small body (0.2 wide) clears it at a run.
    pos.set(0.7, 0, 0);
    r = move(world, pos, 0.5, -0.0067, 0, { stepUp: STEP, snapDown: STEP, hw: 0.1, h: 0.5 });
    expect(r).toMatchObject({ hitX: false, grounded: false });
    expect(pos.x).toBeCloseTo(1.2, 9);
    // At walking pace the body steps onto the rim first and walks off it: never a wall hit.
    pos.set(0.2, 0, 0);
    let top = 0;
    let left = -1;
    for (let i = 0; i < 40; i++) {
      r = move(world, pos, 6.5 / 60, -0.0067, 0, { stepUp: STEP, snapDown: STEP });
      expect(r.hitX).toBe(false);
      top = Math.max(top, pos.y);
      if (!r.grounded && left < 0) left = pos.x;
    }
    expect(top).toBe(0.2);
    expect(left).toBeGreaterThan(1.05 + HW - 1e-3);
    // The same rim with a floor within snap reach behind it is an ordinary step down.
    const terrace = worldOf(box(-5, -1, -5, 1, 0, 5), box(1, -1, -5, 1.05, 0.2, 5), box(1.05, -1, -5, 8, -0.3, 5));
    pos.set(0.2, 0, 0);
    r = move(terrace, pos, 1.5, -0.0267, 0, { stepUp: STEP, snapDown: STEP });
    expect(r).toMatchObject({ hitX: false, grounded: true, stepped: 0 });
    expect(pos.y).toBe(-0.3);
    expect(r.snapped).toBeCloseTo(0.3, 9);
    expect(pos.x).toBeCloseTo(1.7, 9);
  });

  it('fits a crouched body under a beam that stops a standing one', () => {
    const world = worldOf(FLOOR, box(2, 1.2, -5, 3, 3, 5));
    const pos = new THREE.Vector3(0, 0, 0);
    let r = move(world, pos, 4, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBe(2 - HW);
    expect(r).toMatchObject({ hitX: true, wallBoxId: 1, grounded: true });
    r = move(world, pos, 4, 0, 0, { stepUp: STEP, snapDown: STEP, h: 1.1 });
    expect(pos.x).toBeCloseTo(2 - HW + 4, 12);
    expect(r).toMatchObject({ hitX: false, grounded: true });
    // Standing up under the beam is the caller's decision; the query that supports it is overlapBox.
    expect(world.overlapBox(box(2.5 - HW, 0, -HW, 2.5 + HW, H, HW), COL.PLAYER)).toBe(1);
    expect(world.overlapBox(box(2.5 - HW, 0, -HW, 2.5 + HW, 1.1, HW), COL.PLAYER)).toBe(-1);
  });
});

describe('moveAndSlide: step-down', () => {
  const flight = (): CollisionWorld => {
    const world = createCollisionWorld();
    world.addBox(FLOOR);
    stairs(world, 2, 10, 0.3, 0.2, 12);
    world.finalize();
    return world;
  };

  it('stays glued to descending stairs with snapDown', () => {
    const world = flight();
    for (const hz of [30, 60, 144]) {
      const dt = 1 / hz;
      const pos = new THREE.Vector3(8, 2, -0.4);
      let snapped = 0;
      let lastY = 2;
      for (let i = 0; pos.x > 0.5 && i < 3000; i++) {
        const r = move(world, pos, -6.5 * dt, -GRAVITY * dt * dt, 0, { stepUp: STEP, snapDown: STEP });
        if (!r.grounded || r.hitX || pos.y > lastY) throw new Error(`${hz} Hz frame ${i}: ${JSON.stringify(r)} at ${pos.toArray().join(', ')}`);
        snapped += r.snapped;
        lastY = pos.y;
      }
      expect(pos.y).toBe(0);
      expect(snapped).toBeCloseTo(2, 2);
    }
  });

  it('snaps even at dash speed', () => {
    const world = flight();
    const pos = new THREE.Vector3(8, 2, 0);
    for (let i = 0; i < 12; i++) {
      const r = move(world, pos, -0.8, -0.0267, 0, { stepUp: STEP, snapDown: STEP });
      // 0.8 m covers up to three 0.2 m treads: more than one snap reach, so the mover may leave the
      // ground for a frame, but it must never end up inside the stairs.
      expect(penetration(world, pos)).toBeLessThanOrEqual(SKIN);
      expect(r.hitX).toBe(false);
    }
    move(world, pos, 0, -5, 0);
    expect(pos.y).toBe(0);
  });

  it('goes airborne without snapDown, or when the drop is beyond its reach', () => {
    const world = flight();
    // The terrace starts at x = 4.7; one metre back the body only overlaps the tread below it.
    const pos = new THREE.Vector3(5.1, 2, 0);
    let r = move(world, pos, -0.5, 0, 0, { stepUp: STEP, snapDown: 0 });
    expect(r.grounded).toBe(true);
    r = move(world, pos, -0.5, 0, 0, { stepUp: STEP, snapDown: 0 });
    expect(r.grounded).toBe(false);
    expect(pos.y).toBe(2);
    expect(r.snapped).toBe(0);
    // Same move with snapDown lands one tread lower.
    pos.set(5.1, 2, 0);
    r = move(world, pos, -1, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(r.grounded).toBe(true);
    expect(pos.y).toBeCloseTo(1.8, 9);
    expect(r.snapped).toBeCloseTo(0.2, 9);
    // A 0.6 m drop is not a step.
    const ledge = worldOf(FLOOR, box(0, 0, 0, 4, 0.6, 4));
    pos.set(3.9, 0.6, 2);
    r = move(ledge, pos, 0.6, 0, 0, { stepUp: STEP, snapDown: STEP });
    expect(r.grounded).toBe(false);
    expect(pos.y).toBe(0.6);
  });

  it('never snaps a mover that is travelling upward', () => {
    const world = flight();
    const pos = new THREE.Vector3(5.1, 2, 0);
    const r = move(world, pos, -1, 0.05, 0, { stepUp: STEP, snapDown: STEP });
    expect(r.grounded).toBe(false);
    expect(r.snapped).toBe(0);
    expect(pos.y).toBeCloseTo(2.05, 12);
  });
});

describe('moveAndSlide: gates', () => {
  it('reflects enable / disable immediately in every query', () => {
    const world = worldOf(FLOOR, box(5, 0, -4, 6, 4, 4, { flags: COL.GATE, tag: 'gate:deck-refinery', surface: 'energy' }));
    const gate = 1;
    const pos = new THREE.Vector3(4, 0, 0);
    const hit = makeRayHit();
    const probe = box(5.2, 1, -1, 5.8, 2, 1);
    const ids: number[] = [];
    const origin = { x: 0, y: 1, z: 0 };
    const dir = { x: 1, y: 0, z: 0 };

    for (let round = 0; round < 3; round++) {
      // Closed.
      pos.set(4, 0, 0);
      expect(move(world, pos, 3, 0, 0, { mask: COL.PLAYER }).hitX).toBe(true);
      expect(pos.x).toBe(5 - HW);
      pos.set(4, 0, 0);
      expect(move(world, pos, 3, 0, 0, { mask: COL.ENEMY }).wallBoxId).toBe(gate);
      expect(world.raycast(origin, dir, 50, COL.PROJECTILE, hit)).toBe(true);
      expect(hit).toMatchObject({ boxId: gate, surface: 'energy' });
      expect(world.raycast(origin, dir, 50, COL.SIGHT, hit)).toBe(false);
      expect(world.lineOfSight(origin, { x: 10, y: 1, z: 0 })).toBe(true);
      expect(world.lineOfSight(origin, { x: 10, y: 1, z: 0 }, COL.PROJECTILE)).toBe(false);
      expect(world.overlapBox(probe, COL.ANY)).toBe(gate);
      expect(world.overlapBoxAll(probe, COL.ANY, ids)).toBe(1);
      expect(world.overlapSphere({ x: 5.5, y: 1, z: 0 }, 0.2, COL.ANY)).toBe(true);
      expect(world.groundHeight(5.5, 0, 10, COL.PLAYER)).toBe(4);

      // Open.
      const v = world.version;
      expect(world.setEnabledByTag('gate:deck-refinery', false)).toBe(1);
      expect(world.version).toBe(v + 1);
      pos.set(4, 0, 0);
      expect(move(world, pos, 3, 0, 0, { mask: COL.PLAYER }).hitX).toBe(false);
      expect(pos.x).toBeCloseTo(7, 12);
      expect(world.raycast(origin, dir, 50, COL.PROJECTILE, hit)).toBe(false);
      expect(world.lineOfSight(origin, { x: 10, y: 1, z: 0 }, COL.PROJECTILE)).toBe(true);
      expect(world.overlapBox(probe, COL.ANY)).toBe(-1);
      expect(world.overlapBoxAll(probe, COL.ANY, ids)).toBe(0);
      expect(ids).toHaveLength(0);
      expect(world.overlapSphere({ x: 5.5, y: 1, z: 0 }, 0.2, COL.ANY)).toBe(false);
      expect(world.groundHeight(5.5, 0, 10, COL.PLAYER)).toBe(0);
      world.setEnabled(gate, true);
    }
  });

  it('drops a body whose floor is switched off and catches it again when switched on', () => {
    const world = worldOf(FLOOR, box(-2, 0, -2, 2, 3, 2, { tag: 'lift' }));
    const pos = new THREE.Vector3(0, 3, 0);
    expect(move(world, pos, 0, -0.0067, 0, { snapDown: STEP })).toMatchObject({ grounded: true, groundBoxId: 1 });
    world.setEnabledByTag('lift', false);
    let r = move(world, pos, 0, -0.5, 0, { snapDown: STEP });
    expect(r.grounded).toBe(false);
    expect(pos.y).toBe(2.5);
    // Switched back on around the body: it is expelled, never left inside.
    world.setEnabledByTag('lift', true);
    r = move(world, pos, 0, -0.0067, 0);
    expect(penetration(world, pos)).toBeLessThanOrEqual(SKIN);
    world.setEnabledByTag('lift', false);
    pos.set(0, 2.5, 0);
    r = move(world, pos, 0, -10, 0);
    expect(pos.y).toBe(0);
    expect(r).toMatchObject({ grounded: true, groundBoxId: 0 });
  });
});

describe('moveAndSlide: starting embedded in geometry', () => {
  it('rises out of a floor it was placed slightly inside', () => {
    const world = worldOf(FLOOR);
    const pos = new THREE.Vector3(0, -0.1, 0);
    const r = move(world, pos, 0, 0, 0);
    expect(pos.toArray()).toEqual([0, 0, 0]);
    expect(r.grounded).toBe(true);
    // Also near a seam between floor plates: no sideways shove.
    const tiles = createCollisionWorld();
    tiledFloor(tiles, 4);
    tiles.finalize();
    pos.set(0.3, -0.2, 0.3);
    move(tiles, pos, 0, 0, 0);
    expect(pos.toArray()).toEqual([0.3, 0, 0.3]);
  });

  it('is pushed out of a gate that closes on it, toward the nearer side', () => {
    const world = worldOf(FLOOR, box(5, 0, -4, 6, 4, 4, { flags: COL.GATE, tag: 'gate' }));
    world.setEnabledByTag('gate', false);
    const pos = new THREE.Vector3(5.4, 0, 1);
    expect(move(world, pos, 0, -0.0067, 0).grounded).toBe(true);
    world.setEnabledByTag('gate', true);
    let r = move(world, pos, 0, -0.0067, 0);
    expect(pos.toArray()).toEqual([5 - HW, 0, 1]);
    expect(r.grounded).toBe(true);
    pos.set(5.6, 0, 1);
    r = move(world, pos, 0, -0.0067, 0);
    expect(pos.toArray()).toEqual([6 + HW, 0, 1]);
    // Deterministic: the same start always resolves the same way, even dead centre (a tie).
    for (const [x, expected] of [
      [5.45, 5 - HW],
      [5.5, 6 + HW],
    ] as const) {
      for (let i = 0; i < 5; i++) {
        pos.set(x, 0.5, -2);
        move(world, pos, 0, 0, 0);
        expect(penetration(world, pos)).toBeLessThanOrEqual(SKIN);
        expect(pos.toArray()).toEqual([expected, 0.5, -2]);
      }
    }
  });

  it('does not freeze or explode when wedged where it cannot fit', () => {
    const world = worldOf(FLOOR, box(-1, 0, -5, 0, 3, 5), box(0.5, 0, -5, 1.5, 3, 5));
    const pos = new THREE.Vector3(0.25, 0, 0);
    const r = move(world, pos, 0, -0.0067, 1);
    expect(pos.x).toBe(0.25);
    expect(pos.z).toBeCloseTo(1, 12);
    expect(pos.y).toBe(0);
    expect(r.grounded).toBe(true);
    // Too tall for the gap (head inside a slab, feet on the floor): never dropped through the floor,
    // free to walk, and expelled sideways as soon as the edge of the slab is the nearest way out.
    const low = worldOf(FLOOR, box(-2, 1.2, -2, 2, 2, 2));
    pos.set(0, 0, 0);
    for (let i = 0; i < 40; i++) {
      const before = pos.x;
      const step = move(low, pos, 0.1, -0.0067, 0);
      expect(pos.y).toBe(0);
      expect(step.grounded).toBe(true);
      expect(pos.x).toBeGreaterThan(before + 0.099);
    }
    expect(pos.x).toBeGreaterThanOrEqual(4);
    expect(penetration(low, pos)).toBeLessThanOrEqual(SKIN);
  });
});

describe('moveAndSlide: random walk through clutter', () => {
  it('never ends a move inside geometry and never teleports', () => {
    const rng = createRng(4242);
    const world = createCollisionWorld();
    tiledFloor(world, 24);
    while (world.boxes.length < 24 * 24 * 4 + 500) {
      const x = rng.range(-22, 22);
      const z = rng.range(-22, 22);
      if (Math.abs(x) < 2.5 && Math.abs(z) < 2.5) continue;
      const kind = rng.int(0, 4);
      const w = kind === 3 ? 0.04 : rng.range(0.2, 1.4);
      const d = kind === 4 ? 0.04 : rng.range(0.2, 1.4);
      if (kind === 0) world.addBox(box(x - w, 0, z - d, x + w, rng.range(0.05, 0.6), z + d));
      else if (kind === 1) {
        const y0 = rng.range(0.8, 2.6);
        world.addBox(box(x - w, y0, z - d, x + w, y0 + rng.range(0.1, 0.8), z + d));
      } else world.addBox(box(x - w, 0, z - d, x + w, rng.range(1, 4), z + d));
    }
    world.finalize();

    const pos = new THREE.Vector3(0, 0, 0);
    const before = new THREE.Vector3();
    let vy = 0;
    let grounded = true;
    let heading = 0;
    let speed = 5;
    let dt = 1 / 60;
    let stepsTaken = 0;
    let wallHits = 0;
    let worst = 0;
    for (let i = 0; i < 60000; i++) {
      if (i % 45 === 0) {
        heading = rng.range(0, Math.PI * 2);
        speed = rng.chance(0.15) ? rng.range(20, 60) : rng.range(2, 12);
        dt = rng.pick([1 / 30, 1 / 60, 1 / 144]);
      }
      if (grounded && rng.chance(0.02)) {
        vy = 7.75;
        grounded = false;
      }
      vy -= GRAVITY * dt;
      const dx = Math.cos(heading) * speed * dt;
      const dz = Math.sin(heading) * speed * dt;
      const dy = vy * dt;
      const stepUp = grounded ? STEP : 0.2;
      const snapDown = grounded && vy <= 0 ? STEP : 0;
      before.copy(pos);
      const r = move(world, pos, dx, dy, dz, { stepUp, snapDown });
      if (!Number.isFinite(pos.x + pos.y + pos.z)) throw new Error(`NaN at move ${i}`);
      const depth = penetration(world, pos);
      if (depth > worst) worst = depth;
      if (depth > SKIN + 1e-9) throw new Error(`move ${i}: ${depth} deep at ${pos.toArray().join(', ')}`);
      // Horizontal travel never exceeds the request (plus the step-up borrow).
      if (Math.abs(pos.x - before.x) > Math.abs(dx) + 0.005 || Math.abs(pos.z - before.z) > Math.abs(dz) + 0.005) {
        throw new Error(`move ${i}: teleported from ${before.toArray().join(', ')} to ${pos.toArray().join(', ')}`);
      }
      if (pos.y - before.y > Math.max(dy, 0) + stepUp * 6 + 1e-6 || before.y - pos.y > Math.max(-dy, 0) + snapDown * 2 + 0.03) {
        throw new Error(`move ${i}: vertical jump from ${before.y} to ${pos.y}`);
      }
      if (r.stepped > 0) stepsTaken++;
      if (r.hitX || r.hitZ) wallHits++;
      grounded = r.grounded;
      if (grounded) vy = 0;
      else if (r.hitCeiling && vy > 0) vy = 0;
      if (Math.abs(pos.x) > 23 || Math.abs(pos.z) > 23 || pos.y < -1) {
        pos.set(0, 0, 0);
        vy = 0;
        grounded = true;
      }
    }
    // The walk really exercised steps and walls.
    expect(stepsTaken).toBeGreaterThan(200);
    expect(wallHits).toBeGreaterThan(2000);
    expect(worst).toBeLessThanOrEqual(SKIN + 1e-9);
  });

  it('handles far more nearby boxes than the candidate buffer starts with', () => {
    const world = createCollisionWorld();
    world.addBox(FLOOR);
    // 400 paper plates stacked into a 2 m pillar, 300 slats forming a wall, 300 tiles on the floor.
    for (let i = 0; i < 400; i++) world.addBox(box(3, i * 0.005, -1, 4, (i + 1) * 0.005, 1));
    for (let i = 0; i < 300; i++) world.addBox(box(-4, 0, -3 + i * 0.02, -3, 3, -3 + (i + 1) * 0.02));
    for (let i = 0; i < 300; i++) world.addBox(box(-3 + (i % 20) * 0.3, 0, -3 + Math.floor(i / 20) * 0.4, -2.7 + (i % 20) * 0.3, 0.004, -2.6 + Math.floor(i / 20) * 0.4));
    world.finalize();
    const pos = new THREE.Vector3(0, 0, 0);
    let r = move(world, pos, 10, -0.0067, 0, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBe(3 - HW);
    expect(r).toMatchObject({ hitX: true, grounded: true });
    r = move(world, pos, -20, -0.0067, 0.4, { stepUp: STEP, snapDown: STEP });
    expect(pos.x).toBe(-3 + HW);
    expect(pos.z).toBeCloseTo(0.4, 9);
    expect(r).toMatchObject({ hitX: true, hitZ: false, grounded: true });
    expect(penetration(world, pos)).toBeLessThanOrEqual(SKIN);
    // Dropping onto the plate stack lands on its top plate.
    pos.set(3.5, 4, 0);
    r = move(world, pos, 0, -10, 0);
    expect(pos.y).toBeCloseTo(2, 9);
    expect(r.grounded).toBe(true);
    const ids: number[] = [];
    expect(world.overlapBoxAll(box(3.1, -0.5, -2, 4.5, 3, 2), COL.ANY, ids)).toBe(401);
    expect(ids[0]).toBe(0);
    expect(ids[400]).toBe(400);
  });
});

describe('raycast', () => {
  const cube = (): CollisionWorld => worldOf(box(-1, -1, -1, 1, 1, 1, { surface: 'glass' }), box(3, -1, -1, 4, 1, 1, { surface: 'plating' }));
  const hit = makeRayHit();

  it('returns distance, point, face normal, box and surface for all six faces', () => {
    const world = worldOf(box(-1, -1, -1, 1, 1, 1, { surface: 'glass' }));
    const dirs: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of dirs) {
      const origin = { x: -dx * 5 + 0.2, y: -dy * 5 + 0.3, z: -dz * 5 - 0.4 };
      if (dx !== 0) origin.x = -dx * 5;
      if (dy !== 0) origin.y = -dy * 5;
      if (dz !== 0) origin.z = -dz * 5;
      expect(world.raycast(origin, { x: dx, y: dy, z: dz }, 100, COL.PROJECTILE, hit)).toBe(true);
      expect(hit.distance).toBeCloseTo(4, 12);
      expect(hit.normal.toArray()).toEqual([dx === 0 ? 0 : -dx, dy === 0 ? 0 : -dy, dz === 0 ? 0 : -dz]);
      expect(hit.point.x).toBeCloseTo(origin.x + dx * 4, 12);
      expect(hit.point.y).toBeCloseTo(origin.y + dy * 4, 12);
      expect(hit.point.z).toBeCloseTo(origin.z + dz * 4, 12);
      expect(hit.boxId).toBe(0);
      expect(hit.surface).toBe('glass');
    }
    // Oblique hit: the normal is the face that was entered.
    const d = new THREE.Vector3(1, -0.2, 0.1).normalize();
    expect(world.raycast({ x: -5, y: 0.5, z: 0 }, d, 100, COL.PROJECTILE, hit)).toBe(true);
    expect(hit.normal.toArray()).toEqual([-1, 0, 0]);
    expect(hit.point.x).toBeCloseTo(-1, 12);
  });

  it('returns the nearest hit and honours maxDist', () => {
    const world = cube();
    const dir = { x: -1, y: 0, z: 0 };
    expect(world.raycast({ x: 10, y: 0, z: 0 }, dir, 100, COL.ANY, hit)).toBe(true);
    expect(hit.boxId).toBe(1);
    expect(hit.distance).toBeCloseTo(6, 12);
    expect(world.raycast({ x: 10, y: 0, z: 0 }, dir, 5.9, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 10, y: 0, z: 0 }, dir, 6.1, COL.ANY, hit)).toBe(true);
    expect(world.raycast({ x: 10, y: 0, z: 0 }, dir, 0, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 10, y: 0, z: 0 }, dir, Infinity, COL.ANY, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(6, 12);
  });

  it('filters by mask and skips disabled boxes', () => {
    const world = worldOf(
      box(2, 0, -1, 3, 2, 1, { flags: COL.RAILING }),
      box(5, 0, -1, 6, 2, 1, { flags: COL.GATE }),
      box(8, 0, -1, 9, 2, 1),
    );
    const o = { x: 0, y: 1, z: 0 };
    const d = { x: 1, y: 0, z: 0 };
    expect(world.raycast(o, d, 50, COL.PLAYER, hit) && hit.boxId).toBe(0);
    expect(world.raycast(o, d, 50, COL.PROJECTILE, hit) && hit.boxId).toBe(1);
    expect(world.raycast(o, d, 50, COL.SIGHT, hit) && hit.boxId).toBe(2);
    expect(world.raycast(o, d, 50, 0, hit)).toBe(false);
    world.setEnabled(2, false);
    expect(world.raycast(o, d, 50, COL.SIGHT, hit)).toBe(false);
    world.setEnabled(0, false);
    expect(world.raycast(o, d, 50, COL.ANY, hit) && hit.boxId).toBe(1);
  });

  it('ignores the box it starts inside and hits what lies behind it', () => {
    const world = cube();
    expect(world.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(true);
    expect(hit.boxId).toBe(1);
    expect(hit.distance).toBeCloseTo(3, 12);
    expect(world.raycast({ x: 0.999, y: 0.5, z: -0.5 }, { x: -1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, COL.ANY, hit)).toBe(false);
    // Same answer every time.
    for (let i = 0; i < 5; i++) {
      expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(true);
      expect(hit.boxId).toBe(1);
      expect(hit.distance).toBeCloseTo(2.5, 12);
    }
  });

  it('treats a start on the surface deterministically', () => {
    const world = cube();
    // Heading in: hit at distance 0 with the entry face normal, also from a hair inside the face.
    for (const x of [-1, -1 + 1e-9, -1 - 1e-9]) {
      expect(world.raycast({ x, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(true);
      expect(hit.boxId).toBe(0);
      expect(hit.distance).toBeLessThan(1e-8);
      expect(hit.normal.toArray()).toEqual([-1, 0, 0]);
    }
    // Heading out or along the face: that box is not hit.
    expect(world.raycast({ x: -1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 50, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 50, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 50, COL.ANY, hit) && hit.boxId).toBe(1);
  });

  it('skims a tiled floor without hitting tile edges, and never falls through a seam', () => {
    const world = createCollisionWorld();
    tiledFloor(world, 10);
    world.finalize();
    // Along the top plane, axis aligned and diagonal.
    expect(world.raycast({ x: -8.5, y: 0, z: 0.5 }, { x: 1, y: 0, z: 0 }, 17, COL.ANY, hit)).toBe(false);
    const diag = new THREE.Vector3(1, 0, 1).normalize();
    expect(world.raycast({ x: -8.5, y: 0, z: -8.5 }, diag, 20, COL.ANY, hit)).toBe(false);
    expect(world.lineOfSight({ x: -8.5, y: 0, z: 0.5 }, { x: 8.5, y: 0, z: 3.25 }, COL.ANY)).toBe(true);
    // Straight down exactly on a seam, and on a four-tile corner.
    for (const [x, z] of [
      [3, 0.5],
      [0.5, -4],
      [3, 2],
      [0, 0],
      [-10, -10],
      [9.999999, 9.999999],
    ] as const) {
      expect(world.raycast({ x, y: 2, z }, { x: 0, y: -1, z: 0 }, 10, COL.ANY, hit)).toBe(true);
      expect(hit.distance).toBeCloseTo(2, 12);
      expect(hit.normal.toArray()).toEqual([0, 1, 0]);
    }
    // A steep ray through a seam still lands on a top face.
    const steep = new THREE.Vector3(0.3, -1, 0.2).normalize();
    for (let i = 0; i < 200; i++) {
      const origin = { x: -6 + i * 0.05, y: 3, z: -3 + i * 0.031 };
      expect(world.raycast(origin, steep, 20, COL.ANY, hit)).toBe(true);
      expect(hit.point.y).toBeCloseTo(0, 9);
    }
  });

  it('handles rays from outside the world, vertical rays and useless input', () => {
    const world = worldOf(FLOOR, box(5, 0, -10, 6, 3, 10), box(-3, 2.5, -3, 3, 3, 3));
    expect(world.raycast({ x: -500, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 1000, COL.ANY, hit)).toBe(true);
    expect(hit.boxId).toBe(1);
    expect(hit.distance).toBeCloseTo(505, 9);
    expect(world.raycast({ x: -500, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 1000, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 1, z: 500 }, { x: 1, y: 0, z: 0 }, 1000, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 10, COL.ANY, hit)).toBe(true);
    expect(hit.boxId).toBe(2);
    expect(hit.normal.toArray()).toEqual([0, -1, 0]);
    expect(hit.distance).toBeCloseTo(1.5, 12);
    expect(world.raycast({ x: 0, y: 500, z: 0 }, { x: 0, y: -1, z: 0 }, 1000, COL.ANY, hit) && hit.boxId).toBe(2);
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 10, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: Number.NaN, y: 0, z: 0 }, 10, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: Number.NaN, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 10, COL.ANY, hit)).toBe(false);
    expect(world.raycast({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, Number.NaN, COL.ANY, hit)).toBe(false);
  });

  it('lineOfSight: default mask, blockers, degenerate segments, targets resting on a surface', () => {
    const world = worldOf(FLOOR, box(5, 0, -10, 6, 3, 10), box(-6, 0, -10, -5, 3, 10, { flags: COL.GLASS }));
    const eye = { x: 0, y: 1.6, z: 0 };
    expect(world.lineOfSight(eye, { x: 10, y: 1.6, z: 0 })).toBe(false);
    expect(world.lineOfSight({ x: 10, y: 1.6, z: 0 }, eye)).toBe(false);
    expect(world.lineOfSight(eye, { x: 4, y: 1.6, z: 9 })).toBe(true);
    // Over the wall.
    expect(world.lineOfSight({ x: 0, y: 5, z: 0 }, { x: 10, y: 5, z: 0 })).toBe(true);
    // Glass does not block sight by default, but blocks shots.
    expect(world.lineOfSight(eye, { x: -10, y: 1.6, z: 0 })).toBe(true);
    expect(world.lineOfSight(eye, { x: -10, y: 1.6, z: 0 }, COL.PROJECTILE)).toBe(false);
    expect(world.lineOfSight(eye, eye)).toBe(true);
    // A target standing on the floor is visible from above; one under the floor is not.
    expect(world.lineOfSight(eye, { x: 3, y: 0, z: 2 })).toBe(true);
    expect(world.lineOfSight(eye, { x: 3, y: -0.5, z: 2 })).toBe(false);
    // Feet to feet along the floor.
    expect(world.lineOfSight({ x: -3, y: 0, z: 1 }, { x: 4, y: 0, z: -7 })).toBe(true);
  });
});

describe('overlap queries', () => {
  it('overlapBox: touching faces do not overlap, the lowest id wins, masks apply', () => {
    const world = worldOf(box(0, 0, 0, 1, 1, 1), box(0.5, 0, 0, 2, 1, 1, { flags: COL.PLAYER_CLIP }), box(5, 0, 0, 6, 1, 1));
    expect(world.overlapBox(box(1, 0, 0, 1.4, 1, 1), COL.ENEMY)).toBe(-1);
    expect(world.overlapBox(box(-1, 0, 0, 0, 1, 1), COL.ANY)).toBe(-1);
    expect(world.overlapBox(box(0, 1, 0, 1, 2, 1), COL.ANY)).toBe(-1);
    expect(world.overlapBox(box(0, 0, 1, 1, 1, 2), COL.ANY)).toBe(-1);
    expect(world.overlapBox(box(0.9, 0.2, 0.2, 1.4, 0.8, 0.8), COL.ANY)).toBe(0);
    expect(world.overlapBox(box(0.9, 0.2, 0.2, 1.4, 0.8, 0.8), COL.PLAYER)).toBe(0);
    expect(world.overlapBox(box(1.1, 0.2, 0.2, 1.4, 0.8, 0.8), COL.PLAYER)).toBe(1);
    expect(world.overlapBox(box(1.1, 0.2, 0.2, 1.4, 0.8, 0.8), COL.ENEMY)).toBe(-1);
    expect(world.overlapBox(box(-50, -50, -50, 50, 50, 50), COL.ANY)).toBe(0);
    world.setEnabled(0, false);
    expect(world.overlapBox(box(-50, -50, -50, 50, 50, 50), COL.ANY)).toBe(1);
    expect(world.overlapBox(box(100, 0, 0, 101, 1, 1), COL.ANY)).toBe(-1);
  });

  it('overlapBoxAll: clears the output and fills it in ascending id order', () => {
    const world = worldOf(box(0, 0, 0, 1, 1, 1), box(20, 0, 0, 21, 1, 1), box(0.5, 0, 0, 2, 1, 1), box(-9, 0, -9, 30, 0.5, 9));
    const ids = [42, 42, 42, 42, 42, 42];
    expect(world.overlapBoxAll(box(-1, -1, -1, 25, 2, 2), COL.ANY, ids)).toBe(4);
    expect(ids).toEqual([0, 1, 2, 3]);
    expect(world.overlapBoxAll(box(0.6, 0.6, 0.2, 0.9, 0.9, 0.8), COL.ANY, ids)).toBe(2);
    expect(ids).toEqual([0, 2]);
    expect(world.overlapBoxAll(box(50, 0, 0, 51, 1, 1), COL.ANY, ids)).toBe(0);
    expect(ids).toEqual([]);
    expect(world.overlapBoxAll(box(-1, -1, -1, 25, 2, 2), COL.ANY, ids)).toBe(4);
    expect(ids).toEqual([0, 1, 2, 3]);
  });

  it('overlapSphere: exact distance test against faces, edges and corners', () => {
    const world = worldOf(box(-1, -1, -1, 1, 1, 1));
    expect(world.overlapSphere({ x: 2, y: 2, z: 2 }, 1.7, COL.ANY)).toBe(false);
    expect(world.overlapSphere({ x: 2, y: 2, z: 2 }, 1.75, COL.ANY)).toBe(true);
    expect(world.overlapSphere({ x: 2, y: 2, z: 0 }, 1.41, COL.ANY)).toBe(false);
    expect(world.overlapSphere({ x: 2, y: 2, z: 0 }, 1.42, COL.ANY)).toBe(true);
    expect(world.overlapSphere({ x: 2, y: 0, z: 0 }, 1, COL.ANY)).toBe(false);
    expect(world.overlapSphere({ x: 2, y: 0, z: 0 }, 1.001, COL.ANY)).toBe(true);
    expect(world.overlapSphere({ x: 0, y: 0, z: 0 }, 0.1, COL.ANY)).toBe(true);
    expect(world.overlapSphere({ x: 0, y: 0, z: 0 }, 0, COL.ANY)).toBe(false);
    expect(world.overlapSphere({ x: 2, y: 0, z: 0 }, 5, 0)).toBe(false);
    expect(world.overlapSphere({ x: 300, y: 0, z: 0 }, 5, COL.ANY)).toBe(false);
    expect(world.overlapSphere({ x: 300, y: 0, z: 0 }, 400, COL.ANY)).toBe(true);
  });

  it('groundHeight: highest top at or below maxY under the point', () => {
    const world = worldOf(FLOOR, box(0, 2, 0, 4, 2.5, 4), box(1, 0, 1, 2, 0.4, 2, { flags: COL.ENEMY_CLIP }));
    expect(world.groundHeight(3, 3, 10, COL.PLAYER)).toBe(2.5);
    expect(world.groundHeight(3, 3, 2.5, COL.PLAYER)).toBe(2.5);
    expect(world.groundHeight(3, 3, 2.4, COL.PLAYER)).toBe(0);
    expect(world.groundHeight(3, 3, -0.5, COL.PLAYER)).toBe(-Infinity);
    expect(world.groundHeight(1.5, 1.5, 1, COL.PLAYER)).toBe(0);
    expect(world.groundHeight(1.5, 1.5, 1, COL.ENEMY)).toBe(0.4);
    expect(world.groundHeight(100, 0, 10, COL.PLAYER)).toBe(-Infinity);
    expect(world.groundHeight(Number.NaN, 0, 10, COL.PLAYER)).toBe(-Infinity);
    // Edges of a footprint are inside; seams between tiles have a floor.
    expect(world.groundHeight(4, 4, 10, COL.PLAYER)).toBe(2.5);
    const tiles = createCollisionWorld();
    tiledFloor(tiles, 6);
    tiles.finalize();
    for (let i = -6; i <= 6; i++) expect(tiles.groundHeight(i, i, 5, COL.ANY)).toBe(0);
    // Feet resting on a surface see that surface even with float noise in y.
    expect(world.groundHeight(3, 3, 2.5 - 1e-12, COL.PLAYER)).toBe(2.5);
  });
});

describe('thousands of boxes: grid broadphase against brute force', () => {
  const world = bigWorld(5000, 2024);
  const rng = createRng(555);
  const hit = makeRayHit();
  const masks = [COL.PLAYER, COL.ENEMY, COL.PROJECTILE, COL.SIGHT, COL.ANY];

  it('raycast matches the reference for 6000 random rays', () => {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let hits = 0;
    for (let i = 0; i < 6000; i++) {
      origin.set(rng.range(-90, 90), rng.range(-0.5, 5), rng.range(-55, 55));
      const style = i % 6;
      if (style === 0) dir.set(rng.sign(), 0, 0);
      else if (style === 1) dir.set(0, 0, rng.sign());
      else if (style === 2) dir.set(0, -1, 0);
      else if (style === 3) dir.set(rng.range(-1, 1), 0, rng.range(-1, 1));
      else dir.set(rng.range(-1, 1), rng.range(-0.3, 0.3), rng.range(-1, 1));
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
      dir.normalize();
      const maxDist = rng.chance(0.2) ? rng.range(1, 20) : 400;
      const mask = masks[i % masks.length] as number;
      const expected = refRaycast(world, origin, dir, maxDist, mask);
      const got = world.raycast(origin, dir, maxDist, mask, hit);
      if (got !== (expected !== null)) throw new Error(`ray ${i}: hit ${got}, expected ${JSON.stringify(expected)}`);
      if (expected) {
        hits++;
        if (Math.abs(hit.distance - expected.t) > 1e-7) throw new Error(`ray ${i}: distance ${hit.distance} vs ${expected.t}`);
        if (hit.boxId !== expected.id) throw new Error(`ray ${i}: box ${hit.boxId} vs ${expected.id}`);
        const n = [hit.normal.x, hit.normal.y, hit.normal.z];
        if (n[expected.axis] !== expected.sign || Math.abs(n[0] as number) + Math.abs(n[1] as number) + Math.abs(n[2] as number) !== 1) {
          throw new Error(`ray ${i}: normal ${n.join(',')} vs axis ${expected.axis} sign ${expected.sign}`);
        }
        expect(world.boxes[hit.boxId]?.surface).toBe(hit.surface);
      }
    }
    expect(hits).toBeGreaterThan(2000);
  });

  it('lineOfSight matches the reference', () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const d = new THREE.Vector3();
    let clear = 0;
    for (let i = 0; i < 3000; i++) {
      a.set(rng.range(-74, 74), rng.range(0.2, 3), rng.range(-44, 44));
      b.set(a.x + rng.range(-12, 12), rng.range(0.2, 3), a.z + rng.range(-12, 12));
      d.subVectors(b, a);
      const len = d.length();
      d.normalize();
      const expected = refRaycast(world, a, d, len - 1e-3, COL.SIGHT) === null;
      if (world.lineOfSight(a, b) !== expected) throw new Error(`segment ${i}`);
      if (expected) clear++;
    }
    expect(clear).toBeGreaterThan(100);
    expect(clear).toBeLessThan(2900);
  });

  it('overlap and ground queries match the reference', () => {
    const q = box(0, 0, 0, 0, 0, 0);
    const ids: number[] = [];
    const c = new THREE.Vector3();
    for (let i = 0; i < 4000; i++) {
      const mask = masks[i % masks.length] as number;
      q.minX = rng.range(-80, 78);
      q.minY = rng.range(-1, 3);
      q.minZ = rng.range(-50, 48);
      q.maxX = q.minX + rng.range(0.05, 6);
      q.maxY = q.minY + rng.range(0.05, 2);
      q.maxZ = q.minZ + rng.range(0.05, 6);
      const expected = refOverlap(world, q, mask);
      expect(world.overlapBoxAll(q, mask, ids)).toBe(expected.length);
      expect(ids).toEqual(expected);
      expect(world.overlapBox(q, mask)).toBe(expected.length > 0 ? expected[0] : -1);

      c.set(rng.range(-80, 80), rng.range(0, 4), rng.range(-50, 50));
      const radius = rng.range(0.05, 3);
      expect(world.overlapSphere(c, radius, mask)).toBe(refSphere(world, c, radius, mask));

      const maxY = rng.range(-0.5, 5);
      expect(world.groundHeight(c.x, c.z, maxY, mask)).toBe(refGround(world, c.x, c.z, maxY, mask));
    }
  });

  it('keeps matching after boxes are toggled', () => {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    world.setEnabledByTag('k2', false);
    for (let i = 0; i < world.boxes.length; i += 7) world.setEnabled(i, false);
    for (let i = 0; i < 1500; i++) {
      origin.set(rng.range(-74, 74), rng.range(0.1, 3), rng.range(-44, 44));
      dir.set(rng.range(-1, 1), rng.range(-0.2, 0.2), rng.range(-1, 1)).normalize();
      const expected = refRaycast(world, origin, dir, 300, COL.ANY);
      const got = world.raycast(origin, dir, 300, COL.ANY, hit);
      if (got !== (expected !== null) || (expected && (hit.boxId !== expected.id || Math.abs(hit.distance - expected.t) > 1e-7))) {
        throw new Error(`ray ${i} after toggles`);
      }
      if (got) expect(world.boxes[hit.boxId]?.enabled).toBe(true);
    }
    world.setEnabledByTag('k2', true);
    for (let i = 0; i < world.boxes.length; i += 7) world.setEnabled(i, true);
  });
});

describe('performance', () => {
  const world = bigWorld(5000, 31337);
  const hit = makeRayHit();
  const result = makeMoveResult();
  const pos = new THREE.Vector3();
  const delta = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const target = new THREE.Vector3();
  const query = box(0, 0, 0, 0, 0, 0);

  const moves = (n: number): void => {
    for (let i = 0; i < n; i++) {
      const a = (i * 0.61803398875) % (Math.PI * 2);
      delta.set(Math.cos(a) * 0.12, -0.0067, Math.sin(a) * 0.12);
      world.moveAndSlide(pos, HW, H, delta, COL.PLAYER, STEP, STEP, result);
      if (Math.abs(pos.x) > 72 || Math.abs(pos.z) > 42) pos.set(0, 0, 0);
    }
  };
  const rays = (n: number): number => {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const a = (i * 0.61803398875) % (Math.PI * 2);
      origin.set(Math.cos(i * 0.37) * 60, 1.2, Math.sin(i * 0.11) * 35);
      dir.set(Math.cos(a), 0, Math.sin(a));
      if (world.raycast(origin, dir, 200, COL.PROJECTILE, hit)) hits++;
    }
    return hits;
  };
  it('moves and raycasts in a 5000-box world in microseconds', () => {
    moves(20000);
    rays(20000);
    let t0 = performance.now();
    moves(100000);
    const moveUs = ((performance.now() - t0) * 1000) / 100000;
    t0 = performance.now();
    const hits = rays(100000);
    const rayUs = ((performance.now() - t0) * 1000) / 100000;
    console.info(`[physics] 5000 boxes: moveAndSlide ${moveUs.toFixed(3)} us/call, raycast ${rayUs.toFixed(3)} us/call`);
    expect(hits).toBeGreaterThan(50000);
    // Budget: 64 movers + a few hundred rays per frame must be a rounding error. Generous margins.
    expect(moveUs).toBeLessThan(25);
    expect(rayUs).toBeLessThan(25);
  });

  it('builds the broadphase for 5000 boxes quickly', () => {
    const fresh = createCollisionWorld();
    for (const b of world.boxes) fresh.addBox(b);
    const t0 = performance.now();
    fresh.finalize();
    const ms = performance.now() - t0;
    console.info(`[physics] finalize(5000 boxes) ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(250);
    expect(fresh.bounds).toEqual(world.bounds);
  });

  describe('heap allocation', () => {
    // A second world: the queries must stay allocation free when the engine cannot specialise the
    // code for one instance (with a single world it constant-folds everything the closures capture,
    // which hides boxing that shows up as soon as a test, a tool or a restart creates another one).
    const decoy = worldOf(FLOOR, box(2, 0, -5, 6, 0.3, 5));
    const ids: number[] = [];
    // Simulation state lives in typed arrays: a captured `let` holding a double would itself be
    // boxed on every assignment and drown the measurement.
    const sim = new Float64Array(2); // [vy, grounded]
    const seen = new Int32Array(5); // steps, walls, ceilings, airborne frames, snaps
    const walker = new THREE.Vector3(0, 0, 0);

    /** A player-like run through the clutter: walking, steps, walls, jumps, head bumps, landings. */
    const walk = (n: number): void => {
      const dt = 1 / 60;
      for (let i = 0; i < n; i++) {
        const grounded = sim[1] === 1;
        let vy = sim[0];
        if (grounded && i % 53 === 0) vy = 7.75;
        vy -= GRAVITY * dt;
        const heading = Math.floor(i / 40) * 2.399963 + Math.sin(i * 0.013) * 0.4;
        const speed = i % 400 < 30 ? 24 : 6.5;
        delta.set(Math.cos(heading) * speed * dt, vy * dt, Math.sin(heading) * speed * dt);
        const jumping = vy > 0;
        world.moveAndSlide(walker, HW, H, delta, COL.PLAYER, grounded ? STEP : 0.2, grounded && !jumping ? STEP : 0, result);
        if (result.stepped > 0) seen[0]++;
        if (result.hitX || result.hitZ) seen[1]++;
        if (result.hitCeiling) seen[2]++;
        if (!result.grounded) seen[3]++;
        if (result.snapped > 0) seen[4]++;
        if (result.grounded || (result.hitCeiling && jumping)) vy = 0;
        sim[0] = vy;
        sim[1] = result.grounded ? 1 : 0;
        if (Math.abs(walker.x) > 72 || Math.abs(walker.z) > 42 || walker.y < -1) {
          walker.set(0, 0, 0);
          sim[0] = 0;
          sim[1] = 1;
        }
      }
    };
    const sightLines = (n: number): number => {
      let clear = 0;
      for (let i = 0; i < n; i++) {
        origin.set(Math.cos(i * 0.37) * 60, 1.2, Math.sin(i * 0.11) * 35);
        target.set(Math.cos(i * 0.21) * 60, 1.5, Math.sin(i * 0.47) * 35);
        if (world.lineOfSight(origin, target, COL.SIGHT)) clear++;
        if (world.lineOfSight(target, origin)) clear++;
      }
      return clear;
    };
    const boxOverlaps = (n: number): number => {
      let hits = 0;
      for (let i = 0; i < n; i++) {
        query.minX = Math.cos(i * 0.37) * 60;
        query.minY = 0.5;
        query.minZ = Math.sin(i * 0.11) * 35;
        query.maxX = query.minX + 2;
        query.maxY = 2;
        query.maxZ = query.minZ + 2;
        if (world.overlapBox(query, COL.ANY) >= 0) hits++;
      }
      return hits;
    };
    const sphereOverlaps = (n: number): number => {
      let hits = 0;
      for (let i = 0; i < n; i++) {
        origin.set(Math.cos(i * 0.37) * 60, 1.2, Math.sin(i * 0.11) * 35);
        if (world.overlapSphere(origin, 1.5, COL.ANY)) hits++;
      }
      return hits;
    };
    /** The same four regions over and over: the result array keeps its size. */
    const boxOverlapLists = (n: number): number => {
      let total = 0;
      for (let i = 0; i < n; i++) {
        const k = i & 3;
        query.minX = -20 + k * 9;
        query.minY = 0.2;
        query.minZ = -12 + k * 5;
        query.maxX = query.minX + 6;
        query.maxY = 2.5;
        query.maxZ = query.minZ + 6;
        total += world.overlapBoxAll(query, COL.ANY, ids);
      }
      return total;
    };
    /**
     * Integer coordinates: a fractional number passed to a call that is not inlined is boxed by the
     * CALLER, which is not what this test is about.
     */
    const grounds = (n: number): number => {
      let raised = 0;
      for (let i = 0; i < n; i++) {
        if (world.groundHeight(((i * 7) % 140) - 70, ((i * 13) % 80) - 40, 10, COL.PLAYER) > 0) raised++;
      }
      return raised;
    };

    it('measures a single boxed number per call (positive control)', () => {
      expect(boxOneNumberPerCall(WARM_UP_CALLS)).toBeTypeOf('number');
      const control = bytesPerCall(boxOneNumberPerCall);
      console.info(`[physics] control: ${control.toFixed(2)} bytes per boxed number`);
      // 16 bytes on 64-bit V8, 12 with pointer compression. If this ever reads ~0 the measurement
      // has gone blind and the checks below prove nothing.
      expect(control).toBeGreaterThan(8);
      expect(control).toBeLessThan(40);
    });

    it('does not allocate in moveAndSlide, raycast, lineOfSight or the overlap queries', () => {
      expect(decoy.boxes).toHaveLength(2);
      const queries: [string, (n: number) => unknown][] = [
        ['moveAndSlide (steady walk)', moves],
        ['moveAndSlide (run, jump, step, bump)', walk],
        ['raycast', rays],
        ['lineOfSight', sightLines],
        ['overlapBox', boxOverlaps],
        ['overlapSphere', sphereOverlaps],
        ['overlapBoxAll (stable result size)', boxOverlapLists],
      ];
      for (const [, fn] of queries) fn(WARM_UP_CALLS);
      // Every code path of the walk was really taken while measuring.
      seen.fill(0);
      const report: string[] = [];
      for (const [name, fn] of queries) {
        const bytes = bytesPerCall(fn);
        report.push(`${name} ${bytes.toFixed(2)}`);
        if (bytes >= ALLOC_LIMIT_BYTES) throw new Error(`${name} allocates about ${bytes.toFixed(1)} bytes per call`);
      }
      console.info(`[physics] heap bytes per call: ${report.join(', ')}`);
      expect(seen[0]).toBeGreaterThan(100);
      expect(seen[1]).toBeGreaterThan(100);
      expect(seen[2]).toBeGreaterThan(10);
      expect(seen[3]).toBeGreaterThan(1000);
      expect(seen[4]).toBeGreaterThan(100);
      expect(rays(2000)).toBeGreaterThan(1000);
      expect(boxOverlapLists(4)).toBeGreaterThan(4);
    });

    it('groundHeight costs at most the boxing of its return value', () => {
      // The contract returns the height as a number: the engine boxes a fractional result (12-16
      // bytes) whenever it does not inline the call. Nothing else may be allocated.
      grounds(WARM_UP_CALLS);
      const bytes = bytesPerCall(grounds);
      console.info(`[physics] groundHeight: ${bytes.toFixed(2)} heap bytes per call`);
      expect(bytes).toBeLessThan(20);
      expect(grounds(5600)).toBeGreaterThan(50);
    });
  });
});
