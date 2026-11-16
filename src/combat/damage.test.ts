/**
 * The damage entry point and the hit-confirm feedback: routing without multipliers, unknown and dead
 * targets, one spark per ray, and the per-target merge flushed once per substep.
 */
import { describe, expect, it } from 'vitest';
import { clearDamageResult, makeDamageResult } from '../core/make';
import type { DamageInfo, DamageResult } from '../core/types';
import { createTestRig } from './testkit';

describe('applyDamage', () => {
  it('hands the info to the victim untouched and returns the victim\'s own result', () => {
    const rig = createTestRig();
    const result = makeDamageResult();
    let seen: DamageInfo | null = null;
    const target = rig.target({ part: 'weak' });
    target.takeDamage = (info): DamageResult => {
      seen = info;
      result.dealt = 123;
      result.part = 'armor';
      return result;
    };
    const info = rig.info(40, { part: 'weak', critScale: 3, knockback: 5, sphereIndex: 0 });
    const out = rig.combat.applyDamage(target, info);
    // The very same objects: no copy, no multiplier, no rewrite.
    expect(seen).toBe(info);
    expect(out).toBe(result);
    expect(info.amount).toBe(40);
    expect(info.critScale).toBe(3);
    expect(info.part).toBe('weak');
    expect(out.dealt).toBe(123);
  });

  it('applies no multiplier of its own for any part', () => {
    const rig = createTestRig();
    for (const part of ['body', 'weak', 'armor', 'shield'] as const) {
      const target = rig.target({ part, hp: 1000 });
      rig.combat.applyDamage(target, rig.info(17.5, { part, critScale: 2.5 }));
      expect(target.taken).toEqual([17.5]);
    }
  });

  it('accepts the target or its id', () => {
    const rig = createTestRig();
    const target = rig.target();
    expect(rig.combat.applyDamage(target.id, rig.info(10)).dealt).toBe(10);
    expect(rig.combat.applyDamage(target, rig.info(5)).dealt).toBe(5);
    expect(target.taken).toEqual([10, 5]);
  });

  it('deals 0 to unknown, unregistered and dead targets without calling them', () => {
    const rig = createTestRig();
    expect(rig.combat.applyDamage(987654, rig.info(10)).dealt).toBe(0);

    const stray = rig.target({ detached: true });
    const strayResult = rig.combat.applyDamage(stray, rig.info(10));
    expect(strayResult.dealt).toBe(0);
    expect(strayResult.killed).toBe(false);
    expect(stray.taken).toEqual([]);

    const dead = rig.target();
    dead.alive = false;
    expect(rig.combat.applyDamage(dead, rig.info(10)).dealt).toBe(0);
    expect(rig.combat.applyDamage(dead.id, rig.info(10)).dealt).toBe(0);
    expect(dead.taken).toEqual([]);

    const gone = rig.target();
    rig.combat.unregister(gone.id);
    expect(rig.combat.applyDamage(gone, rig.info(10)).dealt).toBe(0);
    expect(gone.taken).toEqual([]);

    const nan = rig.target();
    expect(rig.combat.applyDamage(nan, rig.info(NaN)).dealt).toBe(0);
    expect(nan.taken).toEqual([]);

    rig.step();
    expect(rig.hits).toEqual([]);
    expect(rig.fx.spawns).toEqual([]);
  });

  it('never emits or plays anything by itself beyond the spark of a player hit', () => {
    const rig = createTestRig();
    const target = rig.target();
    rig.combat.applyDamage(target, rig.info(10));
    expect(rig.fxIds()).toEqual(['hitEnemy']);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.hits).toEqual([]);
    expect(rig.fx.numbers).toEqual([]);
  });
});

describe('hit spark', () => {
  it('is spawned at once at the hit point, picked by the part of the result', () => {
    const rig = createTestRig();
    const parts = ['body', 'weak', 'armor', 'shield'] as const;
    const ids = ['hitEnemy', 'hitEnemyWeak', 'hitEnemyArmor', 'hitEnemyShield'];
    parts.forEach((part, i) => {
      const target = rig.target({ part, x: i * 3 });
      const info = rig.info(5, { part });
      info.point.set(i * 3, 1, 0.5);
      rig.combat.applyDamage(target, info);
      const spark = rig.fx.spawns[i];
      expect(spark?.id).toBe(ids[i]);
      expect([spark?.x, spark?.y, spark?.z]).toEqual([i * 3, 1, 0.5]);
    });
  });

  it('follows the part the victim reports, not the part that was aimed at', () => {
    const rig = createTestRig();
    const result = makeDamageResult();
    const target = rig.target();
    target.takeDamage = (): DamageResult => {
      clearDamageResult(result, 'shield');
      result.shieldDamage = result.dealt = 8;
      result.absorbed = true;
      return result;
    };
    rig.combat.applyDamage(target, rig.info(8, { part: 'body' }));
    expect(rig.fxIds()).toEqual(['hitEnemyShield']);
  });

  it('reads an absorbed hit as a shield hit whatever part it struck', () => {
    const rig = createTestRig();
    const result = makeDamageResult();
    const target = rig.target();
    target.takeDamage = (info): DamageResult => {
      clearDamageResult(result, info.part);
      result.absorbed = true;
      return result;
    };
    rig.combat.applyDamage(target, rig.info(8, { part: 'weak' }));
    expect(rig.fxIds()).toEqual(['hitEnemyShield']);
  });

  it('is one per damaging ray, none for splash, none for silent damage', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1000 });
    for (let i = 0; i < 9; i++) rig.combat.applyDamage(target, rig.info(11, { type: 'pellet' }));
    expect(rig.fxIds('hitEnemy').length).toBe(9);
    rig.combat.applyDamage(target, rig.info(11, { splash: true }));
    rig.combat.applyDamage(target, rig.info(11, { silent: true }));
    expect(rig.fxIds('hitEnemy').length).toBe(9);
  });

  it('names the struck surface and the direction of the shot', () => {
    const rig = createTestRig();
    const target = rig.target({ z: 0, radius: 1 });
    const info = rig.info(5, { sphereIndex: 0 });
    info.point.set(0, 2, 0);
    info.dir.set(0, 0, -1);
    rig.combat.applyDamage(target, info);
    const spark = rig.fx.spawns[0];
    // normal = out of the struck sphere; dir = the way the shot was travelling.
    expect([spark?.nx, spark?.ny, spark?.nz]).toEqual([0, 1, 0]);
    expect([spark?.dx, spark?.dy, spark?.dz]).toEqual([0, 0, -1]);
    // Without a sphere the normal faces the shooter; without a direction it still points somewhere sane.
    const blind = rig.info(5);
    blind.dir.set(0, 0, 0);
    rig.combat.applyDamage(target, blind);
    const second = rig.fx.spawns[1];
    expect(Math.hypot(second?.nx ?? 0, second?.ny ?? 0, second?.nz ?? 0)).toBeCloseTo(1, 6);
    expect(Math.hypot(second?.dx ?? 0, second?.dy ?? 0, second?.dz ?? 0)).toBeCloseTo(1, 6);
  });

  it('is not played for hits on the player, for enemy hits, or for hits that did nothing', () => {
    const rig = createTestRig();
    const enemy = rig.target();
    // On the player (whoever shoots): the player owns that feedback.
    rig.combat.applyDamage(rig.player.target, rig.info(5, { faction: 'enemy' }));
    rig.combat.applyDamage(rig.player.target, rig.info(5, { faction: 'player' }));
    rig.combat.applyDamage(rig.player.target, rig.info(5, { faction: 'neutral' }));
    // Enemy on enemy, neutral on enemy — also with player credit: the hitmarker is for the player's own hits.
    rig.combat.applyDamage(enemy, rig.info(5, { faction: 'enemy', creditPlayer: true }));
    rig.combat.applyDamage(enemy, rig.info(5, { faction: 'neutral' }));
    // A player hit that neither dealt damage nor was absorbed.
    const result = makeDamageResult();
    const ghost = rig.target();
    ghost.takeDamage = (info): DamageResult => clearDamageResult(result, info.part);
    rig.combat.applyDamage(ghost, rig.info(5));
    // A zero-amount "hit" is no hit.
    rig.combat.applyDamage(enemy, rig.info(0));
    rig.step();
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.hits).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.fx.numbers).toEqual([]);
  });
});

describe('feedback flush', () => {
  it('merges a nine-pellet blast on one enemy into one number, one sound and one event', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1000 });
    for (let i = 0; i < 9; i++) {
      const info = rig.info(11, { type: 'pellet', weapon: 'breaker' });
      info.point.set(i * 0.01, 1, 0.5);
      rig.combat.applyDamage(target, info);
    }
    // Nothing before the update...
    expect(rig.hits.length).toBe(0);
    expect(rig.fx.numbers.length).toBe(0);
    expect(rig.audio.sounds.length).toBe(0);
    rig.step();
    // ...then exactly one of each.
    expect(rig.fx.numbers).toEqual([{ x: 0.08, y: 1, z: 0.5, amount: 99, crit: false, shield: false, kill: false, targetId: target.id }]);
    expect(rig.soundIds()).toEqual(['hitConfirm']);
    expect(rig.audio.sounds[0]?.positional).toBe(false);
    expect(rig.hits.length).toBe(1);
    const hit = rig.hits[0];
    expect(hit?.targetId).toBe(target.id);
    expect(hit?.amount).toBe(99);
    expect(hit?.crit).toBe(false);
    expect(hit?.killed).toBe(false);
    expect(hit?.shield).toBe(false);
    expect(hit?.part).toBe('body');
    expect(hit?.weapon).toBe('breaker');
    expect(hit?.point.toArray()).toEqual([0.08, 1, 0.5]);
    // And nothing again on the next update.
    rig.step();
    expect(rig.hits.length).toBe(1);
    expect(rig.audio.sounds.length).toBe(1);
  });

  it('flushes once per target', () => {
    const rig = createTestRig();
    const a = rig.target({ x: -2, hp: 1000 });
    const b = rig.target({ x: 2, hp: 1000 });
    for (let i = 0; i < 4; i++) rig.combat.applyDamage(a, rig.info(10));
    for (let i = 0; i < 5; i++) rig.combat.applyDamage(b, rig.info(10));
    rig.combat.applyDamage(a, rig.info(10));
    rig.step();
    expect(rig.hits.map((h) => [h.targetId, h.amount])).toEqual([
      [a.id, 50],
      [b.id, 50],
    ]);
    expect(rig.fx.numbers.length).toBe(2);
    expect(rig.audio.sounds.length).toBe(2);
    // Several targets in one substep share the loudness.
    expect(rig.audio.sounds[0]?.volume).toBeLessThan(1);
  });

  it('merges crit = any, killed = any, shield = every hit absorbed, part = best, weapon and point = last', () => {
    const rig = createTestRig();
    const result = makeDamageResult();
    const target = rig.target({ hp: 1000 });
    const script: Partial<DamageResult>[] = [
      { dealt: 5, shieldDamage: 5, absorbed: true, part: 'shield' },
      { dealt: 7, healthDamage: 7, part: 'armor' },
      { dealt: 30, healthDamage: 30, crit: true, part: 'weak' },
      { dealt: 9, healthDamage: 9, part: 'body' },
    ];
    let call = 0;
    target.takeDamage = (info): DamageResult => Object.assign(clearDamageResult(result, info.part), script[call++]);
    for (let i = 0; i < script.length; i++) {
      const info = rig.info(10, { weapon: i === script.length - 1 ? 'lance' : 'vector' });
      info.point.set(i, 2, 3);
      rig.combat.applyDamage(target, info);
    }
    rig.step();
    const hit = rig.hits[0];
    expect(hit?.amount).toBe(51);
    expect(hit?.crit).toBe(true);
    expect(hit?.killed).toBe(false);
    expect(hit?.shield).toBe(false);
    expect(hit?.part).toBe('weak');
    expect(hit?.weapon).toBe('lance');
    expect(hit?.point.toArray()).toEqual([3, 2, 3]);
    expect(rig.soundIds()).toEqual(['hitCrit']);
    expect(rig.fx.numbers[0]?.crit).toBe(true);
  });

  it('picks the sound by priority: kill > crit > shield > armour > plain', () => {
    const cases: [Partial<DamageResult>[], string][] = [
      [[{ dealt: 5, part: 'body' }], 'hitConfirm'],
      [[{ dealt: 5, part: 'armor' }], 'hitArmor'],
      [[{ dealt: 5, shieldDamage: 5, absorbed: true, part: 'shield' }], 'hitShield'],
      [[{ dealt: 0, absorbed: true, part: 'body' }], 'hitShield'],
      [[{ dealt: 5, part: 'armor' }, { dealt: 5, crit: true, part: 'weak' }], 'hitCrit'],
      [[{ dealt: 5, crit: true, part: 'weak' }, { dealt: 5, killed: true, part: 'body' }], 'hitKill'],
      [[{ dealt: 5, absorbed: true, part: 'shield' }, { dealt: 5, part: 'armor' }], 'hitArmor'],
    ];
    for (const [script, sound] of cases) {
      const rig = createTestRig();
      const result = makeDamageResult();
      const target = rig.target();
      let call = 0;
      target.takeDamage = (info): DamageResult => Object.assign(clearDamageResult(result, info.part), script[call++]);
      for (let i = 0; i < script.length; i++) rig.combat.applyDamage(target, rig.info(10));
      rig.step();
      expect(rig.soundIds()).toEqual([sound]);
    }
  });

  it('confirms a kill although the victim unregistered itself meanwhile', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 20 });
    rig.combat.applyDamage(target, rig.info(14));
    const last = rig.combat.applyDamage(target, rig.info(14));
    expect(last.killed).toBe(true);
    expect(rig.combat.getTarget(target.id)).toBeUndefined();
    rig.step();
    expect(rig.hits.length).toBe(1);
    expect(rig.hits[0]?.killed).toBe(true);
    expect(rig.hits[0]?.amount).toBe(20);
    expect(rig.soundIds()).toEqual(['hitKill']);
    expect(rig.fx.numbers[0]?.kill).toBe(true);
  });

  it('draws no number for a fully absorbed hit but still confirms it', () => {
    const rig = createTestRig();
    const result = makeDamageResult();
    const target = rig.target();
    target.takeDamage = (info): DamageResult => {
      clearDamageResult(result, info.part);
      result.absorbed = true;
      return result;
    };
    rig.combat.applyDamage(target, rig.info(50));
    rig.step();
    expect(rig.fx.numbers).toEqual([]);
    expect(rig.hits.length).toBe(1);
    expect(rig.hits[0]?.shield).toBe(true);
    expect(rig.hits[0]?.amount).toBe(0);
  });

  it('counts splash and chain damage of the player in the merge, without a spark', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1000 });
    rig.combat.applyDamage(target, rig.info(30, { splash: true, type: 'explosion', weapon: 'hornet' }));
    rig.step();
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.hits.length).toBe(1);
    expect(rig.hits[0]?.amount).toBe(30);
    expect(rig.hits[0]?.weapon).toBe('hornet');
  });

  it('holds a hit recorded by a listener of the flush for the next update', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1000 });
    let echoed = false;
    rig.ctx.events.on('hit:confirmed', (e) => {
      if (echoed) return;
      echoed = true;
      // The payload is live and reused: read it before causing the next hit.
      expect(e.amount).toBe(10);
      rig.combat.applyDamage(target, rig.info(3, { type: 'chain', weapon: 'chainLightning' }));
    });
    rig.combat.applyDamage(target, rig.info(10));
    rig.step();
    expect(rig.hits.map((h) => h.amount)).toEqual([10]);
    rig.step();
    expect(rig.hits.map((h) => h.amount)).toEqual([10, 3]);
    expect(rig.hits[1]?.weapon).toBe('chainLightning');
  });

  it('stops cleanly when a listener of the flush resets the game', () => {
    const rig = createTestRig();
    const a = rig.target({ x: -2, hp: 1000 });
    const b = rig.target({ x: 2, hp: 1000 });
    rig.ctx.events.on('hit:confirmed', () => rig.combat.reset());
    rig.combat.applyDamage(a, rig.info(10));
    rig.combat.applyDamage(b, rig.info(10));
    expect(() => rig.step()).not.toThrow();
    expect(rig.hits.map((h) => h.targetId)).toEqual([a.id]);
    rig.step();
    expect(rig.hits.length).toBe(1);
  });

  it('is dropped silently by reset', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1000 });
    rig.combat.applyDamage(target, rig.info(10));
    const sparks = rig.fx.spawns.length;
    rig.combat.reset();
    rig.step();
    expect(rig.hits).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.fx.numbers).toEqual([]);
    expect(rig.fx.spawns.length).toBe(sparks);
    // Registrations are kept: the owner unregisters its own target.
    expect(rig.combat.getTarget(target.id)).toBe(target);
    expect(rig.combat.getTarget(rig.player.target.id)).toBe(rig.player.target);
  });
});
