// STUB: gray-box stand-in for every enemy kind that has no real implementation yet
import * as THREE from 'three';
import { clearDamageInfo, makeDamageInfo, makeHitSphere } from '../../core/make';
import { dirToYaw } from '../../core/math';
import { PALETTE } from '../../core/palette';
import type { EnemyActor, EnemyBehavior, EnemyKind, EnemyType, FxId, GameContext } from '../../core/types';

const DEATH_FX: Record<EnemyType, FxId> = { skitter: 'deathSkitter', riveter: 'deathRiveter', wasp: 'deathWasp', tick: 'deathTick', lancer: 'deathLancer', bulwark: 'deathBulwark', conductor: 'deathConductor' };

/** A capsule that walks (or flies) at the player through the manager's integrators and hurts on contact. */
export function placeholderKind(type: EnemyType): EnemyKind {
  return {
    type,
    create(ctx: GameContext, actor: EnemyActor): EnemyBehavior {
      const def = actor.def;
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(def.radius, Math.max(0.1, def.height - def.radius * 2), 4, 10), new THREE.MeshStandardMaterial({ color: PALETTE.gunmetalLight, emissive: def.accent, emissiveIntensity: 0.6 }));
      mesh.castShadow = true;
      mesh.position.y = def.flying ? 0 : def.height / 2;
      actor.root.add(mesh);
      actor.spheres.push(makeHitSphere(Math.max(def.radius, def.height * 0.35)));
      const want = new THREE.Vector3();
      const hit = makeDamageInfo();
      let cooldown = 0;
      /** Pose the root, the aim point and every sphere centre from position / yaw. */
      const place = (): void => {
        actor.aimPoint.set(actor.position.x, actor.position.y + (def.flying ? 0 : def.height / 2), actor.position.z);
        (actor.spheres[0] as { center: THREE.Vector3 }).center.copy(actor.aimPoint);
        actor.root.position.copy(actor.position);
        actor.root.rotation.y = actor.yaw;
      };
      return {
        onSpawn(): void {
          cooldown = 0.5;
          if (actor.isBoss) actor.phaseCount = 3;
          place();
        },
        update(dt: number): void {
          const player = ctx.player;
          want.subVectors(player.center, actor.aimPoint);
          const dist = want.length();
          const reach = def.radius + 1.3;
          const speed = dist > reach && actor.stun <= 0 ? actor.speed : 0;
          if (def.flying) {
            want.setY(player.position.y + (def.hoverMin + def.hoverMax) * 0.35 - actor.position.y).normalize().multiplyScalar(speed);
            ctx.enemies.moveFlying(actor, want, dt, def.hoverMin * 0.5);
          } else {
            if (!ctx.nav.sampleFlow(actor.position, want)) want.setY(0).normalize();
            want.multiplyScalar(speed);
            ctx.enemies.moveGround(actor, want, dt);
          }
          if (want.x * want.x + want.z * want.z > 0.01) actor.yaw = dirToYaw(want.x, want.z);
          place();
          cooldown -= dt;
          // canAttack may have turned false earlier in this very substep: check right before the hit.
          if (cooldown <= 0 && ctx.enemies.canAttack && dist <= reach + (def.flying ? 2 : 0)) {
            cooldown = Math.max(0.8, def.attackCooldown);
            clearDamageInfo(hit);
            hit.amount = def.damage; hit.type = 'contact'; hit.faction = 'enemy'; hit.sourceId = actor.id; hit.weapon = 'enemy';
            hit.point.copy(player.center); hit.dir.subVectors(player.center, actor.aimPoint).normalize();
            ctx.combat.applyDamage(player.targetId, hit);
          }
        },
        animate: place,
        onDamaged(): void {
          // The boss kind drives its own phases (the manager never derives them from hp).
          if (!actor.isBoss) return;
          const f = actor.hp / actor.maxHp;
          ctx.enemies.setBossPhase(actor.id, f <= (def.tuning.phase3 ?? 0) ? 3 : f <= (def.tuning.phase2 ?? 0) ? 2 : 1);
        },
        onKilled(): number {
          ctx.fx.spawn(DEATH_FX[type], actor.aimPoint);
          // The boss stays as a corpse for its staged death; this value becomes 'boss:defeated'.sequenceSeconds.
          return actor.isBoss ? (def.tuning.deathSeconds ?? 0) : 0;
        },
        updateDying(dt: number): void {
          actor.root.rotation.z += dt * 0.6;
        },
        onDespawn(): void {
          actor.root.rotation.z = 0;
        },
      };
    },
  };
}
