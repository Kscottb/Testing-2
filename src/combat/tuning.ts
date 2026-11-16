/**
 * Combat-internal tuning: everything the contract leaves to combat's judgement (feedback strengths,
 * bounce feel, the audiovisual package per explosion look, the impact feedback per projectile kind).
 * Per-kind gameplay defaults that shooters rely on live in data/projectiles.ts, not here.
 */
import { PALETTE } from '../core/palette';
import type {
  CombatFxId,
  CombatSoundId,
  DecalKind,
  ExplosionVisual,
  Faction,
  HitPart,
  ProjectileKind,
  SharedFxId,
  SharedSoundId,
  SurfaceType,
} from '../core/types';

/** Blasts resolved per update; the rest waits for the next substep (CombatSystem.update, step 2). */
export const MAX_BLASTS_PER_UPDATE = 32;

/** Explosion defaults of ExplosionOptions. */
export const BLAST_DEFAULTS = {
  edgeFalloff: 0.2,
  selfDamageMul: 0.35,
  knockback: 6,
  /** `visual` default: 'small' below this radius, 'large' from it on. */
  largeFromRadius: 4,
} as const;

/** Projectile defaults of ProjectileOptions that are not per kind. */
export const PROJECTILE_DEFAULTS = {
  lifetime: 8,
  /** Seconds over which the drawn position blends from visualOrigin onto the simulated path. */
  visualBlend: 0.15,
} as const;

/**
 * Removal margins around ctx.world.bounds: a shot at the perimeter still reaches its wall, a lobbed
 * shell may leave through the top and come back.
 */
export const BOUNDS_MARGIN = { side: 4, below: 6, above: 80 } as const;

/** Bounce feel (restitution comes from ProjectileOptions.bounce). */
export const BOUNCE = {
  /** Fraction of the tangential speed kept per bounce (friction). */
  tangentKeep: 0.72,
  /** A floor contact slower than this (m/s along the normal) ends the hopping: the shell rolls. */
  settleSpeed: 1.3,
  /** Rolling deceleration in m/s^2 and the speed below which it comes to rest. */
  rollDecel: 8,
  restSpeed: 0.35,
  /** Surfaces at least this upright count as floor. */
  floorNormalY: 0.7,
  /** Bounce fx + sound: minimum impact speed and minimum seconds between two of one projectile. */
  feedbackSpeed: 1.6,
  feedbackInterval: 0.09,
} as const;

/** 'bulletWhiz': an enemy projectile passing this close to the eye without hitting. */
export const WHIZ = { radius: 2, minSpeed: 10 } as const;

/** The shootable hit sphere is this much larger than the collision radius (a missile is a small target). */
export const SHOOTABLE_SPHERE_SCALE = 1.5;

/** Warm fire light: deliberately none of the five accent colours. */
export const FIRE_COLOR = 0xffa45a;
export const FIRE_FLASH_COLOR = 0xffe9cf;
/** Concussion without fire: neutral pale blue-white. */
export const SHOCK_COLOR = 0xbcd6ff;
export const SHOCK_FLASH_COLOR = 0xe6f0ff;
export const BOSS_FLASH_COLOR = 0xffd3e2;

/** The audiovisual package of one explosion look (everything combat.explode plays besides the damage). */
export interface BlastLook {
  fx: CombatFxId;
  sound: CombatSoundId;
  /** Scorch kind left on the nearest surface, and its size as a fraction of the damage radius. */
  decal: DecalKind;
  decalScale: number;
  /** Also spawn 'shockwaveRing' on the floor when the blast is near it. */
  ring: boolean;
  /** Pooled light: colour (0 = by faction accent), normalised intensity, reach as a multiple of the radius, seconds. */
  lightColor: number;
  lightIntensity: number;
  lightReach: number;
  lightSeconds: number;
  /** Camera trauma at the centre and how far (multiple of the radius) it is felt. */
  trauma: number;
  shakeReach: number;
  /** Gamepad rumble at the centre (falls off over RUMBLE_RANGE). */
  rumble: number;
  rumbleSeconds: number;
  /** Close-range treatment at point-blank: chromatic boost, screen flash, hit-stop seconds (0 = none). */
  chroma: number;
  flash: number;
  flashColor: number;
  hitstop: number;
  /** SoundOptions.priority of the blast sound. */
  priority: number;
}

export const BLAST_LOOKS: Readonly<Record<Exclude<ExplosionVisual, 'none'>, BlastLook>> = {
  small: {
    fx: 'explosionSmall',
    sound: 'explosionSmall',
    decal: 'scorch',
    decalScale: 0.55,
    ring: false,
    lightColor: FIRE_COLOR,
    lightIntensity: 2,
    lightReach: 2.6,
    lightSeconds: 0.28,
    trauma: 0.32,
    shakeReach: 3.5,
    rumble: 0.45,
    rumbleSeconds: 0.14,
    chroma: 0.35,
    flash: 0.14,
    flashColor: FIRE_FLASH_COLOR,
    hitstop: 0,
    priority: 2,
  },
  large: {
    fx: 'explosionLarge',
    sound: 'explosionLarge',
    decal: 'scorch',
    decalScale: 0.6,
    ring: true,
    lightColor: FIRE_COLOR,
    lightIntensity: 3,
    lightReach: 2.8,
    lightSeconds: 0.42,
    trauma: 0.6,
    shakeReach: 4,
    rumble: 0.8,
    rumbleSeconds: 0.22,
    chroma: 0.7,
    flash: 0.3,
    flashColor: FIRE_FLASH_COLOR,
    hitstop: 0.05,
    priority: 2,
  },
  plasma: {
    fx: 'explosionPlasma',
    sound: 'explosionPlasma',
    decal: 'plasmaBurn',
    decalScale: 0.6,
    ring: false,
    lightColor: 0,
    lightIntensity: 2,
    lightReach: 2.6,
    lightSeconds: 0.24,
    trauma: 0.3,
    shakeReach: 3.5,
    rumble: 0.4,
    rumbleSeconds: 0.12,
    chroma: 0.45,
    flash: 0.12,
    flashColor: 0,
    hitstop: 0,
    priority: 2,
  },
  shock: {
    fx: 'explosionShock',
    sound: 'explosionShock',
    decal: 'crack',
    decalScale: 0.5,
    ring: true,
    lightColor: SHOCK_COLOR,
    lightIntensity: 2.4,
    lightReach: 2.4,
    lightSeconds: 0.3,
    trauma: 0.55,
    shakeReach: 4,
    rumble: 0.7,
    rumbleSeconds: 0.2,
    chroma: 0.8,
    flash: 0.16,
    flashColor: SHOCK_FLASH_COLOR,
    hitstop: 0.04,
    priority: 2,
  },
  boss: {
    fx: 'explosionBoss',
    sound: 'explosionBoss',
    decal: 'scorch',
    decalScale: 0.7,
    ring: true,
    lightColor: PALETTE.elite,
    lightIntensity: 6,
    lightReach: 3,
    lightSeconds: 0.6,
    trauma: 0.9,
    shakeReach: 6,
    rumble: 1,
    rumbleSeconds: 0.35,
    chroma: 1,
    flash: 0.5,
    flashColor: BOSS_FLASH_COLOR,
    hitstop: 0.07,
    priority: 3,
  },
};

/** Blast feedback ranges that do not depend on the look. */
export const BLAST_FEEL = {
  /** 'explosionDistant' replaces the near sound beyond this distance from the listener (contract). */
  distantFrom: 40,
  /** Rumble only within this distance of the player (contract). */
  rumbleRange: 12,
  /** Minimum reach of the camera shake in metres. */
  minShakeReach: 12,
  /** "Close" = within radius * closeScale + closeBase metres of the eye; the treatment scales to 0 there. */
  closeScale: 1.2,
  closeBase: 3,
  /** Hit-stop only above this closeness (0..1). */
  hitstopFrom: 0.35,
  /** Screen flash only above this closeness. */
  flashFrom: 0.12,
  /** How far below a blast the floor may be for the ground ring and the scorch. */
  groundReachScale: 0.5,
  groundReachMax: 2.5,
  /** Decal size clamp in metres. */
  decalMin: 0.6,
  decalMax: 5,
  /** The origin is lifted this far (headroom permitting) for the cover test, so a kerb does not shield a whole room. */
  sightLift: 0.5,
} as const;

/** The burst of a projectile that was shot down (harmless: no damage is dealt). */
export const SHOOTDOWN = {
  fxRadius: 1.4,
  volume: 0.7,
  pitch: 1.25,
  lightIntensity: 1.6,
  lightRadius: 6,
  lightSeconds: 0.2,
  trauma: 0.12,
  shakeRadius: 10,
} as const;

/** Hit spark per part struck (CombatFxId hitEnemy*). */
export const HIT_FX: Readonly<Record<HitPart, CombatFxId>> = {
  body: 'hitEnemy',
  weak: 'hitEnemyWeak',
  armor: 'hitEnemyArmor',
  shield: 'hitEnemyShield',
};

/** Merge order of 'hit:confirmed'.part: weak > body > armor > shield. */
export const PART_RANK: Readonly<Record<HitPart, number>> = { weak: 3, body: 2, armor: 1, shield: 0 };

/** A merged number below this is not drawn (a floating "0" for a fully absorbed hit says nothing). */
export const MIN_DAMAGE_NUMBER = 0.5;

export const SURFACE_FX: Readonly<Record<SurfaceType, SharedFxId>> = {
  metal: 'impactMetal',
  plating: 'impactPlating',
  grate: 'impactGrate',
  glass: 'impactGlass',
  energy: 'impactEnergy',
};

export const SURFACE_SOUND: Readonly<Record<SurfaceType, SharedSoundId>> = {
  metal: 'impactMetal',
  plating: 'impactPlating',
  grate: 'impactGrate',
  glass: 'impactGlass',
  energy: 'impactEnergy',
};

/** What a projectile WITHOUT splash leaves on the world (explosive ones get the blast package instead). */
export interface ImpactLook {
  /** Flavour effect; null = the surface's own impact effect. */
  fx: SharedFxId | null;
  sound: SharedSoundId | null;
  fxScale: number;
  volume: number;
  pitch: number;
  decal: DecalKind;
  decalSize: number;
  /** Pooled light (intensity 0 = none). */
  lightIntensity: number;
  lightRadius: number;
  lightSeconds: number;
}

const SOLID_IMPACT: ImpactLook = {
  fx: null,
  sound: null,
  fxScale: 1.4,
  volume: 1,
  pitch: 0.8,
  decal: 'crack',
  decalSize: 0.5,
  lightIntensity: 0,
  lightRadius: 0,
  lightSeconds: 0,
};

export const IMPACT_LOOKS: Readonly<Record<ProjectileKind, ImpactLook>> = {
  rocket: SOLID_IMPACT,
  grenade: SOLID_IMPACT,
  mortar: SOLID_IMPACT,
  bossMissile: SOLID_IMPACT,
  plasmaBolt: {
    fx: 'impactPlasma',
    sound: 'impactPlasma',
    fxScale: 1,
    volume: 0.9,
    pitch: 1,
    decal: 'plasmaBurn',
    decalSize: 0.55,
    lightIntensity: 1.2,
    lightRadius: 5,
    lightSeconds: 0.14,
  },
  lightBolt: {
    fx: 'impactBolt',
    sound: 'impactPlasma',
    fxScale: 0.7,
    volume: 0.5,
    pitch: 1.45,
    decal: 'plasmaBurn',
    decalSize: 0.28,
    lightIntensity: 0,
    lightRadius: 0,
    lightSeconds: 0,
  },
  bossBolt: {
    fx: 'impactPlasma',
    sound: 'impactPlasma',
    fxScale: 1.6,
    volume: 1,
    pitch: 0.75,
    decal: 'plasmaBurn',
    decalSize: 0.95,
    lightIntensity: 2,
    lightRadius: 7,
    lightSeconds: 0.18,
  },
};

/**
 * Accent of a projectile kind in the colour script: the boss's and the bulwark's ordnance is elite
 * magenta, everything else reads by the faction that fired it. Explosive hardware of the player keeps
 * the player cyan for its engine and indicator lights.
 */
export function projectileAccent(kind: ProjectileKind, faction: Faction): number {
  if (faction === 'player') return PALETTE.player;
  if (kind === 'bossBolt' || kind === 'bossMissile' || kind === 'mortar') return PALETTE.elite;
  return PALETTE.enemy;
}

/** Light / tint of energy that belongs to a faction (plasma blasts without a projectile to take it from). */
export function factionAccent(faction: Faction): number {
  return faction === 'player' ? PALETTE.player : faction === 'enemy' ? PALETTE.enemy : FIRE_COLOR;
}
