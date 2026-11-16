/**
 * COMBAT — the shared rules of violence: hit targets and traces, the one damage entry point, the
 * hit-confirm feedback of player hits, projectiles and explosions (CombatSystem, core/types.ts §17).
 *
 *   targets.ts      registry + ray / pierce / radius queries (no damage, no feedback, no allocation)
 *   feedback.ts     hit spark per ray; per target and substep one number, one sound, one 'hit:confirmed'
 *   explosions.ts   FIFO blast queue, radial damage, and the audiovisual package of every blast
 *   projectiles.ts  pooled simulation with continuous collision, bounces, fuses, homing, shoot-down
 *   visuals.ts      instanced projectile meshes
 *   tuning.ts       everything the contract leaves to combat's judgement
 *   testkit.ts      test support only (a recording GameContext); nothing in the game imports it
 */
import * as THREE from 'three';
import { clearDamageResult, makeDamageResult } from '../core/make';
import type {
  CombatSystem,
  DamageInfo,
  DamageResult,
  ExplosionOptions,
  Faction,
  GameContext,
  HitTarget,
  PierceResult,
  ProjectileOptions,
  ShotHit,
  TraceOptions,
  Vec3Like,
} from '../core/types';
import { createExplosionQueue } from './explosions';
import { createHitFeedback } from './feedback';
import { createProjectileSystem } from './projectiles';
import { createTargetRegistry } from './targets';
import { createProjectileVisuals } from './visuals';
import type { ProjectileVisuals } from './visuals';

/** Refused explode() requests are reported at most this often (a caller bug must not end the run). */
const MAX_INVALID_REPORTS = 3;

export function createCombatSystem(ctx: GameContext): CombatSystem {
  // Plain data only up here: the other systems do not exist yet and are reached through ctx at call time.
  const registry = createTargetRegistry(() => ctx.collision);
  const feedback = createHitFeedback(ctx);
  /** The answer for unknown and dead targets. */
  const nothing = makeDamageResult();
  let invalidBlasts = 0;

  const applyDamage = (target: HitTarget | number, info: DamageInfo): DamageResult => {
    const victim = typeof target === 'number' ? registry.get(target) : target;
    // Unknown, unregistered and dead targets deal 0 — and so does a damage that is not a number.
    if (!victim || !victim.alive || !registry.has(victim) || Number.isNaN(info.amount)) {
      return clearDamageResult(nothing, info.part);
    }
    // No multiplier of ours: the attacker's factors are in info.amount, the victim applies its own.
    const result = victim.takeDamage(info);
    if (
      info.faction === 'player' &&
      victim.faction !== 'player' &&
      !info.silent &&
      info.amount > 0 &&
      (result.dealt > 0 || result.absorbed)
    ) {
      feedback.record(victim, info, result);
    }
    return result;
  };

  const explosions = createExplosionQueue(ctx, registry, applyDamage);
  const projectiles = createProjectileSystem(ctx, registry, explosions, applyDamage);

  const root = new THREE.Group();
  root.name = 'combat';
  let visuals: ProjectileVisuals | null = null;

  const combat: CombatSystem = {
    register(target: HitTarget): void {
      registry.register(target);
    },
    unregister(id: number): void {
      registry.unregister(id);
    },
    getTarget: (id) => registry.get(id),

    traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: ShotHit): boolean {
      return registry.traceShot(origin, dir, maxDist, opts, out);
    },
    tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: PierceResult): number {
      return registry.tracePierce(origin, dir, maxDist, opts, out);
    },
    queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number {
      return registry.queryRadius(center, radius, faction, out);
    },

    applyDamage,

    explode(opts: ExplosionOptions): void {
      // Never resolved in here: queued, then resolved (damage, fx, sound) by update() in FIFO order.
      if (!explosions.enqueue(opts) && invalidBlasts++ < MAX_INVALID_REPORTS) {
        ctx.game.reportError('combat:explode', new Error('explosion with a non-finite position, radius or damage was ignored'));
      }
    },

    spawnProjectile(opts: ProjectileOptions): number {
      return projectiles.spawn(opts);
    },
    removeProjectile(id: number, detonate = false): boolean {
      const removed = projectiles.remove(id, detonate);
      if (removed) visuals?.sync(projectiles.live);
      return removed;
    },
    clearProjectiles(faction?: Faction): void {
      projectiles.clear(faction);
      visuals?.sync(projectiles.live);
    },
    get projectileCount(): number {
      return projectiles.count;
    },

    init(): void {
      if (visuals) return;
      visuals = createProjectileVisuals();
      root.add(visuals.group);
      ctx.scene.add(root);
      // One of each projectile mesh, compiled against the scene's lights and fog before the first fight.
      ctx.render.warm(root);
    },

    reset(): void {
      // Silent: no fx, no sound. Registrations are KEPT — owners unregister their own targets.
      projectiles.clear();
      explosions.clear();
      feedback.clear();
      visuals?.hide();
    },

    update(dt: number): void {
      // Targets were posed by their owners earlier in this substep: re-measure the broad phase once.
      registry.refresh();
      try {
        // 1. projectiles, each on its own clock.
        projectiles.update(dt);
        // 2. the explosion queue, FIFO, chain reactions included, up to the cap.
        explosions.resolve();
        // 3. one number, one sound, one 'hit:confirmed' per target the player damaged.
        feedback.flush();
      } finally {
        // Whatever happened above, the picture matches the projectiles that are left.
        visuals?.sync(projectiles.live);
      }
    },

    dispose(): void {
      projectiles.clear();
      explosions.clear();
      feedback.clear();
      registry.clear();
      ctx.scene.remove(root);
      if (visuals) {
        root.remove(visuals.group);
        visuals.dispose();
        visuals = null;
      }
    },
  };
  return combat;
}
