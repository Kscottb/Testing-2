/**
 * The colour script (brief section 4). Accent colours carry gameplay meaning — never reuse them for
 * anything else: this is how the player reads a fight.
 */
export const PALETTE = {
  /** Player / friendly / interactable. */
  player: 0x35e0ff,
  /** Enemy. */
  enemy: 0xff4a1c,
  /** Elite / boss. */
  elite: 0xff2a7a,
  /** Danger telegraph. */
  hazard: 0xffc21a,
  /** Lightning. */
  lightning: 0xc9b8ff,

  // UI semantic colours
  uiPrimary: 0x35e0ff,
  uiWarning: 0xffb000,
  uiDanger: 0xff3b30,
  uiText: 0xe8f1f5,
  uiTextDim: 0x8aa0ad,
  uiPanel: 0x0b1218,

  // Vitals
  health: 0x9dff8a,
  shield: 0x35e0ff,
  overclock: 0xfff2b0,

  // Environment (desaturated teal/graphite with warm key light)
  hullWhite: 0xd8d6cf,
  hullGraphite: 0x2a3138,
  hullDark: 0x161b20,
  safetyOrange: 0xf06a1d,
  hazardStripe: 0xe8b21a,
  guideCyan: 0x35e0ff,
  beaconRed: 0xff2d2d,
  shadowTeal: 0x10262d,
  keyWarm: 0xffb27a,

  // Enemy chassis
  gunmetal: 0x23272d,
  gunmetalLight: 0x3a4048,

  // Weapons
  weaponGraphite: 0x2b2f35,
  weaponShell: 0xdcdad3,

  // Page background
  background: 0x05080c,
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** '#rrggbb' string for a 0xRRGGBB number (CSS, canvas 2D). */
export function hexCss(color: number): string {
  return '#' + (color & 0xffffff).toString(16).padStart(6, '0');
}

/** 'rgba(r,g,b,a)' string for a 0xRRGGBB number. */
export function rgbaCss(color: number, alpha: number): string {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;
}
