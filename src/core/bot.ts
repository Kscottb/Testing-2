/**
 * Autopilot used by soak tests (window.__SH.bot). It plays ONLY through the public interfaces on the
 * context and the virtual input, so every code path a human would hit gets exercised: aiming, firing,
 * reloading, weapon cycling, nav-grid movement, pickups, perks, dash, grenades, melee, Overclock.
 */
import * as THREE from 'three';
import { COL, WEAPON_IDS } from './constants';
import { makeNavPath } from './make';
import { angleDelta, clamp, dirToPitch, dirToYaw } from './math';
import { createRng } from './rng';
import type { BotOptions, Difficulty, EnemyHandle, GameContext, InputAction, PickupState, WeaponId } from './types';

export interface Bot {
  readonly enabled: boolean;
  setEnabled(on: boolean, opts?: BotOptions): void;
  /** Called by the frame pipeline before input.poll. */
  update(realDt: number): void;
}

const WEAPON_ACTIONS: Readonly<Record<WeaponId, InputAction>> = {
  vector: 'weapon1',
  breaker: 'weapon2',
  lance: 'weapon3',
  hornet: 'weapon4',
};

const HELD_ACTIONS: readonly InputAction[] = ['fire', 'ads', 'sprint', 'crouch'];

export function createBot(ctx: GameContext): Bot {
  const rng = createRng(0xb07);
  const path = makeNavPath(48);
  const goal = new THREE.Vector3();
  const steer = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  let enabled = false;
  let autoStart = false;
  let difficulty: Difficulty = 'veteran';
  let perkDelay = 0.4;
  let turnRate = 9;

  let menuTimer = 0;
  let perkTimer = 0;
  let targetId = 0;
  let targetVisible = false;
  let retargetTimer = 0;
  let repathTimer = 0;
  let hasPath = false;
  let strafeDir = 1;
  let strafeTimer = 0;
  let stuckTimer = 0;
  let semiTimer = 0;
  let switchTimer = 0;
  let grenadeTimer = 4;
  let dashTimer = 2;
  let jumpTimer = 2;
  let slideTimer = 6;
  let meleeTimer = 0;
  let wanderTimer = 0;
  let hasWander = false;
  const wander = new THREE.Vector3();

  const releaseAll = (): void => {
    for (const action of HELD_ACTIONS) ctx.input.setVirtualButton(action, false);
    ctx.input.setVirtualMove(0, 0);
  };

  const pickTarget = (): EnemyHandle | null => {
    let bestEnemy: EnemyHandle | null = null;
    let bestScore = Infinity;
    targetVisible = false;
    for (const enemy of ctx.enemies.list) {
      if (!enemy.alive || enemy.spawning) continue;
      const d = eye.distanceTo(enemy.aimPoint);
      const visible = ctx.collision.lineOfSight(eye, enemy.aimPoint, COL.PROJECTILE);
      // Prefer visible targets, then the closest; stick a little to the current one.
      const score = d + (visible ? 0 : 500) - (enemy.id === targetId ? 3 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestEnemy = enemy;
        targetVisible = visible;
      }
    }
    return bestEnemy;
  };

  /**
   * Next unlocked weapon (after the current one) that still has ammo and whose blast would not reach us
   * at `dist` metres; null if none.
   */
  const nextUsableWeapon = (dist: number): WeaponId | null => {
    const current = ctx.weapons.current.id;
    const start = WEAPON_IDS.indexOf(current);
    for (let i = 1; i <= WEAPON_IDS.length; i++) {
      const id = WEAPON_IDS[(start + i) % WEAPON_IDS.length] as WeaponId;
      const w = ctx.weapons.weapons[id];
      if (id === current || !w.unlocked || w.mag + w.reserve <= 0) continue;
      if (w.def.splashRadius > 0 && dist < w.def.splashRadius + 2) continue;
      return id;
    }
    return null;
  };

  /** Would walking into this pickup do anything? (A full-health player cannot collect a health cell.) */
  const pickupUseful = (pickup: PickupState): boolean => {
    const { player, weapons } = ctx;
    switch (pickup.type) {
      case 'health':
        return player.hp < player.maxHp;
      case 'shield':
        return player.shield < player.maxShield;
      case 'grenade':
        return weapons.grenades < weapons.grenadeCap;
      case 'ammo':
        for (const id of WEAPON_IDS) {
          const w = weapons.weapons[id];
          if (w.unlocked && w.reserve < w.reserveMax) return true;
        }
        return false;
      default:
        return true;
    }
  };

  /** Horizontal unit direction to walk toward `to`, following the nav grid when possible. */
  const steerToward = (to: THREE.Vector3, realDt: number): boolean => {
    const pos = ctx.player.position;
    repathTimer -= realDt;
    if (repathTimer <= 0) {
      repathTimer = 0.35;
      hasPath = ctx.nav.findPath(pos, to, path) && path.count > 0;
    }
    let tx = to.x;
    let tz = to.z;
    if (hasPath) {
      // Skip waypoints we are already standing on.
      let index = 0;
      while (index < path.count - 1) {
        const p = path.points[index] as THREE.Vector3;
        const dx = p.x - pos.x;
        const dz = p.z - pos.z;
        if (dx * dx + dz * dz > 0.8 * 0.8) break;
        index++;
      }
      const p = path.points[index] as THREE.Vector3;
      tx = p.x;
      tz = p.z;
    }
    steer.set(tx - pos.x, 0, tz - pos.z);
    const len = steer.length();
    if (len < 0.05) {
      steer.set(0, 0, 0);
      return false;
    }
    steer.multiplyScalar(1 / len);
    return true;
  };

  const update = (realDt: number): void => {
    if (!enabled) return;
    const { game, input, player, weapons, director } = ctx;
    const mode = game.mode;

    if (mode !== 'playing') {
      releaseAll();
      if (autoStart && (mode === 'menu' || mode === 'gameover' || mode === 'victory')) {
        menuTimer += realDt;
        if (menuTimer > 1) {
          menuTimer = 0;
          game.startRun(difficulty);
        }
      }
      return;
    }
    menuTimer = 0;

    // Perk screen: wait a moment (so the UI gets rendered in soak runs), then choose.
    const offer = director.perkOffer;
    if (director.phase === 'perkSelect' && offer && offer.length > 0) {
      releaseAll();
      perkTimer += realDt;
      if (perkTimer >= perkDelay) {
        perkTimer = 0;
        director.choosePerk(rng.int(0, offer.length - 1));
      }
      return;
    }
    perkTimer = 0;

    if (!player.alive) {
      releaseAll();
      return;
    }

    eye.copy(player.eye);

    // --- target -------------------------------------------------------------------------------
    retargetTimer -= realDt;
    let target = targetId ? (ctx.enemies.get(targetId) ?? null) : null;
    if (target && (!target.alive || target.spawning)) target = null;
    if (!target || retargetTimer <= 0) {
      retargetTimer = 0.2;
      target = pickTarget();
      targetId = target ? target.id : 0;
    }

    let dist = Infinity;
    let aimed = false;
    if (target) {
      // Lead slightly; closed-loop turn toward the aim point.
      aim.copy(target.aimPoint).addScaledVector(target.velocity, 0.06);
      tmp.subVectors(aim, eye);
      dist = tmp.length();
      const wantYaw = dirToYaw(tmp.x, tmp.z);
      const wantPitch = dirToPitch(tmp.x, tmp.y, tmp.z);
      const errYaw = angleDelta(player.yaw, wantYaw);
      const errPitch = wantPitch - player.pitch;
      const maxTurn = turnRate * realDt;
      input.addVirtualLook(clamp(errYaw * 0.55, -maxTurn, maxTurn), clamp(errPitch * 0.55, -maxTurn, maxTurn));
      const tolerance = 0.035 + Math.atan2(target.radius * 0.6, Math.max(dist, 0.5));
      aimed = targetVisible && Math.abs(errYaw) < tolerance && Math.abs(errPitch) < tolerance;
    } else {
      // Nothing to shoot: level the view and look where we walk.
      const errPitch = -player.pitch;
      const maxTurn = turnRate * 0.5 * realDt;
      let errYaw = 0;
      if (steer.lengthSq() > 0.01) errYaw = angleDelta(player.yaw, dirToYaw(steer.x, steer.z));
      input.addVirtualLook(clamp(errYaw * 0.3, -maxTurn, maxTurn), clamp(errPitch * 0.3, -maxTurn, maxTurn));
    }

    // --- weapons ------------------------------------------------------------------------------
    const weapon = weapons.current;
    const def = weapon.def;
    const ready = !weapon.reloading && !weapons.switching;
    // Never fire a splash weapon into our own face.
    const tooClose = def.splashRadius > 0 && dist < def.splashRadius + 2;
    let holdFire = false;
    let wantFire = false;
    semiTimer += realDt;
    if (target && ready && dist < def.range && !tooClose) {
      if (def.trigger === 'auto') {
        holdFire = aimed;
      } else if (def.trigger === 'charge') {
        // Releasing cancels the charge: once it started, keep holding until the shot goes off, even
        // when the aim flickers off the target for a frame.
        holdFire = aimed || weapon.charge > 0;
      } else if (aimed && semiTimer >= 60 / (def.rpm * Math.max(0.1, ctx.mods.fireRateMul)) + 0.03) {
        // Semi-automatic: one press per shot at the weapon's own cadence.
        semiTimer = 0;
        input.pressVirtual('fire');
      }
      wantFire = aimed;
    }
    input.setVirtualButton('fire', holdFire);
    input.setVirtualButton('ads', aimed && dist > 22);

    switchTimer += realDt;
    if (ready) {
      if (tooClose && switchTimer > 0.5) {
        const next = nextUsableWeapon(dist);
        if (next) {
          switchTimer = 0;
          input.pressVirtual(WEAPON_ACTIONS[next]);
        }
      } else if (weapon.mag === 0 && weapon.reserve > 0) {
        input.pressVirtual('reload');
      } else if (weapon.mag === 0 && weapon.reserve === 0) {
        const next = nextUsableWeapon(dist);
        if (next && switchTimer > 0.5) {
          switchTimer = 0;
          input.pressVirtual(WEAPON_ACTIONS[next]);
        }
      } else if (switchTimer > 7 && weapon.charge === 0) {
        switchTimer = 0;
        const next = nextUsableWeapon(dist);
        if (next) input.pressVirtual(WEAPON_ACTIONS[next]);
      } else if (!target && weapon.mag < weapon.magSize * 0.5 && weapon.reserve > 0) {
        input.pressVirtual('reload');
      }
    }

    // --- abilities ----------------------------------------------------------------------------
    grenadeTimer += realDt;
    dashTimer += realDt;
    jumpTimer += realDt;
    slideTimer += realDt;
    meleeTimer += realDt;
    if (target) {
      if (player.overclock.ready) input.pressVirtual('overclock');
      if (dist < 2.6 && meleeTimer > 0.8) {
        meleeTimer = 0;
        input.pressVirtual('melee');
      }
      if (weapons.grenades > 0 && aimed && dist > 9 && dist < 30 && grenadeTimer > 9) {
        grenadeTimer = 0;
        input.pressVirtual('grenade');
      }
      if (dashTimer > 5 && dist < 10 && player.dash.charges > 0) {
        dashTimer = 0;
        input.pressVirtual('dash');
      }
    }

    // --- movement -----------------------------------------------------------------------------
    let moveX = 0;
    let moveY = 0;
    let sprint = false;
    let haveGoal = false;

    // 1) Pickups (supply crates first), unless something is in our face.
    if (!target || dist > 7) {
      let bestD = 35 * 35;
      for (const pickup of director.pickups) {
        if (!pickupUseful(pickup)) continue;
        const d = pickup.position.distanceToSquared(player.position) * (pickup.type === 'weapon' ? 0.1 : 1);
        if (d < bestD) {
          bestD = d;
          goal.copy(pickup.position);
          haveGoal = true;
        }
      }
    }
    // 2) An enemy we cannot see: walk to it.
    if (!haveGoal && target && !targetVisible) {
      goal.copy(target.position);
      haveGoal = true;
    }
    // 3) Nothing to fight: follow the objective marker, else wander.
    if (!haveGoal && !target) {
      const marker = director.objective.position;
      if (marker) {
        goal.copy(marker);
        haveGoal = true;
      } else {
        wanderTimer -= realDt;
        if (wanderTimer <= 0 || !hasWander) {
          wanderTimer = 4;
          hasWander = ctx.nav.randomPointInAnnulus(player.position, 5, 18, rng, wander);
        }
        if (hasWander) {
          goal.copy(wander);
          haveGoal = true;
        }
      }
    }

    const sinYaw = Math.sin(player.yaw);
    const cosYaw = Math.cos(player.yaw);
    if (haveGoal) {
      if (steerToward(goal, realDt)) {
        // World direction -> local axes (forward = (-sin, -cos), right = (cos, -sin)).
        moveY = steer.x * -sinYaw + steer.z * -cosYaw;
        moveX = steer.x * cosYaw + steer.z * -sinYaw;
        sprint = goal.distanceToSquared(player.position) > 10 * 10 && !wantFire;
      }
    } else if (target) {
      // Combat dance: hold a 7-16 m band, strafe, never step off the walkable area.
      steer.set(0, 0, 0);
      strafeTimer -= realDt;
      if (strafeTimer <= 0) {
        strafeTimer = rng.range(1.1, 2.4);
        strafeDir = -strafeDir;
      }
      moveY = dist > 16 ? 1 : dist < 7 ? -1 : 0;
      moveX = strafeDir;
      const wx = (moveX * cosYaw + moveY * -sinYaw) * 1.6;
      const wz = (moveX * -sinYaw + moveY * -cosYaw) * 1.6;
      if (!ctx.nav.isWalkable(player.position.x + wx, player.position.z + wz)) {
        strafeDir = -strafeDir;
        moveX = -moveX;
        moveY = 0;
      }
    }

    // Stuck: wanting to move but not moving -> hop and change direction.
    if (Math.abs(moveX) + Math.abs(moveY) > 0.3 && player.speed < 0.6) {
      stuckTimer += realDt;
      if (stuckTimer > 0.7) {
        stuckTimer = 0;
        strafeDir = -strafeDir;
        repathTimer = 0;
        hasWander = false;
        input.pressVirtual('jump');
      }
    } else {
      stuckTimer = 0;
    }

    if (jumpTimer > 3.7 && player.grounded && Math.abs(moveX) + Math.abs(moveY) > 0.3) {
      jumpTimer = rng.range(0, 1.2);
      input.pressVirtual('jump');
    }
    if (slideTimer > 8 && sprint && player.grounded) {
      slideTimer = 0;
      input.pressVirtual('crouch', 0.4);
    }

    input.setVirtualButton('sprint', sprint);
    input.setVirtualMove(moveX, moveY);
  };

  return {
    get enabled(): boolean {
      return enabled;
    },
    setEnabled(on: boolean, opts?: BotOptions): void {
      enabled = on;
      ctx.debug.bot = on;
      if (opts) {
        autoStart = opts.autoStart ?? autoStart;
        difficulty = opts.difficulty ?? difficulty;
        perkDelay = opts.perkDelay ?? perkDelay;
        turnRate = opts.turnRate ?? turnRate;
      }
      if (!on) {
        ctx.input.clearVirtual();
        autoStart = false;
      }
      targetId = 0;
      hasPath = false;
      hasWander = false;
      semiTimer = 0;
    },
    update,
  };
}
