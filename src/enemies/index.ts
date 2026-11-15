// STUB: replaced by the enemies team
import * as THREE from 'three';
import { COL, ENEMY_ARRIVAL_SECONDS, ENEMY_TYPES, KNOCKBACK_MAX, MAX_ENEMIES } from '../core/constants';
import { clearDamageInfo, clearDamageResult, makeDamageInfo, makeDamageResult } from '../core/make';
import { clamp, damp, dirToYaw, isFiniteVec3 } from '../core/math';
import { ENEMIES } from '../data/enemies';
import { ENEMY_KINDS } from './kinds';
import { placeholderKind } from './kinds/placeholder';
import type { BossHandle, DamageInfo, DamageResult, EnemyActor, EnemyBehavior, EnemyHandle, EnemyKillOptions, EnemyKind, EnemySpawnOptions, EnemySystem, EnemyType, GameContext, HitTarget, SoundId, Vec3Like } from '../core/types';

type Actor = { -readonly [K in keyof EnemyActor]: EnemyActor[K] } & { behavior: EnemyBehavior; target: HitTarget; arrival: number; corpse: number; losAt: number; los: boolean };
const SPAWN_SOUND: Record<EnemyType, SoundId> = { skitter: 'skitterSpawn', riveter: 'riveterSpawn', wasp: 'waspSpawn', tick: 'tickSpawn', lancer: 'lancerSpawn', bulwark: 'bulwarkSpawn', conductor: 'conductorSpawn' };
const TOKEN_TIMEOUT = 8;
const LOS_INTERVAL = 0.15;

/** Gray-box manager: pooling, arrival, hp arithmetic, corpses, tokens and the two integrators — no finesse. */
export function createEnemySystem(ctx: GameContext): EnemySystem {
  const kinds = new Map<EnemyType, EnemyKind>();
  const pools = new Map<EnemyType, Actor[]>();
  const live: Actor[] = [];
  const order: Actor[] = [];
  const byId = new Map<number, Actor>();
  const tokens = new Map<number, { weight: number; at: number }>();
  const result = makeDamageResult();
  const world = makeDamageInfo();
  const push = new THREE.Vector3();
  const apart = new THREE.Vector3();
  const to = new THREE.Vector3();
  const sky = new THREE.Vector3();
  const root = new THREE.Group();
  root.name = 'enemies';
  let boss: Actor | null = null;
  let wasAttacking = false;
  let lastFlash = -Infinity;

  const report = (actor: Actor, error: unknown): void => ctx.game.reportError(`enemy:${actor.type}`, error);
  const inScene = (actor: Actor): boolean => byId.get(actor.id) === actor;

  const create = (type: EnemyType, kind: EnemyKind): Actor => {
    const def = ENEMIES[type];
    const actor = { id: 0, type, def, root: new THREE.Group(), spheres: [], position: new THREE.Vector3(), velocity: new THREE.Vector3(), aimPoint: new THREE.Vector3(), knock: new THREE.Vector3(), radius: def.radius, height: def.height, yaw: 0, hp: 0, maxHp: 0, alive: false, spawning: false, dying: false, zone: null, isBoss: type === 'conductor', summoned: false, speed: def.speed, stun: 0, age: 0, name: def.name, phase: 1, phaseCount: 1, invulnerable: false, arrival: 0, corpse: 0, losAt: -1, los: false } as unknown as Actor;
    actor.behavior = kind.create(ctx, actor);
    actor.root.visible = false;
    root.add(actor.root);
    return actor;
  };
  /** Free the slot for any reason. */
  const despawn = (actor: Actor): void => {
    if (!inScene(actor)) return;
    byId.delete(actor.id);
    live.splice(live.indexOf(actor), 1);
    tokens.delete(actor.id);
    actor.alive = actor.dying = actor.spawning = false;
    actor.target.alive = false;
    ctx.combat.unregister(actor.id);
    ctx.fx.cancelOwner(actor.id);
    ctx.audio.stopOwner(actor.id);
    try { actor.behavior.onDespawn(); } catch (error) { report(actor, error); }
    actor.root.visible = false;
    if (boss === actor) boss = null;
    pools.get(actor.type)?.push(actor);
  };
  /** The arrival is over: the machine appears and becomes a target. */
  const land = (actor: Actor): void => {
    actor.spawning = false;
    actor.root.visible = true;
    ctx.combat.register(actor.target);
    ctx.audio.playAt(SPAWN_SOUND[actor.type], actor.aimPoint, { owner: actor.id });
  };
  const strike = (actor: Actor): void => {
    sky.copy(actor.position).setY(actor.position.y + 60);
    ctx.fx.lightningBolt(sky, actor.position, { light: actor.def.spawnKind === 'heavy' });
    ctx.fx.spawn('spawnFlash', actor.position);
    ctx.audio.playAt('spawnStrike', actor.position);
    // At most one sky flash per 0.5 s however many machines arrive.
    if (ctx.time.now - lastFlash >= 0.5) { lastFlash = ctx.time.now; ctx.render.lightningFlash(0.15); }
    land(actor);
  };
  /** hp reached 0 (or kill()): the normal death path. */
  const die = (actor: Actor, info: DamageInfo, crit: boolean): void => {
    const silent = info.silent;
    const arriving = actor.spawning;
    actor.alive = false; actor.spawning = false; actor.hp = 0; actor.target.alive = false;
    ctx.combat.unregister(actor.id);
    tokens.delete(actor.id);
    ctx.fx.cancelOwner(actor.id);
    ctx.audio.stopOwner(actor.id);
    let corpse = 0;
    if (!silent && !arriving) {
      try { corpse = actor.behavior.onKilled(info) || 0; } catch (error) { report(actor, error); }
    }
    const byPlayer = info.faction === 'player' || info.creditPlayer;
    ctx.events.emit('enemy:killed', { enemy: actor, type: actor.type, position: actor.aimPoint, info, weapon: info.weapon, crit, byPlayer, score: byPlayer && !silent ? actor.def.score : 0 });
    if (actor.isBoss && !silent) {
      // The fight is over: remove the adds (world kills; the real manager staggers them over 0.6 s) and their shots.
      for (const other of [...live]) if (other !== actor && other.alive) system.kill(other.id);
      ctx.combat.clearProjectiles('enemy');
      ctx.events.emit('boss:defeated', { boss: actor as BossHandle, position: actor.aimPoint, sequenceSeconds: corpse });
    }
    if (corpse > 0 && Number.isFinite(corpse) && inScene(actor)) { actor.dying = true; actor.corpse = corpse; } else despawn(actor);
  };
  const takeDamage = (actor: Actor, info: DamageInfo): DamageResult => {
    clearDamageResult(result, info.part);
    if (!actor.alive || actor.spawning) return result;
    if (actor.invulnerable) { result.absorbed = true; return result; }
    const def = actor.def;
    const weak = info.part === 'weak' && !info.splash;
    const base = info.amount * (weak ? def.weakMul * info.critScale : info.part === 'armor' ? def.armorMul : info.part === 'shield' ? 0 : 1);
    let amount = base;
    if (actor.behavior.filterDamage) {
      try { amount = actor.behavior.filterDamage(info, base, result); } catch (error) { report(actor, error); despawn(actor); return clearDamageResult(result, info.part); }
    }
    amount = Number.isFinite(amount) ? clamp(amount, 0, actor.hp) : 0;
    result.healthDamage = amount; result.dealt = amount + result.shieldDamage; result.crit = weak && amount > 0; result.absorbed = amount <= 0;
    // Knockback sums per substep and is clamped; light units are stunned by melee and rail hits.
    actor.knock.addScaledVector(info.dir, info.knockback / def.mass).clampLength(0, KNOCKBACK_MAX);
    if (def.mass <= 3 && (info.type === 'melee' || info.type === 'rail')) { actor.stun = Math.max(actor.stun, info.type === 'melee' ? 0.35 : 0.2); tokens.delete(actor.id); }
    actor.hp -= amount;
    if (actor.hp > 0) {
      if (result.dealt > 0) {
        try { actor.behavior.onDamaged?.(info, result); } catch (error) { report(actor, error); despawn(actor); return result; }
        ctx.events.emit('enemy:damaged', { enemy: actor, info, result });
      }
      return result;
    }
    result.killed = true;
    die(actor, info, result.crit);
    return result;
  };

  const system: EnemySystem = {
    registerKind(kind: EnemyKind): void {
      kinds.set(kind.type, kind);
      for (const stale of pools.get(kind.type) ?? []) root.remove(stale.root);
      pools.set(kind.type, []);
    },
    spawn(type: EnemyType, position: Vec3Like, opts: EnemySpawnOptions = {}): EnemyHandle | null {
      const kind = kinds.get(type);
      if (!kind || live.length >= MAX_ENEMIES) return null;
      let actor: Actor;
      try { actor = pools.get(type)?.pop() ?? create(type, kind); } catch (error) { ctx.game.reportError(`enemy:${type}`, error); return null; }
      const def = actor.def;
      const instant = (opts.instant ?? false) || actor.isBoss;
      actor.id = ctx.nextId();
      actor.position.set(position.x, position.y, position.z);
      actor.velocity.set(0, 0, 0); actor.knock.set(0, 0, 0);
      actor.hp = actor.maxHp = def.hp * (actor.isBoss ? ctx.mods.bossHealthMul : ctx.mods.enemyHealthMul) * (opts.hpMul ?? 1);
      actor.speed = def.speed * ctx.mods.enemySpeedMul;
      actor.radius = def.radius; actor.height = def.height;
      actor.yaw = dirToYaw(ctx.player.position.x - position.x, ctx.player.position.z - position.z);
      actor.alive = true; actor.dying = false; actor.spawning = !instant; actor.stun = 0; actor.age = 0;
      actor.name = def.name; actor.phase = 1; actor.phaseCount = 1; actor.invulnerable = false;
      actor.summoned = opts.summoned ?? false;
      actor.zone = ctx.world.zoneAt(position.x, position.z);
      actor.arrival = ENEMY_ARRIVAL_SECONDS; actor.corpse = 0; actor.losAt = -1;
      actor.target = { id: actor.id, faction: 'enemy', alive: true, center: actor.aimPoint, boundRadius: Math.max(def.radius, def.height / 2), spheres: actor.spheres, takeDamage: (info) => takeDamage(actor, info), enemy: actor };
      live.push(actor); byId.set(actor.id, actor);
      try { actor.behavior.onSpawn(opts); } catch (error) { report(actor, error); despawn(actor); return null; }
      if (instant) land(actor);
      else {
        ctx.fx.telegraph({ kind: 'spawn', position: actor.position, radius: def.radius * 1.5 + 0.5, seconds: ENEMY_ARRIVAL_SECONDS, owner: actor.id });
        ctx.audio.playAt('spawnTelegraph', actor.position, { owner: actor.id });
      }
      ctx.events.emit('enemy:spawned', { enemy: actor });
      if (actor.isBoss) { boss = actor; ctx.events.emit('boss:spawned', { boss: actor as BossHandle }); }
      return actor;
    },
    list: live,
    get aliveCount() { let n = 0; for (const a of live) if (a.alive) n++; return n; },
    get waveCount() { let n = 0; for (const a of live) if (a.alive && !a.summoned) n++; return n; },
    countOf(type: EnemyType): number { let n = 0; for (const a of live) if (a.alive && a.type === type) n++; return n; },
    get: (id) => byId.get(id),
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
    kill(enemyId: number, opts: EnemyKillOptions = {}): boolean {
      const actor = byId.get(enemyId);
      if (!actor || !actor.alive) return false;
      clearDamageInfo(world);
      world.amount = actor.hp; world.type = 'hazard'; world.weapon = 'world';
      world.silent = opts.silent ?? false; world.creditPlayer = opts.creditPlayer ?? false;
      world.point.copy(actor.aimPoint);
      die(actor, world, false);
      return true;
    },
    killAll(silent = false): number {
      const count = system.aliveCount;
      for (const actor of [...live]) system.kill(actor.id, { silent });
      // Silent cleanups also free the corpses at once.
      if (silent) for (const actor of [...live]) despawn(actor);
      return count;
    },
    get boss() { return boss as BossHandle | null; },
    setBossPhase(enemyId: number, phase: number): void {
      const actor = byId.get(enemyId);
      if (!actor || actor.phase === phase) return;
      const prev = actor.phase;
      actor.phase = phase;
      ctx.events.emit('boss:phase', { boss: actor as BossHandle, phase, prev });
    },
    get canAttack() { return ctx.player.alive && ctx.game.mode === 'playing' && !ctx.debug.freezeAi; },
    hasLineOfSight(enemyId: number): boolean {
      const actor = byId.get(enemyId);
      if (!actor) return false;
      if (actor.losAt < 0 || ctx.time.now - actor.losAt >= LOS_INTERVAL) {
        actor.losAt = ctx.time.now;
        actor.los = ctx.collision.lineOfSight(actor.aimPoint, ctx.player.center, COL.SIGHT);
      }
      return actor.los;
    },
    tryAcquireAttackToken(enemyId: number, weight?: number): boolean {
      if (tokens.has(enemyId)) return true;
      const cost = weight ?? byId.get(enemyId)?.def.tokenCost ?? 1;
      if (cost <= 0) return true;
      if (!system.canAttack || system.tokensInUse + cost > ctx.mods.attackTokens) return false;
      tokens.set(enemyId, { weight: cost, at: ctx.time.now });
      return true;
    },
    releaseAttackToken: (enemyId) => void tokens.delete(enemyId),
    get tokensInUse() { let used = 0; for (const t of tokens.values()) used += t.weight; return used; },
    separation(enemy: EnemyHandle, radius: number, out: THREE.Vector3): THREE.Vector3 {
      out.set(0, 0, 0);
      for (const a of live) {
        if (a.id === enemy.id || !a.alive || a.spawning) continue;
        push.subVectors(enemy.position, a.position).setY(0);
        const d = push.length();
        if (d > 1e-3 && d < radius) out.addScaledVector(push, (1 - d / radius) / d);
      }
      return out.clampLength(0, 1);
    },
    moveGround(actor: EnemyActor, desired: Vec3Like, dt: number): void {
      const p = actor.position;
      system.separation(actor, actor.radius * 2.2, apart);
      const dx = (desired.x + actor.knock.x + apart.x * 2) * dt;
      const dz = (desired.z + actor.knock.z + apart.z * 2) * dt;
      const fromX = p.x, fromZ = p.z;
      if (!ctx.nav.isWalkable(p.x, p.z)) {
        // Off the grid (spawned there, or the cell got blocked): walk freely until back on it.
        p.x += dx; p.z += dz;
      } else if (ctx.nav.isLineWalkable(p, to.set(p.x + dx, p.y, p.z + dz))) {
        p.x += dx; p.z += dz;
      } else if (ctx.nav.isLineWalkable(p, to.set(p.x + dx, p.y, p.z))) {
        p.x += dx;
      } else if (ctx.nav.isLineWalkable(p, to.set(p.x, p.y, p.z + dz))) {
        p.z += dz;
      }
      p.y = damp(p.y, ctx.nav.heightAt(p.x, p.z, p.y), 12, dt);
      if (dt > 0) actor.velocity.set((p.x - fromX) / dt, 0, (p.z - fromZ) / dt);
    },
    moveFlying(actor: EnemyActor, desired: Vec3Like, dt: number, minAltitude: number): void {
      const p = actor.position;
      const b = ctx.world.bounds;
      system.separation(actor, actor.radius * 2.2, apart);
      to.set(p.x + (desired.x + actor.knock.x + apart.x * 2) * dt, p.y + (desired.y + actor.knock.y) * dt, p.z + (desired.z + actor.knock.z + apart.z * 2) * dt);
      // Blocked by geometry: give up the horizontal part and climb over it.
      if (ctx.collision.overlapSphere(to, actor.radius, COL.ENEMY)) to.set(p.x, p.y + actor.speed * dt, p.z);
      to.x = clamp(to.x, b.minX + actor.radius, b.maxX - actor.radius);
      to.z = clamp(to.z, b.minZ + actor.radius, b.maxZ - actor.radius);
      to.y = clamp(Math.max(to.y, ctx.nav.heightAt(to.x, to.z, to.y - minAltitude) + minAltitude), b.minY, b.maxY - actor.radius);
      if (dt > 0) actor.velocity.subVectors(to, p).multiplyScalar(1 / dt);
      p.copy(to);
    },
    init(): void {
      ctx.scene.add(root);
      for (const kind of ENEMY_KINDS) system.registerKind(kind);
      // Every type stays spawnable while its real kind is not written yet.
      for (const type of ENEMY_TYPES) if (!kinds.has(type)) system.registerKind(placeholderKind(type));
      // One pooled actor per kind exists (hidden) from the start so its shaders are compiled up front.
      for (const type of ENEMY_TYPES) {
        const actor = create(type, kinds.get(type) as EnemyKind);
        pools.get(type)?.push(actor);
        ctx.render.warm(actor.root);
      }
    },
    reset(): void {
      for (const actor of [...live]) despawn(actor);
      tokens.clear();
      boss = null; wasAttacking = false; lastFlash = -Infinity;
    },
    update(dt: number): void {
      const can = system.canAttack;
      if (ctx.game.mode === 'playing') ctx.nav.updateFlowField(ctx.player.position);
      // Stand down: whatever the actors were telegraphing or firing is cancelled for them.
      if (wasAttacking && !can) {
        for (const actor of live) { ctx.fx.cancelOwner(actor.id); ctx.audio.stopOwner(actor.id); }
        tokens.clear();
      }
      wasAttacking = can;
      for (const [id, token] of tokens) if (ctx.time.now - token.at > TOKEN_TIMEOUT) tokens.delete(id);
      const bounds = ctx.world.bounds;
      order.length = 0;
      for (const actor of live) order.push(actor);
      for (const actor of order) {
        if (!inScene(actor)) continue;
        if (actor.dying) {
          // Corpse time runs on the player clock: slow motion staged by the kind does not stretch it.
          actor.corpse -= ctx.time.playerDt;
          try { actor.behavior.updateDying?.(dt, ctx.time.playerDt); } catch (error) { report(actor, error); actor.corpse = 0; }
          if (actor.corpse <= 0) despawn(actor);
          continue;
        }
        if (!actor.alive) { despawn(actor); continue; }
        if (actor.spawning) {
          actor.arrival -= dt;
          if (actor.arrival <= 0) strike(actor);
          continue;
        }
        actor.age += dt;
        actor.stun = Math.max(0, actor.stun - dt);
        actor.knock.multiplyScalar(Math.exp(-6 * dt));
        try {
          if (can) actor.behavior.update(dt);
          else actor.behavior.animate(dt);
        } catch (error) {
          report(actor, error);
          despawn(actor);
          continue;
        }
        if (!inScene(actor) || !actor.alive) continue;
        const p = actor.position;
        if (!isFiniteVec3(p)) { system.kill(actor.id, { silent: true }); continue; }
        if (p.x < bounds.minX - 1 || p.x > bounds.maxX + 1 || p.z < bounds.minZ - 1 || p.z > bounds.maxZ + 1 || p.y > bounds.maxY + 1 || p.y < ctx.world.killY) { system.kill(actor.id); continue; }
        actor.zone = ctx.world.zoneAt(p.x, p.z);
      }
    },
    dispose(): void {
      system.reset();
      ctx.scene.remove(root);
      root.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    },
  };
  return system;
}
