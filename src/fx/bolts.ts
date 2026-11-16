/**
 * Lightning bolts: a jagged main channel with side branches between two points. A bolt stores only its
 * end points and a seed; its shape is regenerated from the seed whenever it is drawn, and re-rolled once
 * mid-life (the re-strike) unless strobing is disabled.
 */
import type { Vec3Like } from '../core/types';
import type { RibbonWriter } from './ribbons';

const MAX_STEPS = 32;
/** HDR gain of the channel. */
const BOLT_GAIN = 6;
/** Quad half width of the channel in core widths (leaves room for the glow). */
const BOLT_QUAD = 1.8;
/** Hard cap of side branches per bolt. */
export const BOLT_MAX_BRANCHES = 6;

export class Bolts {
  /** Live bolts. */
  count = 0;
  private readonly ends: Float32Array;
  private readonly rgb: Float32Array;
  private readonly width: Float32Array;
  private readonly seconds: Float32Array;
  private readonly age: Float32Array;
  private readonly seed: Uint32Array;
  private readonly branches: Uint8Array;
  /** 0 free, 1 strobing, 2 steady (reduce flashes). */
  private readonly state: Uint8Array;
  private cursor = 0;
  private readonly offU = new Float32Array(MAX_STEPS + 1);
  private readonly offV = new Float32Array(MAX_STEPS + 1);
  private readonly path = new Float32Array((MAX_STEPS + 1) * 3);
  private rand = 1;

  constructor(readonly capacity: number) {
    this.ends = new Float32Array(capacity * 6);
    this.rgb = new Float32Array(capacity * 3);
    this.width = new Float32Array(capacity);
    this.seconds = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.seed = new Uint32Array(capacity);
    this.branches = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
  }

  /** `r, g, b` linear colour; `strobe` false = one steady fade (reduce flashes). */
  add(from: Vec3Like, to: Vec3Like, r: number, g: number, b: number, width: number, branches: number, seconds: number, strobe: boolean, seed: number): void {
    if (!Number.isFinite(from.x + from.y + from.z + to.x + to.y + to.z)) return;
    let slot = -1;
    for (let k = 0; k < this.capacity; k++) {
      const i = (this.cursor + k) % this.capacity;
      if (this.state[i] === 0) {
        slot = i;
        break;
      }
    }
    // Pool full: the oldest bolt (the next one in creation order) makes room.
    if (slot < 0) slot = this.cursor;
    else this.count++;
    this.cursor = (slot + 1) % this.capacity;
    const e = slot * 6;
    this.ends[e] = from.x;
    this.ends[e + 1] = from.y;
    this.ends[e + 2] = from.z;
    this.ends[e + 3] = to.x;
    this.ends[e + 4] = to.y;
    this.ends[e + 5] = to.z;
    this.rgb[slot * 3] = r;
    this.rgb[slot * 3 + 1] = g;
    this.rgb[slot * 3 + 2] = b;
    this.width[slot] = Number.isFinite(width) && width > 0 ? width : 0.25;
    this.seconds[slot] = Number.isFinite(seconds) && seconds > 0.02 ? Math.min(seconds, 3) : 0.22;
    this.age[slot] = 0;
    this.seed[slot] = (seed >>> 0) | 1;
    const n = Number.isFinite(branches) ? Math.floor(branches) : 3;
    this.branches[slot] = n < 0 ? 0 : n > BOLT_MAX_BRANCHES ? BOLT_MAX_BRANCHES : n;
    this.state[slot] = strobe ? 1 : 2;
  }

  update(dt: number): void {
    if (this.count === 0 || !(dt > 0)) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === 0) continue;
      const age = (this.age[i] as number) + dt;
      this.age[i] = age;
      if (age >= (this.seconds[i] as number)) {
        this.state[i] = 0;
        this.count--;
      }
    }
  }

  clear(): void {
    this.state.fill(0);
    this.count = 0;
    this.cursor = 0;
  }

  /** Deterministic 0..1 stream for the shape of one bolt. */
  private next(): number {
    let s = this.rand;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rand = s >>> 0;
    return (s >>> 0) / 4294967296;
  }

  /** Midpoint displacement into `off`: zero at both ends, fractal in between. */
  private displace(off: Float32Array, steps: number, amplitude: number): void {
    off[0] = 0;
    off[steps] = 0;
    let amp = amplitude;
    for (let step = steps; step > 1; step >>= 1) {
      const half = step >> 1;
      for (let i = half; i < steps; i += step) {
        off[i] = ((off[i - half] as number) + (off[i + half] as number)) * 0.5 + (this.next() * 2 - 1) * amp;
      }
      amp *= 0.55;
    }
  }

  write(rib: RibbonWriter): void {
    if (this.count === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const state = this.state[i] as number;
      if (state === 0) continue;
      const t = (this.age[i] as number) / (this.seconds[i] as number);
      // Brightness over life: strike, dip, re-strike, decay — or one steady decay.
      let level: number;
      let restruck = false;
      if (state === 2) {
        level = Math.pow(1 - t, 1.5);
      } else if (t < 0.22) {
        level = 1;
      } else if (t < 0.36) {
        level = 0.22;
      } else {
        restruck = true;
        level = t < 0.55 ? 0.95 : 0.95 * Math.pow(Math.max(0, (1 - t) / 0.45), 1.6);
      }
      if (!(level > 0.003)) continue;
      this.rand = ((this.seed[i] as number) + (restruck ? 0x9e3779b9 : 0)) >>> 0 || 1;

      const e = i * 6;
      const ax = this.ends[e] as number;
      const ay = this.ends[e + 1] as number;
      const az = this.ends[e + 2] as number;
      const dx = (this.ends[e + 3] as number) - ax;
      const dy = (this.ends[e + 4] as number) - ay;
      const dz = (this.ends[e + 5] as number) - az;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(length > 1e-3)) continue;
      const nx = dx / length;
      const ny = dy / length;
      const nz = dz / length;
      // Two unit vectors perpendicular to the channel.
      let ux: number;
      let uy: number;
      let uz: number;
      if (Math.abs(ny) < 0.99) {
        ux = nz;
        uy = 0;
        uz = -nx;
      } else {
        ux = 0;
        uy = -nz;
        uz = ny;
      }
      const ul = 1 / Math.sqrt(ux * ux + uy * uy + uz * uz);
      ux *= ul;
      uy *= ul;
      uz *= ul;
      const vx = ny * uz - nz * uy;
      const vy = nz * ux - nx * uz;
      const vz = nx * uy - ny * ux;

      const steps = length < 5 ? 8 : length < 45 ? 16 : MAX_STEPS;
      const amp = Math.min(Math.max(length * 0.085, 0.1), 20);
      this.displace(this.offU, steps, amp);
      this.displace(this.offV, steps, amp);
      const width = this.width[i] as number;
      const half = width * BOLT_QUAD;
      const r = (this.rgb[i * 3] as number) * BOLT_GAIN;
      const g = (this.rgb[i * 3 + 1] as number) * BOLT_GAIN;
      const b = (this.rgb[i * 3 + 2] as number) * BOLT_GAIN;
      const path = this.path;
      rib.start();
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        const ou = this.offU[k] as number;
        const ov = this.offV[k] as number;
        const x = ax + dx * f + ux * ou + vx * ov;
        const y = ay + dy * f + uy * ou + vy * ov;
        const z = az + dz * f + uz * ou + vz * ov;
        path[k * 3] = x;
        path[k * 3 + 1] = y;
        path[k * 3 + 2] = z;
        rib.point(x, y, z, half, r, g, b, level);
      }
      rib.end();

      // Side branches fork off the channel and die out.
      const branches = this.branches[i] as number;
      for (let n = 0; n < branches; n++) {
        const k0 = 1 + Math.floor(this.next() * steps * 0.72);
        const phi = this.next() * 6.2831853;
        const lean = 0.45 + this.next() * 0.55;
        const cp = Math.cos(phi) * lean;
        const sp = Math.sin(phi) * lean;
        let bx = nx + ux * cp + vx * sp;
        let by = ny + uy * cp + vy * sp;
        let bz = nz + uz * cp + vz * sp;
        const bl = 1 / Math.sqrt(bx * bx + by * by + bz * bz);
        bx *= bl;
        by *= bl;
        bz *= bl;
        const reach = length * (0.1 + this.next() * 0.2);
        const segs = 5;
        let x = path[k0 * 3] as number;
        let y = path[k0 * 3 + 1] as number;
        let z = path[k0 * 3 + 2] as number;
        const jag = reach * 0.16;
        rib.start();
        rib.point(x, y, z, half * 0.55, r, g, b, level * 0.7);
        for (let s = 1; s <= segs; s++) {
          const taper = 1 - s / segs;
          x += bx * (reach / segs) + (this.next() * 2 - 1) * jag;
          y += by * (reach / segs) + (this.next() * 2 - 1) * jag;
          z += bz * (reach / segs) + (this.next() * 2 - 1) * jag;
          rib.point(x, y, z, half * (0.12 + 0.43 * taper), r, g, b, level * 0.7 * (0.15 + 0.85 * taper));
        }
        rib.end();
      }
    }
  }
}
