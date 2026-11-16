/**
 * Ambient weather near the camera — drifting motes, streaking static rain, the near streaks of the
 * eclipse vortex, cloud wisps crossing the deck — and the ambient storm: FX weather schedules every
 * strike, draws its distant bolt, calls render for the sky flash and audio for thunder, crackle and
 * gusts. Everything is placed in volumes that wrap around the camera inside the vertex shader.
 */
import * as THREE from 'three';
import { RENDER_ORDER } from '../core/constants';
import { makeSoundOptions } from '../core/make';
import type { GameContext, LightingState, Rng, WeatherId } from '../core/types';
import { TIME_OF_DAY } from '../data/timeOfDay';
import { SPR } from './consts';
import { fxMaterial } from './gpu';
import type { SharedUniforms } from './gpu';
import { WEATHER_FRAGMENT, WEATHER_VERTEX } from './shaders';

/** Instances per layer at full density on the ultra preset. */
const MOTES = 900;
const STREAKS = 820;
const WISPS = 26;
/** QualityParams.weatherScale of the densest preset: densities are relative to it. */
const FULL_WEATHER_SCALE = 1.3;
/** Seconds of the cross-fade between two weathers. */
const BLEND_SECONDS = 2.5;
const SPEED_OF_SOUND = 343;

/** Fields of a weather look (one float each, blended linearly between weathers). */
const F = {
  MOTE_DENSITY: 0,
  MOTE_SIZE: 1,
  MOTE_GAIN: 2,
  MOTE_TWINKLE: 3,
  /** 0 = fixed tint .. 1 = the colour of the sun. */
  MOTE_SUN: 4,
  MOTE_R: 5,
  MOTE_G: 6,
  MOTE_B: 7,
  STREAK_DENSITY: 8,
  STREAK_WIDTH: 9,
  STREAK_GAIN: 10,
  STREAK_FLICKER: 11,
  STREAK_SUN: 12,
  STREAK_R: 13,
  STREAK_G: 14,
  STREAK_B: 15,
  WISP_DENSITY: 16,
  WISP_ALPHA: 17,
  WISP_SIZE: 18,
  WISP_SPEED: 19,
  WIND_X: 20,
  WIND_Y: 21,
  WIND_Z: 22,
  FALL_X: 23,
  FALL_Y: 24,
  FALL_Z: 25,
  /** Tangential streak speed around the boss arena (the vortex). */
  SWIRL: 26,
  /** Seconds of motion a streak covers. */
  SHUTTER: 27,
  COUNT: 28,
} as const;

const tmp = new THREE.Color();

function look(values: Partial<Record<keyof typeof F, number>>, moteTint = 0xffffff, streakTint = 0xffffff): Float32Array {
  const out = new Float32Array(F.COUNT);
  out[F.MOTE_SIZE] = 0.03;
  out[F.MOTE_TWINKLE] = 2;
  out[F.STREAK_WIDTH] = 0.012;
  out[F.STREAK_FLICKER] = 12;
  out[F.WISP_SIZE] = 9;
  out[F.WISP_SPEED] = 2;
  out[F.SHUTTER] = 0.035;
  for (const key of Object.keys(values) as (keyof typeof F)[]) out[F[key]] = values[key] as number;
  tmp.setHex(moteTint);
  out[F.MOTE_R] = tmp.r;
  out[F.MOTE_G] = tmp.g;
  out[F.MOTE_B] = tmp.b;
  tmp.setHex(streakTint);
  out[F.STREAK_R] = tmp.r;
  out[F.STREAK_G] = tmp.g;
  out[F.STREAK_B] = tmp.b;
  return out;
}

/**
 * The looks. None of them uses an accent colour of the colour script directly: embers are the warm key
 * light, static rain is a pale steel white, and the vortex streaks take the colour of the eclipse sun.
 */
const LOOKS: Record<WeatherId, Float32Array> = {
  clear: look({}),
  embers: look(
    { MOTE_DENSITY: 0.6, MOTE_SIZE: 0.042, MOTE_GAIN: 3.6, MOTE_TWINKLE: 2.4, MOTE_SUN: 0.45, WIND_X: 0.9, WIND_Y: 0.35, WIND_Z: 0.4 },
    0xffa868,
  ),
  haze: look(
    {
      MOTE_DENSITY: 0.6, MOTE_SIZE: 0.036, MOTE_GAIN: 2, MOTE_TWINKLE: 1.2, MOTE_SUN: 0.6,
      WISP_DENSITY: 0.6, WISP_ALPHA: 0.11, WISP_SIZE: 10, WISP_SPEED: 1.6,
      WIND_X: 1.4, WIND_Y: 0.05, WIND_Z: 0.6,
    },
    0xb9a8e0,
  ),
  staticRain: look(
    {
      MOTE_DENSITY: 0.36, MOTE_SIZE: 0.024, MOTE_GAIN: 2.4, MOTE_TWINKLE: 14, MOTE_SUN: 0.1,
      STREAK_DENSITY: 1, STREAK_WIDTH: 0.011, STREAK_GAIN: 0.85, STREAK_FLICKER: 16, STREAK_SUN: 0.15,
      WISP_DENSITY: 0.55, WISP_ALPHA: 0.14, WISP_SIZE: 11, WISP_SPEED: 5,
      WIND_X: 3.5, WIND_Y: -0.6, WIND_Z: 1.5,
      FALL_X: 7, FALL_Y: -27, FALL_Z: 3, SHUTTER: 0.036,
    },
    0xd6e2f2,
    0xc4d6ea,
  ),
  vortex: look(
    {
      MOTE_DENSITY: 0.5, MOTE_SIZE: 0.032, MOTE_GAIN: 2.6, MOTE_TWINKLE: 5, MOTE_SUN: 0.85,
      STREAK_DENSITY: 0.62, STREAK_WIDTH: 0.013, STREAK_GAIN: 1.25, STREAK_FLICKER: 9, STREAK_SUN: 0.8,
      WISP_DENSITY: 0.38, WISP_ALPHA: 0.12, WISP_SIZE: 12, WISP_SPEED: 6,
      WIND_X: 0.4, WIND_Y: 1.8, WIND_Z: 0.2,
      FALL_X: 0, FALL_Y: 5.5, FALL_Z: 0, SWIRL: 15, SHUTTER: 0.06,
    },
    0xff9db4,
    0xff8fa8,
  ),
};

const WEATHER_IDS = Object.keys(LOOKS) as WeatherId[];

/** Is `id` one of the weathers this system knows? */
export function isWeatherId(id: unknown): id is WeatherId {
  return typeof id === 'string' && (WEATHER_IDS as string[]).includes(id);
}

/**
 * Scheduler of the ambient storm. Each event has a phase that fills at its current rate and fires when
 * it crosses a randomised threshold, so rates may change (or drop to zero) at any time.
 */
export class StormClock {
  static readonly STRIKE = 1;
  static readonly CRACKLE = 2;
  static readonly GUST = 4;
  private readonly phase = [0, 0, 0];
  private readonly threshold = [1, 1, 1];

  /** Restart every countdown (also re-rolls the first intervals). */
  reset(rng: Rng): void {
    for (let i = 0; i < 3; i++) {
      this.phase[i] = 0;
      this.threshold[i] = rng.range(0.4, 1.6);
    }
  }

  /** Advance by dt with the given events per minute; returns the STRIKE | CRACKLE | GUST bits now due. */
  step(dt: number, strikesPerMinute: number, cracklesPerMinute: number, gustsPerMinute: number, rng: Rng): number {
    if (!(dt > 0)) return 0;
    let due = 0;
    for (let i = 0; i < 3; i++) {
      const rate = i === 0 ? strikesPerMinute : i === 1 ? cracklesPerMinute : gustsPerMinute;
      if (!(rate > 0)) continue;
      const phase = (this.phase[i] as number) + (dt * rate) / 60;
      if (phase >= (this.threshold[i] as number)) {
        this.phase[i] = 0;
        this.threshold[i] = rng.range(0.4, 1.6);
        due |= 1 << i;
      } else {
        this.phase[i] = phase;
      }
    }
    return due;
  }
}

const from = new THREE.Vector3();
const to = new THREE.Vector3();
const toward = new THREE.Vector3();

export class Weather {
  id: WeatherId = 'clear';
  /** True once setWeather was called from outside since the last reset (enables the storm in test mode). */
  external = false;
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly current = new Float32Array(F.COUNT);
  private target: Float32Array = LOOKS.clear;
  private intensity = 1;
  private quality = 1;
  private time = 0;
  private gust = 0;
  private readonly swirl = new THREE.Vector3();
  private readonly storm = new StormClock();
  private readonly sound = makeSoundOptions();
  private readonly uVol = [new THREE.Vector3(20, 12, 20), new THREE.Vector3(30, 22, 30), new THREE.Vector3(150, 28, 150)];
  private readonly uOff = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly uCol = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  private readonly uShape = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  private readonly uStretch = new THREE.Vector3();
  private readonly uWeatherTime = { value: 0 };

  constructor(
    private readonly ctx: GameContext,
    atlas: THREE.Texture,
    shared: SharedUniforms,
    quad: { position: THREE.BufferAttribute; index: THREE.BufferAttribute },
    /** Draw the distant bolt of a storm strike. */
    private readonly bolt: (from: THREE.Vector3, to: THREE.Vector3, width: number, branches: number, seconds: number) => void,
  ) {
    const rng = ctx.cosmeticRng;
    const total = MOTES + STREAKS + WISPS;
    const seed = new Float32Array(total * 3);
    const rand = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
      seed[i * 3] = rng.next();
      seed[i * 3 + 1] = rng.next();
      seed[i * 3 + 2] = rng.next();
      rand[i * 4] = rng.next();
      rand[i * 4 + 1] = rng.next();
      rand[i * 4 + 2] = rng.next();
      rand[i * 4 + 3] = i < MOTES ? 0 : i < MOTES + STREAKS ? 1 : 2;
    }
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', quad.position);
    this.geometry.setIndex(quad.index);
    this.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
    this.geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
    this.geometry.instanceCount = 0;
    this.material = fxMaterial({
      name: 'fx-weather',
      vertex: WEATHER_VERTEX,
      fragment: WEATHER_FRAGMENT,
      blend: 'over',
      uniforms: {
        uAtlas: { value: atlas },
        uVol: { value: this.uVol },
        uOff: { value: this.uOff },
        uCol: { value: this.uCol },
        uShape: { value: this.uShape },
        uStretch: { value: this.uStretch },
        uWeatherTime: this.uWeatherTime,
        uViewport: shared.uViewport,
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'fx-weather';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.WEATHER;
    this.storm.reset(rng);
  }

  /** Is anything of the weather drawn right now? */
  get visible(): boolean {
    return this.geometry.instanceCount > 0;
  }

  /** Switch the weather; the look cross-fades. */
  set(id: WeatherId, intensity: number): void {
    this.id = id;
    this.target = LOOKS[id];
    this.intensity = Number.isFinite(intensity) ? Math.min(Math.max(intensity, 0), 2) : 1;
  }

  /** Jump to the target look (reset, init). */
  snap(): void {
    this.current.set(this.target);
    this.applyDensity();
  }

  /** Restart the storm clock and forget an external override (reset). */
  resetStorm(): void {
    this.external = false;
    this.gust = 0;
    this.storm.reset(this.ctx.cosmeticRng);
  }

  setQuality(weatherScale: number): void {
    const scale = Number.isFinite(weatherScale) ? weatherScale : 1;
    this.quality = Math.min(Math.max(scale / FULL_WEATHER_SCALE, 0), 1);
    this.applyDensity();
  }

  private applyDensity(): void {
    const c = this.current;
    const k = this.intensity * this.quality;
    const motes = (c[F.MOTE_DENSITY] as number) * k;
    const streaks = (c[F.STREAK_DENSITY] as number) * k;
    const wisps = (c[F.WISP_DENSITY] as number) * Math.min(1, this.intensity) * (0.5 + 0.5 * this.quality);
    (this.uShape[0] as THREE.Vector4).z = motes;
    (this.uShape[1] as THREE.Vector4).z = streaks;
    (this.uShape[2] as THREE.Vector4).z = wisps;
    this.geometry.instanceCount = motes + streaks + wisps > 0.003 ? MOTES + STREAKS + WISPS : 0;
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;
    const c = this.current;
    const t = this.target;
    if (step > 0) {
      const blend = 1 - Math.exp(-step * (3 / BLEND_SECONDS));
      for (let i = 0; i < F.COUNT; i++) c[i] = (c[i] as number) + ((t[i] as number) - (c[i] as number)) * blend;
      this.time = (this.time + step) % 512;
      this.gust = Math.max(0, this.gust - step / 2.5);
    }
    this.uWeatherTime.value = this.time;
    this.applyDensity();
    const lighting: LightingState = ctx.render.lighting;
    const flash = lighting.flash > 0 ? Math.min(lighting.flash, 1) : 0;
    const sun = lighting.sunColor;
    const fog = lighting.fogColor;

    // Motes.
    const moteSun = c[F.MOTE_SUN] as number;
    const moteGain = (c[F.MOTE_GAIN] as number) * (1 + 1.5 * flash);
    (this.uCol[0] as THREE.Vector4).set(
      ((c[F.MOTE_R] as number) + (sun.r - (c[F.MOTE_R] as number)) * moteSun) * moteGain,
      ((c[F.MOTE_G] as number) + (sun.g - (c[F.MOTE_G] as number)) * moteSun) * moteGain,
      ((c[F.MOTE_B] as number) + (sun.b - (c[F.MOTE_B] as number)) * moteSun) * moteGain,
      0,
    );
    const moteShape = this.uShape[0] as THREE.Vector4;
    moteShape.x = c[F.MOTE_SIZE] as number;
    moteShape.y = SPR.GLOW;
    moteShape.w = c[F.MOTE_TWINKLE] as number;
    const windBoost = 1 + 2.2 * this.gust;
    this.drift(0, (c[F.WIND_X] as number) * windBoost, c[F.WIND_Y] as number, (c[F.WIND_Z] as number) * windBoost, step);

    // Streaks: the fall of the static rain plus, in the vortex, a swirl around the boss arena.
    let vx = c[F.FALL_X] as number;
    const vy = c[F.FALL_Y] as number;
    let vz = c[F.FALL_Z] as number;
    const swirlSpeed = c[F.SWIRL] as number;
    if (swirlSpeed > 0.01) {
      const centre = ctx.world.bossArena.center;
      const p = ctx.player.position;
      let rx = p.x - centre.x;
      let rz = p.z - centre.z;
      const len = Math.sqrt(rx * rx + rz * rz);
      if (len > 1 && Number.isFinite(len)) {
        rx /= len;
        rz /= len;
      } else {
        rx = 1;
        rz = 0;
      }
      // Tangent of the circle around the arena, eased so it never snaps when the player crosses the centre.
      const ease = step > 0 ? 1 - Math.exp(-step * 2) : 1;
      this.swirl.x += (-rz * swirlSpeed - this.swirl.x) * ease;
      this.swirl.z += (rx * swirlSpeed - this.swirl.z) * ease;
      vx += this.swirl.x;
      vz += this.swirl.z;
    } else {
      this.swirl.set(0, 0, 0);
    }
    const streakSun = c[F.STREAK_SUN] as number;
    const streakGain = (c[F.STREAK_GAIN] as number) * (1 + 2.5 * flash);
    (this.uCol[1] as THREE.Vector4).set(
      ((c[F.STREAK_R] as number) + (sun.r - (c[F.STREAK_R] as number)) * streakSun) * streakGain,
      ((c[F.STREAK_G] as number) + (sun.g - (c[F.STREAK_G] as number)) * streakSun) * streakGain,
      ((c[F.STREAK_B] as number) + (sun.b - (c[F.STREAK_B] as number)) * streakSun) * streakGain,
      0,
    );
    const streakShape = this.uShape[1] as THREE.Vector4;
    streakShape.x = c[F.STREAK_WIDTH] as number;
    streakShape.y = SPR.SPARK;
    streakShape.w = c[F.STREAK_FLICKER] as number;
    const shutter = c[F.SHUTTER] as number;
    // The streak's tail trails behind its head.
    this.uStretch.set(-vx * shutter, -vy * shutter, -vz * shutter);
    this.drift(1, vx, vy, vz, step);

    // Wisps: fog banks lit by the scene.
    const light = 0.8 + 0.14 * lighting.sunIntensity + 2 * flash;
    (this.uCol[2] as THREE.Vector4).set(
      (fog.r * 0.85 + sun.r * 0.1) * light,
      (fog.g * 0.85 + sun.g * 0.1) * light,
      (fog.b * 0.85 + sun.b * 0.1) * light,
      c[F.WISP_ALPHA] as number,
    );
    const wispShape = this.uShape[2] as THREE.Vector4;
    wispShape.x = c[F.WISP_SIZE] as number;
    wispShape.y = SPR.WISP;
    const wispSpeed = (c[F.WISP_SPEED] as number) * windBoost;
    this.drift(2, wispSpeed, 0.05 * wispSpeed, wispSpeed * 0.45, step);

    this.updateStorm(step, lighting);
  }

  /** Move the anchor of one layer; the offset stays inside its volume so it never loses precision. */
  private drift(layer: number, vx: number, vy: number, vz: number, dt: number): void {
    const off = this.uOff[layer] as THREE.Vector3;
    const vol = this.uVol[layer] as THREE.Vector3;
    off.x = (off.x + vx * dt) % vol.x;
    off.y = (off.y + vy * dt) % vol.y;
    off.z = (off.z + vz * dt) % vol.z;
  }

  private updateStorm(dt: number, lighting: LightingState): void {
    const ctx = this.ctx;
    // Automation sees no ambient strikes unless a tool asked for weather explicitly.
    if (ctx.testMode && !this.external) return;
    const def = TIME_OF_DAY[ctx.render.timeOfDay];
    const storm = Number.isFinite(lighting.storm) ? Math.min(Math.max(lighting.storm, 0), 1) : 0;
    const strikes = def.lightningPerMinute * storm;
    const stormy = this.id === 'staticRain' || this.id === 'vortex';
    const crackles = stormy ? 4 + 8 * storm : 0;
    const gusts = this.id === 'clear' ? 0 : 1.5 + 3.5 * storm;
    const rng = ctx.cosmeticRng;
    const due = this.storm.step(dt, strikes, crackles, gusts, rng);
    if (due === 0) return;
    const sound = this.sound;
    sound.priority = 0;
    if ((due & StormClock.STRIKE) !== 0) this.strike();
    if ((due & StormClock.CRACKLE) !== 0) {
      sound.delay = 0;
      sound.volume = rng.range(0.35, 0.8);
      sound.pitch = rng.range(0.85, 1.2);
      ctx.audio.play('staticCrackle', sound);
    }
    if ((due & StormClock.GUST) !== 0) {
      sound.delay = 0;
      sound.volume = rng.range(0.45, 0.9) * (0.6 + 0.4 * storm);
      sound.pitch = rng.range(0.85, 1.15);
      ctx.audio.play('windGust', sound);
      this.gust = 1;
    }
  }

  /** One strike of the ambient storm: distant bolt, sky flash, thunder after its travel time. */
  private strike(): void {
    const ctx = this.ctx;
    const rng = ctx.cosmeticRng;
    const bounds = ctx.world.bounds;
    const cx = (bounds.minX + bounds.maxX) * 0.5;
    const cz = (bounds.minZ + bounds.maxZ) * 0.5;
    // Always outside the rig: 150 - 400 m out, and never closer than the corner of the map.
    const rim = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.5 + 45;
    const range = Math.max(rng.range(150, 400), Number.isFinite(rim) ? rim : 150);
    const angle = rng.next() * Math.PI * 2;
    const x = cx + Math.cos(angle) * range;
    const z = cz + Math.sin(angle) * range;
    // Distance to whoever hears it: the player while a run is on, else the middle of the rig.
    const mode = ctx.game.mode;
    const listener = mode === 'playing' || mode === 'paused' ? ctx.player.position : null;
    const distance = listener ? Math.hypot(x - listener.x, z - listener.z) : range;
    const near = Math.min(Math.max((400 - distance) / 250, 0), 1);

    if (rng.chance(0.78)) {
      const top = rng.range(190, 280);
      from.set(x + rng.range(-40, 40), top, z + rng.range(-40, 40));
      to.set(x, rng.range(-90, -30), z);
      this.bolt(from, to, range * 0.011, rng.int(3, 6), rng.range(0.28, 0.46));
    }
    toward.set(x - cx, 70, z - cz).normalize();
    ctx.render.lightningFlash((0.4 + 0.55 * near) * rng.range(0.8, 1), toward);

    const sound = this.sound;
    sound.delay = distance / SPEED_OF_SOUND;
    sound.pitch = rng.range(0.9, 1.1);
    sound.volume = 0.55 + 0.45 * near;
    sound.priority = 1;
    ctx.audio.play(distance < 200 ? 'thunderNear' : 'thunderFar', sound);
    if (distance < 240) {
      sound.volume = 0.4 + 0.5 * near;
      ctx.audio.play('lightningCrack', sound);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
