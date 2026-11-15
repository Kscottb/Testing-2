// STUB: replaced by the enemies team
import * as THREE from 'three';
import { ENEMY_TYPES, MAX_ENEMIES } from '../core/constants';
import { clearDamageInfo, clearDamageResult, makeDamageInfo, makeDamageResult, makeHitSphere } from '../core/make';
import { dirToYaw } from '../core/math';
import { PALETTE } from '../core/palette';
import { ENEMIES } from '../data/enemies';
import type { BossHandle, DamageInfo, DamageResult, EnemyActor, EnemyBehavior, EnemyHandle, EnemyKind, EnemySpawnOptions, EnemySystem, EnemyType, GameContext, HitTarget, Vec3Like } from '../core/types';

type Actor = { -readonly [K in keyof EnemyActor]: EnemyActor[K] } & { behavior: EnemyBehavior; target: HitTarget; name: string; phase: number; phaseCount: number; invulnerable: boolean };

/** Gray-box kind used for every type: a capsule that walks (or flies) at the player and hurts on contact. */
const capsuleKind = (type: EnemyType): EnemyKind => ({
  type,
  create(ctx: GameContext, actor: EnemyActor): EnemyBehavior {
    const def = actor.def;
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(def.radius, Math.max(0.1, def.height - def.radius * 2), 4, 10), new THREE.MeshStandardMaterial({ color: PALETTE.gunmetalLight, emissive: def.accent, emissiveIntensity: 0.6 }));
    mesh.position.y = def.flying ? 0 : def.height / 2;
    actor.root.add(mesh);
    actor.spheres.push(makeHitSphere(Math.max(def.radius, def.height * 0.35)));
    const flow = new THREE.Vector3();
    const hit = makeDamageInfo();
    let cooldown = 0;
    const place = (): void => {
      actor.aimPoint.set(actor.position.x, actor.position.y + (def.flying ? 0 : def.height / 2), actor.position.z);
      (actor.spheres[0] as { center: THREE.Vector3 }).center.copy(actor.aimPoint);
      actor.root.position.copy(actor.position);
      actor.root.rotation.y = actor.yaw;
    };
    return {
      onSpawn: () => { cooldown = 0.5; place(); },
      update(dt: number): void {
        const player = ctx.player;
        flow.subVectors(player.eye, actor.aimPoint);
        const dist = flow.length();
        if (def.flying) flow.set(flow.x, player.position.y + (def.hoverMin + def.hoverMax) * 0.35 - actor.position.y, flow.z).normalize();
        else if (!ctx.nav.sampleFlow(actor.position, flow)) flow.setY(0).normalize();
        const reach = def.radius + 1.3;
        const speed = dist > reach && player.alive ? def.speed * ctx.mods.enemySpeedMul : 0;
        actor.velocity.copy(flow).multiplyScalar(speed).add(actor.knock);
        actor.position.addScaledVector(actor.velocity, dt);
        if (!def.flying) actor.position.y = ctx.nav.heightAt(actor.position.x, actor.position.z, actor.position.y);
        if (speed > 0) actor.yaw = dirToYaw(flow.x, flow.z);
        place();
        cooldown -= dt;
        if (cooldown <= 0 && player.alive && dist <= reach + (def.flying ? 2 : 0)) {
          cooldown = Math.max(0.8, def.attackCooldown);
          clearDamageInfo(hit);
          hit.amount = def.damage; hit.type = 'contact'; hit.faction = 'enemy'; hit.sourceId = actor.id; hit.weapon = 'enemy';
          hit.point.copy(player.eye); hit.dir.subVectors(player.eye, actor.aimPoint).normalize();
          ctx.combat.applyDamage(player.targetId, hit);
        }
      },
      animate: place,
      onKilled: () => ctx.fx.spawn('explosionSmall', actor.aimPoint),
      onDespawn: () => undefined,
    };
  },
});

export function createEnemySystem(ctx: GameContext): EnemySystem {
  const kinds = new Map<EnemyType, EnemyKind>();
  const live: Actor[] = [];
  const result = makeDamageResult();
  const world = makeDamageInfo();
  const tokens = new Map<number, number>();
  const push = new THREE.Vector3();
  const apart = new THREE.Vector3();
  let boss: Actor | null = null;

  const remove = (actor: Actor): void => {
    actor.behavior.onDespawn();
    tokens.delete(actor.id);
    ctx.combat.unregister(actor.id);
    ctx.scene.remove(actor.root);
    actor.root.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    live.splice(live.indexOf(actor), 1);
    if (boss === actor) boss = null;
  };
  const takeDamage = (actor: Actor, info: DamageInfo): DamageResult => {
    clearDamageResult(result, info.part);
    if (!actor.alive || actor.spawning) return result;
    const def = actor.def;
    const crit = info.part === 'weak' && !info.splash;
    const base = info.amount * (crit ? def.weakMul * info.critScale : info.part === 'armor' ? def.armorMul : info.part === 'shield' ? 0 : 1);
    const amount = Math.min(actor.hp, actor.behavior.filterDamage ? actor.behavior.filterDamage(info, base) : base);
    if (amount <= 0) { result.absorbed = true; return result; }
    actor.hp -= amount;
    actor.knock.addScaledVector(info.dir, info.knockback / def.mass);
    result.dealt = result.healthDamage = amount; result.crit = crit; result.killed = actor.hp <= 0;
    const byPlayer = info.faction === 'player';
    if (!result.killed) {
      actor.behavior.onDamaged?.(info, result);
      ctx.events.emit('enemy:damaged', { enemy: actor, info, result });
      const phase = actor.isBoss ? (actor.hp <= actor.maxHp * def.tuning.phase3 ? 3 : actor.hp <= actor.maxHp * def.tuning.phase2 ? 2 : 1) : 1;
      if (phase !== actor.phase) { const prev = actor.phase; actor.phase = phase; ctx.events.emit('boss:phase', { boss: actor as BossHandle, phase, prev }); }
      return result;
    }
    actor.alive = false; actor.target.alive = false;
    if (!info.silent) actor.behavior.onKilled(info);
    ctx.events.emit('enemy:killed', { enemy: actor, type: actor.type, position: actor.aimPoint, info, weapon: info.weapon, crit, byPlayer, score: info.silent ? 0 : def.score });
    if (actor.isBoss && !info.silent) ctx.events.emit('boss:defeated', { boss: actor as BossHandle, position: actor.aimPoint, sequenceSeconds: 1 });
    return result;
  };

  const system: EnemySystem = {
    registerKind: (kind) => void kinds.set(kind.type, kind),
    spawn(type: EnemyType, position: Vec3Like, opts: EnemySpawnOptions = {}): EnemyHandle | null {
      const kind = kinds.get(type);
      if (!kind || live.length >= MAX_ENEMIES) return null;
      const def = ENEMIES[type];
      const isBoss = type === 'conductor';
      const hp = def.hp * (isBoss ? ctx.mods.bossHealthMul : ctx.mods.enemyHealthMul) * (opts.hpMul ?? 1);
      const actor = { id: ctx.nextId(), type, def, root: new THREE.Group(), spheres: [], position: new THREE.Vector3(position.x, position.y, position.z), velocity: new THREE.Vector3(), aimPoint: new THREE.Vector3(), knock: new THREE.Vector3(), radius: def.radius, height: def.height, yaw: opts.yaw ?? 0, hp, maxHp: hp, alive: true, spawning: false, zone: ctx.world.zoneAt(position.x, position.z), isBoss, summoned: opts.summoned ?? false, stun: 0, age: 0, name: def.name, phase: 1, phaseCount: 3, invulnerable: false } as unknown as Actor;
      actor.behavior = kind.create(ctx, actor);
      actor.target = { id: actor.id, faction: 'enemy', alive: true, center: actor.aimPoint, boundRadius: Math.max(def.radius, def.height / 2), spheres: actor.spheres, takeDamage: (info) => takeDamage(actor, info), enemy: actor };
      actor.behavior.onSpawn(opts);
      ctx.scene.add(actor.root);
      ctx.combat.register(actor.target);
      live.push(actor);
      ctx.events.emit('enemy:spawned', { enemy: actor });
      if (isBoss) { boss = actor; ctx.events.emit('boss:spawned', { boss: actor as BossHandle }); }
      return actor;
    },
    list: live,
    get aliveCount() { let n = 0; for (const a of live) if (a.alive) n++; return n; },
    get waveCount() { let n = 0; for (const a of live) if (a.alive && !a.summoned) n++; return n; },
    countOf: (type) => live.filter((a) => a.alive && a.type === type).length,
    get: (id) => live.find((a) => a.id === id),
    nearest(pos: Vec3Like, maxDist: number): EnemyHandle | null {
      let best: Actor | null = null;
      let bestD = maxDist;
      for (const a of live) { const d = a.aimPoint.distanceTo(pos as THREE.Vector3); if (a.alive && !a.spawning && d <= bestD) { bestD = d; best = a; } }
      return best;
    },
    queryRadius(center: Vec3Like, radius: number, out: EnemyHandle[]): number {
      out.length = 0;
      for (const a of live) if (a.alive && !a.spawning && a.aimPoint.distanceTo(center as THREE.Vector3) <= radius) out.push(a);
      return out.length;
    },
    killAll(silent = false): number {
      const count = live.length;
      for (const actor of [...live]) {
        clearDamageInfo(world);
        world.amount = actor.hp * 1000; world.type = 'hazard'; world.weapon = 'world'; world.silent = silent; world.critScale = 0;
        world.point.copy(actor.aimPoint);
        if (actor.alive) { actor.spawning = false; takeDamage(actor, world); }
        remove(actor);
      }
      return count;
    },
    get boss() { return boss as BossHandle | null; },
    tryAcquireAttackToken(id: number, weight = 1): boolean {
      let used = 0;
      for (const w of tokens.values()) used += w;
      if (tokens.has(id) || used + weight > ctx.mods.attackTokens) return tokens.has(id);
      tokens.set(id, weight);
      return true;
    },
    releaseAttackToken: (id) => void tokens.delete(id),
    separation(enemy: EnemyHandle, radius: number, out: THREE.Vector3): THREE.Vector3 {
      out.set(0, 0, 0);
      for (const a of live) {
        if (a.id === enemy.id) continue;
        push.subVectors(enemy.position, a.position).setY(0);
        const d = push.length();
        if (d > 1e-3 && d < radius) out.addScaledVector(push, (1 - d / radius) / d);
      }
      return out.clampLength(0, 1);
    },
    init(): void { for (const type of ENEMY_TYPES) system.registerKind(capsuleKind(type)); },
    reset(): void { for (const actor of [...live]) remove(actor); tokens.clear(); boss = null; },
    update(dt: number): void {
      ctx.nav.updateFlowField(ctx.player.position);
      for (let i = live.length - 1; i >= 0; i--) {
        const actor = live[i] as Actor;
        if (!actor.alive) { remove(actor); continue; }
        actor.age += dt;
        actor.knock.multiplyScalar(Math.exp(-6 * dt));
        if (ctx.debug.freezeAi || ctx.game.mode !== 'playing') actor.behavior.animate?.(dt);
        else { actor.behavior.update(dt); system.separation(actor, actor.radius * 2.2, apart); actor.position.addScaledVector(apart, dt * 2); }
      }
    },
    dispose(): void { system.reset(); },
  };
  return system;
}
