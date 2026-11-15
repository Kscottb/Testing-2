import { PALETTE } from '../core/palette';
import type { PickupDef, PickupType } from '../core/types';

/** Pickups dropped by enemies: magnetise within 3 m, expire after 25 s (brief section 3). */
export const PICKUPS: Readonly<Record<PickupType, PickupDef>> = {
  ammo: {
    type: 'ammo',
    name: 'AMMO',
    amount: 0.25,
    weight: 5,
    lifetime: 25,
    magnetRadius: 3,
    collectRadius: 1,
    color: PALETTE.uiText,
  },
  health: {
    type: 'health',
    name: 'HEALTH CELL',
    amount: 25,
    weight: 3,
    lifetime: 25,
    magnetRadius: 3,
    collectRadius: 1,
    color: PALETTE.health,
  },
  shield: {
    type: 'shield',
    name: 'SHIELD CELL',
    amount: 40,
    weight: 2,
    lifetime: 25,
    magnetRadius: 3,
    collectRadius: 1,
    color: PALETTE.shield,
  },
  grenade: {
    type: 'grenade',
    name: 'GRENADE',
    amount: 1,
    weight: 1.5,
    lifetime: 25,
    magnetRadius: 3,
    collectRadius: 1,
    color: PALETTE.weaponShell,
  },
  weapon: {
    type: 'weapon',
    name: 'SUPPLY CRATE',
    amount: 1,
    weight: 0,
    lifetime: Infinity,
    magnetRadius: 0,
    collectRadius: 2,
    color: PALETTE.player,
  },
};
