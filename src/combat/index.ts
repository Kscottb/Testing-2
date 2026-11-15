// STUB: replaced by the combat team
import * as THREE from 'three';
import { COL } from '../core/constants';
import { clearDamageResult, makeDamageInfo, makeDamageResult, makeRayHit, makeShotHit } from '../core/make';
import { PALETTE } from '../core/palette';
import type { CombatSystem, DamageInfo, DamageResult, ExplosionOptions, Faction, GameContext, HitTarget, PierceResult, ProjectileOptions, ShotHit, TraceOptions, Vec3Like } from '../core/types';

interface Projectile { id: number; opts: ProjectileOptions; pos: THREE.Vector3; vel: THREE.Vector3; age: number; mesh: THREE.Mesh }

/** Gray-box combat: brute-force ray/sphere tests, simple projectiles, radial explosions without fx. */
export function createCombatSystem(ctx: GameContext): CombatSystem {
  const targets = new Map<number, HitTarget>();
  const projectiles: Projectile[] = [];
  const queued: ExplosionOptions[] = [];
  const nothing = makeDamageResult();
  const rayHit = makeRayHit();
  const probe = makeShotHit();
  const info = makeDamageInfo();
  const toCenter = new THREE.Vector3();
  const step = new THREE.Vector3();
  const geometry = new THREE.SphereGeometry(0.14, 8, 6);
  const materials: Record<Faction, THREE.Material> = { player: new THREE.MeshBasicMaterial({ color: PALETTE.player }), enemy: new THREE.MeshBasicMaterial({ color: PALETTE.enemy }), neutral: new THREE.MeshBasicMaterial({ color: PALETTE.hazard }) };
  let exploding = false;
  let depth = 0;

  const hostile = (target: HitTarget, o: TraceOptions): boolean => target.alive && target.id !== (o.ignoreId ?? 0) && (o.faction === 'neutral' || target.faction !== o.faction);
  /** Nearest enabled sphere of `target` hit by the ray within `limit`; fills `out` and returns the distance, or -1. */
  const hitTarget = (target: HitTarget, origin: Vec3Like, dir: Vec3Like, limit: number, pad: number, out: ShotHit): number => {
    let best = -1;
    for (const sphere of target.spheres) {
      if (!sphere.enabled) continue;
      toCenter.set(sphere.center.x - origin.x, sphere.center.y - origin.y, sphere.center.z - origin.z);
      const along = toCenter.x * dir.x + toCenter.y * dir.y + toCenter.z * dir.z;
      const r = sphere.radius + pad;
      const d2 = toCenter.lengthSq() - along * along;
      if (d2 > r * r) continue;
      const t = Math.max(0, along - Math.sqrt(r * r - d2));
      if (along + r < 0 || t > limit || (best >= 0 && t >= best)) continue;
      best = t;
      out.kind = 'target'; out.distance = t; out.target = target; out.part = sphere.part;
      out.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      out.normal.copy(out.point).sub(sphere.center).normalize();
    }
    return best;
  };
  const kill = (p: Projectile): void => {
    ctx.scene.remove(p.mesh);
    projectiles.splice(projectiles.indexOf(p), 1);
  };
  const detonate = (p: Projectile, struck: number): void => {
    const o = p.opts;
    kill(p);
    if ((o.splashRadius ?? 0) > 0) combat.explode({ position: p.pos, radius: o.splashRadius ?? 0, damage: o.splashDamage ?? o.damage, faction: o.faction, ownerId: o.ownerId, excludeId: struck, selfDamageMul: o.selfDamageMul, friendlyFire: o.friendlyFire, weapon: o.weapon, type: o.type });
  };
  const doExplode = (o: ExplosionOptions): void => {
    for (const target of targets.values()) {
      if (!target.alive || target.id === (o.excludeId ?? 0) || (target.faction === 'enemy' && target.id === (o.ownerId ?? 0))) continue;
      const self = o.faction !== 'neutral' && target.faction === o.faction;
      if (self && target.faction === 'enemy' && !o.friendlyFire) continue;
      const d = Math.max(0, target.center.distanceTo(o.position as THREE.Vector3) - target.boundRadius * 0.5);
      if (d > o.radius || ((o.lineOfSight ?? true) && !ctx.collision.lineOfSight(o.position, target.center, COL.PROJECTILE))) continue;
      const k = 1 - (1 - (o.edgeFalloff ?? 0.2)) * (d / o.radius);
      info.amount = o.damage * k * (self && target.faction === 'player' ? (o.selfDamageMul ?? 0.35) : 1);
      info.type = o.type ?? 'explosion'; info.faction = o.faction; info.sourceId = o.ownerId ?? 0; info.weapon = o.weapon ?? null;
      info.part = 'body'; info.critScale = 1; info.splash = true; info.silent = false; info.knockback = (o.knockback ?? 6) * k;
      info.point.copy(target.center); info.dir.copy(target.center).sub(o.position as THREE.Vector3).normalize();
      combat.applyDamage(target, info);
    }
    ctx.player.addShakeAt(o.position, 0.5, o.radius * 4);
  };

  const combat: CombatSystem = {
    register: (target) => void targets.set(target.id, target),
    unregister: (id) => void targets.delete(id),
    getTarget: (id) => targets.get(id),
    get projectileCount() { return projectiles.length; },
    traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, o: TraceOptions, out: ShotHit): boolean {
      out.kind = 'none'; out.distance = maxDist; out.target = null; out.part = 'body'; out.boxId = -1;
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
      out.hitWorld = ctx.collision.raycast(origin, dir, maxDist, o.worldMask ?? COL.PROJECTILE, rayHit);
      const limit = out.hitWorld ? rayHit.distance : maxDist;
      out.end.set(origin.x + dir.x * limit, origin.y + dir.y * limit, origin.z + dir.z * limit);
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
      depth++;
      let result: DamageResult;
      try { result = target.takeDamage(damage); } finally { depth--; }
      if (damage.faction === 'player' && target.faction === 'enemy' && !damage.silent && (result.dealt > 0 || result.absorbed)) {
        ctx.fx.damageNumber(damage.point, result.dealt, { crit: result.crit, shield: result.absorbed, kill: result.killed });
        ctx.audio.play(result.killed ? 'hitKill' : result.crit ? 'hitCrit' : 'hitConfirm');
        ctx.events.emit('hit:confirmed', { targetId: target.id, amount: result.dealt, crit: result.crit, killed: result.killed, shield: result.absorbed, part: result.part, weapon: damage.weapon, point: damage.point });
      }
      return result;
    },
    explode(o: ExplosionOptions): void {
      if (exploding || depth > 0) { queued.push({ ...o, position: { x: o.position.x, y: o.position.y, z: o.position.z } }); return; }
      exploding = true;
      try { doExplode(o); } finally { exploding = false; }
    },
    spawnProjectile(o: ProjectileOptions): number {
      const mesh = new THREE.Mesh(geometry, materials[o.faction]);
      const p: Projectile = { id: ctx.nextId(), opts: { ...o }, pos: new THREE.Vector3(o.position.x, o.position.y, o.position.z), vel: new THREE.Vector3(o.velocity.x, o.velocity.y, o.velocity.z), age: 0, mesh };
      mesh.position.copy(p.pos);
      ctx.scene.add(mesh);
      projectiles.push(p);
      return p.id;
    },
    clearProjectiles(faction?: Faction): void {
      for (let i = projectiles.length - 1; i >= 0; i--) if (!faction || (projectiles[i] as Projectile).opts.faction === faction) kill(projectiles[i] as Projectile);
    },
    queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number {
      out.length = 0;
      for (const t of targets.values()) if (t.alive && (faction === 'any' || t.faction === faction) && t.center.distanceTo(center as THREE.Vector3) <= radius + t.boundRadius) out.push(t);
      return out.length;
    },
    init(): void {},
    reset(): void { combat.clearProjectiles(); queued.length = 0; },
    update(dt: number): void {
      while (queued.length > 0) combat.explode(queued.shift() as ExplosionOptions);
      for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i] as Projectile;
        const o = p.opts;
        p.age += dt;
        p.vel.y -= (o.gravity ?? 0) * dt;
        const dist = p.vel.length() * dt;
        if ((o.fuse ?? 0) > 0 ? p.age >= (o.fuse ?? 0) : p.age >= (o.lifetime ?? 8)) { if ((o.fuse ?? 0) > 0) detonate(p, 0); else kill(p); continue; }
        if (dist < 1e-6) continue;
        step.copy(p.vel).normalize();
        combat.traceShot(p.pos, step, dist, { faction: o.faction, ignoreId: o.ownerId, radius: o.radius ?? 0.15 }, probe);
        if (probe.kind === 'world' && (o.bounce ?? 0) > 0) {
          p.pos.copy(probe.point).addScaledVector(probe.normal, 0.02);
          p.vel.reflect(probe.normal).multiplyScalar(o.bounce ?? 0);
        } else if (probe.kind !== 'none') {
          p.pos.copy(probe.point);
          const struck = probe.target;
          if (struck && o.damage > 0) {
            info.amount = o.damage; info.type = o.type ?? 'plasma'; info.faction = o.faction; info.sourceId = o.ownerId; info.weapon = o.weapon ?? null;
            info.part = probe.part; info.critScale = o.critScale ?? 1; info.splash = false; info.silent = false; info.knockback = o.knockback ?? 0;
            info.point.copy(probe.point); info.dir.copy(step);
            combat.applyDamage(struck, info);
          }
          detonate(p, struck ? struck.id : 0);
          continue;
        } else p.pos.addScaledVector(step, dist);
        p.mesh.position.copy(p.pos);
      }
    },
    dispose(): void { combat.clearProjectiles(); targets.clear(); },
  };
  return combat;
}
