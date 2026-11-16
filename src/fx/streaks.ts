/**
 * Tracers and beams: both are drawn by the streak batch as camera-facing capsules.
 *   - a tracer is a short streak that runs from the muzzle to the hit point and is gone;
 *   - a beam is a full-length segment: one-shot (rail, laser) or persistent and moved through its handle
 *     (lock laser, boss sweep).
 */
import * as THREE from 'three';
import { PALETTE } from '../core/palette';
import type { BeamHandle, BeamKind, Vec3Like } from '../core/types';
import { STREAK_STRIDE, STYLE } from './consts';
import { DEAD_BEAM } from './handles';

const tmpColor = new THREE.Color();

/** Write one streak instance. Returns the next free instance index. */
export function writeStreak(
  out: Float32Array,
  index: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  width: number, style: number,
  r: number, g: number, b: number, intensity: number,
  progress: number, phase: number, quadScale: number, minPixels: number,
): number {
  if ((index + 1) * STREAK_STRIDE > out.length) return index;
  const o = index * STREAK_STRIDE;
  out[o] = ax;
  out[o + 1] = ay;
  out[o + 2] = az;
  out[o + 3] = width;
  out[o + 4] = bx;
  out[o + 5] = by;
  out[o + 6] = bz;
  out[o + 7] = style;
  out[o + 8] = r;
  out[o + 9] = g;
  out[o + 10] = b;
  out[o + 11] = intensity;
  out[o + 12] = progress;
  out[o + 13] = phase;
  out[o + 14] = quadScale;
  out[o + 15] = minPixels;
  return index + 1;
}

/** Quad half width of a glow dot in core half widths (its hot core is about a third of the dot). */
const DOT_QUAD = 3.3;

/** Write a camera-facing glow dot of the given diameter. Returns the next free instance index. */
export function writeDot(
  out: Float32Array,
  index: number,
  x: number, y: number, z: number,
  diameter: number,
  r: number, g: number, b: number, intensity: number,
  minPixels: number,
): number {
  return writeStreak(out, index, x, y, z, x, y, z, diameter / DOT_QUAD, STYLE.DOT, r, g, b, intensity, 0, 0, DOT_QUAD, minPixels);
}

// ---------------------------------------------------------------------------------------------------
// Tracers
// ---------------------------------------------------------------------------------------------------

const TRACER_GAIN = 5;
/** Shots shorter than this leave no streak. */
const TRACER_MIN_DISTANCE = 0.6;

export class Tracers {
  /** Live tracers. */
  count = 0;
  private readonly ox: Float32Array;
  private readonly oy: Float32Array;
  private readonly oz: Float32Array;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly dz: Float32Array;
  private readonly dist: Float32Array;
  private readonly head: Float32Array;
  private readonly len: Float32Array;
  private readonly speed: Float32Array;
  private readonly width: Float32Array;
  private readonly r: Float32Array;
  private readonly g: Float32Array;
  private readonly b: Float32Array;
  /** 0 free, 1 world clock, 2 player clock. */
  private readonly state: Uint8Array;
  private cursor = 0;

  constructor(readonly capacity: number) {
    const f = (): Float32Array => new Float32Array(capacity);
    this.ox = f();
    this.oy = f();
    this.oz = f();
    this.dx = f();
    this.dy = f();
    this.dz = f();
    this.dist = f();
    this.head = f();
    this.len = f();
    this.speed = f();
    this.width = f();
    this.r = f();
    this.g = f();
    this.b = f();
    this.state = new Uint8Array(capacity);
  }

  add(from: Vec3Like, to: Vec3Like, color: number, speed: number, width: number, playerClock: boolean): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(dist >= TRACER_MIN_DISTANCE) || !(dist < 5000) || !Number.isFinite(from.x + from.y + from.z)) return;
    // Round-robin: when every slot is in flight the oldest streak is the one replaced.
    let slot = -1;
    for (let k = 0; k < this.capacity; k++) {
      const i = (this.cursor + k) % this.capacity;
      if (this.state[i] === 0) {
        slot = i;
        break;
      }
    }
    if (slot < 0) slot = this.cursor;
    else this.count++;
    this.cursor = (slot + 1) % this.capacity;
    const inv = 1 / dist;
    this.ox[slot] = from.x;
    this.oy[slot] = from.y;
    this.oz[slot] = from.z;
    this.dx[slot] = dx * inv;
    this.dy[slot] = dy * inv;
    this.dz[slot] = dz * inv;
    this.dist[slot] = dist;
    this.head[slot] = 0;
    this.len[slot] = Math.min(Math.max(dist * 0.4, 2.2), 12);
    this.speed[slot] = Number.isFinite(speed) && speed > 1 ? speed : 320;
    this.width[slot] = Number.isFinite(width) && width > 0 ? width : 0.035;
    tmpColor.setHex(color & 0xffffff);
    this.r[slot] = tmpColor.r * TRACER_GAIN;
    this.g[slot] = tmpColor.g * TRACER_GAIN;
    this.b[slot] = tmpColor.b * TRACER_GAIN;
    this.state[slot] = playerClock ? 2 : 1;
  }

  update(dt: number, playerDt: number): void {
    if (this.count === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.state[i] as number;
      if (s === 0) continue;
      const head = (this.head[i] as number) + (this.speed[i] as number) * (s === 2 ? playerDt : dt);
      this.head[i] = head;
      // Done when the tail has reached the hit point.
      if (head - (this.len[i] as number) >= (this.dist[i] as number)) {
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

  write(out: Float32Array, index: number): number {
    if (this.count === 0) return index;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === 0) continue;
      const dist = this.dist[i] as number;
      const head = Math.min(this.head[i] as number, dist);
      const tail = Math.max(0, (this.head[i] as number) - (this.len[i] as number));
      if (head - tail < 0.02) continue;
      const ox = this.ox[i] as number;
      const oy = this.oy[i] as number;
      const oz = this.oz[i] as number;
      const dx = this.dx[i] as number;
      const dy = this.dy[i] as number;
      const dz = this.dz[i] as number;
      index = writeStreak(
        out, index,
        ox + dx * tail, oy + dy * tail, oz + dz * tail,
        ox + dx * head, oy + dy * head, oz + dz * head,
        this.width[i] as number, STYLE.TRACER,
        this.r[i] as number, this.g[i] as number, this.b[i] as number, 1,
        0, 0, 5, 1.1,
      );
    }
    return index;
  }
}

// ---------------------------------------------------------------------------------------------------
// Beams
// ---------------------------------------------------------------------------------------------------

interface BeamLook {
  style: number;
  color: number;
  width: number;
  /** Quad half width in core half widths (room for the glow / the rail helix). */
  quad: number;
  minPixels: number;
  gain: number;
  /** Seconds a one-shot keeps fading after its hold time. */
  tail: number;
  /** Glow dots at the far / near end, in core widths (0 = none). */
  dotTo: number;
  dotFrom: number;
}

const BEAM_LOOKS: Record<BeamKind, BeamLook> = {
  rail: { style: STYLE.RAIL, color: PALETTE.player, width: 0.09, quad: 7, minPixels: 1.4, gain: 5, tail: 0.55, dotTo: 0, dotFrom: 0 },
  laser: { style: STYLE.LASER, color: PALETTE.enemy, width: 0.12, quad: 5, minPixels: 1.6, gain: 5, tail: 0.16, dotTo: 4, dotFrom: 0 },
  lockLaser: { style: STYLE.LOCK, color: PALETTE.enemy, width: 0.025, quad: 4, minPixels: 1.2, gain: 3, tail: 0.06, dotTo: 5, dotFrom: 3 },
  sweep: { style: STYLE.SWEEP, color: PALETTE.elite, width: 0.4, quad: 3.2, minPixels: 2, gain: 5, tail: 0.18, dotTo: 3, dotFrom: 2 },
};

/** Seconds a stopped beam takes to fade out. */
const STOP_FADE = 0.1;
const DEFAULT_SECONDS = 0.12;

class LiveBeamHandle implements BeamHandle {
  constructor(
    private readonly beams: Beams,
    private readonly slot: number,
    private readonly gen: number,
  ) {}

  get active(): boolean {
    return this.beams.isLive(this.slot, this.gen);
  }

  set(from: Vec3Like, to: Vec3Like): void {
    this.beams.setEnds(this.slot, this.gen, from, to);
  }

  setIntensity(value: number): void {
    this.beams.setIntensity(this.slot, this.gen, value);
  }

  setColor(color: number): void {
    this.beams.setColor(this.slot, this.gen, color);
  }

  stop(): void {
    this.beams.stop(this.slot, this.gen);
  }
}

export class Beams {
  /** Beams that are still held by their owner or their hold time (not the ones fading out). */
  count = 0;
  private readonly ends: Float32Array;
  private readonly rgb: Float32Array;
  private readonly width: Float32Array;
  private readonly intensity: Float32Array;
  private readonly age: Float32Array;
  /** Hold seconds of a one-shot; 0 = persistent. */
  private readonly hold: Float32Array;
  /** Seconds since stop() (or the end of the hold of a lock / sweep); < 0 while live. */
  private readonly stopAge: Float32Array;
  private readonly phase: Float32Array;
  private readonly owner: Int32Array;
  private readonly gen: Uint32Array;
  private readonly kind: Uint8Array;
  /** 0 free, 1 world clock, 2 player clock. */
  private readonly state: Uint8Array;
  private readonly looks: BeamLook[] = [BEAM_LOOKS.rail, BEAM_LOOKS.laser, BEAM_LOOKS.lockLaser, BEAM_LOOKS.sweep];
  private readonly kinds: BeamKind[] = ['rail', 'laser', 'lockLaser', 'sweep'];
  private drawn = 0;

  constructor(readonly capacity: number) {
    this.ends = new Float32Array(capacity * 6);
    this.rgb = new Float32Array(capacity * 3);
    this.width = new Float32Array(capacity);
    this.intensity = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.hold = new Float32Array(capacity);
    this.stopAge = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.owner = new Int32Array(capacity);
    this.gen = new Uint32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.state = new Uint8Array(capacity);
  }

  /** Slots in use, fading ones included (for the "anything to draw" test). */
  get busy(): number {
    return this.drawn;
  }

  create(
    from: Vec3Like,
    to: Vec3Like,
    kind: BeamKind,
    color: number | undefined,
    width: number | undefined,
    seconds: number | undefined,
    playerClock: boolean,
    owner: number,
    phase: number,
  ): BeamHandle {
    const k = this.kinds.indexOf(kind);
    if (k < 0 || !Number.isFinite(from.x + from.y + from.z + to.x + to.y + to.z)) return DEAD_BEAM;
    let slot = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === 0) {
        slot = i;
        break;
      }
    }
    if (slot < 0) slot = this.reclaim();
    if (slot < 0) return DEAD_BEAM;
    const look = this.looks[k] as BeamLook;
    this.drawn++;
    this.count++;
    this.state[slot] = playerClock ? 2 : 1;
    this.kind[slot] = k;
    this.gen[slot] = (this.gen[slot] as number) + 1;
    this.owner[slot] = Number.isFinite(owner) ? owner : 0;
    const e = slot * 6;
    this.ends[e] = from.x;
    this.ends[e + 1] = from.y;
    this.ends[e + 2] = from.z;
    this.ends[e + 3] = to.x;
    this.ends[e + 4] = to.y;
    this.ends[e + 5] = to.z;
    this.writeColor(slot, color !== undefined && Number.isFinite(color) ? color : look.color);
    this.width[slot] = width !== undefined && Number.isFinite(width) && width > 0 ? width : look.width;
    this.intensity[slot] = 1;
    this.age[slot] = 0;
    const hold = seconds === undefined || !Number.isFinite(seconds) ? DEFAULT_SECONDS : Math.max(0, seconds);
    this.hold[slot] = hold;
    this.stopAge[slot] = -1;
    this.phase[slot] = phase;
    return new LiveBeamHandle(this, slot, this.gen[slot] as number);
  }

  /**
   * Pool exhausted: take a beam that is already fading, else the oldest one-shot. Persistent beams are
   * never taken from their owner.
   */
  private reclaim(): number {
    let best = -1;
    let bestAge = -1;
    for (let i = 0; i < this.capacity; i++) {
      if ((this.stopAge[i] as number) >= 0 && (this.stopAge[i] as number) > bestAge) {
        bestAge = this.stopAge[i] as number;
        best = i;
      }
    }
    if (best < 0) {
      for (let i = 0; i < this.capacity; i++) {
        if ((this.hold[i] as number) > 0 && (this.age[i] as number) > bestAge) {
          bestAge = this.age[i] as number;
          best = i;
        }
      }
    }
    if (best >= 0) this.free(best);
    return best;
  }

  private free(slot: number): void {
    if (this.state[slot] === 0) return;
    if (this.isHeld(slot)) this.count--;
    this.state[slot] = 0;
    this.gen[slot] = (this.gen[slot] as number) + 1;
    this.stopAge[slot] = -1;
    this.hold[slot] = 0;
    this.owner[slot] = 0;
    this.drawn--;
  }

  /** Still owned: not stopped and (for a one-shot) inside its hold time. */
  private isHeld(slot: number): boolean {
    if (this.state[slot] === 0 || (this.stopAge[slot] as number) >= 0) return false;
    const hold = this.hold[slot] as number;
    return hold === 0 || (this.age[slot] as number) < hold;
  }

  isLive(slot: number, gen: number): boolean {
    return this.gen[slot] === gen && this.isHeld(slot);
  }

  setEnds(slot: number, gen: number, from: Vec3Like, to: Vec3Like): void {
    if (!this.isLive(slot, gen) || !Number.isFinite(from.x + from.y + from.z + to.x + to.y + to.z)) return;
    const e = slot * 6;
    this.ends[e] = from.x;
    this.ends[e + 1] = from.y;
    this.ends[e + 2] = from.z;
    this.ends[e + 3] = to.x;
    this.ends[e + 4] = to.y;
    this.ends[e + 5] = to.z;
  }

  setIntensity(slot: number, gen: number, value: number): void {
    if (!this.isLive(slot, gen) || !Number.isFinite(value)) return;
    this.intensity[slot] = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  setColor(slot: number, gen: number, color: number): void {
    if (!this.isLive(slot, gen) || !Number.isFinite(color)) return;
    this.writeColor(slot, color);
  }

  stop(slot: number, gen: number): void {
    if (!this.isLive(slot, gen)) return;
    this.count--;
    this.stopAge[slot] = 0;
  }

  private writeColor(slot: number, color: number): void {
    tmpColor.setHex(color & 0xffffff);
    this.rgb[slot * 3] = tmpColor.r;
    this.rgb[slot * 3 + 1] = tmpColor.g;
    this.rgb[slot * 3 + 2] = tmpColor.b;
  }

  cancelOwner(owner: number): void {
    if (owner === 0 || this.drawn === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] !== 0 && this.owner[i] === owner && this.isHeld(i)) {
        this.count--;
        this.stopAge[i] = 0;
      }
    }
  }

  update(dt: number, playerDt: number): void {
    if (this.drawn === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.state[i] as number;
      if (s === 0) continue;
      const d = s === 2 ? playerDt : dt;
      const held = this.isHeld(i);
      const age = (this.age[i] as number) + d;
      this.age[i] = age;
      const stop = this.stopAge[i] as number;
      if (stop >= 0) {
        this.stopAge[i] = stop + d;
        if (stop + d >= STOP_FADE) this.free(i);
        continue;
      }
      const hold = this.hold[i] as number;
      if (hold > 0 && age >= hold) {
        if (held) this.count--;
        if (age >= hold + (this.looks[this.kind[i] as number] as BeamLook).tail) this.free(i);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.free(i);
    this.count = 0;
    this.drawn = 0;
  }

  write(out: Float32Array, index: number): number {
    if (this.drawn === 0) return index;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === 0) continue;
      const look = this.looks[this.kind[i] as number] as BeamLook;
      const e = i * 6;
      const ax = this.ends[e] as number;
      const ay = this.ends[e + 1] as number;
      const az = this.ends[e + 2] as number;
      const bx = this.ends[e + 3] as number;
      const by = this.ends[e + 4] as number;
      const bz = this.ends[e + 5] as number;
      const hold = this.hold[i] as number;
      const age = this.age[i] as number;
      const stop = this.stopAge[i] as number;
      // One-shots animate over their whole life; everything fades when stopped.
      let progress = hold > 0 ? Math.min(1, age / (hold + look.tail)) : 0;
      let level = this.intensity[i] as number;
      if (stop >= 0) level *= Math.max(0, 1 - stop / STOP_FADE);
      else if (hold > 0 && look.style !== STYLE.RAIL && look.style !== STYLE.LASER && age > hold) {
        level *= Math.max(0, 1 - (age - hold) / look.tail);
        progress = 0;
      }
      if (!(level > 0.001)) continue;
      const width = (this.width[i] as number) * (0.45 + 0.55 * (this.intensity[i] as number));
      const r = (this.rgb[i * 3] as number) * look.gain;
      const g = (this.rgb[i * 3 + 1] as number) * look.gain;
      const b = (this.rgb[i * 3 + 2] as number) * look.gain;
      const phase = (this.phase[i] as number) + (look.style === STYLE.RAIL ? age * 11 : 0);
      index = writeStreak(out, index, ax, ay, az, bx, by, bz, width, look.style, r, g, b, level, progress, phase, look.quad, look.minPixels);
      const dotLevel = level * (hold > 0 ? 1 - progress : 1);
      if (look.dotTo > 0) index = writeDot(out, index, bx, by, bz, width * look.dotTo, r, g, b, dotLevel, 3);
      if (look.dotFrom > 0) index = writeDot(out, index, ax, ay, az, width * look.dotFrom, r, g, b, dotLevel * 0.8, 2.5);
    }
    return index;
  }
}
