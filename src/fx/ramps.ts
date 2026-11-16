/**
 * Life curves of particles, baked into one lookup table. A ramp has four channels over the normalised
 * life t: `mix` blends the particle's colour A toward its colour B, `white` pulls the result toward
 * white-hot, `gain` is the HDR intensity and `alpha` the coverage.
 */

/** Samples per ramp and floats per sample. */
export const RAMP_SAMPLES = 16;
export const RAMP_STRIDE = 4;

/** One key: [t, mix, white, gain, alpha]. Keys are sorted by t; the first is at 0, the last at 1. */
type Key = readonly [number, number, number, number, number];

const DEFS = {
  /** Instant flash that collapses. */
  FLASH: [
    [0, 0, 0.9, 1, 1],
    [0.15, 0, 0.6, 0.75, 1],
    [0.5, 0.3, 0.1, 0.25, 0.8],
    [1, 1, 0, 0, 0],
  ],
  /** Soft pulse: quick in, slow out. */
  PULSE: [
    [0, 0, 0.5, 0, 0],
    [0.12, 0, 0.5, 1, 1],
    [0.45, 0.3, 0.1, 0.6, 0.9],
    [1, 1, 0, 0, 0],
  ],
  /** Fire: white-hot, through colour A to colour B, then out. */
  FIRE: [
    [0, 0, 0.95, 1.5, 1],
    [0.1, 0, 0.55, 1.2, 1],
    [0.3, 0.25, 0.05, 0.85, 1],
    [0.65, 0.8, 0, 0.4, 0.8],
    [1, 1, 0, 0, 0],
  ],
  /** Plasma: a short white core, then pure colour that thins out. */
  PLASMA: [
    [0, 0, 0.7, 1.4, 1],
    [0.12, 0, 0.2, 1.1, 1],
    [0.45, 0.5, 0, 0.75, 0.9],
    [1, 1, 0, 0, 0],
  ],
  /** Sparks: hot for most of their life, then cool quickly. */
  SPARK: [
    [0, 0, 0.5, 1.2, 1],
    [0.25, 0.1, 0.15, 1, 1],
    [0.7, 0.6, 0, 0.7, 1],
    [1, 1, 0, 0, 0],
  ],
  /** Smoke: fades in, lingers, thins out. */
  SMOKE: [
    [0, 0, 0, 1, 0],
    [0.1, 0.1, 0, 1, 0.8],
    [0.45, 0.6, 0, 1, 0.55],
    [1, 1, 0, 1, 0],
  ],
  /** Dust: lighter and shorter than smoke. */
  DUST: [
    [0, 0, 0, 1, 0],
    [0.12, 0, 0, 1, 0.55],
    [0.5, 0.5, 0, 1, 0.3],
    [1, 1, 0, 1, 0],
  ],
  /** Expanding ring: bright edge that thins as it grows. */
  RING: [
    [0, 0, 0.7, 1.3, 1],
    [0.2, 0, 0.3, 1, 1],
    [0.6, 0.5, 0, 0.55, 0.9],
    [1, 1, 0, 0, 0],
  ],
  /** Solid debris: hot at first (colour A), cold (colour B), gone at the very end. */
  DEBRIS: [
    [0, 0, 0, 1, 1],
    [0.3, 0.7, 0, 1, 1],
    [0.82, 1, 0, 1, 1],
    [1, 1, 0, 1, 0],
  ],
  /** Embers: steady glow, slow fade. */
  EMBER: [
    [0, 0, 0.4, 1, 1],
    [0.3, 0.2, 0.1, 0.9, 1],
    [0.75, 0.7, 0, 0.6, 1],
    [1, 1, 0, 0, 0],
  ],
  /** Converging motes: fade in while they travel, brightest on arrival. */
  GATHER: [
    [0, 0, 0, 0, 0],
    [0.3, 0, 0.1, 0.6, 1],
    [0.85, 0, 0.5, 1.2, 1],
    [1, 0, 0.8, 0.4, 0.3],
  ],
  /** Long hold with short ramps at both ends. */
  HOLD: [
    [0, 0, 0.3, 0, 0],
    [0.08, 0, 0.3, 1, 1],
    [0.7, 0.3, 0, 0.9, 1],
    [1, 1, 0, 0, 0],
  ],
  /** Electric flicker. */
  FLICKER: [
    [0, 0, 0.9, 1.3, 1],
    [0.18, 0, 0.3, 0.25, 1],
    [0.34, 0, 0.8, 1.1, 1],
    [0.52, 0, 0.2, 0.2, 1],
    [0.7, 0.3, 0.5, 0.8, 1],
    [1, 1, 0, 0, 0],
  ],
  /** Steam: bright vapour that vanishes fast. */
  STEAM: [
    [0, 0, 0, 1, 0],
    [0.15, 0, 0, 1, 0.6],
    [0.5, 0.5, 0, 1, 0.35],
    [1, 1, 0, 1, 0],
  ],
} as const satisfies Record<string, readonly Key[]>;

export type RampName = keyof typeof DEFS;
const NAMES = Object.keys(DEFS) as RampName[];

/** Ramp ids: RAMP.FIRE etc. index into the table returned by bakeRamps(). */
export const RAMP = Object.fromEntries(NAMES.map((name, index) => [name, index])) as Record<RampName, number>;
export const RAMP_COUNT = NAMES.length;

/** Bake every ramp into RAMP_COUNT * RAMP_SAMPLES * RAMP_STRIDE floats. */
export function bakeRamps(): Float32Array {
  const table = new Float32Array(RAMP_COUNT * RAMP_SAMPLES * RAMP_STRIDE);
  for (let r = 0; r < RAMP_COUNT; r++) {
    const keys: readonly Key[] = DEFS[NAMES[r] as RampName];
    for (let s = 0; s < RAMP_SAMPLES; s++) {
      const t = s / (RAMP_SAMPLES - 1);
      let k = 0;
      while (k < keys.length - 2 && t > (keys[k + 1] as Key)[0]) k++;
      const a = keys[k] as Key;
      const b = keys[k + 1] as Key;
      const span = b[0] - a[0];
      const f = span > 0 ? Math.min(1, Math.max(0, (t - a[0]) / span)) : 1;
      const o = (r * RAMP_SAMPLES + s) * RAMP_STRIDE;
      for (let c = 0; c < RAMP_STRIDE; c++) table[o + c] = a[c + 1]! + (b[c + 1]! - a[c + 1]!) * f;
    }
  }
  return table;
}
