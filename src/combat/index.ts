// STUB: replaced by the combat team
import * as THREE from 'three';
import { COL, MAX_PROJECTILES } from '../core/constants';
import { clearDamageInfo, clearDamageResult, makeDamageInfo, makeDamageResult, makeRayHit, makeShotHit } from '../core/make';
import { PALETTE } from '../core/palette';
import { PROJECTILES } from '../data/projectiles';
import type { CombatSystem, DamageInfo, DamageResult, DamageSource, ExplosionOptions, Faction, FxId, GameContext, HitPart, HitTarget, PierceResult, ProjectileOptions, ShotHit, SoundId, TraceOptions, Vec3Like } from '../core/types';

interface Projectile { id: number; opts: ProjectileOptions; pos: THREE.Vector3; vel: THREE.Vector3; age: number; playerClock: boolean; mesh: THREE.Mesh }
/** Player hits on one target since the last flush (merged into ONE damage number, sound and 'hit:confirmed'). */
interface Feedback { amount: number; crit: boolean; killed: boolean; shield: boolean; part: HitPart; weapon: DamageSource | null; point: THREE.Vector3 }

const PART_RANK: Record<HitPart, number> = { weak: 3, body: 2, armor: 1, shield: 0 };
const HIT_FX: Record<HitPart, FxId> = { body: 'hitEnemy', weak: 'hitEnemyWeak', armor: 'hitEnemyArmor', shield: 'hitEnemyShield' };
const MAX_BLASTS_PER_UPDATE = 32;

/** Gray-box combat: brute-force ray/sphere tests, simple projectiles, queued radial explosions. */
export function createCombatSystem(ctx: GameContext): CombatSystem {
  const targets = new Map<number, HitTarget>();
  const projectiles: Projectile[] = [];
  const queued: ExplosionOptions[] = [];
  const feedback = new Map<number, Feedback>();
  const nothing = makeDamageResult();
  const rayHit = makeRayHit();
  const probe = makeShotHit();
  const info = makeDamageInfo();
  const toCenter = new THREE.Vector3();
  const step = new THREE.Vector3();
  const root = new THREE.Group();
  root.name = 'combat';
  const geometry = new THREE.SphereGeometry(0.14, 8, 6);
  const materials: Record<Faction, THREE.Material> = { player: new THREE.MeshBasicMaterial({ color: PALETTE.player }), enemy: new THREE.MeshBasicMaterial({ color: PALETTE.enemy }), neutral: new THREE.MeshBasicMaterial({ color: PALETTE.hazard }) };

  const hostile = (target: HitTarget, o: TraceOptions): boolean => target.alive && target.id !== (o.ignoreId ?? 0) && (o.faction === 'neutral' || target.faction !== o.faction);
  /** Nearest enabled sphere of `target` hit by the ray within `limit`; fills `out` and returns the distance, or -1. */
  const hitTarget = (target: HitTarget, origin: Vec3Like, dir: Vec3Like, limit: number, pad: number, out: ShotHit): number => {
    let best = -1;
    for (let s = 0; s < target.spheres.length; s++) {
      const sphere = target.spheres[s] as HitTarget['spheres'][number];
      if (!sphere.enabled) continue;
      toCenter.set(sphere.center.x - origin.x, sphere.center.y - origin.y, sphere.center.z - origin.z);
      const along = toCenter.x * dir.x + toCenter.y * dir.y + toCenter.z * dir.z;
      const r = sphere.radius + pad;
      const d2 = toCenter.lengthSq() - along * along;
      if (d2 > r * r) continue;
      const t = Math.max(0, along - Math.sqrt(r * r - d2));
      if (along + r < 0 || t > limit || (best >= 0 && t >= best)) continue;
      best = t;
      out.kind = 'target'; out.distance = t; out.target = target; out.part = sphere.part; out.sphereIndex = s;
      out.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      out.normal.copy(out.point).sub(sphere.center).normalize();
    }
    return best;
  };
  const remove = (p: Projectile): void => {
    root.remove(p.mesh);
    // Anything attached to the projectile (trail, fly loop) dies with it.
    ctx.fx.cancelOwner(p.id);
    ctx.audio.stopOwner(p.id);
    projectiles.splice(projectiles.indexOf(p), 1);
  };
  const detonate = (p: Projectile, struck: number): void => {
    const o = p.opts;
    remove(p);
    if ((o.splashRadius ?? 0) > 0) combat.explode({ position: p.pos, radius: o.splashRadius ?? 0, damage: o.splashDamage ?? o.damage, faction: o.faction, ownerId: o.ownerId, excludeId: struck, selfDamageMul: o.selfDamageMul, friendlyFire: o.friendlyFire, creditPlayer: o.creditPlayer, weapon: o.weapon, type: o.type ?? PROJECTILES[o.kind].type, visual: o.visual ?? PROJECTILES[o.kind].visual });
  };
  const resolveExplosion = (o: ExplosionOptions): void => {
    const center = o.position as THREE.Vector3;
    for (const target of targets.values()) {
      if (!target.alive || target.id === (o.excludeId ?? 0) || (target.faction === 'enemy' && target.id === (o.ownerId ?? 0))) continue;
      const self = o.faction !== 'neutral' && target.faction === o.faction;
      if (self && target.faction === 'enemy' && !o.friendlyFire) continue;
      // Distance to the target's surface: d = max(0, |pos - center| - boundRadius).
      const d = Math.max(0, target.center.distanceTo(center) - target.boundRadius);
      if (d > o.radius || ((o.lineOfSight ?? true) && !ctx.collision.lineOfSight(o.position, target.center, COL.PROJECTILE))) continue;
      const k = 1 - (1 - (o.edgeFalloff ?? 0.2)) * (d / o.radius);
      clearDamageInfo(info);
      info.amount = o.damage * k * (self && target.faction === 'player' ? (o.selfDamageMul ?? 0.35) : 1);
      info.type = o.type ?? 'explosion'; info.faction = o.faction; info.sourceId = o.ownerId ?? 0; info.weapon = o.weapon ?? null;
      info.splash = true; info.creditPlayer = o.creditPlayer ?? false; info.knockback = (o.knockback ?? 6) * k;
      info.point.copy(target.center); info.dir.copy(target.center).sub(center).normalize();
      combat.applyDamage(target, info);
    }
    // The audiovisual package belongs to combat and plays when the blast resolves.
    const visual = o.visual ?? (o.radius < 4 ? 'small' : 'large');
    if (visual !== 'none') {
      const id = (`explosion${visual[0]?.toUpperCase() ?? ''}${visual.slice(1)}`) as FxId & SoundId;
      ctx.fx.spawn(id, o.position, { radius: o.radius });
      ctx.audio.playAt(center.distanceTo(ctx.player.eye) > 40 ? 'explosionDistant' : id, o.position);
    }
    ctx.player.addShakeAt(o.position, 0.5, o.radius * 4);
  };
  const flushFeedback = (): void => {
    for (const [targetId, f] of feedback) {
      ctx.fx.damageNumber(f.point, f.amount, { crit: f.crit, shield: f.shield, kill: f.killed, targetId });
      ctx.audio.play(f.killed ? 'hitKill' : f.crit ? 'hitCrit' : f.shield ? 'hitShield' : f.part === 'armor' ? 'hitArmor' : 'hitConfirm');
      ctx.events.emit('hit:confirmed', { targetId, amount: f.amount, crit: f.crit, killed: f.killed, shield: f.shield, part: f.part, weapon: f.weapon, point: f.point });
    }
    feedback.clear();
  };
  /** One simulation step of one projectile on its own clock. */
  const advance = (p: Projectile, dt: number): void => {
    const o = p.opts;
    p.age += dt;
    p.vel.y -= (o.gravity ?? 0) * dt;
    const dist = p.vel.length() * dt;
    if ((o.fuse ?? 0) > 0 ? p.age >= (o.fuse ?? 0) : p.age >= (o.lifetime ?? 8)) { if ((o.fuse ?? 0) > 0) detonate(p, 0); else remove(p); return; }
    const w = ctx.world.bounds;
    if (p.pos.x < w.minX - 20 || p.pos.x > w.maxX + 20 || p.pos.z < w.minZ - 20 || p.pos.z > w.maxZ + 20 || p.pos.y < w.minY - 40 || p.pos.y > w.maxY + 80) { remove(p); return; }
    if (dist < 1e-6) return;
    step.copy(p.vel).normalize();
    combat.traceShot(p.pos, step, dist, { faction: o.faction, ignoreId: o.ownerId, radius: o.radius ?? PROJECTILES[o.kind].radius }, probe);
    if (probe.kind === 'world' && (o.bounce ?? 0) > 0) {
      p.pos.copy(probe.point).addScaledVector(probe.normal, 0.02);
      p.vel.reflect(probe.normal).multiplyScalar(o.bounce ?? 0);
      ctx.fx.spawn('grenadeBounce', p.pos);
      ctx.audio.playAt('grenadeBounce', p.pos);
    } else if (probe.kind !== 'none') {
      p.pos.copy(probe.point);
      const struck = probe.target;
      if (struck && o.damage > 0) {
        clearDamageInfo(info);
        info.amount = o.damage; info.type = o.type ?? PROJECTILES[o.kind].type; info.faction = o.faction; info.sourceId = o.ownerId; info.weapon = o.weapon ?? null;
        info.part = probe.part; info.sphereIndex = probe.sphereIndex; info.critScale = o.critScale ?? 1; info.creditPlayer = o.creditPlayer ?? false; info.knockback = o.knockback ?? 0;
        info.point.copy(probe.point); info.dir.copy(step);
        combat.applyDamage(struck, info);
      }
      detonate(p, struck ? struck.id : 0);
      return;
    } else p.pos.addScaledVector(step, dist);
    p.mesh.position.copy(p.pos);
  };

  const combat: CombatSystem = {
    register: (target) => void targets.set(target.id, target),
    unregister: (id) => void targets.delete(id),
    getTarget: (id) => targets.get(id),
    get projectileCount() { return projectiles.length; },
    traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, o: TraceOptions, out: ShotHit): boolean {
      out.kind = 'none'; out.distance = maxDist; out.target = null; out.part = 'body'; out.sphereIndex = -1; out.boxId = -1;
      out.point.set(origin.x + dir.x * maxDist, origin.y + dir.y * maxDist, origin.z + dir.z * maxDist);
      const mask = o.worldMask ?? COL.PROJECTILE;
      if (mask !== 0 && ctx.collision.raycast(origin, dir, maxDist, mask, rayHit)) {
        out.kind = 'world'; out.distance = rayHit.distance; out.point.copy(rayHit.point); out.normal.copy(rayHit.normal); out.surface = rayHit.surface; out.boxId = rayHit.boxId;
      }
      for (const target of targets.values()) if (hostile(target, o)) hitTarget(target, origin, dir, out.distance, o.radius ?? 0, out);
      return out.kind !== 'none';
    },
    tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, o: TraceOptions, out: PierceResult): number {
      out.count = 0;
      const mask = o.worldMask ?? COL.PROJECTILE;
      out.hitWorld = mask !== 0 && ctx.collision.raycast(origin, dir, maxDist, mask, rayHit);
      const limit = out.hitWorld ? rayHit.distance : maxDist;
      out.end.set(origin.x + dir.x * limit, origin.y + dir.y * limit, origin.z + dir.z * limit);
      out.boxId = out.hitWorld ? rayHit.boxId : -1;
      if (out.hitWorld) { out.endNormal.copy(rayHit.normal); out.surface = rayHit.surface; }
      for (const target of targets.values()) {
        if (out.count >= out.hits.length || !hostile(target, o)) continue;
        if (hitTarget(target, origin, dir, limit, o.radius ?? 0, out.hits[out.count] as ShotHit) >= 0) out.count++;
      }
      for (let i = 1; i < out.count; i++) {
        for (let j = i; j > 0 && (out.hits[j] as ShotHit).distance < (out.hits[j - 1] as ShotHit).distance; j--) {
          const swap = out.hits[j] as ShotHit;
          out.hits[j] = out.hits[j - 1] as ShotHit;
          out.hits[j - 1] = swap;
        }
      }
      return out.count;
    },
    applyDamage(targetOrId: HitTarget | number, damage: DamageInfo): DamageResult {
      const target = typeof targetOrId === 'number' ? targets.get(targetOrId) : targetOrId;
      if (!target || !target.alive) return clearDamageResult(nothing);
      const result = target.takeDamage(damage);
      // Player hits on hostile non-player targets: one spark per ray now, the rest merged per target at the flush.
      if (damage.faction === 'player' && target.faction !== 'player' && !damage.silent && (result.dealt > 0 || result.absorbed)) {
        if (!damage.splash) ctx.fx.spawn(HIT_FX[result.part], damage.point, { dir: damage.dir });
        let f = feedback.get(target.id);
        if (!f) { f = { amount: 0, crit: false, killed: false, shield: true, part: result.part, weapon: null, point: new THREE.Vector3() }; feedback.set(target.id, f); }
        f.amount += result.dealt; f.crit ||= result.crit; f.killed ||= result.killed; f.shield &&= result.absorbed;
        if (PART_RANK[result.part] > PART_RANK[f.part]) f.part = result.part;
        f.weapon = damage.weapon; f.point.copy(damage.point);
      }
      return result;
    },
    // ALWAYS queued (opts copied): the blast resolves inside update(), never inside this call.
    explode(o: ExplosionOptions): void {
      queued.push({ ...o, position: new THREE.Vector3(o.position.x, o.position.y, o.position.z) });
    },
    spawnProjectile(o: ProjectileOptions): number {
      if (projectiles.length >= MAX_PROJECTILES) remove(projectiles[0] as Projectile);
      const mesh = new THREE.Mesh(geometry, materials[o.faction]);
      const p: Projectile = { id: ctx.nextId(), opts: { ...o }, pos: new THREE.Vector3(o.position.x, o.position.y, o.position.z), vel: new THREE.Vector3(o.velocity.x, o.velocity.y, o.velocity.z), age: 0, playerClock: (o.clock ?? (o.faction === 'player' ? 'player' : 'world')) === 'player', mesh };
      mesh.position.copy(p.pos);
      root.add(mesh);
      projectiles.push(p);
      return p.id;
    },
    removeProjectile(id: number, explode = false): boolean {
      const p = projectiles.find((q) => q.id === id);
      if (!p) return false;
      if (explode) detonate(p, 0); else remove(p);
      return true;
    },
    clearProjectiles(faction?: Faction): void {
      for (let i = projectiles.length - 1; i >= 0; i--) if (!faction || (projectiles[i] as Projectile).opts.faction === faction) remove(projectiles[i] as Projectile);
    },
    queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number {
      out.length = 0;
      for (const t of targets.values()) if (t.alive && (faction === 'any' || t.faction === faction) && t.center.distanceTo(center as THREE.Vector3) <= radius + t.boundRadius) out.push(t);
      return out.length;
    },
    init(): void {
      ctx.scene.add(root);
      const sample = new THREE.Group();
      for (const material of Object.values(materials)) sample.add(new THREE.Mesh(geometry, material));
      ctx.render.warm(sample);
    },
    reset(): void { combat.clearProjectiles(); queued.length = 0; feedback.clear(); },
    update(dt: number): void {
      // 1. projectiles, each on its own clock (the player's keep full speed during Overclock).
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i] as Projectile;
        try {
          advance(p, p.playerClock ? ctx.time.playerDt : dt);
        } catch (error) {
          ctx.game.reportError(`projectile:${p.opts.kind}`, error);
          if (projectiles.includes(p)) remove(p);
        }
      }
      // 2. the explosion queue, FIFO, including blasts enqueued while resolving (chain reactions).
      for (let n = 0; n < MAX_BLASTS_PER_UPDATE && queued.length > 0; n++) resolveExplosion(queued.shift() as ExplosionOptions);
      // 3. one damage number / sound / 'hit:confirmed' per target.
      flushFeedback();
    },
    dispose(): void { combat.clearProjectiles(); targets.clear(); ctx.scene.remove(root); },
  };
  return combat;
}
