/**
 * Shared identifiers of the FX system: sprite cells of the atlas, particle flags, streak styles and the
 * hard limits the contract puts on effect lifetimes.
 */

/** Cells of the 4 x 4 sprite atlas (see atlas.ts). */
export const SPR = {
  GLOW: 0,
  SPARK: 1,
  SMOKE_A: 2,
  SMOKE_B: 3,
  FIRE: 4,
  RING: 5,
  SHARD: 6,
  FLARE: 7,
  BURST: 8,
  DOT: 9,
  ZAP: 10,
  WISP: 11,
  HALO: 12,
  HEX: 13,
  PLUS: 14,
  CASING: 15,
} as const;

/** Radius of the RING sprite's bright edge as a fraction of the quad's half size. */
export const RING_EDGE = 0.856;
/** Radius of the HALO sprite's crest as a fraction of the quad's half size. */
export const HALO_EDGE = 0.677;

/** Particle flags (ParticleSim.flags). */
export const PF_ADD = 1;
export const PF_STRETCH = 2;
export const PF_ALIGNED = 4;
export const PF_BOUNCE = 8;
export const PF_PLAYER_CLOCK = 16;

/** A burst must be over within 2.5 s, one puff of a stream within 0.25 s (FxSystem.spawn). */
export const MAX_BURST_LIFE = 2.4;
export const MAX_STREAM_LIFE = 0.25;

/** Fragment styles of the streak batch (tracers, beams, glow dots). */
export const STYLE = {
  TRACER: 0,
  RAIL: 1,
  LASER: 2,
  LOCK: 3,
  SWEEP: 4,
  DOT: 5,
} as const;

/** Floats per instance of the particle / streak batches. */
export const PARTICLE_STRIDE = 16;
export const STREAK_STRIDE = 16;
export const RIBBON_STRIDE = 24;
export const TELEGRAPH_STRIDE = 12;
export const DECAL_STRIDE = 18;
export const NUMBER_STRIDE = 12;

/** three.js candela per normalised lightFlash unit: 1 lights a white wall 3 m away to about mid-grey. */
export const LIGHT_UNIT = 6;
