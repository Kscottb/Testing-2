/**
 * Hit-confirm feedback for PLAYER hits on hostile targets: one spark per damaging ray at once, and —
 * merged per target, flushed once per substep — one damage number, one hit sound, one 'hit:confirmed'.
 */
import * as THREE from 'three';
import { clearFxOptions, makeFxOptions, makeSoundOptions } from '../core/make';
import type {
  CombatSoundId,
  DamageInfo,
  DamageNumberOptions,
  DamageResult,
  DamageSource,
  EventMap,
  GameContext,
  HitPart,
  HitSphere,
  HitTarget,
} from '../core/types';
import { HIT_FX, MIN_DAMAGE_NUMBER, PART_RANK } from './tuning';

/** Everything that hit one target since the last flush. */
interface Pending {
  targetId: number;
  amount: number;
  crit: boolean;
  killed: boolean;
  /** Every hit so far was absorbed. */
  shield: boolean;
  part: HitPart;
  weapon: DamageSource | null;
  point: THREE.Vector3;
}

export interface HitFeedback {
  /** A player hit landed (dealt damage or was absorbed): spark now, the rest at the next flush. */
  record(target: HitTarget, info: Readonly<DamageInfo>, result: Readonly<DamageResult>): void;
  /** One number, one sound and one 'hit:confirmed' per target recorded since the last flush. */
  flush(): void;
  /** Drop everything pending without any feedback. */
  clear(): void;
  /** Targets waiting for the next flush. */
  readonly pending: number;
}

function hitSound(p: Pending): CombatSoundId {
  if (p.killed) return 'hitKill';
  if (p.crit) return 'hitCrit';
  if (p.shield || p.part === 'shield') return 'hitShield';
  if (p.part === 'armor') return 'hitArmor';
  return 'hitConfirm';
}

export function createHitFeedback(ctx: GameContext): HitFeedback {
  /** Pending records in first-hit order; `byTarget` finds the open one of a target. */
  const order: Pending[] = [];
  const byTarget = new Map<number, Pending>();
  const free: Pending[] = [];
  const sparkOpts = makeFxOptions();
  const soundOpts = makeSoundOptions();
  const numberOpts: DamageNumberOptions = { crit: false, shield: false, kill: false, targetId: 0 };
  const payload: EventMap['hit:confirmed'] = {
    targetId: 0,
    amount: 0,
    crit: false,
    killed: false,
    shield: false,
    part: 'body',
    weapon: null,
    point: new THREE.Vector3(),
  };

  const acquire = (targetId: number): Pending => {
    const p =
      free.pop() ??
      ({ targetId: 0, amount: 0, crit: false, killed: false, shield: true, part: 'shield', weapon: null, point: new THREE.Vector3() } as Pending);
    p.targetId = targetId;
    p.amount = 0;
    p.crit = false;
    p.killed = false;
    p.shield = true;
    p.part = 'shield';
    p.weapon = null;
    return p;
  };

  /** The spark of one damaging ray: thrown off the struck surface, carried along with a moving victim. */
  const spark = (target: HitTarget, info: Readonly<DamageInfo>, result: Readonly<DamageResult>): void => {
    const o = clearFxOptions(sparkOpts);
    const n = o.normal;
    const sphere = info.sphereIndex >= 0 ? (target.spheres[info.sphereIndex] as HitSphere | undefined) : undefined;
    if (sphere) n.subVectors(info.point, sphere.center);
    else n.copy(info.dir).negate();
    const len = n.length();
    if (len > 1e-5 && Number.isFinite(len)) n.multiplyScalar(1 / len);
    else if (info.dir.lengthSq() > 1e-10) n.copy(info.dir).negate().normalize();
    else n.set(0, 1, 0);
    // Sparks leave along the reflected shot: a glancing hit sprays on, a square hit sprays back.
    const along = info.dir.dot(n);
    o.dir.copy(info.dir).addScaledVector(n, -2 * along);
    if (!(o.dir.lengthSq() > 1e-10)) o.dir.copy(n);
    else o.dir.normalize();
    if (target.enemy) o.velocity.copy(target.enemy.velocity);
    // An absorbed hit reads as a shield hit whatever part it struck, matching the sound of the flush.
    ctx.fx.spawn(result.absorbed ? HIT_FX.shield : HIT_FX[result.part], info.point, o);
  };

  return {
    record(target: HitTarget, info: Readonly<DamageInfo>, result: Readonly<DamageResult>): void {
      if (!info.splash) spark(target, info, result);
      let p = byTarget.get(target.id);
      if (!p) {
        p = acquire(target.id);
        byTarget.set(target.id, p);
        order.push(p);
      }
      p.amount += result.dealt;
      if (result.crit) p.crit = true;
      if (result.killed) p.killed = true;
      if (!result.absorbed) p.shield = false;
      if (PART_RANK[result.part] > PART_RANK[p.part]) p.part = result.part;
      p.weapon = info.weapon;
      p.point.copy(info.point);
    },

    flush(): void {
      // Only what is pending NOW: a hit recorded by a listener of this very flush waits for the next one.
      const n = order.length;
      if (n === 0) return;
      // Several targets in one substep (a rail through a pack, a blast): the clicks must not add up to a bang.
      const volume = n > 1 ? 1 / Math.sqrt(n) : 1;
      for (let i = 0; i < n; i++) {
        const p = order[i] as Pending;
        // Closed before the feedback goes out, so a re-entrant hit on the same target opens a new record.
        byTarget.delete(p.targetId);

        if (p.amount >= MIN_DAMAGE_NUMBER) {
          numberOpts.crit = p.crit;
          numberOpts.shield = p.shield;
          numberOpts.kill = p.killed;
          numberOpts.targetId = p.targetId;
          ctx.fx.damageNumber(p.point, p.amount, numberOpts);
        }

        soundOpts.volume = volume;
        soundOpts.pitch = 1;
        soundOpts.delay = 0;
        soundOpts.owner = 0;
        soundOpts.priority = p.killed ? 3 : 2;
        ctx.audio.play(hitSound(p), soundOpts);

        payload.targetId = p.targetId;
        payload.amount = p.amount;
        payload.crit = p.crit;
        payload.killed = p.killed;
        payload.shield = p.shield;
        payload.part = p.part;
        payload.weapon = p.weapon;
        payload.point.copy(p.point);
        ctx.events.emit('hit:confirmed', payload);
      }
      for (let i = 0; i < n; i++) free.push(order[i] as Pending);
      // Keep whatever arrived during the flush, in order.
      const rest = order.length - n;
      for (let i = 0; i < rest; i++) order[i] = order[i + n] as Pending;
      order.length = rest;
    },

    clear(): void {
      for (let i = 0; i < order.length; i++) free.push(order[i] as Pending);
      order.length = 0;
      byTarget.clear();
    },

    get pending(): number {
      return order.length;
    },
  };
}
