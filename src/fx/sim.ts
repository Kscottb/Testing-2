/**
 * CPU particle core: one fixed pool in struct-of-arrays form, simulated on two clocks and written into
 * two instance buffers (additive, alpha) for the GPU. No three.js, no allocation after construction.
 */
import { PARTICLE_STRIDE, PF_ADD, PF_ALIGNED, PF_BOUNCE, PF_PLAYER_CLOCK, PF_STRETCH } from './consts';
import { RAMP_SAMPLES, RAMP_STRIDE } from './ramps';

/** Slots probed for a victim before falling back to a full scan. */
const VICTIM_PROBES = 48;

export class ParticleSim {
  readonly capacity: number;
  /** Live particles occupy the slots [0, count). */
  count = 0;
  /** Active cap (<= capacity): lowered by the quality preset, never raised above the pool size. */
  cap: number;
  /** Spawn requests that found no room since the last clear() (debug). */
  dropped = 0;
  /** Instances written by the last write(). */
  addCount = 0;
  alphaCount = 0;

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size0: Float32Array;
  readonly size1: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  readonly drag: Float32Array;
  readonly grav: Float32Array;
  /** Colour A and colour B (linear RGB) blended by the ramp's mix channel. */
  readonly ar: Float32Array;
  readonly ag: Float32Array;
  readonly ab: Float32Array;
  readonly br: Float32Array;
  readonly bg: Float32Array;
  readonly bb: Float32Array;
  readonly gain: Float32Array;
  readonly alpha: Float32Array;
  /** Plane normal of PF_ALIGNED particles. */
  readonly ax: Float32Array;
  readonly ay: Float32Array;
  readonly az: Float32Array;
  /** Seconds of velocity a PF_STRETCH streak covers. */
  readonly stretch: Float32Array;
  /** Floor under the spawn point: the bounce plane of debris, the fade plane of soft billboards. */
  readonly floorY: Float32Array;
  readonly bounce: Float32Array;
  /** 0 = lit by the scene, 1 = self-lit (alpha batch only). */
  readonly emis: Float32Array;
  readonly aspect: Float32Array;
  readonly ramp: Uint16Array;
  readonly sprite: Uint8Array;
  readonly flags: Uint8Array;
  /** 0 = secondary (dropped first), 1 = normal, 2 = critical (core flashes). */
  readonly prio: Uint8Array;
  /** Size easing: 0 linear, 1 ease-out, 2 strong ease-out, 3 ease-in. */
  readonly ease: Uint8Array;

  private readonly floats: Float32Array[];
  private cursor = 0;

  constructor(
    capacity: number,
    private readonly ramps: Float32Array,
  ) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.cap = this.capacity;
    const f = (): Float32Array => new Float32Array(this.capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.size0 = f();
    this.size1 = f();
    this.rot = f();
    this.spin = f();
    this.drag = f();
    this.grav = f();
    this.ar = f();
    this.ag = f();
    this.ab = f();
    this.br = f();
    this.bg = f();
    this.bb = f();
    this.gain = f();
    this.alpha = f();
    this.ax = f();
    this.ay = f();
    this.az = f();
    this.stretch = f();
    this.floorY = f();
    this.bounce = f();
    this.emis = f();
    this.aspect = f();
    this.ramp = new Uint16Array(this.capacity);
    this.sprite = new Uint8Array(this.capacity);
    this.flags = new Uint8Array(this.capacity);
    this.prio = new Uint8Array(this.capacity);
    this.ease = new Uint8Array(this.capacity);
    this.floats = [
      this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.size0, this.size1,
      this.rot, this.spin, this.drag, this.grav, this.ar, this.ag, this.ab, this.br, this.bg, this.bb,
      this.gain, this.alpha, this.ax, this.ay, this.az, this.stretch, this.floorY, this.bounce, this.emis,
      this.aspect,
    ];
  }

  /** Lower (or restore) the active cap; surplus particles are dropped, least important first. */
  setCap(cap: number): void {
    const next = Number.isFinite(cap) ? Math.min(this.capacity, Math.max(0, Math.floor(cap))) : this.capacity;
    this.cap = next;
    while (this.count > next) {
      const victim = this.findVictim(3);
      this.kill(victim >= 0 ? victim : this.count - 1);
    }
  }

  /**
   * Reserve a slot for a new particle of the given priority and return its index (every field reset to
   * a neutral default), or -1 when the pool is full of more important particles.
   */
  alloc(prio: number): number {
    let i: number;
    if (this.count < this.cap) {
      i = this.count++;
    } else {
      i = this.findVictim(prio);
      if (i < 0) {
        this.dropped++;
        return -1;
      }
    }
    const floats = this.floats;
    for (let k = 0; k < floats.length; k++) (floats[k] as Float32Array)[i] = 0;
    this.life[i] = 1;
    this.gain[i] = 1;
    this.alpha[i] = 1;
    this.ay[i] = 1;
    this.aspect[i] = 1;
    this.floorY[i] = -1e9;
    this.ramp[i] = 0;
    this.sprite[i] = 0;
    this.flags[i] = 0;
    this.prio[i] = prio;
    this.ease[i] = 0;
    return i;
  }

  /**
   * Graceful degradation when the pool is full: pick the least important, most finished particle. A
   * candidate must be of lower priority than the newcomer, or of the same priority and past half its
   * life. Critical newcomers may always replace the oldest critical one.
   */
  private findVictim(prio: number): number {
    const n = this.count;
    if (n === 0) return -1;
    let best = -1;
    let bestScore = -1;
    const probes = n < VICTIM_PROBES ? n : VICTIM_PROBES;
    let c = this.cursor;
    for (let k = 0; k < probes; k++) {
      if (c >= n) c = 0;
      const p = this.prio[c] as number;
      const done = (this.age[c] as number) / (this.life[c] as number);
      if (p < prio || (p === prio && done > 0.5) || prio >= 3) {
        // Lower priority always beats a higher one; within a priority the most finished goes first.
        const score = (2 - p) * 2 + done;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      c++;
    }
    this.cursor = c;
    if (best >= 0 || prio === 0) return best;
    // Nothing nearby: important newcomers search the whole pool for something less important.
    for (let i = 0; i < n; i++) {
      const p = this.prio[i] as number;
      if (p < prio) {
        const score = (2 - p) * 2 + (this.age[i] as number) / (this.life[i] as number);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
    if (best >= 0 || prio < 2) return best;
    for (let i = 0; i < n; i++) {
      const done = (this.age[i] as number) / (this.life[i] as number);
      if (done > bestScore) {
        bestScore = done;
        best = i;
      }
    }
    return best;
  }

  /** Remove the particle in slot i (the last live particle takes its place). */
  kill(i: number): void {
    const last = --this.count;
    if (i === last || i < 0) return;
    const floats = this.floats;
    for (let k = 0; k < floats.length; k++) {
      const a = floats[k] as Float32Array;
      a[i] = a[last] as number;
    }
    this.ramp[i] = this.ramp[last] as number;
    this.sprite[i] = this.sprite[last] as number;
    this.flags[i] = this.flags[last] as number;
    this.prio[i] = this.prio[last] as number;
    this.ease[i] = this.ease[last] as number;
  }

  clear(): void {
    this.count = 0;
    this.addCount = 0;
    this.alphaCount = 0;
    this.dropped = 0;
    this.cursor = 0;
  }

  /** Advance every particle: world-clock ones by `dt`, player-clock ones by `playerDt`. */
  update(dt: number, playerDt: number): void {
    const wdt = dt > 0 && dt < 1 ? dt : dt >= 1 ? 1 : 0;
    const pdt = playerDt > 0 && playerDt < 1 ? playerDt : playerDt >= 1 ? 1 : 0;
    if (wdt === 0 && pdt === 0) return;
    const { px, py, pz, vx, vy, vz, age, life, rot, spin, drag, grav, flags, floorY, bounce } = this;
    for (let i = this.count - 1; i >= 0; i--) {
      const f = flags[i] as number;
      const d = (f & PF_PLAYER_CLOCK) !== 0 ? pdt : wdt;
      if (d === 0) continue;
      const a = (age[i] as number) + d;
      if (!(a < (life[i] as number))) {
        this.kill(i);
        continue;
      }
      age[i] = a;
      const k = drag[i] as number;
      if (k > 0) {
        const keep = Math.exp(-k * d);
        vx[i] = (vx[i] as number) * keep;
        vy[i] = (vy[i] as number) * keep;
        vz[i] = (vz[i] as number) * keep;
      }
      vy[i] = (vy[i] as number) - (grav[i] as number) * d;
      const x = (px[i] as number) + (vx[i] as number) * d;
      let y = (py[i] as number) + (vy[i] as number) * d;
      const z = (pz[i] as number) + (vz[i] as number) * d;
      if ((f & PF_BOUNCE) !== 0) {
        const floor = floorY[i] as number;
        if (y < floor) {
          y = floor;
          const up = -(vy[i] as number) * (bounce[i] as number);
          if (up > 0.6) {
            vy[i] = up;
            vx[i] = (vx[i] as number) * 0.62;
            vz[i] = (vz[i] as number) * 0.62;
            spin[i] = (spin[i] as number) * 0.6;
          } else {
            // At rest: slide to a stop.
            vy[i] = 0;
            vx[i] = (vx[i] as number) * 0.5;
            vz[i] = (vz[i] as number) * 0.5;
            spin[i] = 0;
          }
        }
      }
      // A particle that left the representable world (NaN / Infinity / absurdly far) is dropped.
      const sum = x + y + z;
      if (!(sum > -1e7 && sum < 1e7)) {
        this.kill(i);
        continue;
      }
      px[i] = x;
      py[i] = y;
      pz[i] = z;
      rot[i] = (rot[i] as number) + (spin[i] as number) * d;
    }
  }

  /**
   * Evaluate the life curves and write one instance per particle into the additive or the alpha buffer
   * (PARTICLE_STRIDE floats each: position + size, axis + rotation, colour + alpha, sprite / mode /
   * emissive / aspect). Sets addCount and alphaCount.
   */
  write(add: Float32Array, alp: Float32Array): void {
    const lut = this.ramps;
    const last = RAMP_SAMPLES - 1;
    let na = 0;
    let nb = 0;
    const maxA = Math.floor(add.length / PARTICLE_STRIDE);
    const maxB = Math.floor(alp.length / PARTICLE_STRIDE);
    for (let i = 0; i < this.count; i++) {
      const f = this.flags[i] as number;
      const additive = (f & PF_ADD) !== 0;
      if (additive ? na >= maxA : nb >= maxB) continue;
      let t = (this.age[i] as number) / (this.life[i] as number);
      if (!(t >= 0)) t = 0;
      else if (t > 1) t = 1;
      const s = t * last;
      let i0 = s | 0;
      let fr = s - i0;
      if (i0 >= last) {
        i0 = last - 1;
        fr = 1;
      }
      const o = ((this.ramp[i] as number) * RAMP_SAMPLES + i0) * RAMP_STRIDE;
      const mix = (lut[o] as number) + ((lut[o + 4] as number) - (lut[o] as number)) * fr;
      const white = (lut[o + 1] as number) + ((lut[o + 5] as number) - (lut[o + 1] as number)) * fr;
      const gain = ((lut[o + 2] as number) + ((lut[o + 6] as number) - (lut[o + 2] as number)) * fr) * (this.gain[i] as number);
      const alpha = ((lut[o + 3] as number) + ((lut[o + 7] as number) - (lut[o + 3] as number)) * fr) * (this.alpha[i] as number);
      let r = (this.ar[i] as number) + ((this.br[i] as number) - (this.ar[i] as number)) * mix;
      let g = (this.ag[i] as number) + ((this.bg[i] as number) - (this.ag[i] as number)) * mix;
      let b = (this.ab[i] as number) + ((this.bb[i] as number) - (this.ab[i] as number)) * mix;
      r = (r + (1 - r) * white) * gain;
      g = (g + (1 - g) * white) * gain;
      b = (b + (1 - b) * white) * gain;
      let e = t;
      const ease = this.ease[i] as number;
      if (ease === 1) e = 1 - (1 - t) * (1 - t);
      else if (ease === 2) {
        const u = 1 - t;
        e = 1 - u * u * u * u;
      } else if (ease === 3) e = t * t;
      const size = (this.size0[i] as number) + ((this.size1[i] as number) - (this.size0[i] as number)) * e;

      const out = additive ? add : alp;
      const p = (additive ? na++ : nb++) * PARTICLE_STRIDE;
      out[p] = this.px[i] as number;
      out[p + 1] = this.py[i] as number;
      out[p + 2] = this.pz[i] as number;
      out[p + 3] = size;
      let mode = 0;
      if ((f & PF_STRETCH) !== 0) {
        // The tail trails behind the head by `stretch` seconds of travel.
        const st = this.stretch[i] as number;
        out[p + 4] = -(this.vx[i] as number) * st;
        out[p + 5] = -(this.vy[i] as number) * st;
        out[p + 6] = -(this.vz[i] as number) * st;
        mode = 1;
      } else if ((f & PF_ALIGNED) !== 0) {
        out[p + 4] = this.ax[i] as number;
        out[p + 5] = this.ay[i] as number;
        out[p + 6] = this.az[i] as number;
        mode = 2;
      } else {
        // Billboards carry the floor they fade toward instead of an axis.
        out[p + 4] = this.floorY[i] as number;
        out[p + 5] = 1;
        out[p + 6] = 0;
      }
      out[p + 7] = this.rot[i] as number;
      out[p + 8] = r;
      out[p + 9] = g;
      out[p + 10] = b;
      out[p + 11] = alpha;
      out[p + 12] = this.sprite[i] as number;
      out[p + 13] = mode;
      out[p + 14] = this.emis[i] as number;
      out[p + 15] = this.aspect[i] as number;
    }
    this.addCount = na;
    this.alphaCount = nb;
  }
}
