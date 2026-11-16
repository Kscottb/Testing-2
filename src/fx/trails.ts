/**
 * Trails follow a retained, live position vector. Each trail is a glowing ribbon of recent positions
 * (sampled by distance, so it looks the same on whichever clock its owner moves), an optional glow dot
 * at the head and optional smoke puffs dropped along the path.
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import type { TrailHandle, TrailKind } from '../core/types';
import { DEAD_TRAIL } from './handles';
import type { RibbonWriter } from './ribbons';
import { writeDot } from './streaks';

interface TrailLook {
  color: number;
  /** Half width of the ribbon at the head, metres. */
  half: number;
  /** A sample fades over this many seconds ... */
  life: number;
  /** ... or this many metres behind the head, whichever comes first. */
  length: number;
  /** Distance between samples, metres. */
  spacing: number;
  gain: number;
  /** Diameter of the glow dot at the head (0 = none). */
  glow: number;
  /** Metres between smoke puffs (0 = none). */
  puff: number;
}

export const TRAIL_KINDS: readonly TrailKind[] = ['rocket', 'grenade', 'plasma', 'bolt', 'mortar', 'missile', 'bossBolt', 'supply'];

const LOOKS: Record<TrailKind, TrailLook> = {
  rocket: { color: PALETTE.player, half: 0.11, life: 0.3, length: 5.5, spacing: 0.45, gain: 4, glow: 0.7, puff: 0.6 },
  grenade: { color: PALETTE.player, half: 0.035, life: 0.35, length: 2.2, spacing: 0.22, gain: 1.6, glow: 0.22, puff: 0 },
  plasma: { color: PALETTE.enemy, half: 0.13, life: 0.22, length: 2.6, spacing: 0.3, gain: 4, glow: 0.75, puff: 0 },
  bolt: { color: PALETTE.enemy, half: 0.07, life: 0.14, length: 1.8, spacing: 0.3, gain: 3.5, glow: 0.4, puff: 0 },
  mortar: { color: PALETTE.elite, half: 0.14, life: 0.45, length: 4, spacing: 0.4, gain: 3, glow: 0.8, puff: 0.8 },
  missile: { color: PALETTE.elite, half: 0.1, life: 0.3, length: 4.5, spacing: 0.4, gain: 4, glow: 0.7, puff: 0.75 },
  bossBolt: { color: PALETTE.elite, half: 0.2, life: 0.25, length: 3.6, spacing: 0.35, gain: 4.5, glow: 1.1, puff: 0 },
  supply: { color: PALETTE.player, half: 0.32, life: 0.6, length: 12, spacing: 0.7, gain: 3.5, glow: 1.6, puff: 1.1 },
};

/** Samples kept per trail. */
const SAMPLES = 20;
const SAMPLE_STRIDE = 4;
/** A jump longer than this in one update is a teleport: the ribbon restarts instead of bridging it. */
const TELEPORT = 60;
/** Seconds a detached trail takes to dim on top of the natural fade of its samples. */
const DETACH_FADE = 0.35;
const MAX_PUFFS_PER_UPDATE = 6;

const tmpColor = new THREE.Color();

class LiveTrailHandle implements TrailHandle {
  constructor(
    private readonly trails: Trails,
    private readonly slot: number,
    private readonly gen: number,
  ) {}

  get active(): boolean {
    return this.trails.isAttached(this.slot, this.gen);
  }

  detach(): void {
    this.trails.detach(this.slot, this.gen);
  }
}

export class Trails {
  /** Trails still attached to their owner. */
  count = 0;
  private readonly target: (THREE.Vector3 | null)[];
  private readonly samples: Float32Array;
  /** Ring start and number of samples per trail. */
  private readonly first: Uint8Array;
  private readonly used: Uint8Array;
  /** Last seen head position (also the frozen head of a detached trail) and puff distance carry. */
  private readonly head: Float32Array;
  private readonly carry: Float32Array;
  private readonly rgb: Float32Array;
  private readonly detached: Float32Array;
  private readonly owner: Int32Array;
  private readonly gen: Uint32Array;
  private readonly kind: Uint8Array;
  /** 0 free, 1 attached, 2 detached (fading). */
  private readonly state: Uint8Array;
  private readonly looks: TrailLook[] = TRAIL_KINDS.map((kind) => LOOKS[kind]);
  private inUse = 0;

  constructor(
    readonly capacity: number,
    /** Drop one smoke puff of trail kind `kind` (index into TRAIL_KINDS) at a point. */
    private readonly puff: (kind: number, x: number, y: number, z: number) => void,
  ) {
    this.target = new Array<THREE.Vector3 | null>(capacity).fill(null);
    this.samples = new Float32Array(capacity * SAMPLES * SAMPLE_STRIDE);
    this.first = new Uint8Array(capacity);
    this.used = new Uint8Array(capacity);
    this.head = new Float32Array(capacity * 3);
    this.carry = new Float32Array(capacity);
    this.rgb = new Float32Array(capacity * 3);
    this.detached = new Float32Array(capacity);
    this.owner = new Int32Array(capacity);
    this.gen = new Uint32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
  }

  /** Slots in use, fading trails included. */
  get busy(): number {
    return this.inUse;
  }

  attach(kind: TrailKind, position: THREE.Vector3, color: number | undefined, owner: number): TrailHandle {
    const k = TRAIL_KINDS.indexOf(kind);
    if (k < 0 || !position || !Number.isFinite(position.x + position.y + position.z)) return DEAD_TRAIL;
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === 0) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      // Pool exhausted: the trail that has been fading the longest gives way.
      let longest = -1;
      for (let i = 0; i < this.capacity; i++) {
        if (this.state[i] === 2 && (this.detached[i] as number) > longest) {
          longest = this.detached[i] as number;
          slot = i;
        }
      }
      if (slot < 0) return DEAD_TRAIL;
      this.free(slot);
    }
    this.inUse++;
    this.count++;
    this.state[slot] = 1;
    this.kind[slot] = k;
    this.gen[slot] = (this.gen[slot] as number) + 1;
    this.owner[slot] = Number.isFinite(owner) ? owner : 0;
    this.target[slot] = position;
    this.first[slot] = 0;
    this.used[slot] = 0;
    this.carry[slot] = 0;
    this.detached[slot] = 0;
    this.head[slot * 3] = position.x;
    this.head[slot * 3 + 1] = position.y;
    this.head[slot * 3 + 2] = position.z;
    tmpColor.setHex((color !== undefined && Number.isFinite(color) ? color : (this.looks[k] as TrailLook).color) & 0xffffff);
    this.rgb[slot * 3] = tmpColor.r;
    this.rgb[slot * 3 + 1] = tmpColor.g;
    this.rgb[slot * 3 + 2] = tmpColor.b;
    this.push(slot, position.x, position.y, position.z);
    return new LiveTrailHandle(this, slot, this.gen[slot] as number);
  }

  isAttached(slot: number, gen: number): boolean {
    return this.gen[slot] === gen && this.state[slot] === 1;
  }

  detach(slot: number, gen: number): void {
    if (this.isAttached(slot, gen)) this.release(slot);
  }

  /** Stop following; the samples fade out by themselves. */
  private release(slot: number): void {
    this.state[slot] = 2;
    this.target[slot] = null;
    this.detached[slot] = 0;
    this.count--;
  }

  private free(slot: number): void {
    if (this.state[slot] === 0) return;
    if (this.state[slot] === 1) this.count--;
    this.state[slot] = 0;
    this.target[slot] = null;
    this.gen[slot] = (this.gen[slot] as number) + 1;
    this.used[slot] = 0;
    this.owner[slot] = 0;
    this.inUse--;
  }

  cancelOwner(owner: number): void {
    if (owner === 0 || this.count === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === 1 && this.owner[i] === owner) this.release(i);
    }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.free(i);
    this.count = 0;
    this.inUse = 0;
  }

  /** Add a sample at the newest end of the ring (the oldest is overwritten when full). */
  private push(slot: number, x: number, y: number, z: number): void {
    let first = this.first[slot] as number;
    let used = this.used[slot] as number;
    if (used === SAMPLES) {
      first = (first + 1) % SAMPLES;
      this.first[slot] = first;
    } else {
      used++;
      this.used[slot] = used;
    }
    const o = (slot * SAMPLES + ((first + used - 1) % SAMPLES)) * SAMPLE_STRIDE;
    this.samples[o] = x;
    this.samples[o + 1] = y;
    this.samples[o + 2] = z;
    this.samples[o + 3] = 0;
  }

  update(dt: number): void {
    if (this.inUse === 0) return;
    const step = dt > 0 ? dt : 0;
    for (let i = 0; i < this.capacity; i++) {
      const state = this.state[i] as number;
      if (state === 0) continue;
      const look = this.looks[this.kind[i] as number] as TrailLook;
      const h = i * 3;
      if (state === 1) {
        const p = this.target[i] as THREE.Vector3;
        const x = p.x;
        const y = p.y;
        const z = p.z;
        if (!(Math.abs(x) < 1e6) || !(Math.abs(y) < 1e6) || !(Math.abs(z) < 1e6)) {
          // The owner's vector went bad: let go instead of drawing garbage.
          this.release(i);
        } else {
          const lx = this.head[h] as number;
          const ly = this.head[h + 1] as number;
          const lz = this.head[h + 2] as number;
          const moved = Math.sqrt((x - lx) * (x - lx) + (y - ly) * (y - ly) + (z - lz) * (z - lz));
          if (moved > TELEPORT) {
            this.first[i] = 0;
            this.used[i] = 0;
            this.carry[i] = 0;
            this.push(i, x, y, z);
          } else {
            const used = this.used[i] as number;
            if (used === 0) {
              this.push(i, x, y, z);
            } else {
              const newest = (i * SAMPLES + (((this.first[i] as number) + used - 1) % SAMPLES)) * SAMPLE_STRIDE;
              const sx = x - (this.samples[newest] as number);
              const sy = y - (this.samples[newest + 1] as number);
              const sz = z - (this.samples[newest + 2] as number);
              if (sx * sx + sy * sy + sz * sz >= look.spacing * look.spacing) this.push(i, x, y, z);
            }
            if (look.puff > 0 && moved > 1e-4) {
              let carry = (this.carry[i] as number) + moved;
              let puffs = 0;
              while (carry >= look.puff && puffs < MAX_PUFFS_PER_UPDATE) {
                carry -= look.puff;
                // Place the puff where the path crossed the spacing mark.
                const f = 1 - carry / moved;
                const t = f < 0 ? 0 : f > 1 ? 1 : f;
                this.puff(this.kind[i] as number, lx + (x - lx) * t, ly + (y - ly) * t, lz + (z - lz) * t);
                puffs++;
              }
              this.carry[i] = carry >= look.puff ? 0 : carry;
            }
          }
          this.head[h] = x;
          this.head[h + 1] = y;
          this.head[h + 2] = z;
        }
      } else {
        this.detached[i] = (this.detached[i] as number) + step;
      }
      // Age the samples and drop the expired ones from the old end.
      let first = this.first[i] as number;
      let used = this.used[i] as number;
      const base = i * SAMPLES;
      for (let k = 0; k < used; k++) {
        const o = (base + ((first + k) % SAMPLES)) * SAMPLE_STRIDE + 3;
        this.samples[o] = (this.samples[o] as number) + step;
      }
      while (used > 0 && (this.samples[(base + first) * SAMPLE_STRIDE + 3] as number) >= look.life) {
        first = (first + 1) % SAMPLES;
        used--;
      }
      this.first[i] = first;
      this.used[i] = used;
      if (this.state[i] === 2 && (used === 0 || (this.detached[i] as number) >= DETACH_FADE + look.life)) this.free(i);
    }
  }

  /** Write the ribbons and the head glow dots. Returns the next free streak instance index. */
  write(rib: RibbonWriter, streaks: Float32Array, streakIndex: number): number {
    if (this.inUse === 0) return streakIndex;
    for (let i = 0; i < this.capacity; i++) {
      const state = this.state[i] as number;
      if (state === 0) continue;
      const look = this.looks[this.kind[i] as number] as TrailLook;
      const dim = state === 2 ? Math.max(0, 1 - (this.detached[i] as number) / DETACH_FADE) : 1;
      if (!(dim > 0)) continue;
      const r = (this.rgb[i * 3] as number) * look.gain;
      const g = (this.rgb[i * 3 + 1] as number) * look.gain;
      const b = (this.rgb[i * 3 + 2] as number) * look.gain;
      const h = i * 3;
      let px = this.head[h] as number;
      let py = this.head[h + 1] as number;
      let pz = this.head[h + 2] as number;
      if (look.glow > 0 && state === 1) {
        streakIndex = writeDot(streaks, streakIndex, px, py, pz, look.glow, r, g, b, 1, 2);
      }
      const used = this.used[i] as number;
      if (used === 0) continue;
      const first = this.first[i] as number;
      const base = i * SAMPLES;
      rib.start();
      rib.point(px, py, pz, look.half, r, g, b, dim);
      let arc = 0;
      // From the newest sample back to the oldest.
      for (let k = used - 1; k >= 0; k--) {
        const o = (base + ((first + k) % SAMPLES)) * SAMPLE_STRIDE;
        const x = this.samples[o] as number;
        const y = this.samples[o + 1] as number;
        const z = this.samples[o + 2] as number;
        arc += Math.sqrt((x - px) * (x - px) + (y - py) * (y - py) + (z - pz) * (z - pz));
        px = x;
        py = y;
        pz = z;
        let fade = Math.max((this.samples[o + 3] as number) / look.life, arc / look.length);
        if (fade > 1) fade = 1;
        const keep = 1 - fade;
        rib.point(x, y, z, look.half * (0.25 + 0.75 * keep), r, g, b, keep * keep * dim);
        if (fade >= 1) break;
      }
      rib.end();
    }
    return streakIndex;
  }
}
