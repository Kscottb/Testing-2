/**
 * Surface marks: pooled quads aligned to the surface they hit, drawn procedurally per kind. A decal is
 * clipped to the face of its collision box wherever that face really ends (a ledge), and continues
 * across the seam where another box carries the same surface on.
 */
import { COL } from '../core/constants';
import { makeRayHit } from '../core/make';
import type { CollisionBox, CollisionWorld, DecalKind, Rng, Vec3Like } from '../core/types';
import { DECAL_STRIDE } from './consts';

const KINDS: readonly DecalKind[] = ['bulletHole', 'scorch', 'plasmaBurn', 'railBurn', 'crack', 'energyMark'];
/** Default diameter in metres and lifetime in seconds per kind (same order as KINDS). */
const SIZE = [0.17, 3, 0.9, 0.5, 1.6, 1.4];
const LIFE = [22, 30, 16, 16, 28, 14];
const MAX_SIZE = 16;
const OPEN = 1e9;
/** Surfaces a mark can continue on: anything visible and solid. */
const SURFACE_MASK = COL.PLAYER | COL.PROJECTILE;

const hit = makeRayHit();
const origin = { x: 0, y: 0, z: 0 };
const down = { x: 0, y: 0, z: 0 };

export class Decals {
  /** Live decals. */
  count = 0;
  /** Live cap (quality); the oldest decals are recycled beyond it. */
  cap: number;
  /** The instance buffer has to be rewritten. */
  dirty = false;
  private readonly data: Float32Array;
  private readonly box: Int32Array;
  private readonly born: Uint32Array;
  private readonly expires: Float32Array;
  private readonly alive: Uint8Array;
  private sequence = 0;
  private version = -1;
  private nextExpiry = Infinity;

  constructor(
    readonly capacity: number,
    private readonly rng: Rng,
  ) {
    this.cap = capacity;
    this.data = new Float32Array(capacity * DECAL_STRIDE);
    this.box = new Int32Array(capacity).fill(-1);
    this.born = new Uint32Array(capacity);
    this.expires = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  setCap(cap: number): void {
    this.cap = Number.isFinite(cap) ? Math.min(this.capacity, Math.max(0, Math.floor(cap))) : this.capacity;
    while (this.count > this.cap) this.kill(this.oldest());
  }

  private oldest(): number {
    let best = -1;
    let seq = 0xffffffff;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 1 && (this.born[i] as number) <= seq) {
        seq = this.born[i] as number;
        best = i;
      }
    }
    return best;
  }

  private kill(slot: number): void {
    if (slot < 0 || this.alive[slot] === 0) return;
    this.alive[slot] = 0;
    this.box[slot] = -1;
    this.count--;
    this.dirty = true;
  }

  /**
   * Place a mark. `time` is the FX world clock (the shader ages the mark against it). The call is ignored
   * when the box does not take decals or is switched off.
   */
  add(kind: DecalKind, position: Vec3Like, normal: Vec3Like, size: number | undefined, boxId: number | undefined, collision: CollisionWorld, time: number): void {
    const k = KINDS.indexOf(kind);
    if (k < 0 || this.cap === 0 || !Number.isFinite(position.x + position.y + position.z)) return;
    let nx = normal.x;
    let ny = normal.y;
    let nz = normal.z;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(nl > 1e-6) || !Number.isFinite(nl)) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    let box: CollisionBox | undefined;
    if (boxId !== undefined && Number.isInteger(boxId) && boxId >= 0) {
      box = collision.boxes[boxId];
      if (box && (!box.decals || !box.enabled)) return;
    }
    const diameter = size !== undefined && Number.isFinite(size) && size > 0 ? Math.min(size, MAX_SIZE) : (SIZE[k] as number);

    while (this.count >= this.cap) this.kill(this.oldest());
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return;
    this.alive[slot] = 1;
    this.count++;
    this.dirty = true;
    this.born[slot] = this.sequence++;
    this.box[slot] = box ? box.id : -1;
    const life = LIFE[k] as number;
    this.expires[slot] = time + life;
    if (time + life < this.nextExpiry) this.nextExpiry = time + life;

    const o = slot * DECAL_STRIDE;
    const d = this.data;
    d[o] = position.x;
    d[o + 1] = position.y;
    d[o + 2] = position.z;
    d[o + 3] = diameter;
    d[o + 4] = nx;
    d[o + 5] = ny;
    d[o + 6] = nz;
    d[o + 7] = this.rng.next() * 6.2831853;
    d[o + 8] = k;
    d[o + 9] = this.rng.next();
    d[o + 10] = time;
    d[o + 11] = life;
    for (let c = 0; c < 3; c++) {
      d[o + 12 + c] = -OPEN;
      d[o + 15 + c] = OPEN;
    }
    if (box) this.clip(o, box, position, nx, ny, nz, diameter * 0.5, collision);
  }

  /**
   * Clip the mark to the box face it sits on: for each tangent axis and side where the mark reaches past
   * the face, keep it open only if the surface continues there (a coplanar neighbour).
   */
  private clip(o: number, box: CollisionBox, p: Vec3Like, nx: number, ny: number, nz: number, radius: number, collision: CollisionWorld): void {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    const axis = ax > ay && ax > az ? 0 : ay > az ? 1 : 2;
    const sign = (axis === 0 ? nx : axis === 1 ? ny : nz) >= 0 ? 1 : -1;
    down.x = axis === 0 ? -sign : 0;
    down.y = axis === 1 ? -sign : 0;
    down.z = axis === 2 ? -sign : 0;
    const d = this.data;
    for (let t = 0; t < 3; t++) {
      if (t === axis) continue;
      const centre = t === 0 ? p.x : t === 1 ? p.y : p.z;
      const min = t === 0 ? box.minX : t === 1 ? box.minY : box.minZ;
      const max = t === 0 ? box.maxX : t === 1 ? box.maxY : box.maxZ;
      for (let side = -1; side <= 1; side += 2) {
        const bound = side < 0 ? min : max;
        if (side < 0 ? centre - radius >= bound : centre + radius <= bound) continue;
        // Probe just beyond the edge, from slightly above the surface, straight into it.
        origin.x = p.x + (axis === 0 ? sign * 0.08 : 0);
        origin.y = p.y + (axis === 1 ? sign * 0.08 : 0);
        origin.z = p.z + (axis === 2 ? sign * 0.08 : 0);
        if (t === 0) origin.x = bound + side * 0.06;
        else if (t === 1) origin.y = bound + side * 0.06;
        else origin.z = bound + side * 0.06;
        const continues = collision.raycast(origin, down, 0.16, SURFACE_MASK, hit) && Math.abs(hit.distance - 0.08) < 0.04;
        if (!continues) d[o + (side < 0 ? 12 : 15) + t] = bound + side * 0.001;
      }
    }
  }

  /** Expire old marks and drop the ones whose box was switched off (gates). */
  update(time: number, collision: CollisionWorld): void {
    if (this.count === 0) {
      this.version = collision.version;
      return;
    }
    if (collision.version !== this.version) {
      this.version = collision.version;
      const boxes = collision.boxes;
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] === 0) continue;
        const id = this.box[i] as number;
        if (id >= 0 && !(boxes[id]?.enabled ?? false)) this.kill(i);
      }
    }
    if (time >= this.nextExpiry) {
      let next = Infinity;
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] === 0) continue;
        const at = this.expires[i] as number;
        if (time >= at) this.kill(i);
        else if (at < next) next = at;
      }
      this.nextExpiry = next;
    }
  }

  clear(): void {
    this.alive.fill(0);
    this.box.fill(-1);
    this.count = 0;
    this.nextExpiry = Infinity;
    this.dirty = true;
  }

  /** Compact the live marks into the instance buffer; returns the instance count. */
  write(out: Float32Array): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const src = i * DECAL_STRIDE;
      const dst = n++ * DECAL_STRIDE;
      for (let c = 0; c < DECAL_STRIDE; c++) out[dst + c] = this.data[src + c] as number;
    }
    this.dirty = false;
    return n;
  }
}
