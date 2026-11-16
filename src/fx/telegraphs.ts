/**
 * Ground danger markers. Gameplay-critical: never thinned by quality, never refused below the pool cap
 * (beyond it the oldest timed marker is recycled). Timed markers fill over world-time seconds and
 * vanish; persistent ones show whatever their owner sets.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import type { TelegraphHandle, TelegraphKind, TelegraphOptions, Vec3Like } from '../core/types';
import { TELEGRAPH_STRIDE } from './consts';
import { DEAD_TELEGRAPH } from './handles';

const KINDS: readonly TelegraphKind[] = ['ring', 'circle', 'spawn', 'strike', 'mortar', 'shock'];
/** Lift above the given ground point (on top of the material's polygon offset). */
const LIFT = 0.03;
/** Seconds a new marker takes to fade in (no popping). */
const APPEAR = 0.08;
const MAX_RADIUS = 200;

const tmpColor = new THREE.Color();

class LiveTelegraphHandle implements TelegraphHandle {
  constructor(
    private readonly pool: Telegraphs,
    private readonly slot: number,
    private readonly gen: number,
  ) {}

  get active(): boolean {
    return this.pool.isLive(this.slot, this.gen);
  }

  setPosition(position: Vec3Like): void {
    this.pool.setPosition(this.slot, this.gen, position);
  }

  setRadius(radius: number): void {
    this.pool.setRadius(this.slot, this.gen, radius);
  }

  setProgress(value: number): void {
    this.pool.setProgress(this.slot, this.gen, value);
  }

  cancel(): void {
    this.pool.cancel(this.slot, this.gen);
  }
}

export class Telegraphs {
  /** Live markers. */
  count = 0;
  private readonly pos: Float32Array;
  private readonly radius: Float32Array;
  private readonly progress: Float32Array;
  /** 0 = persistent. */
  private readonly seconds: Float32Array;
  private readonly age: Float32Array;
  private readonly rgb: Float32Array;
  private readonly phase: Float32Array;
  private readonly owner: Int32Array;
  private readonly gen: Uint32Array;
  private readonly order: Uint32Array;
  private readonly kind: Uint8Array;
  private readonly alive: Uint8Array;
  private sequence = 0;

  constructor(readonly capacity: number) {
    this.pos = new Float32Array(capacity * 3);
    this.radius = new Float32Array(capacity);
    this.progress = new Float32Array(capacity);
    this.seconds = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.rgb = new Float32Array(capacity * 3);
    this.phase = new Float32Array(capacity);
    this.owner = new Int32Array(capacity);
    this.gen = new Uint32Array(capacity);
    this.order = new Uint32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  create(opts: TelegraphOptions, phase: number): TelegraphHandle {
    const k = KINDS.indexOf(opts.kind);
    const p = opts.position;
    if (k < 0 || !p || !Number.isFinite(p.x + p.y + p.z)) return DEAD_TELEGRAPH;
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      // Beyond the cap: recycle the oldest timed marker (it is the closest to done).
      let oldest = 0xffffffff;
      for (let i = 0; i < this.capacity; i++) {
        if ((this.seconds[i] as number) > 0 && (this.order[i] as number) < oldest) {
          oldest = this.order[i] as number;
          slot = i;
        }
      }
      if (slot < 0) return DEAD_TELEGRAPH;
      this.free(slot);
    }
    this.count++;
    this.alive[slot] = 1;
    this.kind[slot] = k;
    this.gen[slot] = (this.gen[slot] as number) + 1;
    this.order[slot] = this.sequence++;
    this.owner[slot] = opts.owner !== undefined && Number.isFinite(opts.owner) ? opts.owner : 0;
    this.pos[slot * 3] = p.x;
    this.pos[slot * 3 + 1] = p.y;
    this.pos[slot * 3 + 2] = p.z;
    this.radius[slot] = Number.isFinite(opts.radius) && opts.radius > 0 ? Math.min(opts.radius, MAX_RADIUS) : 0.01;
    this.seconds[slot] = Number.isFinite(opts.seconds) && opts.seconds > 0 ? opts.seconds : 0;
    this.progress[slot] = 0;
    this.age[slot] = 0;
    this.phase[slot] = phase;
    const fallback = opts.kind === 'spawn' ? PALETTE.lightning : PALETTE.hazard;
    tmpColor.setHex((opts.color !== undefined && Number.isFinite(opts.color) ? opts.color : fallback) & 0xffffff);
    this.rgb[slot * 3] = tmpColor.r;
    this.rgb[slot * 3 + 1] = tmpColor.g;
    this.rgb[slot * 3 + 2] = tmpColor.b;
    return new LiveTelegraphHandle(this, slot, this.gen[slot] as number);
  }

  private free(slot: number): void {
    if (this.alive[slot] === 0) return;
    this.alive[slot] = 0;
    this.seconds[slot] = 0;
    this.owner[slot] = 0;
    this.gen[slot] = (this.gen[slot] as number) + 1;
    this.count--;
  }

  isLive(slot: number, gen: number): boolean {
    return this.gen[slot] === gen && this.alive[slot] === 1;
  }

  setPosition(slot: number, gen: number, p: Vec3Like): void {
    if (!this.isLive(slot, gen) || !Number.isFinite(p.x + p.y + p.z)) return;
    this.pos[slot * 3] = p.x;
    this.pos[slot * 3 + 1] = p.y;
    this.pos[slot * 3 + 2] = p.z;
  }

  setRadius(slot: number, gen: number, radius: number): void {
    if (!this.isLive(slot, gen) || !Number.isFinite(radius)) return;
    this.radius[slot] = radius > 0 ? Math.min(radius, MAX_RADIUS) : 0.01;
  }

  setProgress(slot: number, gen: number, value: number): void {
    // Timed markers advance by themselves.
    if (!this.isLive(slot, gen) || (this.seconds[slot] as number) > 0 || !Number.isFinite(value)) return;
    this.progress[slot] = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  cancel(slot: number, gen: number): void {
    if (this.isLive(slot, gen)) this.free(slot);
  }

  cancelOwner(owner: number): void {
    if (owner === 0 || this.count === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 1 && this.owner[i] === owner) this.free(i);
    }
  }

  update(dt: number): void {
    if (this.count === 0 || !(dt > 0)) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const age = (this.age[i] as number) + dt;
      this.age[i] = age;
      const seconds = this.seconds[i] as number;
      if (seconds > 0) {
        if (age >= seconds) this.free(i);
        else this.progress[i] = age / seconds;
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.free(i);
    this.count = 0;
  }

  /** Write one instance per live marker; returns the instance count. */
  write(out: Float32Array): number {
    if (this.count === 0) return 0;
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const o = n++ * TELEGRAPH_STRIDE;
      out[o] = this.pos[i * 3] as number;
      out[o + 1] = (this.pos[i * 3 + 1] as number) + LIFT;
      out[o + 2] = this.pos[i * 3 + 2] as number;
      out[o + 3] = this.radius[i] as number;
      out[o + 4] = this.rgb[i * 3] as number;
      out[o + 5] = this.rgb[i * 3 + 1] as number;
      out[o + 6] = this.rgb[i * 3 + 2] as number;
      const appear = 0.3 + (0.7 * (this.age[i] as number)) / APPEAR;
      out[o + 7] = appear < 1 ? appear : 1;
      out[o + 8] = this.kind[i] as number;
      out[o + 9] = this.progress[i] as number;
      out[o + 10] = this.phase[i] as number;
      out[o + 11] = 0;
    }
    return n;
  }
}
