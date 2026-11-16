/**
 * Per-kind projectile defaults (see ProjectileDef). Shooters pass only what differs per shot through
 * ProjectileOptions; combat reads the rest from here.
 */
import { PROJECTILE_KINDS } from '../core/constants';
import type { ProjectileDef, ProjectileKind } from '../core/types';

export const PROJECTILES: Readonly<Record<ProjectileKind, ProjectileDef>> = {
  /** HORNET micro-missile (player). */
  rocket: { kind: 'rocket', radius: 0.18, type: 'explosion', trail: 'rocket', loop: 'rocketLoop', visual: 'large', shootable: false },
  /** Frag grenade (player): bounces until its fuse ends. */
  grenade: { kind: 'grenade', radius: 0.12, type: 'explosion', trail: 'grenade', loop: null, visual: 'large', shootable: false },
  /** Riveter burst bolt. */
  plasmaBolt: { kind: 'plasmaBolt', radius: 0.16, type: 'plasma', trail: 'plasma', loop: null, visual: 'plasma', shootable: false },
  /** Wasp rapid light bolt. */
  lightBolt: { kind: 'lightBolt', radius: 0.1, type: 'plasma', trail: 'bolt', loop: null, visual: 'none', shootable: false },
  /** Bulwark lobbed shell (pass gravity + landingTelegraph). */
  mortar: { kind: 'mortar', radius: 0.3, type: 'explosion', trail: 'mortar', loop: 'mortarLoop', visual: 'large', shootable: false },
  /** Conductor volley bolt. */
  bossBolt: { kind: 'bossBolt', radius: 0.26, type: 'plasma', trail: 'bossBolt', loop: null, visual: 'plasma', shootable: false },
  /** Conductor homing missile: the player can shoot it down. */
  bossMissile: { kind: 'bossMissile', radius: 0.35, type: 'explosion', trail: 'missile', loop: 'missileLoop', visual: 'small', shootable: true },
};

export const PROJECTILE_LIST: readonly ProjectileDef[] = PROJECTILE_KINDS.map((kind) => PROJECTILES[kind]);
