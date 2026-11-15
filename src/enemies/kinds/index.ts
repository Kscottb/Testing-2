// STUB: replaced by the enemies team
/**
 * THE registration point for enemy kinds: one import line + one array entry per kind, e.g.
 *
 *   import { skitterKind } from './skitter';
 *   export const ENEMY_KINDS: readonly EnemyKind[] = [skitterKind, tickKind, riveterKind];
 *
 * Each kind lives in `./<type>.ts` and exports `<type>Kind`. The manager registers every entry and
 * falls back to `placeholderKind(type)` (./placeholder.ts) for each EnemyType that is missing here.
 */
import type { EnemyKind } from '../../core/types';

export const ENEMY_KINDS: readonly EnemyKind[] = [];
