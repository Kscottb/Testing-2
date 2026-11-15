/**
 * Allocation helpers for the plain-data structs of the contract. Create these ONCE (module-level
 * scratch) and reuse them; never allocate them inside update().
 */
import * as THREE from 'three';
import type {
  DamageInfo,
  DamageResult,
  FxSpawnOptions,
  HitPart,
  HitSphere,
  LookDelta,
  Modifiers,
  MoveResult,
  NavPath,
  PierceResult,
  RayHit,
  RunStats,
  ScreenPoint,
  ShotHit,
  SoundOptions,
} from './types';

export function makeRayHit(): RayHit {
  return { distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), boxId: -1, surface: 'metal' };
}

export function makeMoveResult(): MoveResult {
  return {
    grounded: false,
    hitX: false,
    hitZ: false,
    hitCeiling: false,
    stepped: 0,
    snapped: 0,
    groundBoxId: -1,
    groundSurface: 'metal',
    wallBoxId: -1,
  };
}

export function makeShotHit(): ShotHit {
  return {
    kind: 'none',
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    target: null,
    part: 'body',
    sphereIndex: -1,
    surface: 'metal',
    boxId: -1,
  };
}

/** `capacity` = max targets a piercing ray reports. */
export function makePierceResult(capacity = 16): PierceResult {
  const hits: ShotHit[] = [];
  for (let i = 0; i < capacity; i++) hits.push(makeShotHit());
  return {
    hits,
    count: 0,
    end: new THREE.Vector3(),
    endNormal: new THREE.Vector3(0, 1, 0),
    hitWorld: false,
    surface: 'metal',
    boxId: -1,
  };
}

export function makeDamageInfo(): DamageInfo {
  return {
    amount: 0,
    type: 'bullet',
    faction: 'neutral',
    sourceId: 0,
    weapon: null,
    part: 'body',
    sphereIndex: -1,
    critScale: 1,
    point: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    knockback: 0,
    splash: false,
    creditPlayer: false,
    silent: false,
  };
}

/** Reset a DamageInfo to neutral defaults (keeps its vectors). Returns it. */
export function clearDamageInfo(info: DamageInfo): DamageInfo {
  info.amount = 0;
  info.type = 'bullet';
  info.faction = 'neutral';
  info.sourceId = 0;
  info.weapon = null;
  info.part = 'body';
  info.sphereIndex = -1;
  info.critScale = 1;
  info.point.set(0, 0, 0);
  info.dir.set(0, 0, 0);
  info.knockback = 0;
  info.splash = false;
  info.creditPlayer = false;
  info.silent = false;
  return info;
}

export function makeDamageResult(): DamageResult {
  return { dealt: 0, healthDamage: 0, shieldDamage: 0, killed: false, crit: false, absorbed: false, part: 'body' };
}

/** Zero a DamageResult (the "nothing happened" value). Returns it. */
export function clearDamageResult(result: DamageResult, part: HitPart = 'body'): DamageResult {
  result.dealt = 0;
  result.healthDamage = 0;
  result.shieldDamage = 0;
  result.killed = false;
  result.crit = false;
  result.absorbed = false;
  result.part = part;
  return result;
}

export function makeHitSphere(radius: number, part: HitPart = 'body'): HitSphere {
  return { center: new THREE.Vector3(), radius, part, enabled: true };
}

export function makeNavPath(capacity = 32): NavPath {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < capacity; i++) points.push(new THREE.Vector3());
  return { points, count: 0 };
}

export function makeScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, depth: 0, visible: false };
}

export function makeLookDelta(): LookDelta {
  return { yaw: 0, pitch: 0 };
}

/** FxSpawnOptions that owns its vectors, for callers that spawn effects from update paths. */
export type FxOptionsScratch = FxSpawnOptions & {
  normal: THREE.Vector3;
  dir: THREE.Vector3;
  velocity: THREE.Vector3;
};

/** Reusable FxSpawnOptions (module-level scratch). Every field starts at its documented default. */
export function makeFxOptions(): FxOptionsScratch {
  return clearFxOptions({
    normal: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
  });
}

/** Restore the defaults (normal and dir up, no velocity, scale 1, authored size and colour, world clock). Returns it. */
export function clearFxOptions(options: FxOptionsScratch): FxOptionsScratch {
  options.normal.set(0, 1, 0);
  options.dir.set(0, 1, 0);
  options.velocity.set(0, 0, 0);
  options.scale = 1;
  options.radius = undefined;
  options.charge = undefined;
  options.color = undefined;
  options.clock = 'world';
  return options;
}

/** Reusable SoundOptions (module-level scratch) at the documented defaults; `timeScaled` stays unset (per-call default). */
export function makeSoundOptions(): SoundOptions {
  return { volume: 1, pitch: 1, delay: 0, priority: 1, owner: 0 };
}

export function makeModifiers(): Modifiers {
  return resetModifiers({} as Modifiers);
}

/** Restore every modifier to its documented default. Core calls it before every run. Returns `mods`. */
export function resetModifiers(mods: Modifiers): Modifiers {
  mods.damageMul = 1;
  mods.fireRateMul = 1;
  mods.magSizeMul = 1;
  mods.reloadSpeedMul = 1;
  mods.critDamageMul = 1;
  mods.chainLightning = 0;
  mods.explosiveCrits = 0;
  mods.grenadeCapBonus = 0;
  mods.grenadePowerMul = 1;
  mods.maxShieldBonus = 0;
  mods.maxHealthBonus = 0;
  mods.shieldRegenMul = 1;
  mods.shieldDelayMul = 1;
  mods.moveSpeedMul = 1;
  mods.extraJumps = 0;
  mods.dashCooldownMul = 1;
  mods.extraDashCharges = 0;
  mods.lifeOnKill = 0;
  mods.overclockGainMul = 1;
  mods.overclockDurationBonus = 0;
  mods.lastStand = 0;
  mods.damageTakenMul = 1;
  mods.ammoPickupMul = 1;
  mods.dropChanceBonus = 0;
  mods.scoreMul = 1;
  mods.enemyCountMul = 1;
  mods.enemyHealthMul = 1;
  mods.bossHealthMul = 1;
  mods.enemySpeedMul = 1;
  mods.attackTokens = 3;
  return mods;
}

export function makeRunStats(): RunStats {
  return resetRunStats({ perks: [] } as unknown as RunStats);
}

/** Zero the statistics of a run in place (keeps object identity). Returns `stats`. */
export function resetRunStats(stats: RunStats): RunStats {
  stats.kills = 0;
  stats.shots = 0;
  stats.hits = 0;
  stats.accuracy = 0;
  stats.crits = 0;
  stats.damageDealt = 0;
  stats.damageTaken = 0;
  stats.seconds = 0;
  stats.bestCombo = 0;
  stats.bestMultikill = 0;
  stats.wave = 0;
  stats.score = 0;
  stats.perks.length = 0;
  stats.grade = '';
  stats.victory = false;
  return stats;
}
