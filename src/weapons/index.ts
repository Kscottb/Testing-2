// STUB: replaced by the weapons team
import * as THREE from 'three';
import { WEAPON_IDS } from '../core/constants';
import { makeDamageInfo, makeShotHit } from '../core/make';
import { clamp, falloff } from '../core/math';
import { PALETTE } from '../core/palette';
import { GRENADE, MELEE, WEAPONS } from '../data/weapons';
import type { GameContext, InputAction, WeaponDef, WeaponId, WeaponState, WeaponSystem } from '../core/types';

type Slot = { -readonly [K in keyof WeaponState]: WeaponState[K] } & { reloadLeft: number };
const SLOT_ACTIONS: readonly InputAction[] = ['weapon1', 'weapon2', 'weapon3', 'weapon4'];

/** Gray-box arsenal: every weapon is a hitscan variant of its table row (hornet fires real rockets). */
export function createWeaponSystem(ctx: GameContext): WeaponSystem {
  const slots = {} as Record<WeaponId, Slot>;
  for (const id of WEAPON_IDS) {
    const def = WEAPONS[id];
    slots[id] = { id, def, unlocked: false, mag: 0, magSize: def.magSize, reserve: 0, reserveMax: def.reserveMax, reloading: false, reloadProgress: 0, charge: 0, reloadLeft: 0 };
  }
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const shot = new THREE.Vector3();
  const hit = makeShotHit();
  const info = makeDamageInfo();
  const model = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: PALETTE.weaponGraphite, emissive: PALETTE.player, emissiveIntensity: 0.15 }));
  let current: Slot = slots.vector;
  let cooldown = 0, grenades = 0, grenadeCooldown = 0, meleeCooldown = 0, shotsFired = 0, shotsHit = 0, ads = 0;

  const fill = (slot: Slot): void => {
    slot.magSize = Math.round(slot.def.magSize * ctx.mods.magSizeMul);
    slot.mag = slot.magSize;
    slot.reloading = false;
    slot.reloadProgress = 0;
  };
  /** One ray: trace, damage, tracer. Returns true when an enemy was damaged. */
  const ray = (def: WeaponDef, spread: number, damage: number, range: number, weapon: WeaponId | 'melee', radius = 0): boolean => {
    shot.copy(dir);
    shot.x += (ctx.rng.next() - 0.5) * 2 * spread; shot.y += (ctx.rng.next() - 0.5) * 2 * spread; shot.z += (ctx.rng.next() - 0.5) * 2 * spread;
    shot.normalize();
    ctx.combat.traceShot(origin, shot, range, { faction: 'player', ignoreId: ctx.player.targetId, radius }, hit);
    if (weapon !== 'melee') ctx.fx.tracer(origin, hit.point);
    if (hit.kind !== 'target' || !hit.target) return false;
    info.amount = damage * ctx.mods.damageMul * falloff(hit.distance, def.falloffStart, def.falloffEnd, def.falloffMin);
    info.type = weapon === 'melee' ? 'melee' : 'bullet'; info.faction = 'player'; info.sourceId = ctx.player.targetId; info.weapon = weapon;
    info.part = hit.part; info.critScale = def.critScale * ctx.mods.critDamageMul; info.knockback = def.knockback; info.splash = false; info.silent = false;
    info.point.copy(hit.point); info.dir.copy(shot);
    return ctx.combat.applyDamage(hit.target, info).dealt > 0;
  };

  const system: WeaponSystem = {
    weapons: slots,
    get current() { return current; },
    switching: false,
    get grenades() { return grenades; },
    get grenadeCap() { return GRENADE.cap + ctx.mods.grenadeCapBonus; },
    get meleeCooldown() { return meleeCooldown; },
    get spread() { return current.def.spreadMin * (1 - ads * (1 - current.def.spreadAdsMul)); },
    get adsAmount() { return ads; },
    get shotsFired() { return shotsFired; },
    get shotsHit() { return shotsHit; },
    unlock(id: WeaponId, equip = false): void {
      const slot = slots[id];
      if (!slot.unlocked) {
        slot.unlocked = true; slot.reserve = slot.def.reserveStart; fill(slot);
        ctx.events.emit('weapon:unlocked', { weapon: id });
      }
      if (equip) system.switchTo(id);
    },
    switchTo(id: WeaponId): boolean {
      const slot = slots[id];
      if (!slot.unlocked || slot === current) return false;
      const prev = current.id;
      current.reloading = false; current.reloadProgress = 0;
      current = slot; cooldown = slot.def.equipSeconds;
      ctx.events.emit('weapon:switched', { weapon: id, prev });
      return true;
    },
    addAmmo(id: WeaponId | 'all', amount: number, asFraction = false): number {
      let added = 0;
      for (const wid of id === 'all' ? WEAPON_IDS : [id]) {
        const slot = slots[wid];
        if (!slot.unlocked) continue;
        const gain = clamp(Math.ceil(asFraction ? amount * slot.reserveMax : amount), 0, slot.reserveMax - slot.reserve);
        slot.reserve += gain; added += gain;
      }
      return added;
    },
    refill(): void {
      for (const id of WEAPON_IDS) if (slots[id].unlocked) { slots[id].reserve = slots[id].reserveMax; fill(slots[id]); }
      grenades = system.grenadeCap;
    },
    addGrenades(count: number): number {
      const gain = clamp(count, 0, system.grenadeCap - grenades);
      grenades += gain;
      return gain;
    },
    init(): void {
      model.position.set(0.22, -0.2, -0.55);
      ctx.viewScene.add(model);
    },
    reset(): void {
      for (const id of WEAPON_IDS) { slots[id].unlocked = false; slots[id].reserve = 0; slots[id].mag = 0; slots[id].charge = 0; }
      current = slots.vector; cooldown = 0; grenadeCooldown = 0; meleeCooldown = 0; shotsFired = 0; shotsHit = 0; ads = 0;
      system.unlock('vector');
      grenades = GRENADE.startCount;
    },
    update(dt: number): void {
      const { input, player } = ctx;
      if (!player.alive) return;
      const def = current.def;
      cooldown -= dt; grenadeCooldown -= dt; meleeCooldown = Math.max(0, meleeCooldown - dt);
      ads = clamp(ads + (input.isDown('ads') ? dt : -dt) / def.adsSeconds, 0, 1);
      player.setAds(ads, def.adsZoom, def.adsMoveMul);
      player.setSpeedMultiplier('weapon', def.moveMul);
      WEAPON_IDS.forEach((id, i) => { if (input.justPressed(SLOT_ACTIONS[i] as InputAction)) system.switchTo(id); });
      if (input.justPressed('weaponNext') || input.justPressed('weaponPrev')) {
        const step = input.justPressed('weaponNext') ? 1 : WEAPON_IDS.length - 1;
        for (let i = 1, at = WEAPON_IDS.indexOf(current.id); i <= WEAPON_IDS.length; i++) if (system.switchTo(WEAPON_IDS[(at + step * i) % WEAPON_IDS.length] as WeaponId)) break;
      }
      player.getAimRay(origin, dir);
      const free = ctx.debug.infiniteAmmo || player.overclock.active;

      if (current.reloading) {
        current.reloadLeft -= dt * ctx.mods.reloadSpeedMul;
        const total = def.reloadSeconds * (def.reloadPerRound ? current.magSize : 1);
        current.reloadProgress = clamp(1 - current.reloadLeft / total, 0, 1);
        if (current.reloadLeft <= 0) {
          const take = Math.min(current.magSize - current.mag, current.reserve);
          current.mag += take; current.reserve -= take; current.reloading = false; current.reloadProgress = 0;
          ctx.events.emit('weapon:reloaded', { weapon: current.id, mag: current.mag, reserve: current.reserve });
        }
      } else if ((input.justPressed('reload') || current.mag === 0) && current.mag < current.magSize && current.reserve > 0) {
        current.reloading = true;
        current.reloadLeft = def.reloadSeconds * (def.reloadPerRound ? current.magSize - current.mag : 1);
        ctx.events.emit('weapon:reloadStart', { weapon: current.id, seconds: current.reloadLeft });
      } else if (cooldown <= 0 && (def.trigger === 'semi' ? input.justPressed('fire') : input.isDown('fire'))) {
        if (current.mag <= 0 && !free) {
          cooldown = 0.25;
          ctx.events.emit('weapon:empty', { weapon: current.id });
        } else {
          cooldown = 60 / (def.rpm * ctx.mods.fireRateMul) + def.chargeSeconds;
          if (!free) current.mag--;
          shotsFired++;
          let any = false;
          if (def.delivery === 'projectile') {
            shot.copy(dir).multiplyScalar(def.projectileSpeed);
            ctx.combat.spawnProjectile({ kind: 'rocket', position: origin, velocity: shot, faction: 'player', ownerId: player.targetId, damage: def.damage * ctx.mods.damageMul, splashRadius: def.splashRadius, splashDamage: def.splashDamage * ctx.mods.damageMul, selfDamageMul: def.selfDamageMul, weapon: current.id });
          } else {
            for (let i = 0; i < def.pellets; i++) any = ray(def, def.pelletSpread + system.spread, def.damage, def.range, current.id) || any;
          }
          if (any) shotsHit++;
          player.addRecoil(def.recoilPitch * 0.3, 0);
          ctx.audio.play(`${current.id}Fire`);
          ctx.events.emit('weapon:fired', { weapon: current.id, mag: current.mag, reserve: current.reserve });
        }
      }
      if (input.justPressed('grenade') && grenadeCooldown <= 0 && (grenades > 0 || ctx.debug.infiniteAmmo)) {
        if (!ctx.debug.infiniteAmmo) grenades--;
        grenadeCooldown = GRENADE.cooldownSeconds;
        shot.copy(dir).multiplyScalar(GRENADE.throwSpeed).setY(shot.y + 4);
        ctx.combat.spawnProjectile({ kind: 'grenade', position: origin, velocity: shot, faction: 'player', ownerId: player.targetId, damage: 0, splashRadius: GRENADE.radius * ctx.mods.grenadePowerMul, splashDamage: GRENADE.damage * ctx.mods.grenadePowerMul * ctx.mods.damageMul, selfDamageMul: GRENADE.selfDamageMul, gravity: GRENADE.gravity, bounce: GRENADE.bounce, fuse: GRENADE.fuseSeconds, weapon: 'grenade' });
        ctx.events.emit('weapon:grenade', { left: grenades });
      }
      if (input.justPressed('melee') && meleeCooldown <= 0) {
        meleeCooldown = MELEE.cooldownSeconds;
        ctx.events.emit('weapon:melee', { hit: ray(WEAPONS.vector, 0, MELEE.damage, MELEE.range, 'melee', 0.8) });
      }
    },
    dispose(): void { ctx.viewScene.remove(model); },
  };
  return system;
}
