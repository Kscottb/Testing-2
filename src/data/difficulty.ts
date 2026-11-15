import { DIFFICULTIES } from '../core/constants';
import type { Difficulty, DifficultyDef } from '../core/types';

/** Recruit / Veteran / Nightmare (brief section 3). */
export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyDef>> = {
  recruit: {
    id: 'recruit',
    name: 'RECRUIT',
    description: 'Fewer, weaker machines. Learn the rig.',
    enemyHealthMul: 0.8,
    enemyDamageMul: 0.6,
    enemySpeedMul: 0.95,
    enemyCountMul: 0.8,
    bossHealthMul: 0.7,
    scoreMul: 0.75,
    attackTokens: 2,
    dropMul: 1.3,
  },
  veteran: {
    id: 'veteran',
    name: 'VETERAN',
    description: 'The intended fight.',
    enemyHealthMul: 1,
    enemyDamageMul: 1,
    enemySpeedMul: 1,
    enemyCountMul: 1,
    bossHealthMul: 1,
    scoreMul: 1,
    attackTokens: 3,
    dropMul: 1,
  },
  nightmare: {
    id: 'nightmare',
    name: 'NIGHTMARE',
    description: 'Denser waves that hit much harder.',
    enemyHealthMul: 1.3,
    enemyDamageMul: 1.6,
    enemySpeedMul: 1.1,
    enemyCountMul: 1.35,
    bossHealthMul: 1.4,
    scoreMul: 1.6,
    attackTokens: 5,
    dropMul: 0.8,
  },
};

export const DIFFICULTY_LIST: readonly DifficultyDef[] = DIFFICULTIES.map((id) => DIFFICULTY[id]);
