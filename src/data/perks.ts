/**
 * Roguelite perks (brief section 3). `apply` adds ONE stack to the run modifiers. Instant side
 * effects (healing on a max-health perk, refilling grenades ...) are the director's job.
 */
import { PERK_IDS } from '../core/constants';
import type { PerkDef, PerkId } from '../core/types';

export const PERKS: Readonly<Record<PerkId, PerkDef>> = {
  damage: {
    id: 'damage',
    name: 'OVERPRESSURE',
    description: '+15% weapon damage.',
    maxStacks: 5,
    rarity: 'common',
    icon: 'damage',
    apply: (m) => {
      m.damageMul += 0.15;
    },
  },
  fireRate: {
    id: 'fireRate',
    name: 'HAIR TRIGGER',
    description: '+12% rate of fire and charge speed.',
    maxStacks: 4,
    rarity: 'common',
    icon: 'fireRate',
    apply: (m) => {
      m.fireRateMul += 0.12;
    },
  },
  magSize: {
    id: 'magSize',
    name: 'EXTENDED CELLS',
    description: '+25% magazine size.',
    maxStacks: 3,
    rarity: 'common',
    icon: 'magSize',
    apply: (m) => {
      m.magSizeMul += 0.25;
    },
  },
  reloadSpeed: {
    id: 'reloadSpeed',
    name: 'QUICK HANDS',
    description: '+20% reload speed.',
    maxStacks: 3,
    rarity: 'common',
    icon: 'reloadSpeed',
    apply: (m) => {
      m.reloadSpeedMul += 0.2;
    },
  },
  maxShield: {
    id: 'maxShield',
    name: 'CAPACITOR BANK',
    description: '+25 maximum shield.',
    maxStacks: 4,
    rarity: 'common',
    icon: 'maxShield',
    apply: (m) => {
      m.maxShieldBonus += 25;
    },
  },
  maxHealth: {
    id: 'maxHealth',
    name: 'REINFORCED FRAME',
    description: '+25 maximum health and a full heal.',
    maxStacks: 4,
    rarity: 'common',
    icon: 'maxHealth',
    apply: (m) => {
      m.maxHealthBonus += 25;
    },
  },
  shieldRegen: {
    id: 'shieldRegen',
    name: 'FAST RECHARGE',
    description: 'Shield recharges 35% faster and starts 20% sooner.',
    maxStacks: 3,
    rarity: 'common',
    icon: 'shieldRegen',
    apply: (m) => {
      m.shieldRegenMul += 0.35;
      m.shieldDelayMul *= 0.8;
    },
  },
  moveSpeed: {
    id: 'moveSpeed',
    name: 'SERVO BOOST',
    description: '+8% movement speed.',
    maxStacks: 3,
    rarity: 'common',
    icon: 'moveSpeed',
    apply: (m) => {
      m.moveSpeedMul += 0.08;
    },
  },
  doubleJump: {
    id: 'doubleJump',
    name: 'THRUSTER PACK',
    description: 'Gain an extra jump in mid-air.',
    maxStacks: 1,
    rarity: 'rare',
    icon: 'doubleJump',
    apply: (m) => {
      m.extraJumps += 1;
    },
  },
  dashCharge: {
    id: 'dashCharge',
    name: 'BLINK COILS',
    description: '+1 dash charge and 15% faster dash recharge.',
    maxStacks: 2,
    rarity: 'rare',
    icon: 'dashCharge',
    apply: (m) => {
      m.extraDashCharges += 1;
      m.dashCooldownMul *= 0.85;
    },
  },
  lifeOnKill: {
    id: 'lifeOnKill',
    name: 'SALVAGE PROTOCOL',
    description: 'Restore 3 health on every kill.',
    maxStacks: 3,
    rarity: 'rare',
    icon: 'lifeOnKill',
    apply: (m) => {
      m.lifeOnKill += 3;
    },
  },
  chainLightning: {
    id: 'chainLightning',
    name: 'ARC ROUNDS',
    description: 'Hits arc to a nearby enemy for 35% damage. More stacks, more arcs.',
    maxStacks: 3,
    rarity: 'epic',
    icon: 'chainLightning',
    apply: (m) => {
      m.chainLightning += 1;
    },
  },
  explosiveCrits: {
    id: 'explosiveCrits',
    name: 'VOLATILE CORES',
    description: 'Weak-point kills detonate the target.',
    maxStacks: 3,
    rarity: 'epic',
    icon: 'explosiveCrits',
    apply: (m) => {
      m.explosiveCrits += 1;
    },
  },
  scavenger: {
    id: 'scavenger',
    name: 'SCAVENGER',
    description: 'Ammo pickups give 50% more and enemies drop supplies more often.',
    maxStacks: 2,
    rarity: 'common',
    icon: 'scavenger',
    apply: (m) => {
      m.ammoPickupMul += 0.5;
      m.dropChanceBonus += 0.05;
    },
  },
  overclockGain: {
    id: 'overclockGain',
    name: 'HOT CLOCK',
    description: 'Overclock charges 30% faster and lasts 1 second longer.',
    maxStacks: 3,
    rarity: 'rare',
    icon: 'overclockGain',
    apply: (m) => {
      m.overclockGainMul += 0.3;
      m.overclockDurationBonus += 1;
    },
  },
  grenadier: {
    id: 'grenadier',
    name: 'GRENADIER',
    description: '+1 grenade capacity and 20% bigger, harder blasts.',
    maxStacks: 3,
    rarity: 'common',
    icon: 'grenadier',
    apply: (m) => {
      m.grenadeCapBonus += 1;
      m.grenadePowerMul += 0.2;
    },
  },
  critDamage: {
    id: 'critDamage',
    name: 'WEAK POINT ANALYSIS',
    description: '+30% weak-point damage.',
    maxStacks: 4,
    rarity: 'rare',
    icon: 'critDamage',
    apply: (m) => {
      m.critDamageMul += 0.3;
    },
  },
  lastStand: {
    id: 'lastStand',
    name: 'LAST STAND',
    description: 'Once per run, survive a lethal hit with a full shield.',
    maxStacks: 2,
    rarity: 'epic',
    icon: 'lastStand',
    apply: (m) => {
      m.lastStand += 1;
    },
  },
};

export const PERK_LIST: readonly PerkDef[] = PERK_IDS.map((id) => PERKS[id]);

/** How many perks are offered per choice. */
export const PERK_CHOICES = 3;
