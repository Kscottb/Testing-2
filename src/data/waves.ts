/**
 * The ten-wave campaign (brief section 3). Counts are the VETERAN baseline; the director multiplies
 * group counts by ctx.mods.enemyCountMul (rounded up, boss excluded).
 */
import type { WaveDef } from '../core/types';

export const WAVES: readonly WaveDef[] = [
  {
    index: 1,
    name: 'FIRST CONTACT',
    zone: 'deck',
    groups: [
      { type: 'skitter', count: 6, at: 0, interval: 0.7 },
      { type: 'skitter', count: 5, at: 10, interval: 0.6 },
    ],
    boss: false,
    maxAlive: 10,
    clearBonus: 500,
    intermissionSeconds: 8,
    unlocksZone: null,
    supply: 'breaker',
    timeOfDay: 'dusk',
  },
  {
    index: 2,
    name: 'GUN PLATFORMS',
    zone: 'deck',
    groups: [
      { type: 'skitter', count: 8, at: 0, interval: 0.6 },
      { type: 'riveter', count: 2, at: 4, interval: 2 },
      { type: 'skitter', count: 4, at: 14, interval: 0.5 },
      { type: 'riveter', count: 2, at: 16, interval: 2.5 },
    ],
    boss: false,
    maxAlive: 12,
    clearBonus: 750,
    intermissionSeconds: 8,
    unlocksZone: null,
    supply: null,
    timeOfDay: 'dusk',
  },
  {
    index: 3,
    name: 'SWARM LOGIC',
    zone: 'deck',
    groups: [
      { type: 'skitter', count: 10, at: 0, interval: 0.5 },
      { type: 'tick', count: 3, at: 5, interval: 1.2 },
      { type: 'riveter', count: 3, at: 8, interval: 2 },
      { type: 'tick', count: 3, at: 18, interval: 1 },
      { type: 'skitter', count: 6, at: 20, interval: 0.4 },
    ],
    boss: false,
    maxAlive: 14,
    clearBonus: 1000,
    intermissionSeconds: 10,
    unlocksZone: 'refinery',
    supply: null,
    timeOfDay: 'dusk',
  },
  {
    index: 4,
    name: 'INTO THE REFINERY',
    zone: 'refinery',
    groups: [
      { type: 'wasp', count: 4, at: 0, interval: 1 },
      { type: 'skitter', count: 8, at: 2, interval: 0.5 },
      { type: 'riveter', count: 4, at: 8, interval: 1.8 },
      { type: 'tick', count: 4, at: 16, interval: 1 },
      { type: 'wasp', count: 3, at: 20, interval: 1.2 },
    ],
    boss: false,
    maxAlive: 16,
    clearBonus: 1250,
    intermissionSeconds: 8,
    unlocksZone: null,
    supply: 'lance',
    timeOfDay: 'twilight',
  },
  {
    index: 5,
    name: 'LONG SIGHTS',
    zone: 'refinery',
    groups: [
      { type: 'lancer', count: 2, at: 0, interval: 3 },
      { type: 'skitter', count: 10, at: 2, interval: 0.5 },
      { type: 'wasp', count: 5, at: 8, interval: 1 },
      { type: 'riveter', count: 4, at: 14, interval: 1.6 },
      { type: 'lancer', count: 1, at: 22, interval: 0 },
      { type: 'tick', count: 4, at: 24, interval: 0.8 },
    ],
    boss: false,
    maxAlive: 16,
    clearBonus: 1500,
    intermissionSeconds: 8,
    unlocksZone: null,
    supply: null,
    timeOfDay: 'twilight',
  },
  {
    index: 6,
    name: 'HEAVY METAL',
    zone: 'refinery',
    groups: [
      { type: 'bulwark', count: 1, at: 0, interval: 0 },
      { type: 'skitter', count: 12, at: 2, interval: 0.45 },
      { type: 'riveter', count: 4, at: 8, interval: 1.6 },
      { type: 'tick', count: 6, at: 14, interval: 0.8 },
      { type: 'lancer', count: 2, at: 18, interval: 3 },
      { type: 'wasp', count: 4, at: 24, interval: 1 },
    ],
    boss: false,
    maxAlive: 18,
    clearBonus: 2000,
    intermissionSeconds: 10,
    unlocksZone: 'spire',
    supply: 'hornet',
    timeOfDay: 'twilight',
  },
  {
    index: 7,
    name: 'STORMFRONT',
    zone: 'spire',
    groups: [
      { type: 'wasp', count: 6, at: 0, interval: 0.8 },
      { type: 'skitter', count: 12, at: 2, interval: 0.4 },
      { type: 'lancer', count: 3, at: 8, interval: 2.5 },
      { type: 'tick', count: 8, at: 14, interval: 0.7 },
      { type: 'bulwark', count: 1, at: 20, interval: 0 },
      { type: 'riveter', count: 4, at: 22, interval: 1.5 },
    ],
    boss: false,
    maxAlive: 18,
    clearBonus: 2500,
    intermissionSeconds: 8,
    unlocksZone: null,
    supply: null,
    timeOfDay: 'stormnight',
  },
  {
    index: 8,
    name: 'CROSSFIRE',
    zone: 'spire',
    groups: [
      { type: 'riveter', count: 6, at: 0, interval: 1.2 },
      { type: 'lancer', count: 2, at: 3, interval: 3 },
      { type: 'wasp', count: 8, at: 8, interval: 0.8 },
      { type: 'skitter', count: 10, at: 12, interval: 0.4 },
      { type: 'bulwark', count: 2, at: 18, interval: 8 },
      { type: 'lancer', count: 2, at: 26, interval: 3 },
      { type: 'tick', count: 6, at: 28, interval: 0.7 },
    ],
    boss: false,
    maxAlive: 20,
    clearBonus: 3000,
    intermissionSeconds: 8,
    unlocksZone: null,
    supply: null,
    timeOfDay: 'stormnight',
  },
  {
    index: 9,
    name: 'LAST LIGHT',
    zone: 'spire',
    groups: [
      { type: 'skitter', count: 16, at: 0, interval: 0.35 },
      { type: 'bulwark', count: 1, at: 2, interval: 0 },
      { type: 'wasp', count: 8, at: 6, interval: 0.7 },
      { type: 'tick', count: 10, at: 12, interval: 0.6 },
      { type: 'riveter', count: 6, at: 16, interval: 1.2 },
      { type: 'lancer', count: 4, at: 20, interval: 2.5 },
      { type: 'bulwark', count: 2, at: 28, interval: 6 },
    ],
    boss: false,
    maxAlive: 22,
    clearBonus: 4000,
    intermissionSeconds: 12,
    unlocksZone: null,
    supply: null,
    timeOfDay: 'stormnight',
  },
  {
    index: 10,
    name: 'THE CONDUCTOR',
    zone: 'spire',
    groups: [{ type: 'conductor', count: 1, at: 0, interval: 0 }],
    boss: true,
    maxAlive: 24,
    clearBonus: 10000,
    intermissionSeconds: 0,
    unlocksZone: null,
    supply: null,
    timeOfDay: 'eclipse',
  },
];

export const TOTAL_WAVES = WAVES.length;

/** Seconds of "get ready" before wave 1 and of boss intro before the boss spawns. */
export const WARMUP_SECONDS = 3;
export const BOSS_INTRO_SECONDS = 4;
/** Seconds between the last kill and the supply drop / perk screen. */
export const CLEARED_SECONDS = 1.6;
/** A supply crate that is not collected within this time opens by itself. */
export const SUPPLY_TIMEOUT_SECONDS = 20;
/** Seconds between the player's death and the game-over screen. */
export const DEATH_DELAY_SECONDS = 1.5;

/** WaveDef for a 1-based wave number (clamped to the table). */
export function waveDef(wave: number): WaveDef {
  const i = Math.min(WAVES.length, Math.max(1, Math.floor(wave))) - 1;
  return WAVES[i] as WaveDef;
}
