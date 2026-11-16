/**
 * The fixed pool of point lights. The lights themselves are created once by the FX system and never
 * added, removed or hidden; an idle light sits at intensity 0.
 */
import { LIGHT_UNIT } from './consts';

/** The part of THREE.PointLight the pool drives (lets the logic run without three.js). */
export interface PoolLight {
  position: { set(x: number, y: number, z: number): unknown };
  color: { setHex(hex: number): unknown };
  intensity: number;
  distance: number;
}

/** Normalised intensities above this are clamped (FxSystem.lightFlash). */
const MAX_NORMALISED = 8;

export class LightPool {
  /** Lights currently lit. */
  lit = 0;
  private readonly peak: Float32Array;
  private readonly seconds: Float32Array;
  private readonly age: Float32Array;
  private readonly key: Int32Array;
  private readonly busy: Uint8Array;

  constructor(
    private readonly lights: readonly PoolLight[],
    private readonly maxKeyed: number,
  ) {
    const n = lights.length;
    this.peak = new Float32Array(n);
    this.seconds = new Float32Array(n);
    this.age = new Float32Array(n);
    this.key = new Int32Array(n);
    this.busy = new Uint8Array(n);
    this.clear();
  }

  /**
   * Flash one light. `intensity` is the normalised scale of the contract; `halve` is the reduce-flashes
   * setting. A non-zero `key` refreshes the slot it already holds; at most `maxKeyed` slots are keyed.
   */
  flash(x: number, y: number, z: number, color: number, intensity: number, radius: number, seconds: number, key: number, halve: boolean): void {
    if (!Number.isFinite(x + y + z) || !(intensity > 0) || !Number.isFinite(intensity)) return;
    const peak = Math.min(intensity, MAX_NORMALISED) * LIGHT_UNIT * (halve ? 0.5 : 1);
    const life = Number.isFinite(seconds) && seconds > 0.016 ? seconds : 0.016;
    const distance = Number.isFinite(radius) && radius > 0.1 ? radius : 0.1;
    const n = this.lights.length;
    let slot = -1;
    if (key !== 0) {
      let keyed = 0;
      for (let i = 0; i < n; i++) {
        if (this.busy[i] === 0 || this.key[i] === 0) continue;
        if (this.key[i] === key) slot = i;
        keyed++;
      }
      if (slot < 0 && keyed >= this.maxKeyed) return;
    }
    if (slot < 0) {
      for (let i = 0; i < n; i++) {
        if (this.busy[i] === 0) {
          slot = i;
          break;
        }
      }
    }
    if (slot < 0) {
      // All busy: steal the weakest flash that is not held by a key.
      let weakest = Infinity;
      for (let i = 0; i < n; i++) {
        if (this.key[i] !== 0) continue;
        const now = (this.lights[i] as PoolLight).intensity;
        if (now < weakest) {
          weakest = now;
          slot = i;
        }
      }
      // A newcomer weaker than everything that is still burning is the one to go without.
      if (slot < 0 || (key === 0 && peak < weakest)) return;
    }
    const light = this.lights[slot] as PoolLight;
    light.position.set(x, y, z);
    light.color.setHex(color & 0xffffff);
    light.distance = distance;
    light.intensity = peak;
    this.peak[slot] = peak;
    this.seconds[slot] = life;
    this.age[slot] = 0;
    this.key[slot] = key;
    this.busy[slot] = 1;
    this.count();
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    for (let i = 0; i < this.lights.length; i++) {
      if (this.busy[i] === 0) continue;
      const age = (this.age[i] as number) + dt;
      const left = 1 - age / (this.seconds[i] as number);
      if (!(left > 0)) {
        this.park(i);
        continue;
      }
      this.age[i] = age;
      (this.lights[i] as PoolLight).intensity = (this.peak[i] as number) * left * left;
    }
    this.count();
  }

  /** Park every light (intensity 0, far below the world). */
  clear(): void {
    for (let i = 0; i < this.lights.length; i++) this.park(i);
    this.lit = 0;
  }

  private park(i: number): void {
    const light = this.lights[i] as PoolLight;
    light.intensity = 0;
    light.position.set(0, -1000, 0);
    this.busy[i] = 0;
    this.key[i] = 0;
    this.peak[i] = 0;
    this.age[i] = 0;
  }

  private count(): void {
    let lit = 0;
    for (let i = 0; i < this.busy.length; i++) lit += this.busy[i] as number;
    this.lit = lit;
  }
}
