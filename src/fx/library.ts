/**
 * The effect library: one layered particle recipe per FxId (the Record is exhaustive, so the compiler
 * forces every id to exist). A recipe only emits particles — never a decal, a pooled light or a bolt:
 * the owner of the moment calls those itself.
 *
 * Colour script: enemy fire orange-red, elite / boss magenta, player tech cyan, lightning white-violet,
 * danger hazard yellow. Everything else (hot metal, flame, smoke, dust, brass, glass, health green,
 * Overclock gold) uses neutral or vitals colours so the five accents keep their meaning.
 */
import { PALETTE } from '../core/palette';
import type { EnemyType, FxId, TrailKind } from '../core/types';
import { ENEMIES } from '../data/enemies';
import { HALO_EDGE, RING_EDGE, SPR } from './consts';
import { ACCENT, ACCENT2, ACCENT_PALE, SHAPE, layer } from './emit';
import type { Emitter, Layer, LayerDef } from './emit';
import { RAMP } from './ramps';

export type Recipe = (e: Emitter) => void;

/** Neutral colours of matter and heat. */
const C = {
  white: 0xffffff,
  hot: 0xffd684,
  spark: 0xffa94d,
  sparkDim: 0xb8431a,
  fireA: 0xff9c34,
  fireB: 0xa62a08,
  smokeWarm: 0x5a4030,
  smoke: 0x34312e,
  smokeGrey: 0x77726b,
  dust: 0xa39a8a,
  dustDark: 0x6b655b,
  steam: 0xe4eaee,
  metal: 0x3a4048,
  metalDark: 0x14171b,
  metalHot: 0xff8a3c,
  chip: 0xd8d6cf,
  glass: 0xcfe9f2,
  brass: 0xd9ac55,
  brassDark: 0x6e5424,
  shell: 0xb9b2a4,
} as const;

// ---------------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------------

/** Derive a layer from a base description. */
const vary = (base: LayerDef, changes: Partial<LayerDef>): Layer => layer({ ...base, ...changes });

// --- light -------------------------------------------------------------------------------------------
const flashDef: LayerDef = { sprite: SPR.GLOW, ramp: RAMP.FLASH, prio: 2, lifeVar: 0, sizeVar: 0, colorA: ACCENT, gain: 4.5, soft: true };
/** Core flashes (always emitted with one(): absolute size). */
const FLASH = layer(flashDef);
const FLASH_WHITE = vary(flashDef, { colorA: C.white, gain: 5 });
const FLASH_WARM = vary(flashDef, { colorA: C.fireA, gain: 5 });
/** Dimmer flash that leaves room for a shaped muzzle flash on top; muzzle flashes travel with the gun. */
const FLASH_SOFT = vary(flashDef, { gain: 2, inherit: 1 });
const GLOW = vary(flashDef, { ramp: RAMP.PULSE, prio: 1, gain: 2.2 });
const GLOW_HOLD = vary(flashDef, { ramp: RAMP.HOLD, prio: 1, gain: 2 });
const STAR = vary(flashDef, { sprite: SPR.FLARE, colorA: ACCENT_PALE, rot: true, gain: 4, soft: false });
const PETALS = vary(flashDef, { sprite: SPR.BURST, colorA: ACCENT_PALE, rot: true, gain: 6, soft: false, inherit: 1 });

const ringDef: LayerDef = { sprite: SPR.RING, ramp: RAMP.RING, prio: 2, ease: 2, lifeVar: 0, sizeVar: 0, colorA: ACCENT, gain: 1.5 };
/** Shock rings: flat on the surface, across the direction, or facing the camera. */
const RING_N = vary(ringDef, { flat: true });
const RING_D = vary(ringDef, { flat: true, alongDir: true });
const RING_B = layer(ringDef);
const RING_N_WHITE = vary(ringDef, { flat: true, colorA: C.white, gain: 0.9 });
const RING_B_WHITE = vary(ringDef, { colorA: C.white, gain: 0.9 });
const haloDef: LayerDef = { sprite: SPR.HALO, ramp: RAMP.PULSE, prio: 1, ease: 1, lifeVar: 0, sizeVar: 0, colorA: ACCENT, gain: 2.4 };
const HALO_N = vary(haloDef, { flat: true });
const HALO_B = layer(haloDef);
/** Rings that close in instead of opening (gathering energy). */
const RING_IN_N = vary(ringDef, { flat: true, ramp: RAMP.GATHER, ease: 3, prio: 1, gain: 3 });
const RING_IN_B = vary(ringDef, { ramp: RAMP.GATHER, ease: 3, prio: 1, gain: 3 });

const sparkDef: LayerDef = {
  sprite: SPR.SPARK, ramp: RAMP.SPARK, secondary: true, abs: true, size: 0.055, sizeVar: 0.35, stretch: 0.05,
  speed: 8, speedVar: 0.6, gravity: 12, drag: 1.4, life: 0.38, lifeVar: 0.45, shape: SHAPE.HEMI,
  colorA: C.hot, colorB: C.sparkDim, gain: 5, inherit: 0.5,
};
/** Hot metal sparks (neutral). */
const SPARK_HEMI = layer(sparkDef);
const SPARK_SPHERE = vary(sparkDef, { shape: SHAPE.SPHERE });
const SPARK_CONE = vary(sparkDef, { shape: SHAPE.CONE, alongDir: true, cone: 0.42 });
const SPARK_WIDE = vary(sparkDef, { shape: SHAPE.CONE, alongDir: true, cone: 1.05 });
const SPARK_DISC = vary(sparkDef, { shape: SHAPE.DISC, up: 2.5 });
const SPARK_UP = vary(sparkDef, { shape: SHAPE.CONE, cone: 0.55 });
/** Sparks in the accent colour (energy weapons, electricity). */
const accentSpark: LayerDef = { ...sparkDef, colorA: ACCENT_PALE, colorB: ACCENT };
const ASPARK_HEMI = layer(accentSpark);
const ASPARK_SPHERE = vary(accentSpark, { shape: SHAPE.SPHERE });
const ASPARK_DISC = vary(accentSpark, { shape: SHAPE.DISC, up: 2 });

const streakDef: LayerDef = {
  sprite: SPR.SPARK, ramp: RAMP.FLASH, abs: true, size: 0.035, sizeVar: 0.3, stretch: 0.055, speed: 20, speedVar: 0.45,
  drag: 3.5, life: 0.17, lifeVar: 0.35, colorA: ACCENT_PALE, colorB: ACCENT, gain: 4, secondary: true, inherit: 0.5,
};
/** Weightless energy streaks. */
const STREAK_SPHERE = layer(streakDef);
const STREAK_CONE = vary(streakDef, { shape: SHAPE.CONE, alongDir: true, cone: 0.3 });
const STREAK_WIDE = vary(streakDef, { shape: SHAPE.CONE, alongDir: true, cone: 0.9 });
const STREAK_DISC = vary(streakDef, { shape: SHAPE.DISC });
const STREAK_DISC_D = vary(streakDef, { shape: SHAPE.DISC, alongDir: true });
/** Rising column of streaks (unlocks, respawn): spawned around the origin, going up the normal. */
const STREAK_RISE = vary(streakDef, { shape: SHAPE.CONE, cone: 0.07, jitter: 0.5, drag: 1.2, life: 0.5, stretch: 0.07 });
/** Streaks that fly inward to the origin. */
const STREAK_IN = vary(streakDef, { ramp: RAMP.GATHER, offset: 1, speed: -5.5, speedVar: 0.2, drag: 0, life: 0.18, lifeVar: 0.1, stretch: 0.04 });

const emberDef: LayerDef = {
  sprite: SPR.DOT, ramp: RAMP.EMBER, secondary: true, abs: true, size: 0.045, sizeVar: 0.4, speed: 2.2, speedVar: 0.6,
  gravity: 2.5, drag: 1.4, life: 1.1, lifeVar: 0.4, shape: SHAPE.HEMI, colorA: C.spark, colorB: C.sparkDim, gain: 4,
};
const EMBER_SPHERE = vary(emberDef, { shape: SHAPE.SPHERE });
/** Floating accent motes. */
const MOTE = vary(emberDef, { colorA: ACCENT_PALE, colorB: ACCENT, gravity: -0.8, shape: SHAPE.SPHERE, speed: 1.4, gain: 3.5 });
const MOTE_RISE = vary(emberDef, { colorA: ACCENT_PALE, colorB: ACCENT, gravity: -1.5, shape: SHAPE.CONE, cone: 0.5, jitter: 0.4, speed: 1.6, gain: 3.5 });
/** Motes that gather on the origin (charge-ups). */
const MOTE_IN = vary(emberDef, {
  ramp: RAMP.GATHER, colorA: ACCENT_PALE, colorB: ACCENT_PALE, shape: SHAPE.SPHERE, offset: 0.7, speed: -3.6, speedVar: 0.15,
  gravity: 0, drag: 0, life: 0.19, lifeVar: 0.1, size: 0.05, stretch: 0.03, gain: 4,
});

const ZAP = layer({ sprite: SPR.ZAP, ramp: RAMP.FLICKER, rot: true, life: 0.15, lifeVar: 0.3, size: 0.7, sizeVar: 0.35, jitter: 0.2, colorA: ACCENT_PALE, colorB: ACCENT, gain: 4 });
const PUFF = layer({ sprite: SPR.GLOW, ramp: RAMP.PULSE, soft: true, life: 0.3, size: 0.5, grow: 1.9, ease: 1, speed: 1.2, drag: 2.5, jitter: 0.2, colorA: ACCENT, gain: 1.5, secondary: true });
const fireDef: LayerDef = {
  sprite: SPR.FIRE, ramp: RAMP.FIRE, soft: true, rot: true, spin: 1.3, colorA: C.fireA, colorB: C.fireB, gain: 0.8,
  size: 0.6, sizeVar: 0.2, grow: 1.65, ease: 1, offset: 0.4, jitter: 0.12, speed: 0.9, drag: 3, life: 0.6, lifeVar: 0.3,
};
/** Flame puffs, written per metre of blast radius: the outermost puff ends at 1.0. */
const FIRE = layer(fireDef);
const FIRE_CORE = vary(fireDef, { size: 0.6, grow: 1.9, offset: 0, jitter: 0.15, speed: 0.3, life: 0.4, gain: 1.2, prio: 2 });
/** Energy "flame" in the accent colour (plasma, boss). */
const FIRE_ACCENT = vary(fireDef, { ramp: RAMP.PLASMA, colorA: ACCENT_PALE, colorB: ACCENT, gain: 0.9 });
const hexDef: LayerDef = {
  sprite: SPR.HEX, ramp: RAMP.HOLD, rot: true, spin: 3, size: 0.26, sizeVar: 0.4, speed: 3.2, speedVar: 0.5, drag: 2.6,
  life: 0.45, lifeVar: 0.3, colorA: ACCENT_PALE, colorB: ACCENT, gain: 3, shape: SHAPE.HEMI,
};
/** Shield cells. */
const HEX_SPHERE = vary(hexDef, { shape: SHAPE.SPHERE });
const HEX_FLAT = vary(hexDef, { flat: true, shape: SHAPE.NONE, spin: 0, jitter: 0.25, ramp: RAMP.FLICKER, life: 0.22 });
const HEX_IN = vary(hexDef, { shape: SHAPE.SPHERE, ramp: RAMP.GATHER, offset: 1, speed: -3, speedVar: 0.2, drag: 0, life: 0.32, lifeVar: 0.1 });
const PLUS = layer({ sprite: SPR.PLUS, ramp: RAMP.HOLD, size: 0.2, sizeVar: 0.35, jitter: 0.45, shape: SHAPE.CONE, cone: 0.25, speed: 1.3, drag: 0.8, life: 0.8, colorA: ACCENT_PALE, colorB: ACCENT, gain: 3 });

// --- matter (alpha blended, lit by the scene) -------------------------------------------------------
const smokeDef: LayerDef = {
  sprite: SPR.SMOKE_A, sprite2: SPR.SMOKE_B, add: false, ramp: RAMP.SMOKE, soft: true, secondary: true, rot: true, spin: 0.8,
  colorA: C.smokeWarm, colorB: C.smoke, alpha: 0.72, size: 0.6, sizeVar: 0.25, grow: 1.8, ease: 1, offset: 0.35, jitter: 0.15,
  speed: 0.5, drag: 1.4, up: 0.25, life: 1.7, lifeVar: 0.3,
};
/** Blast smoke, written per metre of blast radius. */
const SMOKE = layer(smokeDef);
/** Small grey wisps in metres (muzzles, impacts, damage smoke). */
const WISP = vary(smokeDef, { offset: 0, inherit: 0.3, colorA: C.smokeGrey, colorB: C.smokeGrey, alpha: 0.4, size: 0.18, grow: 2.6, jitter: 0.04, speed: 0.6, up: 0.5, life: 0.7 });
const WISP_DARK = vary(smokeDef, { offset: 0, inherit: 0.4, colorA: C.smokeWarm, colorB: C.smoke, alpha: 0.7, size: 0.3, grow: 2.4, jitter: 0.1, speed: 0.5, up: 1.2, life: 1 });
const WISP_CONE = vary(smokeDef, { offset: 0, inherit: 0.3, colorA: C.smokeGrey, colorB: C.smokeGrey, alpha: 0.45, size: 0.22, grow: 2.8, jitter: 0.05, shape: SHAPE.CONE, alongDir: true, cone: 0.3, speed: 3, drag: 4, up: 0.3, life: 0.8 });
const dustDef: LayerDef = {
  sprite: SPR.SMOKE_A, sprite2: SPR.SMOKE_B, add: false, ramp: RAMP.DUST, soft: true, secondary: true, rot: true, spin: 0.6,
  colorA: C.dust, colorB: C.dustDark, alpha: 0.55, size: 0.35, sizeVar: 0.3, grow: 2.4, ease: 1,
  shape: SHAPE.DISC, speed: 2.4, speedVar: 0.4, drag: 3, up: 0.25, life: 0.75, lifeVar: 0.3,
};
/** Dust kicked along the ground, or puffing off a surface. */
const DUST_DISC = layer(dustDef);
const DUST_HEMI = vary(dustDef, { shape: SHAPE.HEMI, speed: 1.2 });
const DUST_CONE = vary(dustDef, { shape: SHAPE.CONE, alongDir: true, cone: 0.5, speed: 2.2 });
const STEAM = layer({
  sprite: SPR.SMOKE_B, sprite2: SPR.WISP, add: false, ramp: RAMP.STEAM, soft: true, secondary: true, rot: true, spin: 1, colorA: C.steam,
  alpha: 0.5, emis: 0.25, size: 0.25, sizeVar: 0.3, grow: 3.2, ease: 1, shape: SHAPE.CONE, alongDir: true, cone: 0.16,
  speed: 9, speedVar: 0.25, drag: 2.5, life: 0.25, lifeVar: 0.1,
});
const shardDef: LayerDef = {
  sprite: SPR.SHARD, add: false, ramp: RAMP.DEBRIS, secondary: true, abs: true, size: 0.12, sizeVar: 0.55, rot: true, spin: 14,
  shape: SHAPE.HEMI, speed: 5.5, speedVar: 0.55, gravity: 15, drag: 0.3, bounce: 0.36, life: 1.3, lifeVar: 0.3,
  colorA: C.metal, colorB: C.metalDark,
};
/** Chassis fragments: cold, or glowing where they were torn. */
const SHARD = layer(shardDef);
const SHARD_SPHERE = vary(shardDef, { shape: SHAPE.SPHERE });
const SHARD_HOT = vary(shardDef, { colorA: C.metalHot, colorB: C.metalDark, emis: 0.6 });
const SHARD_HOT_SPHERE = vary(shardDef, { colorA: C.metalHot, colorB: C.metalDark, emis: 0.6, shape: SHAPE.SPHERE });
const CHIP = vary(shardDef, { colorA: C.chip, colorB: C.chip, size: 0.05, speed: 3.5, spin: 20, life: 0.9, bounce: 0.25 });
const GLASS = vary(shardDef, { colorA: C.glass, colorB: C.glass, emis: 0.85, alpha: 0.9, size: 0.075, speed: 4.5, spin: 18, life: 1.1 });
/** Shards of hardened energy (shield plates) in the accent colour. */
const ESHARD = vary(shardDef, { add: true, ramp: RAMP.EMBER, colorA: ACCENT_PALE, colorB: ACCENT, gain: 2.6, gravity: 6, bounce: 0, life: 0.7, size: 0.14, shape: SHAPE.SPHERE });
const casingDef: LayerDef = {
  sprite: SPR.CASING, add: false, ramp: RAMP.DEBRIS, abs: true, size: 0.075, sizeVar: 0.05, aspect: 1, rot: true, spin: 22,
  shape: SHAPE.CONE, alongDir: true, cone: 0.22, speed: 2.8, speedVar: 0.25, gravity: 12, drag: 0.2, bounce: 0.42,
  inherit: 1, life: 1.25, lifeVar: 0.1, colorA: C.brass, colorB: C.brassDark, emis: 0.15,
};
const CASING = layer(casingDef);
const SHELL = vary(casingDef, { size: 0.12, colorA: C.shell, colorB: C.brassDark, speed: 2.2, spin: 14, life: 1.4 });

// --- layers of single recipes ------------------------------------------------------------------------
const STREAK_DOWN = vary(streakDef, { shape: SHAPE.CONE, cone: 0.35, drag: 2.5 });
const ZAP_SPARK = vary({ sprite: SPR.ZAP, ramp: RAMP.FLICKER, rot: true, life: 0.12, size: 0.5, jitter: 0.1, gain: 3.5 }, { colorA: C.hot, colorB: C.spark });
const ZAP_ACCENT2 = vary({ sprite: SPR.ZAP, ramp: RAMP.FLICKER, rot: true, life: 0.2, lifeVar: 0.4, size: 0.7, sizeVar: 0.4, jitter: 0.6, gain: 4 }, { colorA: ACCENT2 });
const SPARK_ACCENT2 = vary(sparkDef, { shape: SHAPE.SPHERE, colorA: ACCENT2, colorB: ACCENT2 });
const RING_N_SHIELD = vary(ringDef, { flat: true, colorA: ACCENT2 });
const HEX_SHIELD = vary(hexDef, { shape: SHAPE.SPHERE, colorA: ACCENT2, colorB: ACCENT2 });
const HEX_FLAT_B = vary(hexDef, { shape: SHAPE.NONE, spin: 0, jitter: 0.35, ramp: RAMP.FLICKER, life: 0.22 });
const CASING_POP = vary(casingDef, { shape: SHAPE.CONE, alongDir: false, cone: 0.6, speed: 3.2, inherit: 0, life: 0.9 });

// ---------------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------------

/** Diameter of a RING / HALO quad whose visible edge sits at `radius`. */
const ring = (radius: number): number => (2 * radius) / RING_EDGE;
const halo = (radius: number): number => (2 * radius) / HALO_EDGE;

/** Cloud layers written per metre (fire, smoke) at an explicit scale: size, spread and speed together. */
function cloud(e: Emitter, L: Layer, count: number, scale: number, life = 1): void {
  e.emit(L, count, scale, scale, life);
}

/** White-hot core + coloured glow: the part of a burst that quality never thins. */
function core(e: Emitter, size: number, seconds: number): void {
  e.one(FLASH_WHITE, size * 0.45, size * 0.75, seconds * 0.7);
  e.one(FLASH, size, size * 1.6, seconds);
}

/**
 * Fiery blast covering exactly `R` metres: core flash, fireball, smoke, sparks, embers, shards and the
 * shock ring that marks the edge. Call after e.unit().
 */
function blast(e: Emitter, R: number, amount: number): void {
  e.ground(R * 0.4);
  // Core flash: never thinned.
  e.one(FLASH_WHITE, R * 0.9, R * 1.5, 0.11);
  e.one(FLASH_WARM, R * 1.6, R * 2.7, 0.2);
  e.emit(FIRE_CORE, 3);
  e.emit(FIRE, 5 + 4 * amount);
  e.emit(SMOKE, 3 + 3 * amount);
  e.emit(SPARK_SPHERE, 16 + 22 * amount, 1, 0.42);
  e.emit(EMBER_SPHERE, 6 + 10 * amount, 1, 0.5);
  e.emit(SHARD_HOT, 3 + 8 * amount, 1, 0.34);
  e.lift(0.06);
  e.one(RING_N_WHITE, R * 0.5, ring(R), 0.34);
  e.emit(DUST_DISC, 4 + 4 * amount, 0.5, 0.42);
}

/** Wreck burst of a machine of radius `r`: flash in its accent, chassis shards, sparks, oily smoke. */
function wreck(e: Emitter, r: number, amount: number): void {
  // Bigger machines throw their pieces further.
  const throwMul = 0.65 + 0.6 * r;
  core(e, r * 2.4, 0.14);
  cloud(e, FIRE, 2 + amount, r * 0.9);
  e.emit(SPARK_SPHERE, 10 * amount, 1, throwMul);
  e.emit(ASPARK_SPHERE, 6 * amount, 1, 0.8 * throwMul);
  e.emit(SHARD_SPHERE, 5 * amount, 0.7 + 0.5 * r, 0.9 * throwMul);
  e.emit(SHARD_HOT_SPHERE, 3 * amount, 0.7 + 0.5 * r, 0.9 * throwMul);
  e.emit(WISP_DARK, 3 * amount, 1 + r);
}

/** Converging charge-up puff (stream): motes gather faster and the core grows with opts.charge. */
function gather(e: Emitter, reach: number, glow: number): void {
  const c = e.charge;
  e.inward(MOTE_IN, 1 + 3 * c, reach);
  e.one(GLOW, glow * (0.3 + 0.7 * c), glow * (0.5 + 0.9 * c), 0.14);
  if (c > 0.7) e.one(STAR, glow * 1.2, glow * 1.8 * c, 0.08);
}

/** Generic impact on a hard surface: flash, sparks off the normal, a puff of dust. */
function surfaceHit(e: Emitter, sparks: number, dust: number): void {
  e.one(FLASH_WARM, 0.16 * e.k, 0.34 * e.k, 0.06);
  e.emit(SPARK_HEMI, sparks);
  e.emit(DUST_HEMI, dust, 0.5);
}

/** Death burst of one enemy type, authored for its table size. */
function death(type: EnemyType, extra: (e: Emitter, r: number) => void): Recipe {
  return (e) => {
    const def = ENEMIES[type];
    e.accent(def.accent);
    const r = e.size(def.radius);
    extra(e, r);
  };
}

// ---------------------------------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------------------------------

export const LIBRARY: Record<FxId, Recipe> = {
  // --- weapons ----------------------------------------------------------------------------------
  muzzleVector(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(PETALS, 0.36 * e.k, 0.6 * e.k, 0.065);
    e.one(STAR, 0.5 * e.k, 0.85 * e.k, 0.055);
    e.one(FLASH_SOFT, 0.45 * e.k, 0.75 * e.k, 0.07);
    e.emit(STREAK_CONE, 3, 1, 0.8);
    e.emit(WISP_CONE, 0.6, 0.6);
  },
  muzzleBreaker(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(PETALS, 0.6 * e.k, 1 * e.k, 0.07);
    e.one(STAR, 0.8 * e.k, 1.3 * e.k, 0.06);
    e.one(FLASH_SOFT, 0.8 * e.k, 1.3 * e.k, 0.08);
    e.emit(STREAK_WIDE, 7, 1, 0.7);
    e.emit(SPARK_WIDE, 6, 1, 1.4);
    e.emit(WISP_CONE, 3, 1.1);
  },
  muzzleLance(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 0.9 * e.k, 0.1);
    e.one(STAR, 1.1 * e.k, 2 * e.k, 0.1);
    e.one(RING_D, 0.2 * e.k, 1.5 * e.k, 0.22);
    e.emit(STREAK_CONE, 8, 1, 1.5);
    e.emit(STREAK_DISC_D, 6, 1, 0.5);
  },
  muzzleHornet(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(PETALS, 0.5 * e.k, 0.9 * e.k, 0.07);
    e.one(FLASH_WHITE, 0.3 * e.k, 0.5 * e.k, 0.06);
    e.one(FLASH_SOFT, 0.8 * e.k, 1.4 * e.k, 0.1);
    e.emit(SPARK_CONE, 6, 1, 1.2);
    e.emit(WISP_CONE, 4, 1.4, 1.3);
  },
  casingVector(e) {
    e.size(1);
    e.emit(CASING, 1);
  },
  casingBreaker(e) {
    e.size(1);
    e.emit(SHELL, 1);
    e.emit(WISP, 0.5, 0.6);
  },
  lanceCharge(e) {
    e.size(1);
    e.accent(PALETTE.player);
    gather(e, 0.75, 0.38);
  },
  lanceDischarge(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(GLOW, 0.5 * e.k, 0.9 * e.k, 0.3);
    e.one(RING_D, 0.15 * e.k, 0.9 * e.k, 0.3);
    e.emit(ZAP, 3, 0.5);
    e.emit(MOTE, 6, 1, 0.8, 0.5);
    e.emit(WISP, 2, 0.8);
  },
  hornetBackblast(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(FLASH_WARM, 0.5 * e.k, 1 * e.k, 0.08);
    e.emit(SPARK_CONE, 8, 1, 1);
    e.emit(WISP_CONE, 5, 1.6, 1.6);
  },
  meleeSwing(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.emit(STREAK_WIDE, 7, 1.3, 0.55, 0.8);
    e.one(GLOW, 0.5 * e.k, 1.1 * e.k, 0.12);
  },
  meleeHit(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 0.8 * e.k, 0.1);
    e.one(STAR, 1 * e.k, 1.7 * e.k, 0.1);
    e.one(RING_N, 0.2 * e.k, 1.7 * e.k, 0.22);
    e.emit(SPARK_HEMI, 12, 1, 1.1);
    e.emit(ASPARK_HEMI, 6);
    e.emit(DUST_HEMI, 3, 0.8);
  },
  chainArc(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 0.6 * e.k, 0.1);
    e.emit(ZAP, 4, 1);
    e.emit(ASPARK_SPHERE, 8, 1, 0.8);
  },

  // --- combat -----------------------------------------------------------------------------------
  hitEnemy(e) {
    // Sparks spray back toward the shooter.
    e.size(1);
    e.reverse();
    e.one(FLASH_WARM, 0.16 * e.k, 0.36 * e.k, 0.06);
    e.emit(SPARK_WIDE, 5, 1, 0.9);
  },
  hitEnemyWeak(e) {
    e.size(1);
    e.accent(PALETTE.overclock);
    e.reverse();
    core(e, 0.5 * e.k, 0.09);
    e.one(STAR, 0.8 * e.k, 1.5 * e.k, 0.11);
    e.one(RING_B, 0.1 * e.k, 0.8 * e.k, 0.18);
    e.emit(SPARK_WIDE, 9, 1, 1.25);
    e.emit(SHARD_HOT, 2, 1, 0.7);
  },
  hitEnemyArmor(e) {
    // Dull deflection: a few long ricochets, no glow.
    e.size(1);
    e.reverse();
    e.one(FLASH_WHITE, 0.08 * e.k, 0.18 * e.k, 0.05);
    e.emit(SPARK_WIDE, 3, 0.8, 1.7, 0.7);
    e.emit(DUST_CONE, 1, 0.35, 0.6);
  },
  hitEnemyShield(e) {
    e.size(1);
    e.accent(PALETTE.elite);
    e.faceShooter();
    e.one(FLASH, 0.25 * e.k, 0.5 * e.k, 0.08);
    e.one(HALO_N, 0.2 * e.k, 1.1 * e.k, 0.24);
    e.emit(HEX_FLAT, 3, 1);
    e.emit(ASPARK_HEMI, 3, 1, 0.5);
  },
  explosionSmall(e) {
    const R = e.unit(3);
    blast(e, R, 0.45);
  },
  explosionLarge(e) {
    const R = e.unit(5.5);
    blast(e, R, 1);
  },
  explosionPlasma(e) {
    // Energy burst: no fire, no smoke — a splash of plasma and a ring at the edge.
    const R = e.unit(3);
    e.accent(PALETTE.enemy);
    e.ground(R * 0.4);
    e.one(FLASH_WHITE, R * 0.6, R * 1.1, 0.1);
    e.one(FLASH, R * 1.4, R * 2.4, 0.2);
    e.emit(FIRE_ACCENT, 7);
    e.emit(ASPARK_SPHERE, 18, 1, 0.45);
    e.emit(MOTE, 8, 1, 0.5, 0.6);
    e.lift(0.06);
    e.one(RING_N, R * 0.4, ring(R), 0.3);
  },
  explosionShock(e) {
    // Concussion without fire: hard ring, arcs, dust thrown outward.
    const R = e.unit(5);
    e.accent(PALETTE.elite);
    e.ground(R * 0.4);
    e.one(FLASH_WHITE, R * 0.5, R * 0.9, 0.09);
    e.one(FLASH, R * 1.1, R * 1.9, 0.16);
    e.emit(ZAP, 6, 0.5 / 0.7);
    e.emit(ASPARK_DISC, 16, 1, 0.5);
    e.lift(0.06);
    e.one(RING_N, R * 0.3, ring(R), 0.32);
    e.one(HALO_N, R * 0.3, halo(R * 0.8), 0.4);
    e.emit(DUST_DISC, 12, 0.5, 0.5);
  },
  explosionBoss(e) {
    const R = e.unit(8);
    e.accent(PALETTE.elite);
    blast(e, R, 1.4);
    e.emit(FIRE_ACCENT, 4);
    e.emit(ASPARK_SPHERE, 24, 1, 0.5);
    e.one(RING_B, R * 0.4, ring(R), 0.4);
    e.one(FLASH, R * 1.8, R * 3, 0.25);
  },
  shockwaveRing(e) {
    const R = e.unit(6);
    e.accent(C.white);
    e.lift(0.06);
    e.one(RING_N_WHITE, R * 0.3, ring(R), 0.4);
    e.one(HALO_N, R * 0.2, halo(R * 0.85), 0.5);
    e.emit(DUST_DISC, 8, 0.4, 0.45);
  },
  grenadeBounce(e) {
    e.size(1);
    e.emit(SPARK_HEMI, 3, 1, 0.5);
    e.emit(DUST_HEMI, 2, 0.4, 0.6);
  },

  // --- player -----------------------------------------------------------------------------------
  hitPlayer(e) {
    // Right in front of the camera: small and short, the screen feedback is render's.
    e.size(1);
    e.accent(PALETTE.enemy);
    e.one(FLASH, 0.2 * e.k, 0.4 * e.k, 0.07);
    e.emit(ASPARK_SPHERE, 5, 1, 0.5, 0.7);
  },
  hitPlayerShield(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(HALO_B, 0.15 * e.k, 0.6 * e.k, 0.18);
    e.emit(HEX_SPHERE, 2, 0.6, 0.5, 0.6);
    e.emit(ASPARK_SPHERE, 3, 1, 0.4, 0.6);
  },
  footDust(e) {
    e.size(1);
    e.emit(DUST_DISC, 2, 0.45, 0.4, 0.7);
  },
  jumpDust(e) {
    e.size(1);
    e.emit(DUST_DISC, 5, 0.6, 0.7);
  },
  landDust(e) {
    e.size(1);
    e.emit(DUST_DISC, 9, 0.8, 1.1);
    e.emit(DUST_HEMI, 2, 0.6, 0.5);
  },
  doubleJump(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(RING_N, 0.3 * e.k, 1.5 * e.k, 0.25);
    e.one(GLOW, 0.5 * e.k, 0.9 * e.k, 0.15);
    e.invert();
    e.emit(STREAK_DOWN, 7, 1, 0.5);
  },
  slideSparks(e) {
    e.size(1);
    e.emit(SPARK_UP, 3, 0.9, 0.7, 0.6);
    e.emit(DUST_HEMI, 0.6, 0.5, 0.6, 0.3);
  },
  dashBurst(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(RING_D, 0.4 * e.k, 2 * e.k, 0.22);
    e.one(GLOW, 0.8 * e.k, 1.4 * e.k, 0.14);
    e.reverse();
    e.emit(STREAK_CONE, 10, 1.2, 0.8, 1.2);
    e.emit(MOTE, 5, 1, 0.6, 0.4);
  },
  shieldBreak(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 0.9 * e.k, 0.1);
    e.one(RING_B, 0.4 * e.k, 2.6 * e.k, 0.3);
    e.emit(ESHARD, 12, 1, 0.9);
    e.emit(HEX_SPHERE, 6, 1, 1);
    e.emit(ASPARK_SPHERE, 10);
  },
  shieldRecharge(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(RING_IN_B, 2 * e.k, 0.5 * e.k, 0.35);
    e.inward(HEX_IN, 5, 0.9);
    e.emit(MOTE_RISE, 6, 1, 0.8, 0.6);
  },
  healPulse(e) {
    e.size(1);
    e.accent(PALETTE.health);
    e.one(HALO_B, 0.4 * e.k, 1.8 * e.k, 0.4);
    e.emit(PLUS, 5);
    e.emit(MOTE_RISE, 8, 1, 0.9, 0.7);
  },
  lifeSteal(e) {
    e.size(1);
    e.accent(PALETTE.health);
    e.inward(STREAK_IN, 9, 1.2, 1.2);
    e.one(GLOW, 0.3 * e.k, 0.7 * e.k, 0.25);
    e.emit(PLUS, 2, 0.7);
  },
  overclockStart(e) {
    e.size(1);
    e.accent(PALETTE.overclock);
    core(e, 1.6 * e.k, 0.14);
    e.one(RING_B, 0.5 * e.k, 7 * e.k, 0.45);
    e.one(RING_N, 0.5 * e.k, 9 * e.k, 0.55);
    e.emit(STREAK_SPHERE, 22, 1.2, 1.1, 1.3);
    e.emit(MOTE, 12, 1, 1.5, 0.8);
  },
  overclockEnd(e) {
    e.size(1);
    e.accent(PALETTE.overclock);
    e.one(RING_IN_B, 5 * e.k, 0.4 * e.k, 0.4);
    e.inward(STREAK_IN, 14, 2.4, 1.7);
    e.one(GLOW, 0.6 * e.k, 1.2 * e.k, 0.3);
  },
  lastStand(e) {
    e.size(1);
    e.accent(PALETTE.overclock);
    e.accent2(PALETTE.player);
    core(e, 2 * e.k, 0.18);
    e.one(STAR, 2.5 * e.k, 4.5 * e.k, 0.16);
    e.one(RING_B, 0.6 * e.k, 8 * e.k, 0.5);
    e.one(RING_N_SHIELD, 0.6 * e.k, 5 * e.k, 0.6);
    e.emit(STREAK_SPHERE, 28, 1.3, 1.2, 1.4);
    e.emit(HEX_SHIELD, 10, 1.2, 1.3);
  },

  // --- enemy manager ----------------------------------------------------------------------------
  spawnFlash(e) {
    e.size(1);
    e.accent(PALETTE.lightning);
    core(e, 1.8 * e.k, 0.14);
    e.one(STAR, 2.2 * e.k, 3.6 * e.k, 0.12);
    e.emit(ZAP, 5, 1.3);
    e.emit(ASPARK_HEMI, 14, 1, 0.9);
    e.emit(STREAK_RISE, 6, 1, 0.5);
    e.lift(0.06);
    e.one(RING_N, 0.4 * e.k, ring(2.2 * e.k), 0.3);
    e.emit(DUST_DISC, 6, 0.9, 0.9);
  },

  // --- enemy kinds ------------------------------------------------------------------------------
  enemySmoke(e) {
    e.size(1);
    e.emit(WISP_DARK, 1.2, 1, 2.2, 0.25);
  },
  enemySparks(e) {
    e.size(1);
    e.emit(SPARK_SPHERE, 2.5, 1, 0.5, 0.6);
    if (e.random() < 0.25) e.emit(ZAP_SPARK, 1, 0.5);
  },
  deathSkitter: death('skitter', (e, r) => {
    wreck(e, r, 1);
    e.emit(SPARK_UP, 6, 1, 0.8);
  }),
  deathRiveter: death('riveter', (e, r) => {
    // The hover reactor pops: a ring, then the hull drops in pieces.
    wreck(e, r, 1.5);
    e.one(RING_B, r * 0.6, r * 4.5, 0.26);
    cloud(e, FIRE, 2, r * 1.2);
    cloud(e, SMOKE, 2, r * 1.2);
    e.emit(EMBER_SPHERE, 10, 1, 0.8);
  }),
  deathWasp: death('wasp', (e, r) => {
    wreck(e, r, 1.1);
    e.emit(SHARD_HOT_SPHERE, 4, 1, 1.3);
    e.emit(EMBER_SPHERE, 8, 1, 0.7);
    cloud(e, FIRE, 2, r);
  }),
  deathTick: death('tick', (e, r) => {
    // The blast itself is combat's: here only the casing bursting apart.
    core(e, r * 2, 0.1);
    e.emit(SHARD_HOT_SPHERE, 7, 1, 1.4);
    e.emit(SPARK_SPHERE, 10, 1, 1.2);
  }),
  deathLancer: death('lancer', (e, r) => {
    wreck(e, r, 1.4);
    // The lens shatters and the capacitor vents upward.
    e.one(STAR, r * 3, r * 5, 0.12);
    e.emit(GLASS, 10, 1, 1.1);
    e.emit(STREAK_RISE, 12, r * 1.2, 0.8);
    e.emit(ZAP, 4, r * 1.6);
  }),
  deathBulwark: death('bulwark', (e, r) => {
    wreck(e, r, 2.6);
    e.one(FLASH_WARM, r * 3, r * 5, 0.22);
    cloud(e, FIRE, 8, r * 1.1);
    cloud(e, SMOKE, 6, r * 1.1);
    e.emit(SHARD, 10, 1.6, 1.3);
    e.emit(EMBER_SPHERE, 16, 1, 1.2);
    e.one(RING_N_WHITE, r * 0.6, r * 7, 0.42);
  }),
  deathConductor: death('conductor', (e, r) => {
    e.one(FLASH_WHITE, r * 2, r * 3.4, 0.2);
    e.one(FLASH, r * 3.5, r * 6, 0.4);
    e.one(STAR, r * 4, r * 7, 0.3);
    cloud(e, FIRE_ACCENT, 12, r * 0.9, 1.4);
    cloud(e, FIRE, 8, r * 0.9, 1.4);
    cloud(e, SMOKE, 8, r * 0.8);
    e.emit(ASPARK_SPHERE, 40, 1.5, 4, 1.6);
    e.emit(SPARK_SPHERE, 30, 1.5, 4.5, 1.6);
    e.emit(SHARD_HOT_SPHERE, 22, 2.2, 3.2, 1.5);
    e.emit(ZAP, 8, r * 2);
    e.one(RING_B, r, r * 7, 0.6);
  }),
  skitterLeap(e) {
    e.size(1);
    e.accent(ENEMIES.skitter.accent);
    e.emit(DUST_DISC, 4, 0.6, 0.6);
    e.emit(ASPARK_DISC, 4, 1, 0.5);
  },
  skitterBite(e) {
    e.size(1);
    e.accent(ENEMIES.skitter.accent);
    e.one(FLASH, 0.3 * e.k, 0.6 * e.k, 0.07);
    e.emit(STREAK_WIDE, 5, 1, 0.4);
    e.emit(SPARK_WIDE, 3, 1, 0.6);
  },
  riveterCharge(e) {
    e.size(1);
    e.accent(ENEMIES.riveter.accent);
    gather(e, 0.6, 0.35);
  },
  riveterMuzzle(e) {
    e.size(1);
    e.accent(ENEMIES.riveter.accent);
    e.one(PETALS, 0.5 * e.k, 0.8 * e.k, 0.06);
    e.one(FLASH_SOFT, 0.7 * e.k, 1.2 * e.k, 0.08);
    e.emit(STREAK_CONE, 4, 1, 0.7);
  },
  waspMuzzle(e) {
    e.size(1);
    e.accent(ENEMIES.wasp.accent);
    e.one(PETALS, 0.3 * e.k, 0.5 * e.k, 0.05);
    e.one(FLASH_SOFT, 0.45 * e.k, 0.75 * e.k, 0.06);
    e.emit(STREAK_CONE, 2, 1, 0.6);
  },
  tickArm(e) {
    // A warning pulse: the tick is about to go off.
    e.size(1);
    e.accent(PALETTE.hazard);
    e.accent2(ENEMIES.tick.accent);
    e.one(GLOW, 0.5 * e.k, 0.95 * e.k, 0.1);
    e.one(HALO_B, 0.3 * e.k, 1.2 * e.k, 0.14);
    e.emit(SPARK_ACCENT2, 1.5, 1, 0.5, 0.5);
  },
  lancerCharge(e) {
    e.size(1);
    e.accent(ENEMIES.lancer.accent);
    gather(e, 0.8, 0.42);
  },
  lancerMuzzle(e) {
    e.size(1);
    e.accent(ENEMIES.lancer.accent);
    core(e, 0.9 * e.k, 0.1);
    e.one(STAR, 1.2 * e.k, 2.2 * e.k, 0.1);
    e.one(RING_D, 0.2 * e.k, 1.4 * e.k, 0.2);
    e.emit(STREAK_CONE, 8, 1, 1.3);
  },
  lancerRelocate(e) {
    e.size(1);
    e.accent(ENEMIES.lancer.accent);
    e.emit(DUST_DISC, 6, 0.9, 0.8);
    e.emit(STREAK_RISE, 8, 0.8, 0.5);
    e.one(HALO_N, 0.4 * e.k, 2.2 * e.k, 0.28);
  },
  bulwarkMortarMuzzle(e) {
    e.size(1);
    e.accent(ENEMIES.bulwark.accent);
    core(e, 1.2 * e.k, 0.11);
    e.one(RING_D, 0.3 * e.k, 2.2 * e.k, 0.24);
    e.emit(SPARK_CONE, 12, 1, 1.4);
    e.emit(WISP_CONE, 6, 1.8, 1.5);
  },
  bulwarkStomp(e) {
    // The moving damage front is the owner's 'shock' telegraph: this is the slam under the foot.
    const R = e.size(3);
    e.accent(ENEMIES.bulwark.accent);
    e.one(FLASH, R * 0.5, R * 0.9, 0.12);
    e.emit(SPARK_DISC, 16, 1, 0.9);
    e.emit(SHARD, 8, 1, 0.8);
    e.lift(0.06);
    e.one(RING_N_WHITE, R * 0.2, ring(R * 0.6), 0.22);
    e.emit(DUST_DISC, 14, 1.4, 1.3);
    e.emit(DUST_HEMI, 4, 1.2, 0.8);
  },
  bulwarkShieldBreak(e) {
    const R = e.size(2);
    e.accent(ENEMIES.bulwark.accent);
    core(e, R * 1.1, 0.12);
    e.one(RING_D, R * 0.3, R * 2.6, 0.3);
    e.emit(ESHARD, 18, 1.2, 1.1);
    e.emit(HEX_SPHERE, 10, 1.3, 1.2);
    e.emit(ZAP, 4, R * 0.7);
    e.emit(ASPARK_SPHERE, 12);
  },
  bulwarkShieldRestore(e) {
    const R = e.size(2);
    e.accent(ENEMIES.bulwark.accent);
    e.one(RING_IN_B, R * 2.4, R * 0.6, 0.4);
    e.inward(HEX_IN, 12, R * 0.7);
    e.one(GLOW_HOLD, R * 0.6, R * 1.3, 0.45);
  },
  bossSpawn(e) {
    const R = e.size(5);
    e.accent(PALETTE.elite);
    e.accent2(PALETTE.lightning);
    e.one(FLASH_WHITE, R * 1.2, R * 2.2, 0.2);
    e.one(FLASH, R * 2.6, R * 4.5, 0.45);
    e.one(STAR, R * 3, R * 5.5, 0.3);
    e.one(RING_B, R * 0.5, R * 6, 0.7);
    e.emit(ZAP_ACCENT2, 12, R * 0.9);
    e.emit(STREAK_SPHERE, 46, 2.5, 4, 2.4);
    e.emit(MOTE, 26, 2, 5, 1.4);
    cloud(e, FIRE_ACCENT, 14, R * 0.9, 1.5);
  },
  bossCharge(e) {
    const R = e.size(1.5);
    e.accent(PALETTE.elite);
    gather(e, R * 1.3, R * 0.9);
    e.inward(MOTE_IN, 3 * e.charge, R * 1.9);
  },
  bossVolleyMuzzle(e) {
    e.size(1);
    e.accent(PALETTE.elite);
    e.one(PETALS, 0.8 * e.k, 1.3 * e.k, 0.07);
    core(e, 1.1 * e.k, 0.1);
    e.emit(STREAK_CONE, 7, 1.2, 0.9);
  },
  bossSweepCharge(e) {
    const R = e.size(1.5);
    e.accent(PALETTE.elite);
    gather(e, R * 1.2, R * 0.8);
    if (e.charge > 0.5) e.emit(ZAP, 1, R * 0.6);
  },
  bossSweepHit(e) {
    // Where the sweep laser drags across the floor: molten spray.
    e.size(1);
    e.accent(PALETTE.elite);
    e.one(FLASH_WHITE, 0.5 * e.k, 0.9 * e.k, 0.08);
    e.one(FLASH, 1 * e.k, 1.7 * e.k, 0.1);
    e.emit(ASPARK_HEMI, 5, 1.1, 0.9, 0.6);
    e.emit(SPARK_UP, 3, 1, 0.8, 0.6);
    e.emit(WISP_DARK, 0.8, 1.2, 1.5, 0.25);
  },
  bossLightningStrike(e) {
    const R = e.size(4);
    e.accent(PALETTE.lightning);
    e.one(FLASH_WHITE, R * 0.7, R * 1.3, 0.14);
    e.one(FLASH, R * 1.5, R * 2.6, 0.24);
    e.one(STAR, R * 1.6, R * 2.8, 0.14);
    e.emit(ZAP, 8, R * 0.5);
    e.emit(ASPARK_HEMI, 26, 1.2, 1.4, 1.2);
    e.emit(SHARD_HOT, 8, 1.2, 1.2);
    e.emit(STREAK_RISE, 10, R * 0.5, 0.8);
    e.lift(0.06);
    e.one(RING_N, R * 0.3, ring(R), 0.32);
    e.emit(DUST_DISC, 10, 1.6, 1.5);
  },
  bossMissileLaunch(e) {
    e.size(1);
    e.accent(PALETTE.elite);
    core(e, 0.9 * e.k, 0.1);
    e.emit(SPARK_CONE, 8, 1, 1.1);
    e.emit(WISP_CONE, 5, 1.6, 1.4);
  },
  bossShockRing(e) {
    // Burst at the origin; the travelling ring is the owner's 'shock' telegraph.
    const R = e.size(4);
    e.accent(PALETTE.elite);
    e.one(FLASH_WHITE, R * 0.5, R * 0.9, 0.1);
    e.one(FLASH, R * 1.1, R * 2, 0.2);
    e.emit(STREAK_DISC, 26, 1.3, 1.6, 1.3);
    e.emit(ZAP, 5, R * 0.45);
    e.lift(0.06);
    e.one(HALO_N, R * 0.3, halo(R), 0.35);
    e.emit(DUST_DISC, 10, 1.4, 1.6);
  },
  bossSummon(e) {
    const R = e.size(2.5);
    e.accent(PALETTE.elite);
    e.one(GLOW_HOLD, R * 0.8, R * 1.6, 0.6);
    e.one(RING_IN_N, ring(R), R * 0.3, 0.5);
    e.one(RING_IN_B, R * 2.4, R * 0.4, 0.55);
    e.inward(STREAK_IN, 16, R, 1.5);
    e.emit(ZAP, 5, R * 0.6);
    e.emit(MOTE_RISE, 14, R * 0.8, 1.2);
  },
  bossPhaseShift(e) {
    const R = e.size(6);
    e.accent(PALETTE.elite);
    e.one(FLASH_WHITE, R * 1.1, R * 2, 0.2);
    e.one(FLASH, R * 2.4, R * 4, 0.4);
    e.one(STAR, R * 2.6, R * 4.6, 0.26);
    e.one(RING_B, R * 0.4, R * 5.5, 0.55);
    e.one(HALO_B, R * 0.5, R * 3.2, 0.5);
    cloud(e, FIRE_ACCENT, 10, R * 0.7, 1.3);
    e.emit(STREAK_SPHERE, 50, 2.5, 4.5, 2.2);
    e.emit(ESHARD, 26, 2, 3.5, 1.6);
    e.emit(ZAP, 10, R * 0.6);
  },
  bossWeakPointBreak(e) {
    const R = e.size(1.2);
    e.accent(PALETTE.elite);
    core(e, R * 1.8, 0.14);
    e.one(STAR, R * 2.4, R * 4, 0.14);
    e.one(RING_B, R * 0.4, R * 4.5, 0.3);
    e.emit(GLASS, 14, 1.3, 1.4);
    e.emit(ZAP, 6, R * 1.1);
    e.emit(ASPARK_SPHERE, 22, 1.2, 1.3);
    e.emit(SHARD_HOT_SPHERE, 8, 1.2, 1.2);
    e.emit(WISP_DARK, 3, 1.6);
  },
  bossDeathBurst(e) {
    // One of the chain explosions that walk over the hull.
    const R = e.unit(4);
    e.accent(PALETTE.elite);
    blast(e, R, 0.9);
    e.emit(FIRE_ACCENT, 5);
    e.emit(ASPARK_SPHERE, 14, 1, 0.45);
    e.emit(ZAP, 3, 0.4 / 0.7);
  },
  bossDeathFinal(e) {
    const R = e.size(10);
    e.accent(PALETTE.elite);
    e.accent2(PALETTE.lightning);
    e.one(FLASH_WHITE, R * 1.6, R * 3, 0.35);
    e.one(FLASH, R * 3, R * 5.5, 0.7);
    e.one(STAR, R * 3.5, R * 7, 0.5);
    e.one(RING_B_WHITE, R * 0.4, R * 5, 0.6);
    e.one(RING_B, R * 0.5, R * 8, 0.9);
    cloud(e, FIRE_ACCENT, 16, R * 0.8, 1.8);
    cloud(e, FIRE, 12, R * 0.7, 1.6);
    cloud(e, SMOKE, 10, R * 0.6);
    e.emit(STREAK_SPHERE, 70, 3, 7, 3);
    e.emit(ASPARK_SPHERE, 50, 2, 6, 2.4);
    e.emit(SPARK_SPHERE, 40, 2, 6.5, 2.4);
    e.emit(SHARD_HOT_SPHERE, 36, 2.6, 5, 1.7);
    e.emit(ESHARD, 30, 2.4, 5.5, 2.2);
    e.emit(ZAP_ACCENT2, 12, R * 0.8);
    e.emit(MOTE, 40, 2.5, 5, 1.8);
  },

  // --- director ---------------------------------------------------------------------------------
  pickupSpawn(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(GLOW, 0.4 * e.k, 0.9 * e.k, 0.25);
    e.one(HALO_N, 0.2 * e.k, 1.2 * e.k, 0.3);
    e.emit(MOTE, 5, 1, 0.8, 0.5);
  },
  pickupAmmo(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(FLASH, 0.4 * e.k, 0.8 * e.k, 0.12);
    e.one(STAR, 0.6 * e.k, 1.2 * e.k, 0.12);
    e.emit(STREAK_RISE, 8, 0.6, 0.45);
    e.emit(CASING_POP, 3);
  },
  pickupHealth(e) {
    e.size(1);
    e.accent(PALETTE.health);
    e.one(FLASH, 0.4 * e.k, 0.8 * e.k, 0.12);
    e.one(HALO_B, 0.3 * e.k, 1.5 * e.k, 0.3);
    e.emit(PLUS, 4, 0.9);
    e.emit(MOTE_RISE, 6, 0.9, 0.9, 0.6);
  },
  pickupShield(e) {
    e.size(1);
    e.accent(PALETTE.shield);
    e.one(FLASH, 0.4 * e.k, 0.8 * e.k, 0.12);
    e.one(RING_B, 0.2 * e.k, 1.5 * e.k, 0.26);
    e.emit(HEX_SPHERE, 5, 0.8, 0.7);
    e.emit(MOTE_RISE, 5, 0.9, 0.9, 0.6);
  },
  pickupGrenade(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(FLASH_WHITE, 0.3 * e.k, 0.6 * e.k, 0.1);
    e.one(RING_N, 0.2 * e.k, 1.5 * e.k, 0.24);
    e.emit(STREAK_RISE, 5, 0.6, 0.45);
    e.emit(SPARK_UP, 4, 1, 0.5);
  },
  pickupExpire(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(RING_IN_B, 1 * e.k, 0.15 * e.k, 0.25);
    e.emit(MOTE, 4, 1, 0.5, 0.4);
    e.emit(WISP, 1, 0.7);
  },
  supplyLand(e) {
    const R = e.size(2.5);
    e.accent(PALETTE.player);
    e.one(FLASH_WHITE, R * 0.5, R * 0.9, 0.1);
    e.one(FLASH, R, R * 1.8, 0.18);
    e.emit(SPARK_DISC, 18, 1, 1);
    e.emit(SHARD, 6, 1, 0.9);
    e.lift(0.06);
    e.one(RING_N, R * 0.3, ring(R), 0.3);
    e.emit(DUST_DISC, 16, 1.5, 1.6);
    e.emit(DUST_HEMI, 6, 1.4, 1.2);
  },
  supplyOpen(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 1.2 * e.k, 0.14);
    e.one(RING_N, 0.4 * e.k, 3.4 * e.k, 0.32);
    e.emit(STREAK_RISE, 14, 1, 0.7);
    e.emit(HEX_SPHERE, 6, 1, 0.9);
    e.emit(WISP, 3, 1.2);
  },
  weaponUnlock(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 1.6 * e.k, 0.18);
    e.one(STAR, 2 * e.k, 3.6 * e.k, 0.2);
    e.one(RING_N, 0.4 * e.k, 5 * e.k, 0.45);
    e.one(RING_B, 0.4 * e.k, 3.4 * e.k, 0.35);
    e.emit(STREAK_RISE, 26, 1.1, 1, 1.5);
    e.emit(MOTE_RISE, 16, 1.2, 1.4, 1.2);
  },
  perkChosen(e) {
    e.size(1);
    e.accent(PALETTE.overclock);
    e.accent2(PALETTE.player);
    e.one(GLOW, 0.8 * e.k, 1.6 * e.k, 0.3);
    e.one(RING_N, 0.4 * e.k, 3.6 * e.k, 0.4);
    e.one(RING_N_SHIELD, 0.3 * e.k, 2.4 * e.k, 0.55);
    e.emit(STREAK_RISE, 16, 0.9, 0.8, 1.3);
    e.emit(MOTE_RISE, 12, 1, 1.2, 1.1);
  },
  waveClear(e) {
    const R = e.size(6);
    e.accent(PALETTE.player);
    e.lift(0.06);
    e.one(RING_N, R * 0.2, ring(R), 0.7);
    e.one(HALO_N, R * 0.2, halo(R * 0.7), 0.9);
    e.emit(MOTE_RISE, 26, R * 0.9, 1.6, 1.5);
    e.emit(STREAK_RISE, 12, R * 0.9, 0.7, 1.3);
  },

  // --- world ------------------------------------------------------------------------------------
  gateOpen(e) {
    const R = e.size(3);
    e.accent(PALETTE.player);
    e.one(FLASH, R * 0.8, R * 1.6, 0.2);
    e.one(RING_B, R * 0.3, R * 2.6, 0.4);
    e.emit(ESHARD, 22, R * 0.5, 0.9, 1.1);
    e.emit(HEX_SPHERE, 12, 1.4, 1);
    e.emit(MOTE, 14, R * 0.5, 1.4, 0.9);
  },
  gateClose(e) {
    const R = e.size(3);
    e.accent(PALETTE.player);
    e.one(RING_IN_B, R * 2.6, R * 0.4, 0.35);
    e.inward(HEX_IN, 14, R * 0.8);
    e.inward(STREAK_IN, 12, R * 0.8, 1.5);
    e.one(GLOW_HOLD, R * 0.6, R * 1.4, 0.4);
  },
  gateDenied(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(HALO_B, 0.3 * e.k, 1.6 * e.k, 0.22);
    e.emit(HEX_FLAT_B, 4, 1.2);
    e.emit(SPARK_SPHERE, 5, 1, 0.5);
  },
  zoneUnlock(e) {
    const R = e.size(8);
    e.accent(PALETTE.player);
    e.one(FLASH, R * 0.6, R * 1.2, 0.3);
    e.lift(0.06);
    e.one(RING_N, R * 0.2, ring(R), 0.9);
    e.one(RING_N, R * 0.1, ring(R * 0.6), 1.3);
    e.emit(STREAK_RISE, 40, R * 0.6, 1.3, 2.2);
    e.emit(MOTE_RISE, 30, R * 0.7, 2, 1.8);
  },
  jumpPad(e) {
    e.size(1);
    e.accent(PALETTE.player);
    e.one(RING_N, 0.5 * e.k, 3 * e.k, 0.3);
    e.one(GLOW, 0.8 * e.k, 1.5 * e.k, 0.18);
    e.emit(STREAK_RISE, 12, 0.8, 0.9);
    e.emit(DUST_DISC, 4, 0.7, 0.8);
  },
  steamVent(e) {
    e.size(1);
    e.emit(STEAM, 3);
  },
  sparkShower(e) {
    e.size(1);
    e.emit(SPARK_CONE, 4, 1, 0.75, 0.65);
  },
  hazardArc(e) {
    e.size(1);
    e.accent(PALETTE.lightning);
    e.emit(ZAP, 1.5, 1.2, 1, 0.9);
    e.one(GLOW, 0.5 * e.k, 0.9 * e.k, 0.1);
    e.emit(ASPARK_SPHERE, 2, 1, 0.5, 0.6);
  },
  respawn(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 1.2 * e.k, 0.16);
    e.one(RING_N, 0.4 * e.k, 3.4 * e.k, 0.4);
    e.one(RING_IN_B, 3 * e.k, 0.5 * e.k, 0.3);
    e.emit(STREAK_RISE, 16, 0.8, 0.9, 1.2);
    e.emit(MOTE_RISE, 10, 0.9, 1.2);
  },

  // --- shared building blocks -------------------------------------------------------------------
  impactMetal(e) {
    e.size(1);
    surfaceHit(e, 7, 1);
  },
  impactPlating(e) {
    // Painted hull plate: fewer sparks, paint chips and a pale puff.
    e.size(1);
    surfaceHit(e, 3, 2.5);
    e.emit(CHIP, 4);
  },
  impactGrate(e) {
    // Open grating: long thin sparks, hardly any dust.
    e.size(1);
    e.one(FLASH_WARM, 0.12 * e.k, 0.26 * e.k, 0.05);
    e.emit(SPARK_HEMI, 6, 0.8, 1.5, 1.2);
  },
  impactGlass(e) {
    e.size(1);
    e.one(FLASH_WHITE, 0.14 * e.k, 0.3 * e.k, 0.06);
    e.emit(GLASS, 7);
    e.emit(DUST_HEMI, 1.5, 0.45, 0.8);
  },
  impactEnergy(e) {
    // Energy surface (gates): a ripple, nothing breaks.
    e.size(1);
    e.accent(PALETTE.player);
    e.lift(0.03);
    e.one(HALO_N, 0.15 * e.k, 0.9 * e.k, 0.26);
    e.one(FLASH, 0.2 * e.k, 0.4 * e.k, 0.08);
    e.emit(HEX_FLAT, 2, 0.8);
  },
  impactPellet(e) {
    e.size(1);
    e.one(FLASH_WARM, 0.1 * e.k, 0.22 * e.k, 0.05);
    e.emit(SPARK_HEMI, 2.5, 0.9, 0.8, 0.8);
  },
  impactRail(e) {
    e.size(1);
    e.accent(PALETTE.player);
    core(e, 0.9 * e.k, 0.12);
    e.one(STAR, 1.2 * e.k, 2 * e.k, 0.1);
    e.lift(0.04);
    e.one(RING_N, 0.2 * e.k, 2 * e.k, 0.26);
    e.emit(ASPARK_HEMI, 12, 1.1, 1.4);
    e.emit(SPARK_HEMI, 8, 1, 1.2);
    e.emit(WISP, 2, 1.2);
  },
  impactPlasma(e) {
    e.size(1);
    e.accent(PALETTE.enemy);
    core(e, 0.6 * e.k, 0.1);
    e.lift(0.04);
    e.one(RING_N, 0.15 * e.k, 1.3 * e.k, 0.22);
    e.emit(ASPARK_HEMI, 7, 1, 0.7);
    e.emit(PUFF, 2, 0.6);
  },
  impactBolt(e) {
    e.size(1);
    e.accent(PALETTE.enemy);
    e.one(FLASH, 0.25 * e.k, 0.5 * e.k, 0.07);
    e.emit(ASPARK_HEMI, 3, 1, 0.6);
  },
  impactLaser(e) {
    e.size(1);
    e.accent(PALETTE.enemy);
    core(e, 0.5 * e.k, 0.1);
    e.emit(ASPARK_HEMI, 6, 1, 0.9);
    e.emit(SPARK_HEMI, 4, 1, 0.8);
    e.emit(WISP_DARK, 1.5, 0.7, 0.8, 0.6);
  },
  lightningImpact(e) {
    e.size(1);
    e.accent(PALETTE.lightning);
    core(e, 1 * e.k, 0.12);
    e.emit(ZAP, 4, 0.9);
    e.emit(ASPARK_HEMI, 10, 1, 0.9);
    e.emit(DUST_HEMI, 2, 0.7, 0.7);
  },
};

/** Fallback for an id the library does not know (a newer contract than this build): a neutral pop. */
export const FALLBACK_RECIPE: Recipe = (e) => {
  e.size(1);
  e.accent(C.white);
  e.one(FLASH, 0.3 * e.k, 0.6 * e.k, 0.08);
  e.emit(SPARK_SPHERE, 5, 1, 0.6);
};

// ---------------------------------------------------------------------------------------------------
// Trail smoke
// ---------------------------------------------------------------------------------------------------

const TRAIL_SMOKE = vary(smokeDef, { offset: 0, colorA: C.smokeGrey, colorB: C.smokeGrey, alpha: 0.4, size: 0.5, grow: 2.4, jitter: 0.05, speed: 0.25, up: 0.25, life: 1 });
const TRAIL_SMOKE_DARK = vary(smokeDef, { offset: 0, colorA: C.smokeWarm, colorB: C.smoke, alpha: 0.55, size: 0.55, grow: 2.4, jitter: 0.06, speed: 0.3, up: 0.3, life: 1.1 });
const TRAIL_SMOKE_BIG = vary(smokeDef, { offset: 0, colorA: C.smokeGrey, colorB: C.smokeGrey, alpha: 0.45, size: 1, grow: 2.4, jitter: 0.1, speed: 0.4, up: 0.2, life: 1.5 });

/** Smoke puff a trail of each kind drops along its path (null = none). */
export const TRAIL_PUFFS: Record<TrailKind, Layer | null> = {
  rocket: TRAIL_SMOKE,
  grenade: null,
  plasma: null,
  bolt: null,
  mortar: TRAIL_SMOKE_DARK,
  missile: TRAIL_SMOKE,
  bossBolt: null,
  supply: TRAIL_SMOKE_BIG,
};
