/**
 * Floating damage numbers. Hits on one target inside the merge window add up into one growing number.
 * Colours follow the ruling of the brief: body near-white, weak point pale gold and larger, shield
 * pale cyan — never hazard yellow, which belongs to danger telegraphs.
 */
import * as THREE from 'three';
import type { Rng, Vec3Like } from '../core/types';
import { NUMBER_STRIDE } from './consts';

const COLOR_BODY = 0xe8f1f5;
const COLOR_CRIT = 0xfff2b0;
const COLOR_SHIELD = 0x9fefff;

/** Numbers for the same target that arrive within this many seconds merge. */
export const NUMBER_MERGE_WINDOW = 0.25;
const MAX_DIGITS = 5;
const MAX_VALUE = 99999;
const FLAG_CRIT = 1;
const FLAG_SHIELD = 2;
const FLAG_KILL = 4;

const tmpColor = new THREE.Color();

function linear(hex: number, gain: number): [number, number, number] {
  tmpColor.setHex(hex);
  return [tmpColor.r * gain, tmpColor.g * gain, tmpColor.b * gain];
}

export class DamageNumbers {
  /** Live numbers. */
  count = 0;
  private readonly pos: Float32Array;
  private readonly value: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  /** Seconds since the last hit was merged in (drives the pop). */
  private readonly since: Float32Array;
  private readonly drift: Float32Array;
  private readonly target: Int32Array;
  private readonly order: Uint32Array;
  private readonly flags: Uint8Array;
  private readonly alive: Uint8Array;
  private sequence = 0;
  private readonly body = linear(COLOR_BODY, 1.05);
  private readonly crit = linear(COLOR_CRIT, 1.7);
  private readonly shield = linear(COLOR_SHIELD, 1.25);

  constructor(
    readonly capacity: number,
    private readonly rng: Rng,
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.value = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.since = new Float32Array(capacity);
    this.drift = new Float32Array(capacity);
    this.target = new Int32Array(capacity);
    this.order = new Uint32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  add(position: Vec3Like, amount: number, crit: boolean, shield: boolean, kill: boolean, targetId: number): void {
    if (!Number.isFinite(position.x + position.y + position.z) || !Number.isFinite(amount) || amount < 0) return;
    const target = Number.isFinite(targetId) ? targetId : 0;
    let slot = -1;
    if (target !== 0) {
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] === 1 && this.target[i] === target && (this.since[i] as number) < NUMBER_MERGE_WINDOW) {
          slot = i;
          break;
        }
      }
    }
    if (slot >= 0) {
      // Merge: one growing number, popping again at the newest hit.
      this.value[slot] = Math.min(MAX_VALUE, (this.value[slot] as number) + amount);
      let flags = this.flags[slot] as number;
      if (crit) flags |= FLAG_CRIT;
      if (kill) flags |= FLAG_KILL;
      // "Absorbed by a shield" only stays while every merged hit was.
      if (!shield) flags &= ~FLAG_SHIELD;
      this.flags[slot] = flags;
      this.since[slot] = 0;
      this.age[slot] = Math.min(this.age[slot] as number, 0.12);
      this.life[slot] = this.lifeFor(flags);
    } else {
      for (let i = 0; i < this.capacity; i++) {
        if (this.alive[i] === 0) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        // Pool full: the oldest number makes room.
        let oldest = 0xffffffff;
        for (let i = 0; i < this.capacity; i++) {
          if ((this.order[i] as number) < oldest) {
            oldest = this.order[i] as number;
            slot = i;
          }
        }
      } else {
        this.count++;
      }
      const flags = (crit ? FLAG_CRIT : 0) | (shield ? FLAG_SHIELD : 0) | (kill ? FLAG_KILL : 0);
      this.alive[slot] = 1;
      this.order[slot] = this.sequence++;
      this.target[slot] = target;
      this.value[slot] = Math.min(MAX_VALUE, amount);
      this.flags[slot] = flags;
      this.age[slot] = 0;
      this.since[slot] = 0;
      this.life[slot] = this.lifeFor(flags);
      this.drift[slot] = this.rng.next() * 2 - 1;
    }
    this.pos[slot * 3] = position.x;
    this.pos[slot * 3 + 1] = position.y;
    this.pos[slot * 3 + 2] = position.z;
  }

  private lifeFor(flags: number): number {
    return (flags & FLAG_KILL) !== 0 ? 1.15 : (flags & FLAG_CRIT) !== 0 ? 1 : 0.8;
  }

  update(dt: number): void {
    if (this.count === 0 || !(dt > 0)) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const age = (this.age[i] as number) + dt;
      this.age[i] = age;
      this.since[i] = (this.since[i] as number) + dt;
      if (age >= (this.life[i] as number)) {
        this.alive[i] = 0;
        this.count--;
      }
    }
  }

  clear(): void {
    this.alive.fill(0);
    this.count = 0;
  }

  /** Write one instance per digit; returns the instance count. */
  write(out: Float32Array): number {
    if (this.count === 0) return 0;
    let n = 0;
    const max = Math.floor(out.length / NUMBER_STRIDE);
    for (let i = 0; i < this.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const flags = this.flags[i] as number;
      const age = this.age[i] as number;
      const life = this.life[i] as number;
      const since = this.since[i] as number;
      const value = Math.max(0, Math.round(this.value[i] as number));
      let digits = 1;
      for (let v = value; v >= 10 && digits < MAX_DIGITS; v = Math.floor(v / 10)) digits++;
      const color = (flags & FLAG_SHIELD) !== 0 ? this.shield : (flags & FLAG_CRIT) !== 0 ? this.crit : this.body;
      const kill = (flags & FLAG_KILL) !== 0;
      // Size: crits and kills larger, absorbed hits smaller, a little growth with the merged value,
      // and a pop at every new hit.
      let scale = (flags & FLAG_SHIELD) !== 0 ? 0.82 : (flags & FLAG_CRIT) !== 0 ? 1.32 : 1;
      if (kill) scale *= 1.22;
      scale *= 1 + Math.min(0.3, Math.log10(1 + value / 40) * 0.22);
      scale *= 1 + (kill ? 0.8 : 0.55) * Math.exp(-since * 16);
      const fadeIn = age < 0.04 ? 0.4 + age * 15 : 1;
      const left = (life - age) / (life * 0.3);
      const alpha = fadeIn * (left < 1 ? Math.max(0, left) : 1);
      // Rise in glyph heights: fast at first, then settling.
      const rise = 0.7 + 1.5 * (1 - Math.exp(-age * 3.4));
      const gain = kill ? 1.25 : 1;
      const drift = (this.drift[i] as number) * 0.5;
      let rest = value;
      for (let dgt = digits - 1; dgt >= 0 && n < max; dgt--) {
        const digit = rest % 10;
        rest = Math.floor(rest / 10);
        const o = n++ * NUMBER_STRIDE;
        out[o] = this.pos[i * 3] as number;
        out[o + 1] = this.pos[i * 3 + 1] as number;
        out[o + 2] = this.pos[i * 3 + 2] as number;
        out[o + 3] = scale;
        out[o + 4] = digit;
        out[o + 5] = dgt - (digits - 1) * 0.5 + drift;
        out[o + 6] = alpha;
        out[o + 7] = rise;
        out[o + 8] = color[0] * gain;
        out[o + 9] = color[1] * gain;
        out[o + 10] = color[2] * gain;
        out[o + 11] = 0;
      }
    }
    return n;
  }
}
