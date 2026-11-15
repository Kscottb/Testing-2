/**
 * Runtime constants that belong to the contract in core/types.ts.
 */
import type {
  Difficulty,
  EnemyType,
  FxId,
  InputAction,
  PerkId,
  PickupType,
  ProjectileKind,
  QualityPreset,
  QualitySetting,
  TimeOfDayId,
  TimeScaleSource,
  WeaponId,
  ZoneId,
} from './types';

export const WEAPON_IDS: readonly WeaponId[] = ['vector', 'breaker', 'lance', 'hornet'];
export const ENEMY_TYPES: readonly EnemyType[] = [
  'skitter',
  'riveter',
  'wasp',
  'tick',
  'lancer',
  'bulwark',
  'conductor',
];
export const ZONE_IDS: readonly ZoneId[] = ['deck', 'refinery', 'spire'];
export const DIFFICULTIES: readonly Difficulty[] = ['recruit', 'veteran', 'nightmare'];
export const PICKUP_TYPES: readonly PickupType[] = ['ammo', 'health', 'shield', 'grenade', 'weapon'];
export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];
/** Values of SettingsData.quality ('auto' is resolved by render). */
export const QUALITY_SETTINGS: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high', 'ultra'];
export const PROJECTILE_KINDS: readonly ProjectileKind[] = [
  'rocket',
  'grenade',
  'plasmaBolt',
  'lightBolt',
  'mortar',
  'bossBolt',
  'bossMissile',
];
export const TIME_SCALE_SOURCES: readonly TimeScaleSource[] = [
  'overclock',
  'hitstop',
  'slowmo',
  'bossStaging',
  'perkSelect',
  'debug',
];
export const TIME_OF_DAY_IDS: readonly TimeOfDayId[] = ['dusk', 'twilight', 'stormnight', 'eclipse'];
export const PERK_IDS: readonly PerkId[] = [
  'damage',
  'fireRate',
  'magSize',
  'reloadSpeed',
  'maxShield',
  'maxHealth',
  'shieldRegen',
  'moveSpeed',
  'doubleJump',
  'dashCharge',
  'lifeOnKill',
  'chainLightning',
  'explosiveCrits',
  'scavenger',
  'overclockGain',
  'grenadier',
  'critDamage',
  'lastStand',
];
export const INPUT_ACTIONS: readonly InputAction[] = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'lookLeft',
  'lookRight',
  'lookUp',
  'lookDown',
  'fire',
  'ads',
  'reload',
  'jump',
  'sprint',
  'crouch',
  'dash',
  'overclock',
  'melee',
  'grenade',
  'weapon1',
  'weapon2',
  'weapon3',
  'weapon4',
  'weaponNext',
  'weaponPrev',
  'pause',
  'perk1',
  'perk2',
  'perk3',
  'uiUp',
  'uiDown',
  'uiLeft',
  'uiRight',
  'uiConfirm',
  'uiBack',
];

/**
 * Collision flag bits: what a box BLOCKS. Queries pass a mask; a box is tested when
 * (box.flags & mask) !== 0.
 */
export const COL = {
  /** Blocks the player's body. */
  PLAYER: 1,
  /** Blocks enemy bodies and defines the nav grid floor/obstacles. */
  ENEMY: 2,
  /** Blocks projectiles and hitscan. */
  PROJECTILE: 4,
  /** Blocks AI line of sight. */
  SIGHT: 8,
  /** Ordinary geometry: blocks everything. */
  SOLID: 15,
  /** Invisible wall for the player only (map edge, anti-fall rails). */
  PLAYER_CLIP: 1,
  /** Keeps ground AI out of a region without affecting the player. */
  ENEMY_CLIP: 2,
  /** Closed energy gate: stops bodies and shots, can be seen through. */
  GATE: 7,
  /** Glass: stops bodies and shots, can be seen through. */
  GLASS: 7,
  /** Railing / grating: stops bodies, shots and sight pass. */
  RAILING: 3,
  /** Every bit (overlap queries that should see all boxes). */
  ANY: 15,
} as const;

/** Largest simulation step; frames longer than this are split into at most MAX_SUBSTEPS. */
export const MAX_STEP = 1 / 30;
export const MAX_SUBSTEPS = 3;
/** Real frame deltas are clamped to this before sub-stepping. */
export const MAX_FRAME_DT = MAX_STEP * MAX_SUBSTEPS;

/** Player body (brief section 3). */
export const PLAYER = {
  HALF_WIDTH: 0.35,
  HEIGHT: 1.8,
  CROUCH_HEIGHT: 1.1,
  EYE: 1.65,
  CROUCH_EYE: 1.0,
  STEP_UP: 0.45,
  MAX_HP: 100,
  MAX_SHIELD: 100,
  SHIELD_REGEN: 25,
  SHIELD_DELAY: 4,
  WALK: 6.5,
  SPRINT: 9.5,
  CROUCH: 3.5,
  JUMP_APEX: 1.25,
  GRAVITY: 24,
  COYOTE: 0.1,
  JUMP_BUFFER: 0.12,
  SLIDE_SPEED: 12,
  SLIDE_SECONDS: 0.9,
  DASH_SECONDS: 0.16,
  DASH_SPEED: 24,
  DASH_COOLDOWN: 2.5,
  DASH_IFRAMES: 0.15,
  OVERCLOCK_SECONDS: 6,
  OVERCLOCK_SCALE: 0.4,
  LOW_HEALTH: 0.3,
  /** Knockback divisor of the player (DamageInfo.knockback / MASS = velocity change). */
  MASS: 2,
} as const;

/** Upper bound of the knockback velocity a victim accumulates (m/s), whatever the number of rays. */
export const KNOCKBACK_MAX = 12;

/** Score / combo rules (brief section 3). */
export const SCORING = {
  COMBO_WINDOW: 4,
  COMBO_MAX: 8,
  /** Kills needed per extra multiplier step. */
  COMBO_STEP: 3,
  CRIT_BONUS: 0.5,
  MULTIKILL_WINDOW: 1.2,
  MULTIKILL_BONUS: 150,
} as const;

/** Hard cap of enemy actors in the scene (EnemySystem.spawn returns null beyond it). */
export const MAX_ENEMIES = 64;
/** Hard cap of live projectiles (combat removes the oldest to make room). */
export const MAX_PROJECTILES = 96;
/** Length of the lightning arrival (ring telegraph before the bolt), seconds of world time. */
export const ENEMY_ARRIVAL_SECONDS = 0.8;
/** The perk1..3 actions are ignored for this long (ctx.time.elapsed) after an offer appears. */
export const PERK_INPUT_GUARD_SECONDS = 0.6;

/**
 * STREAM effects (see FxSystem.spawn): one spawn() = one short puff; the owner re-spawns every 0.05 s
 * while the state lasts. Every other FxId is a BURST: one call is the complete effect.
 */
export const FX_STREAM_IDS: readonly FxId[] = [
  'lanceCharge',
  'riveterCharge',
  'lancerCharge',
  'bossCharge',
  'bossSweepCharge',
  'bossSweepHit',
  'tickArm',
  'enemySmoke',
  'enemySparks',
  'slideSparks',
  'steamVent',
  'sparkShower',
  'hazardArc',
];
/** Seconds between two spawn() calls of a stream effect. */
export const FX_STREAM_INTERVAL = 0.05;

/**
 * Pool capacities FX allocates in init() (the "ultra" caps; quality presets only lower the active
 * counts). telegraph() and persistent beam() never fail below these numbers.
 */
export const FX_CAPS = {
  particles: 4000,
  telegraphs: 96,
  beams: 32,
  trails: 96,
  bolts: 24,
  damageNumbers: 64,
  tracers: 128,
  lights: 6,
  /** Pooled lights that may be held by keyed (moving / pulsing) lightFlash calls. */
  keyedLights: 2,
} as const;

/**
 * mesh.renderOrder for every transparent or additive object (see RENDERING CONVENTIONS in core/types.ts),
 * so effects of different systems sort the same way from every camera position.
 */
export const RENDER_ORDER = {
  SKY: -100,
  OPAQUE: 0,
  DECAL: 10,
  TELEGRAPH: 12,
  WORLD_TRANSPARENT: 20,
  PICKUP: 25,
  ENEMY_SHIELD: 30,
  FX_ALPHA: 40,
  BEAM: 50,
  FX_ADDITIVE: 60,
  WEATHER: 70,
  DAMAGE_NUMBER: 80,
} as const;

/** Storage keys (all prefixed by the storage wrapper). */
export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  BEST: 'best',
} as const;
