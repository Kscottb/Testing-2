// STUB: replaced by the player team
import * as THREE from 'three';
import { COL, PLAYER } from '../core/constants';
import { clearDamageResult, makeDamageResult, makeHitSphere, makeLookDelta, makeMoveResult } from '../core/make';
import { clamp, damp, dirToYaw, jumpSpeed, wrapAngle, yawPitchToDir } from '../core/math';
import { ENEMIES } from '../data/enemies';
import type { DamageInfo, DamageResult, GameContext, GameMode, HitTarget, PlayerSystem, Vec3Like } from '../core/types';

/** Gray-box controller: walk / sprint / jump / dash, mouse look, shield + health, basic Overclock. */
export function createPlayerSystem(ctx: GameContext): PlayerSystem {
  const position = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, -1);
  const delta = new THREE.Vector3();
  const look = makeLookDelta();
  const move = makeMoveResult();
  const result = makeDamageResult();
  const body = makeHitSphere(0.55);
  /** Body centre: the same vector as the HitTarget centre (enemies aim here). */
  const center = body.center;
  const speedMuls = new Map<string, number>();
  const dash = { charges: 1, maxCharges: 1, cooldownLeft: 0, cooldown: PLAYER.DASH_COOLDOWN as number, active: false };
  const overclock = { charge: 0, ready: false, active: false, timeLeft: 0, duration: PLAYER.OVERCLOCK_SECONDS as number };
  let yaw = 0, pitch = 0, grounded = false, hp = 100, shield = 100, alive = true, lastHit = -99, dashLeft = 0, ads = 0, adsZoom = 1, adsMove = 1, lastStandUsed = 0, shake = 0, launched = false, bossDown = false;
  const targetId = ctx.nextId();
  const target: HitTarget = { id: targetId, faction: 'player', alive: true, center, boundRadius: 0.9, spheres: [body], takeDamage: (info) => player.takeDamage(info), enemy: null };

  const syncCamera = (): void => {
    eye.set(position.x, position.y + PLAYER.EYE, position.z);
    center.set(position.x, position.y + PLAYER.HEIGHT * 0.55, position.z);
    yawPitchToDir(yaw, pitch, forward);
    const fov = ctx.settings.data.fov / (1 + (adsZoom - 1) * ads);
    ctx.camera.position.copy(eye);
    ctx.camera.rotation.set(pitch, yaw, 0);
    if (ctx.camera.fov !== fov) {
      ctx.camera.fov = fov;
      ctx.camera.updateProjectionMatrix();
    }
    ctx.camera.updateMatrixWorld();
  };
  const endOverclock = (): void => {
    if (!overclock.active) return;
    overclock.active = false; overclock.timeLeft = 0;
    ctx.time.clearScale('overclock');
    ctx.render.post.overclock = 0;
    ctx.events.emit('overclock:end', {});
  };

  const player: PlayerSystem = {
    position, eye, center, velocity, forward, dash, overclock, targetId,
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get grounded() { return grounded; },
    crouching: false, sliding: false,
    get sprinting() { return ctx.input.isDown('sprint') && grounded; },
    get speed() { return Math.hypot(velocity.x, velocity.z); },
    height: PLAYER.HEIGHT, halfWidth: PLAYER.HALF_WIDTH,
    get hp() { return hp; },
    get maxHp() { return PLAYER.MAX_HP + ctx.mods.maxHealthBonus; },
    get shield() { return shield; },
    get maxShield() { return PLAYER.MAX_SHIELD + ctx.mods.maxShieldBonus; },
    get alive() { return alive; },
    get invulnerable() { return ctx.debug.god || dashLeft > 0 || bossDown; },
    get fov() { return ctx.camera.fov; },
    get lastStandCharges() { return Math.max(0, ctx.mods.lastStand - lastStandUsed); },

    takeDamage(info: DamageInfo): DamageResult {
      clearDamageResult(result, info.part);
      if (!alive) return result;
      // No damage outside 'playing' (victory screen, game over) or while invulnerable.
      if (ctx.game.mode !== 'playing' || player.invulnerable) { result.absorbed = true; return result; }
      const amount = info.amount * (info.faction === 'enemy' ? ctx.mods.damageTakenMul : 1);
      const hadShield = shield > 0;
      result.shieldDamage = Math.min(shield, amount);
      shield -= result.shieldDamage;
      result.healthDamage = Math.min(hp, amount - result.shieldDamage);
      hp -= result.healthDamage;
      if (hp <= 0 && player.lastStandCharges > 0) { lastStandUsed++; hp = 1; shield = player.maxShield; ctx.fx.spawn('lastStand', center); ctx.audio.play('lastStand'); }
      result.dealt = result.shieldDamage + result.healthDamage;
      lastHit = ctx.time.now;
      // The player owns ALL feedback of being hit.
      const post = ctx.render.post;
      if (result.healthDamage > 0) post.damageFlash = Math.max(post.damageFlash, 0.6); else post.shieldFlash = Math.max(post.shieldFlash, 0.6);
      ctx.fx.spawn(result.healthDamage > 0 ? 'hitPlayer' : 'hitPlayerShield', info.point);
      ctx.audio.play(result.healthDamage > 0 ? 'hurt' : 'hurtShield');
      delta.copy(info.dir).multiplyScalar(info.knockback / PLAYER.MASS);
      player.addImpulse(delta);
      // Direction toward the source = -info.dir flattened; angle relative to the view (0 ahead, +PI/2 left).
      const len = Math.hypot(info.dir.x, info.dir.z);
      const dirX = len > 1e-6 ? -info.dir.x / len : 0, dirZ = len > 1e-6 ? -info.dir.z / len : 0;
      const angle = len > 1e-6 ? wrapAngle(dirToYaw(dirX, dirZ) - yaw) : 0;
      ctx.events.emit('player:damaged', { amount: result.dealt, shieldDamage: result.shieldDamage, healthDamage: result.healthDamage, info, dirX, dirZ, angle });
      if (hadShield && shield <= 0) ctx.events.emit('player:shieldBroken', { info });
      if (hp <= 0) {
        alive = false; target.alive = false; result.killed = true;
        endOverclock();
        ctx.audio.play('death');
        ctx.events.emit('player:died', { info });
      }
      return result;
    },
    heal(amount: number): number {
      const gain = clamp(amount, 0, player.maxHp - hp);
      hp += gain;
      if (gain > 0) { ctx.fx.spawn('healPulse', center); ctx.events.emit('player:healed', { amount: gain, kind: 'health' }); }
      return gain;
    },
    addShield(amount: number): number {
      const gain = clamp(amount, 0, player.maxShield - shield);
      shield += gain;
      if (gain > 0) ctx.events.emit('player:healed', { amount: gain, kind: 'shield' });
      return gain;
    },
    launch(v: Vec3Like): void {
      // Jump pad: replace the velocity; `launched` suspends air control until the next landing so the arc holds.
      velocity.set(v.x, v.y, v.z);
      grounded = false; launched = true;
    },
    addImpulse(v: Vec3Like): void {
      velocity.set(velocity.x + v.x, velocity.y + v.y, velocity.z + v.z);
      if (velocity.y > 0.5) grounded = false;
    },
    teleport(p: Vec3Like, newYaw?: number, newPitch?: number): void {
      position.set(p.x, p.y, p.z);
      velocity.set(0, 0, 0);
      launched = false;
      player.setLook(newYaw ?? yaw, newPitch ?? pitch);
    },
    setLook(newYaw: number, newPitch: number): void {
      yaw = newYaw; pitch = clamp(newPitch, -1.55, 1.55);
      syncCamera();
    },
    getAimRay(origin: THREE.Vector3, dir: THREE.Vector3): void { origin.copy(eye); yawPitchToDir(yaw, pitch, dir); },
    addRecoil(p: number, y: number): void { pitch = clamp(pitch + p, -1.55, 1.55); yaw += y; },
    addShake(trauma: number): void { shake = clamp(shake + trauma * ctx.settings.data.screenShake, 0, 1); },
    addShakeAt(p: Vec3Like, trauma: number, radius: number): void { player.addShake(trauma * clamp(1 - eye.distanceTo(p as THREE.Vector3) / radius, 0, 1)); },
    setAds(amount: number, zoom: number, moveMul: number): void { ads = amount; adsZoom = zoom; adsMove = moveMul; },
    setSpeedMultiplier(source: string, mul: number): void { if (mul === 1) speedMuls.delete(source); else speedMuls.set(source, mul); },
    addOverclockCharge(points: number): void {
      const was = overclock.ready;
      overclock.charge = clamp(overclock.charge + points * ctx.mods.overclockGainMul, 0, 100);
      overclock.ready = overclock.charge >= 100 && !overclock.active;
      if (overclock.ready && !was) ctx.events.emit('overclock:ready', {});
    },
    activateOverclock(): boolean {
      if (!overclock.ready || !alive) return false;
      overclock.active = true; overclock.ready = false; overclock.charge = 0;
      overclock.duration = PLAYER.OVERCLOCK_SECONDS + ctx.mods.overclockDurationBonus;
      overclock.timeLeft = overclock.duration;
      ctx.time.setScale('overclock', PLAYER.OVERCLOCK_SCALE);
      ctx.render.post.overclock = 1;
      ctx.events.emit('overclock:start', { seconds: overclock.duration });
      return true;
    },

    init(): void {
      ctx.combat.register(target);
      // Subscribed before the director (init order): the combo multiplier read here is the one BEFORE this kill.
      ctx.events.on('enemy:killed', (e) => {
        if (!e.byPlayer || !alive) return;
        if (!overclock.active) player.addOverclockCharge(ENEMIES[e.type].overclockCharge * (e.crit ? 1.5 : 1) * (1 + 0.1 * (ctx.director.combo.multiplier - 1)));
        if (ctx.mods.lifeOnKill > 0 && player.heal(ctx.mods.lifeOnKill) > 0) ctx.fx.spawn('lifeSteal', center);
      });
      // The fight is won: from here until the next reset() nothing can hurt the player (cleanup blasts,
      // hazards or a fall during the staged death must not kill the victor).
      ctx.events.on('boss:defeated', () => { bossDown = true; });
      // The boss gives no charge on death: 1 point per 150 damage dealt to it instead.
      ctx.events.on('hit:confirmed', (e) => {
        if (alive && !overclock.active && ctx.enemies.boss?.id === e.targetId) player.addOverclockCharge(e.amount / 150);
      });
    },
    reset(): void {
      hp = player.maxHp; shield = player.maxShield; alive = true; target.alive = true; lastHit = -99; dashLeft = 0; ads = 0; adsZoom = 1; adsMove = 1; shake = 0;
      lastStandUsed = 0; grounded = false; launched = false; bossDown = false; speedMuls.clear();
      Object.assign(dash, { charges: 1, maxCharges: 1, cooldownLeft: 0, active: false });
      Object.assign(overclock, { charge: 0, ready: false, active: false, timeLeft: 0 });
      ctx.time.clearScale('overclock');
      player.teleport(ctx.world.playerStart.position, ctx.world.playerStart.yaw, 0);
    },
    // Our update stops outside 'playing': restore every level we own, or it would stay on for the end screens.
    onModeChange(mode: GameMode): void {
      if (mode === 'playing' || mode === 'paused') return;
      endOverclock();
      ctx.render.post.lowHealth = ctx.render.post.overclock = ctx.render.post.dashBlur = 0;
      ctx.audio.setMuffle(0);
    },
    update(dt: number): void {
      if (!alive) return;
      const input = ctx.input;
      input.consumeLook(look);
      yaw += look.yaw / (1 + (adsZoom - 1) * ads); pitch = clamp(pitch + look.pitch / (1 + (adsZoom - 1) * ads), -1.55, 1.55);
      let speedMul = ctx.mods.moveSpeedMul * (1 + (adsMove - 1) * ads);
      for (const m of speedMuls.values()) speedMul *= m;
      const speed = (input.isDown('sprint') ? PLAYER.SPRINT : PLAYER.WALK) * speedMul;
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      const wx = (input.moveX * cos - input.moveY * sin) * speed, wz = (-input.moveX * sin - input.moveY * cos) * speed;
      dash.maxCharges = 1 + ctx.mods.extraDashCharges; dash.cooldown = PLAYER.DASH_COOLDOWN * ctx.mods.dashCooldownMul;
      if (dash.charges < dash.maxCharges && (dash.cooldownLeft -= dt) <= 0) { dash.charges++; dash.cooldownLeft = dash.charges < dash.maxCharges ? dash.cooldown : 0; }
      if (input.justPressed('dash') && dash.charges > 0 && dashLeft <= 0) {
        dash.charges--; if (dash.cooldownLeft <= 0) dash.cooldownLeft = dash.cooldown;
        dashLeft = PLAYER.DASH_SECONDS; launched = false;
        const len = Math.hypot(wx, wz);
        velocity.x = (len > 0.01 ? wx / len : -sin) * PLAYER.DASH_SPEED; velocity.z = (len > 0.01 ? wz / len : -cos) * PLAYER.DASH_SPEED;
        ctx.events.emit('player:dashed', { chargesLeft: dash.charges });
      }
      dash.active = dashLeft > 0;
      if (dashLeft > 0) dashLeft -= dt;
      else if (!launched) { const k = grounded ? 14 : 3; velocity.x = damp(velocity.x, wx, k, dt); velocity.z = damp(velocity.z, wz, k, dt); }
      if (grounded && input.justPressed('jump')) { velocity.y = jumpSpeed(PLAYER.JUMP_APEX, PLAYER.GRAVITY); grounded = false; ctx.events.emit('player:jumped', { double: false }); }
      velocity.y -= PLAYER.GRAVITY * dt;
      const wasGrounded = grounded, fallSpeed = -velocity.y;
      delta.copy(velocity).multiplyScalar(dt);
      ctx.collision.moveAndSlide(position, PLAYER.HALF_WIDTH, PLAYER.HEIGHT, delta, COL.PLAYER, grounded ? PLAYER.STEP_UP : 0.2, grounded && velocity.y <= 0 ? PLAYER.STEP_UP : 0, move);
      grounded = move.grounded;
      if (move.hitX) velocity.x = 0;
      if (move.hitZ) velocity.z = 0;
      if (grounded) { velocity.y = 0; launched = false; }
      else if (move.hitCeiling) velocity.y = Math.min(velocity.y, 0);
      if (grounded && !wasGrounded && fallSpeed > 3) ctx.events.emit('player:landed', { impactSpeed: fallSpeed });
      if (ctx.time.now - lastHit > PLAYER.SHIELD_DELAY * ctx.mods.shieldDelayMul && shield < player.maxShield) shield = Math.min(player.maxShield, shield + PLAYER.SHIELD_REGEN * ctx.mods.shieldRegenMul * dt);
      if (input.justPressed('overclock')) player.activateOverclock();
      if (overclock.active && (overclock.timeLeft -= dt) <= 0) endOverclock();
      ctx.render.post.lowHealth = clamp(1 - hp / (player.maxHp * PLAYER.LOW_HEALTH), 0, 1);
      shake = damp(shake, 0, 4, dt);
      syncCamera();
    },
    // Recoil and shake added by weapons / combat during the substep reach the rendered camera in the same frame.
    lateUpdate(): void {
      if (alive) syncCamera();
    },
    dispose(): void { ctx.combat.unregister(targetId); },
  };
  return player;
}
