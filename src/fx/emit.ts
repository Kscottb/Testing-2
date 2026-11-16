/**
 * The emitter turns layer descriptions into particles. One spawn() of the FX system is: begin() with the
 * caller's options, then the effect recipe calls emit() / one() for each of its layers.
 * Layers are module-level constants (see library.ts); nothing here allocates per spawn.
 */
import * as THREE from 'three';
import type { FxSpawnOptions, Rng, Vec3Like } from '../core/types';
import { MAX_BURST_LIFE, MAX_STREAM_LIFE, PF_ADD, PF_ALIGNED, PF_BOUNCE, PF_PLAYER_CLOCK, PF_STRETCH } from './consts';
import type { ParticleSim } from './sim';

/** Where the particles of a layer are sent. */
export const SHAPE = {
  /** Any direction. */
  SPHERE: 0,
  /** Any direction on the side of the axis. */
  HEMI: 1,
  /** Within `cone` radians of the axis. */
  CONE: 2,
  /** Radially in the plane perpendicular to the axis. */
  DISC: 3,
  /** Exactly along the axis. */
  AXIS: 4,
  /** No motion. */
  NONE: 5,
} as const;

/** Colour sentinels: the effect's accent (overridable by opts.color) and shades of it. */
export const ACCENT = -1;
export const ACCENT_DIM = -2;
export const ACCENT_PALE = -3;
/** The effect's second accent (never overridden). */
export const ACCENT2 = -4;

export interface LayerDef {
  sprite: number;
  /** Second sprite picked at random half of the time. */
  sprite2?: number;
  /** Additive batch (default) or alpha-blended, scene-lit batch. */
  add?: boolean;
  ramp: number;
  count?: number;
  /** Thinned by the quality preset's particleScale. */
  secondary?: boolean;
  /** 0 secondary, 1 normal, 2 critical. Default: 0 when secondary, else 1. */
  prio?: number;
  life?: number;
  lifeVar?: number;
  /** Start size in metres and its relative variation. */
  size?: number;
  sizeVar?: number;
  /** End size as a multiple of the start size. */
  grow?: number;
  ease?: number;
  speed?: number;
  speedVar?: number;
  shape?: number;
  /** Use the spawn's `dir` as the axis instead of its `normal`. */
  alongDir?: boolean;
  cone?: number;
  /** Random start offset inside a sphere of this radius. */
  jitter?: number;
  /** Start offset along the sampled direction (a negative speed then converges on the origin). */
  offset?: number;
  gravity?: number;
  drag?: number;
  /** Random initial rotation / maximum spin in rad/s. */
  rot?: boolean;
  spin?: number;
  /** > 0: velocity-stretched streak covering this many seconds of travel. */
  stretch?: number;
  /** Lie in the plane perpendicular to the axis (ground rings). */
  flat?: boolean;
  /** > 0: bounces on the floor under the spawn point with this restitution. */
  bounce?: number;
  /** Share of opts.velocity the particles inherit. */
  inherit?: number;
  /** Extra velocity along world up (m/s). */
  up?: number;
  /** 0xRRGGBB or one of the ACCENT sentinels. colorB defaults to colorA. */
  colorA?: number;
  colorB?: number;
  /** HDR intensity multiplier and opacity. */
  gain?: number;
  alpha?: number;
  /** The size is in metres whatever the scale of the effect (sparks, shards, casings). */
  abs?: boolean;
  /** Fade toward the floor under the spawn point instead of being cut by it (clouds, glows). */
  soft?: boolean;
  /** Alpha batch: 0 lit by the scene .. 1 self-lit. */
  emis?: number;
  aspect?: number;
}

export interface Layer extends Required<Omit<LayerDef, 'sprite2'>> {
  readonly sprite2: number;
  /** Linear RGB of the fixed colours (unused for sentinels). */
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly cosCone: number;
}

const tmpColor = new THREE.Color();

function linear(hex: number): [number, number, number] {
  if (hex < 0) return [1, 1, 1];
  tmpColor.setHex(hex);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

/** Complete a layer description with the defaults. Call at module load, never per spawn. */
export function layer(def: LayerDef): Layer {
  const secondary = def.secondary ?? false;
  const colorA = def.colorA ?? ACCENT;
  const colorB = def.colorB ?? colorA;
  const cone = def.cone ?? 0.5;
  return Object.freeze({
    sprite: def.sprite,
    sprite2: def.sprite2 ?? def.sprite,
    add: def.add ?? true,
    ramp: def.ramp,
    count: def.count ?? 1,
    secondary,
    prio: def.prio ?? (secondary ? 0 : 1),
    life: def.life ?? 0.3,
    lifeVar: def.lifeVar ?? 0.2,
    size: def.size ?? 0.2,
    sizeVar: def.sizeVar ?? 0.25,
    grow: def.grow ?? 1,
    ease: def.ease ?? 0,
    speed: def.speed ?? 0,
    speedVar: def.speedVar ?? 0.35,
    shape: def.shape ?? SHAPE.SPHERE,
    alongDir: def.alongDir ?? false,
    cone,
    jitter: def.jitter ?? 0,
    offset: def.offset ?? 0,
    gravity: def.gravity ?? 0,
    drag: def.drag ?? 0,
    rot: def.rot ?? false,
    spin: def.spin ?? 0,
    stretch: def.stretch ?? 0,
    flat: def.flat ?? false,
    bounce: def.bounce ?? 0,
    inherit: def.inherit ?? 0,
    up: def.up ?? 0,
    colorA,
    colorB,
    gain: def.gain ?? 1,
    alpha: def.alpha ?? 1,
    emis: def.emis ?? 0,
    aspect: def.aspect ?? 1,
    abs: def.abs ?? false,
    soft: def.soft ?? false,
    a: linear(colorA),
    b: linear(colorB),
    cosCone: Math.cos(cone),
  });
}

function finite(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

export class Emitter {
  /** Origin of the current spawn. */
  x = 0;
  y = 0;
  z = 0;
  /** Unit surface normal and main direction of the current spawn. */
  nx = 0;
  ny = 1;
  nz = 0;
  dx = 0;
  dy = 1;
  dz = 0;
  /** opts.charge (0..1, default 1). */
  charge = 1;
  /** Size factor of the current effect (set by size()). */
  k = 1;
  /** Effective radius in metres of the current effect (set by size()). */
  R = 1;
  /** Quality multiplier on secondary layers. */
  particleScale = 1;
  /** Particles written by the current spawn (debug / tests). */
  emitted = 0;

  private radiusOpt = NaN;
  private scaleOpt = 1;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private tinted = false;
  private readonly accentRgb: [number, number, number] = [1, 1, 1];
  private readonly accent2Rgb: [number, number, number] = [1, 1, 1];
  private playerClock = false;
  private maxLife = MAX_BURST_LIFE;
  private floorKnown = false;
  private floor = -1e9;
  /** The effect sits on the floor: nothing is sent or placed below it. */
  private grounded = false;
  // Tangent frames of the normal (index 0) and the direction (index 1), built on demand.
  private readonly frame = new Float32Array(12);
  private frameN = false;
  private frameD = false;
  private readonly rgb: [number, number, number] = [1, 1, 1];

  constructor(
    private readonly sim: ParticleSim,
    private readonly rng: Rng,
    /** Height of the floor under a point (for bouncing debris); -Infinity when there is none. */
    private readonly floorAt: (x: number, y: number, z: number) => number,
  ) {}

  /** Read the caller's options. Returns false when the position is unusable (the spawn is skipped). */
  begin(position: Vec3Like, opts: FxSpawnOptions | undefined, stream: boolean): boolean {
    const x = position.x;
    const y = position.y;
    const z = position.z;
    if (!(Math.abs(x) < 1e6) || !(Math.abs(y) < 1e6) || !(Math.abs(z) < 1e6)) return false;
    this.x = x;
    this.y = y;
    this.z = z;
    this.nx = 0;
    this.ny = 1;
    this.nz = 0;
    // Normal: given or up. Direction: given or the normal.
    const n = opts?.normal;
    if (n) this.setAxis(0, n.x, n.y, n.z);
    const d = opts?.dir;
    if (!(d && this.setAxis(1, d.x, d.y, d.z))) {
      this.dx = this.nx;
      this.dy = this.ny;
      this.dz = this.nz;
    }
    this.frameN = false;
    this.frameD = false;
    this.radiusOpt = opts?.radius !== undefined && Number.isFinite(opts.radius) && opts.radius > 0 ? Math.min(opts.radius, 200) : NaN;
    const scale = finite(opts?.scale, 1);
    this.scaleOpt = scale > 0 ? Math.min(Math.max(scale, 0.05), 40) : 1;
    const charge = finite(opts?.charge, 1);
    this.charge = charge < 0 ? 0 : charge > 1 ? 1 : charge;
    const v = opts?.velocity;
    if (v && Number.isFinite(v.x + v.y + v.z)) {
      this.vx = v.x;
      this.vy = v.y;
      this.vz = v.z;
    } else {
      this.vx = this.vy = this.vz = 0;
    }
    const color = opts?.color;
    this.tinted = color !== undefined && Number.isFinite(color) && color >= 0;
    if (this.tinted) {
      tmpColor.setHex((color as number) & 0xffffff);
      this.accentRgb[0] = tmpColor.r;
      this.accentRgb[1] = tmpColor.g;
      this.accentRgb[2] = tmpColor.b;
    } else {
      this.accentRgb[0] = this.accentRgb[1] = this.accentRgb[2] = 1;
    }
    this.accent2Rgb[0] = this.accent2Rgb[1] = this.accent2Rgb[2] = 1;
    this.playerClock = opts?.clock === 'player';
    this.maxLife = stream ? MAX_STREAM_LIFE : MAX_BURST_LIFE;
    this.floorKnown = false;
    this.grounded = false;
    this.k = this.scaleOpt;
    this.R = this.scaleOpt;
    this.emitted = 0;
    return true;
  }

  private setAxis(which: number, x: number, y: number, z: number): boolean {
    const len = Math.sqrt(x * x + y * y + z * z);
    if (!(len > 1e-6) || !Number.isFinite(len)) return false;
    const inv = 1 / len;
    if (which === 0) {
      this.nx = x * inv;
      this.ny = y * inv;
      this.nz = z * inv;
    } else {
      this.dx = x * inv;
      this.dy = y * inv;
      this.dz = z * inv;
    }
    return true;
  }

  /**
   * Declare the radius the recipe was authored for; its layers are written in metres for that radius.
   * With opts.radius the effect is scaled to cover exactly that radius (opts.scale is then ignored),
   * otherwise by opts.scale. Returns the effective radius.
   */
  size(authored: number): number {
    this.R = this.radiusOpt === this.radiusOpt ? this.radiusOpt : authored * this.scaleOpt;
    this.k = this.R / authored;
    return this.R;
  }

  /** As size(), for recipes whose layers are written per metre of radius (blasts, rings). */
  unit(authored: number): number {
    this.R = this.radiusOpt === this.radiusOpt ? this.radiusOpt : authored * this.scaleOpt;
    this.k = this.R;
    return this.R;
  }

  private findFloor(): number {
    if (!this.floorKnown) {
      const h = this.floorAt(this.x, this.y + 0.6, this.z);
      this.floor = Number.isFinite(h) ? h : -1e9;
      this.floorKnown = true;
    }
    return this.floor;
  }

  /**
   * Blasts on the ground: when the origin is within `reach` metres of the floor, everything that would
   * go below the floor is mirrored above it (a dome instead of half a buried sphere), and the origin is
   * put on the floor. Returns whether the effect is grounded.
   */
  ground(reach: number): boolean {
    const floor = this.findFloor();
    this.grounded = this.y - floor < reach;
    if (this.grounded && this.y < floor) this.y = floor;
    return this.grounded;
  }

  /** Set the effect's own accent colour (kept when the caller passed opts.color). */
  accent(hex: number): void {
    if (this.tinted) return;
    tmpColor.setHex(hex);
    this.accentRgb[0] = tmpColor.r;
    this.accentRgb[1] = tmpColor.g;
    this.accentRgb[2] = tmpColor.b;
  }

  accent2(hex: number): void {
    tmpColor.setHex(hex);
    this.accent2Rgb[0] = tmpColor.r;
    this.accent2Rgb[1] = tmpColor.g;
    this.accent2Rgb[2] = tmpColor.b;
  }

  /** Move the origin along the surface normal (metres). */
  lift(metres: number): void {
    this.x += this.nx * metres;
    this.y += this.ny * metres;
    this.z += this.nz * metres;
  }

  /** Move the origin along the main direction (metres). */
  advance(metres: number): void {
    this.x += this.dx * metres;
    this.y += this.dy * metres;
    this.z += this.dz * metres;
  }

  /** Reverse the main direction (sparks that spray back toward a shooter). */
  reverse(): void {
    this.dx = -this.dx;
    this.dy = -this.dy;
    this.dz = -this.dz;
    this.frameD = false;
  }

  /** Flip the surface normal. */
  invert(): void {
    this.nx = -this.nx;
    this.ny = -this.ny;
    this.nz = -this.nz;
    this.frameN = false;
  }

  /** Use the reversed main direction as the surface normal (a hit on something facing the shooter). */
  faceShooter(): void {
    this.nx = -this.dx;
    this.ny = -this.dy;
    this.nz = -this.dz;
    this.frameN = false;
  }

  /**
   * Emit a converging layer (negative speed, positive offset) so that its particles start `reach` times
   * the layer's offset away and arrive at the origin exactly at the end of their life.
   */
  inward(L: Layer, countMul: number, reach: number, lifeMul = 1): void {
    const travel = Math.abs(L.speed) * L.life * lifeMul;
    this.emit(L, countMul, reach, travel > 0 ? (L.offset * reach) / travel : 1, lifeMul);
  }

  /** Random number in [0, 1) from the cosmetic stream (recipes that vary their own layout). */
  random(): number {
    return this.rng.next();
  }

  /**
   * Emit a layer. Counts are thinned for secondary layers; sizes and speeds are multiplied by the
   * effect's size factor on top of the given multipliers.
   */
  emit(L: Layer, countMul = 1, sizeMul = 1, speedMul = 1, lifeMul = 1): void {
    let n = L.count * countMul;
    if (L.secondary) n *= this.particleScale;
    if (!(n > 0)) return;
    const whole = Math.floor(n);
    const count = whole + (this.rng.next() < n - whole ? 1 : 0);
    const spread = sizeMul * this.k;
    const size = L.abs ? sizeMul : spread;
    const speed = speedMul * this.k;
    for (let c = 0; c < count; c++) {
      if (!this.put(L, size, spread, speed, lifeMul, NaN, NaN)) return;
    }
  }

  /** Emit exactly one particle of a layer with absolute start / end sizes in metres (flashes, rings). */
  one(L: Layer, size0: number, size1: number, life: number): void {
    this.put(L, 1, this.k, this.k, life / L.life, size0, size1);
  }

  private ensureFrame(dir: boolean): number {
    const o = dir ? 6 : 0;
    if (dir ? this.frameD : this.frameN) return o;
    const ax = dir ? this.dx : this.nx;
    const ay = dir ? this.dy : this.ny;
    const az = dir ? this.dz : this.nz;
    // t = normalize(cross(pick, axis)), b = cross(axis, t).
    let tx: number;
    let ty: number;
    let tz: number;
    if (Math.abs(ay) < 0.99) {
      tx = az;
      ty = 0;
      tz = -ax;
    } else {
      tx = 0;
      ty = -az;
      tz = ay;
    }
    const inv = 1 / Math.sqrt(tx * tx + ty * ty + tz * tz);
    tx *= inv;
    ty *= inv;
    tz *= inv;
    const f = this.frame;
    f[o] = tx;
    f[o + 1] = ty;
    f[o + 2] = tz;
    f[o + 3] = ay * tz - az * ty;
    f[o + 4] = az * tx - ax * tz;
    f[o + 5] = ax * ty - ay * tx;
    if (dir) this.frameD = true;
    else this.frameN = true;
    return o;
  }

  private color(spec: number, fixed: readonly [number, number, number]): void {
    const out = this.rgb;
    if (spec >= 0) {
      out[0] = fixed[0];
      out[1] = fixed[1];
      out[2] = fixed[2];
      return;
    }
    const src = spec === ACCENT2 ? this.accent2Rgb : this.accentRgb;
    if (spec === ACCENT_DIM) {
      out[0] = src[0] * 0.3;
      out[1] = src[1] * 0.3;
      out[2] = src[2] * 0.3;
    } else if (spec === ACCENT_PALE) {
      // A hotter shade of the same hue (a plain mix with white would turn orange-red into pink).
      out[0] = Math.pow(src[0], 0.45);
      out[1] = Math.pow(src[1], 0.45);
      out[2] = Math.pow(src[2], 0.45);
    } else {
      out[0] = src[0];
      out[1] = src[1];
      out[2] = src[2];
    }
  }

  private put(L: Layer, sizeMul: number, spread: number, speedMul: number, lifeMul: number, size0: number, size1: number): boolean {
    const sim = this.sim;
    const i = sim.alloc(L.prio);
    if (i < 0) return false;
    const rng = this.rng;
    const dir = L.alongDir;
    const ax = dir ? this.dx : this.nx;
    const ay = dir ? this.dy : this.ny;
    const az = dir ? this.dz : this.nz;

    // Sample the direction.
    let ux = ax;
    let uy = ay;
    let uz = az;
    const shape = L.shape;
    if (shape === SHAPE.SPHERE || shape === SHAPE.HEMI) {
      const cz = rng.next() * 2 - 1;
      const phi = rng.next() * 6.283185307;
      const s = Math.sqrt(1 - cz * cz);
      ux = s * Math.cos(phi);
      uy = cz;
      uz = s * Math.sin(phi);
      if (shape === SHAPE.HEMI && ux * ax + uy * ay + uz * az < 0) {
        ux = -ux;
        uy = -uy;
        uz = -uz;
      }
    } else if (shape === SHAPE.CONE || shape === SHAPE.DISC) {
      const o = this.ensureFrame(dir);
      const f = this.frame;
      const phi = rng.next() * 6.283185307;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const rx = (f[o] as number) * cp + (f[o + 3] as number) * sp;
      const ry = (f[o + 1] as number) * cp + (f[o + 4] as number) * sp;
      const rz = (f[o + 2] as number) * cp + (f[o + 5] as number) * sp;
      if (shape === SHAPE.DISC) {
        ux = rx;
        uy = ry;
        uz = rz;
      } else {
        const ct = 1 - rng.next() * (1 - L.cosCone);
        const st = Math.sqrt(Math.max(0, 1 - ct * ct));
        ux = ax * ct + rx * st;
        uy = ay * ct + ry * st;
        uz = az * ct + rz * st;
      }
    }

    // On the ground nothing flies into the floor.
    if (this.grounded && uy < 0 && L.speed >= 0) uy = -uy;
    const speed = shape === SHAPE.NONE ? 0 : L.speed * (1 + (rng.next() * 2 - 1) * L.speedVar) * speedMul;
    let x = this.x + ux * L.offset * spread;
    let y = this.y + uy * L.offset * spread;
    let z = this.z + uz * L.offset * spread;
    if (L.jitter > 0) {
      const cz = rng.next() * 2 - 1;
      const phi = rng.next() * 6.283185307;
      const s = Math.sqrt(1 - cz * cz);
      const r = Math.cbrt(rng.next()) * L.jitter * spread;
      x += s * Math.cos(phi) * r;
      y += (this.grounded && cz < 0 ? -cz : cz) * r;
      z += s * Math.sin(phi) * r;
    }
    sim.px[i] = x;
    sim.py[i] = y;
    sim.pz[i] = z;
    sim.vx[i] = ux * speed + this.vx * L.inherit;
    sim.vy[i] = uy * speed + this.vy * L.inherit + L.up * speedMul;
    sim.vz[i] = uz * speed + this.vz * L.inherit;

    let life = L.life * (1 + (rng.next() * 2 - 1) * L.lifeVar) * lifeMul;
    if (life > this.maxLife) life = this.maxLife;
    if (!(life > 0.016)) life = 0.016;
    sim.life[i] = life;

    let s0: number;
    let s1: number;
    if (size0 === size0) {
      s0 = size0;
      s1 = size1;
    } else {
      s0 = L.size * (1 + (rng.next() * 2 - 1) * L.sizeVar) * sizeMul;
      s1 = s0 * L.grow;
    }
    sim.size0[i] = s0;
    sim.size1[i] = s1;
    sim.ease[i] = L.ease;
    if (L.rot) sim.rot[i] = rng.next() * 6.283185307;
    if (L.spin !== 0) sim.spin[i] = (rng.next() * 2 - 1) * L.spin;
    sim.drag[i] = L.drag;
    sim.grav[i] = L.gravity;

    this.color(L.colorA, L.a);
    sim.ar[i] = this.rgb[0];
    sim.ag[i] = this.rgb[1];
    sim.ab[i] = this.rgb[2];
    this.color(L.colorB, L.b);
    sim.br[i] = this.rgb[0];
    sim.bg[i] = this.rgb[1];
    sim.bb[i] = this.rgb[2];
    sim.gain[i] = L.gain;
    sim.alpha[i] = L.alpha;
    sim.emis[i] = L.emis;
    sim.aspect[i] = L.aspect;
    sim.ramp[i] = L.ramp;
    sim.sprite[i] = L.sprite2 !== L.sprite && rng.next() < 0.5 ? L.sprite2 : L.sprite;

    let flags = L.add ? PF_ADD : 0;
    if (this.playerClock) flags |= PF_PLAYER_CLOCK;
    if (L.stretch > 0) {
      flags |= PF_STRETCH;
      sim.stretch[i] = L.stretch;
    } else if (L.flat) {
      flags |= PF_ALIGNED;
      sim.ax[i] = ax;
      sim.ay[i] = ay;
      sim.az[i] = az;
    }
    if (L.bounce > 0) {
      flags |= PF_BOUNCE;
      sim.floorY[i] = this.findFloor() + s0 * 0.3;
      sim.bounce[i] = L.bounce;
    } else if (L.soft) {
      sim.floorY[i] = this.findFloor();
    }
    sim.flags[i] = flags;
    this.emitted++;
    return true;
  }
}
