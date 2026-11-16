/**
 * Explosions: always queued, FIFO, chains inside one update, the cap; falloff to the bounding sphere,
 * knockback, cover, faction rules, exclusion, credit; and the audiovisual package of a blast.
 */
import { describe, expect, it } from 'vitest';
import { PALETTE } from '../core/palette';
import type { ExplosionOptions } from '../core/types';
import { box, createTestRig } from './testkit';
import type { TestRig } from './testkit';
import { BLAST_LOOKS, FIRE_COLOR, MAX_BLASTS_PER_UPDATE } from './tuning';

const at = (x: number, y: number, z: number, over: Partial<ExplosionOptions> = {}): ExplosionOptions => ({
  position: { x, y, z },
  radius: 5,
  damage: 100,
  faction: 'player',
  ...over,
});

/** Explode and resolve in the next substep. */
function blast(rig: TestRig, opts: ExplosionOptions): void {
  rig.combat.explode(opts);
  rig.step();
}

describe('explosion queue', () => {
  it('never resolves inside the call', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 2 });
    rig.combat.explode(at(0, 1, 0));
    expect(target.taken).toEqual([]);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.player.shakes).toEqual([]);
    rig.step();
    expect(target.taken.length).toBe(1);
    expect(rig.fxIds('explosion')).toEqual(['explosionLarge']);
  });

  it('copies the options: the caller may reuse its object at once', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 2 });
    const opts = at(0, 1, 0);
    rig.combat.explode(opts);
    (opts.position as { x: number }).x = 500;
    opts.damage = 1;
    opts.radius = 0.1;
    rig.step();
    expect(target.taken.length).toBe(1);
    expect(target.taken[0]).toBeGreaterThan(50);
  });

  it('resolves in FIFO order', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 100000 });
    for (const damage of [10, 20, 30, 40]) rig.combat.explode(at(0, 1, 0, { damage, edgeFalloff: 1 }));
    rig.step();
    expect(target.taken).toEqual([10, 20, 30, 40]);
  });

  it('resolves a chain reaction inside one update, without recursion', () => {
    const rig = createTestRig();
    // A row of ticks 2 m apart: each one that dies queues its own blast from inside takeDamage.
    const order: number[] = [];
    let depth = 0;
    let maxDepth = 0;
    const ticks = Array.from({ length: 8 }, (_, i) => rig.target({ x: i * 2, hp: 30 }));
    ticks.forEach((tick, i) => {
      tick.onDamage = (info, result): void => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        if (result.killed) {
          order.push(i);
          rig.combat.explode(at(i * 2, 1, 0, { faction: 'enemy', friendlyFire: true, ownerId: tick.id, damage: 45, radius: 5, creditPlayer: info.faction === 'player' || info.creditPlayer }));
        }
        depth--;
      };
    });
    rig.combat.applyDamage(ticks[0] as (typeof ticks)[number], rig.info(40));
    rig.step();
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ticks.every((t) => !t.alive)).toBe(true);
    expect(rig.fxIds('explosionLarge').length).toBe(8);
    // Never a blast resolving inside another one's damage loop.
    expect(maxDepth).toBe(1);
    // The player's credit travels down the whole chain.
    expect(ticks[7]?.lastInfo?.creditPlayer).toBe(true);
    expect(ticks[7]?.lastInfo?.faction).toBe('enemy');
  });

  it('resolves at most the cap per update and keeps the rest for the next substep', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1e9 });
    const total = MAX_BLASTS_PER_UPDATE + 9;
    for (let i = 0; i < total; i++) rig.combat.explode(at(0, 1, 0, { damage: i + 1, edgeFalloff: 1 }));
    rig.step();
    expect(target.taken.length).toBe(MAX_BLASTS_PER_UPDATE);
    expect(target.taken[MAX_BLASTS_PER_UPDATE - 1]).toBe(MAX_BLASTS_PER_UPDATE);
    rig.step();
    expect(target.taken.length).toBe(total);
    expect(target.taken[total - 1]).toBe(total);
  });

  it('survives far more queued blasts than its first buffer holds, in order', () => {
    const rig = createTestRig();
    const target = rig.target({ hp: 1e9 });
    for (let i = 0; i < 300; i++) rig.combat.explode(at(0, 1, 0, { damage: i + 1, edgeFalloff: 1, visual: 'none' }));
    for (let i = 0; i < 12; i++) rig.step();
    expect(target.taken.length).toBe(300);
    expect(target.taken.every((v, i) => v === i + 1)).toBe(true);
  });

  it('forgets queued blasts on reset, silently', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 2 });
    rig.combat.explode(at(0, 1, 0));
    rig.combat.reset();
    rig.step();
    expect(target.taken).toEqual([]);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
  });

  it('ignores and reports a broken request, a few times at most', () => {
    const rig = createTestRig();
    for (let i = 0; i < 6; i++) rig.combat.explode(at(NaN, 1, 0));
    rig.combat.explode(at(0, 1, 0, { radius: 0 }));
    rig.combat.explode(at(0, 1, 0, { damage: Infinity }));
    rig.step();
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.game.errors.length).toBe(3);
    expect(rig.game.errors[0]?.source).toBe('combat:explode');
  });
});

describe('explosion damage', () => {
  it('falls off linearly to the edge, measured to the bounding sphere', () => {
    const rig = createTestRig();
    const centre = rig.target({ x: 0, radius: 0.5, hp: 1e6 });
    // Surface at 2 m, at 5 m (the very edge) and just beyond.
    const mid = rig.target({ x: 2.5, radius: 0.5, hp: 1e6 });
    const edge = rig.target({ x: 5.5, radius: 0.5, hp: 1e6 });
    const beyond = rig.target({ x: 5.6, radius: 0.5, hp: 1e6 });
    // A big target whose centre is far outside but whose hull reaches in.
    const big = rig.target({ x: 0, z: 7, radius: 3, hp: 1e6 });
    blast(rig, at(0, 1, 0, { damage: 100, radius: 5, edgeFalloff: 0.2, faction: 'neutral', lineOfSight: false }));
    expect(centre.taken).toEqual([100]);
    expect(mid.taken[0]).toBeCloseTo(100 * (1 - 0.8 * (2 / 5)), 6);
    expect(edge.taken[0]).toBeCloseTo(20, 6);
    expect(beyond.taken).toEqual([]);
    expect(big.taken[0]).toBeCloseTo(100 * (1 - 0.8 * (4 / 5)), 6);
  });

  it('defaults to 20 % at the edge and lets knockback fall off the same way', () => {
    const rig = createTestRig();
    const near = rig.target({ x: 0.2, radius: 0.5, hp: 1e6 });
    const far = rig.target({ x: 3, radius: 0.5, hp: 1e6 });
    blast(rig, at(0, 1, 0, { damage: 50, radius: 5, knockback: 10, lineOfSight: false }));
    expect(near.taken).toEqual([50]);
    expect(near.lastInfo?.knockback).toBe(10);
    const k = 1 - 0.8 * (2.5 / 5);
    expect(far.taken[0]).toBeCloseTo(50 * k, 6);
    expect(far.lastInfo?.knockback).toBeCloseTo(10 * k, 6);
    // Default impulse at the centre is 6.
    const rig2 = createTestRig();
    const other = rig2.target({ x: 0.2, radius: 0.5 });
    blast(rig2, at(0, 1, 0));
    expect(other.lastInfo?.knockback).toBe(6);
  });

  it('describes the hit as splash from the blast toward the victim', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 3, radius: 0.5, part: 'weak' });
    blast(rig, at(0, 1, 0, { ownerId: rig.player.target.id, weapon: 'hornet', type: 'explosion' }));
    const info = target.lastInfo;
    expect(info?.splash).toBe(true);
    expect(info?.part).toBe('body');
    expect(info?.sphereIndex).toBe(-1);
    expect(info?.faction).toBe('player');
    expect(info?.sourceId).toBe(rig.player.target.id);
    expect(info?.weapon).toBe('hornet');
    expect(info?.type).toBe('explosion');
    expect(info?.creditPlayer).toBe(false);
    expect(info?.silent).toBe(false);
    expect(info?.dir.toArray()).toEqual([1, 0, 0]);
    // The point lies on the side of the victim that faces the blast.
    expect(info?.point.x).toBeLessThan(3);
    expect(info?.point.x).toBeGreaterThan(2.4);
    // Defaults.
    const rig2 = createTestRig();
    const plain = rig2.target({ x: 3 });
    blast(rig2, at(0, 1, 0));
    expect(plain.lastInfo?.type).toBe('explosion');
    expect(plain.lastInfo?.weapon).toBeNull();
    expect(plain.lastInfo?.sourceId).toBe(0);
  });

  it('never hurts anything behind solid cover, unless the caller switches the test off', () => {
    const wall = box(2, 0, -6, 2.3, 6, 6);
    const rig = createTestRig([wall]);
    const hidden = rig.target({ x: 4, hp: 1e6 });
    const open = rig.target({ x: -3, hp: 1e6 });
    blast(rig, at(0, 1, 0));
    expect(hidden.taken).toEqual([]);
    expect(open.taken.length).toBe(1);
    blast(rig, at(0, 1, 0, { lineOfSight: false }));
    expect(hidden.taken.length).toBe(1);
    expect(open.taken.length).toBe(2);
  });

  it('is not blocked by a kerb beside a shell lying on the floor', () => {
    // A 0.4 m pad edge between a blast at floor level and a target standing on the pad.
    const rig = createTestRig([box(1, 0, -4, 6, 0.4, 4)]);
    const onPad = rig.target({ x: 2.5, y: 1.4, radius: 0.6, hp: 1e6 });
    blast(rig, at(0.9, 0.08, 0));
    expect(onPad.taken.length).toBe(1);
  });

  it('lets shots pass what only blocks bodies (a railing) but not glass', () => {
    const rig = createTestRig([
      box(2, 0, -6, 2.2, 3, 6, { flags: 3 }),
      box(-2.2, 0, -6, -2, 6, 6, { flags: 7, surface: 'glass' }),
    ]);
    const behindRailing = rig.target({ x: 4, hp: 1e6 });
    const behindGlass = rig.target({ x: -4, hp: 1e6 });
    blast(rig, at(0, 1, 0));
    expect(behindRailing.taken.length).toBe(1);
    expect(behindGlass.taken).toEqual([]);
  });

  it('player blasts hurt enemies, and the player by the self-damage share', () => {
    const rig = createTestRig();
    const enemy = rig.target({ x: 0, z: 39, hp: 1e6 });
    const player = rig.player.target;
    blast(rig, at(0, 1, 38.6, { damage: 100, edgeFalloff: 1 }));
    expect(enemy.taken).toEqual([100]);
    // Default share 0.35.
    expect(player.taken[0]).toBeCloseTo(35, 6);
    blast(rig, at(0, 1, 38.6, { damage: 100, edgeFalloff: 1, selfDamageMul: 0.5 }));
    expect(player.taken[1]).toBeCloseTo(50, 6);
    // 0 = the player is not touched at all (explosive crits).
    blast(rig, at(0, 1, 38.6, { damage: 100, edgeFalloff: 1, selfDamageMul: 0 }));
    expect(player.taken.length).toBe(2);
    expect(enemy.taken.length).toBe(3);
  });

  it('enemy blasts hurt the player; other enemies only with friendly fire, the instigator never', () => {
    const rig = createTestRig();
    const owner = rig.target({ x: 0, z: 39, hp: 1e6 });
    const mate = rig.target({ x: 1, z: 39, hp: 1e6 });
    const player = rig.player.target;
    blast(rig, at(0, 1, 39.5, { faction: 'enemy', ownerId: owner.id, damage: 45, edgeFalloff: 1 }));
    expect(player.taken).toEqual([45]);
    expect(mate.taken).toEqual([]);
    expect(owner.taken).toEqual([]);
    blast(rig, at(0, 1, 39.5, { faction: 'enemy', ownerId: owner.id, damage: 45, edgeFalloff: 1, friendlyFire: true }));
    expect(player.taken).toEqual([45, 45]);
    expect(mate.taken).toEqual([45]);
    expect(owner.taken).toEqual([]);
    expect(mate.lastInfo?.faction).toBe('enemy');
  });

  it('neutral blasts hurt everyone in full', () => {
    const rig = createTestRig();
    const enemy = rig.target({ x: 0, z: 39, hp: 1e6 });
    blast(rig, at(0, 1, 39.5, { faction: 'neutral', damage: 60, edgeFalloff: 1 }));
    expect(enemy.taken).toEqual([60]);
    expect(rig.player.target.taken).toEqual([60]);
  });

  it('spares the excluded target and passes the player credit on', () => {
    const rig = createTestRig();
    const struck = rig.target({ x: 0.5, hp: 1e6 });
    const bystander = rig.target({ x: -1, hp: 1e6 });
    blast(rig, at(0, 1, 0, { faction: 'enemy', friendlyFire: true, excludeId: struck.id, creditPlayer: true }));
    expect(struck.taken).toEqual([]);
    expect(bystander.taken.length).toBe(1);
    expect(bystander.lastInfo?.creditPlayer).toBe(true);
  });

  it('skips a victim that an earlier victim of the same blast removed', () => {
    const rig = createTestRig();
    const first = rig.target({ x: 1, hp: 10 });
    const second = rig.target({ x: -1, hp: 1e6 });
    first.onDamage = (): void => {
      second.alive = false;
      rig.combat.unregister(second.id);
    };
    blast(rig, at(0, 1, 0));
    expect(first.taken.length).toBe(1);
    expect(second.taken).toEqual([]);
  });

  it('confirms the player\'s splash hits in the same update: a number, a sound and an event per victim, no spark', () => {
    const rig = createTestRig();
    const a = rig.target({ x: 1, hp: 1e6 });
    const b = rig.target({ x: -1, hp: 30 });
    blast(rig, at(0, 1, 0, { weapon: 'grenade' }));
    expect(rig.fxIds('hitEnemy')).toEqual([]);
    expect(rig.hits.map((h) => h.targetId)).toEqual([a.id, b.id]);
    expect(rig.hits[1]?.killed).toBe(true);
    expect(rig.hits[0]?.weapon).toBe('grenade');
    expect(rig.fx.numbers.length).toBe(2);
    expect(rig.soundIds('hit')).toEqual(['hitConfirm', 'hitKill']);
  });
});

describe('explosion package', () => {
  it('plays the recipe of its visual sized to the damage radius', () => {
    const cases = [
      ['small', 'explosionSmall'],
      ['large', 'explosionLarge'],
      ['plasma', 'explosionPlasma'],
      ['shock', 'explosionShock'],
      ['boss', 'explosionBoss'],
    ] as const;
    for (const [visual, id] of cases) {
      const rig = createTestRig();
      blast(rig, at(3, 1, 2, { radius: 6.5, visual }));
      const spawn = rig.fx.spawns.find((s) => s.id === id);
      expect(spawn, visual).toBeDefined();
      expect(spawn?.radius).toBe(6.5);
      expect([spawn?.x, spawn?.y, spawn?.z]).toEqual([3, 1, 2]);
      expect(rig.soundIds('explosion')).toEqual([id]);
      expect(rig.audio.sounds.find((s) => s.id === id)?.positional).toBe(true);
      // A sound that must ring out carries no owner.
      expect(rig.audio.sounds.find((s) => s.id === id)?.owner).toBe(0);
      expect(rig.fx.lights.length).toBe(1);
      expect(rig.player.shakes.length).toBe(1);
    }
  });

  it('picks small below 4 m and large from 4 m when no visual is given', () => {
    const rig = createTestRig();
    blast(rig, at(0, 1, 0, { radius: 3.9 }));
    blast(rig, at(0, 1, 0, { radius: 4 }));
    expect(rig.fxIds('explosion')).toEqual(['explosionSmall', 'explosionLarge']);
  });

  it('plays nothing at all for visual none, but still deals its damage', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 1, faction: 'neutral' });
    blast(rig, at(0, 1, 0, { visual: 'none', faction: 'enemy' }));
    expect(target.taken.length).toBe(1);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.fx.decals).toEqual([]);
    expect(rig.fx.lights).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.player.shakes).toEqual([]);
  });

  it('leaves a scorch on the surface next to it', () => {
    const rig = createTestRig();
    blast(rig, at(0, 1, 0, { radius: 5, visual: 'large' }));
    expect(rig.fx.decals.length).toBe(1);
    const decal = rig.fx.decals[0];
    expect(decal?.kind).toBe('scorch');
    expect(decal?.y).toBeCloseTo(0, 6);
    expect(decal?.boxId).toBeGreaterThanOrEqual(0);
    expect(decal?.size).toBeCloseTo(5 * BLAST_LOOKS.large.decalScale, 6);
    // High in the air: nothing to scorch.
    const rig2 = createTestRig();
    blast(rig2, at(0, 12, 0, { radius: 5, visual: 'large' }));
    expect(rig2.fxIds()).toEqual(['explosionLarge']);
    expect(rig2.fx.decals).toEqual([]);
  });

  it('adds the ground ring only below a burst in the air whose blast still reaches the floor', () => {
    const ringsAt = (y: number, visual: 'small' | 'large' | 'shock' | 'boss' = 'large'): number => {
      const rig = createTestRig();
      blast(rig, at(0, y, 0, { radius: 5, visual }));
      const rings = rig.fx.spawns.filter((s) => s.id === 'shockwaveRing');
      for (const ring of rings) {
        // Always with the damage radius, lying on the floor under the blast.
        expect(ring.radius).toBe(5);
        expect(ring.y).toBeCloseTo(0, 6);
        expect(ring.x).toBe(0);
      }
      return rings.length;
    };
    // On or near the floor the recipe draws its own ring: no second one.
    expect(ringsAt(0.08)).toBe(0);
    expect(ringsAt(1)).toBe(0);
    // A rocket that burst on a chest three metres up.
    expect(ringsAt(3)).toBe(1);
    expect(ringsAt(3, 'boss')).toBe(1);
    expect(ringsAt(3, 'shock')).toBe(1);
    // Too high for the blast to matter down there; and never for a small look.
    expect(ringsAt(4.5)).toBe(0);
    expect(ringsAt(3, 'small')).toBe(0);
  });

  it('scorches the nearest wall when there is no floor in reach', () => {
    const rig = createTestRig([box(1, 0, -5, 1.5, 20, 5)]);
    blast(rig, at(0.4, 10, 0, { radius: 5, visual: 'large' }));
    expect(rig.fx.decals.length).toBe(1);
    expect(rig.fx.decals[0]?.x).toBeCloseTo(1, 6);
    expect(rig.fxIds('shockwaveRing')).toEqual([]);
  });

  it('lights the blast in a fire colour that is none of the accents, plasma by faction, the boss in magenta', () => {
    const rig = createTestRig();
    blast(rig, at(0, 1, 0, { visual: 'large' }));
    expect(rig.fx.lights[0]?.color).toBe(FIRE_COLOR);
    expect(rig.fx.lights[0]?.intensity).toBe(3);
    const accents: number[] = [PALETTE.player, PALETTE.enemy, PALETTE.elite, PALETTE.hazard, PALETTE.lightning];
    expect(accents).not.toContain(FIRE_COLOR);
    blast(rig, at(0, 1, 0, { visual: 'plasma', faction: 'enemy' }));
    expect(rig.fx.lights[1]?.color).toBe(PALETTE.enemy);
    blast(rig, at(0, 1, 0, { visual: 'boss', faction: 'enemy' }));
    expect(rig.fx.lights[2]?.color).toBe(PALETTE.elite);
    expect(rig.fx.lights[2]?.intensity).toBe(6);
    // Out of the floor, so it lights the room.
    expect(rig.fx.lights[0]?.y).toBeGreaterThan(0.1);
  });

  it('switches to the distant sound beyond 40 m from the listener, arriving late', () => {
    const rig = createTestRig();
    // The listener (camera) stands at z = 40.
    blast(rig, at(0, 1, 1));
    blast(rig, at(0, 1, -1));
    expect(rig.soundIds('explosion')).toEqual(['explosionLarge', 'explosionDistant']);
    expect(rig.audio.sounds[0]?.delay).toBe(0);
    expect(rig.audio.sounds[1]?.delay).toBeCloseTo(41 / 343, 2);
  });

  it('shakes the camera through the player with distance falloff left to the player', () => {
    const rig = createTestRig();
    blast(rig, at(0, 1, 0, { radius: 5, visual: 'large' }));
    const shake = rig.player.shakes[0];
    expect([shake?.x, shake?.y, shake?.z]).toEqual([0, 1, 0]);
    expect(shake?.trauma).toBe(BLAST_LOOKS.large.trauma);
    expect(shake?.radius).toBeGreaterThanOrEqual(12);
  });

  it('rumbles only within 12 m of the player', () => {
    const rig = createTestRig();
    blast(rig, at(0, 1, 27));
    expect(rig.input.rumbles).toEqual([]);
    blast(rig, at(0, 1, 34));
    expect(rig.input.rumbles.length).toBe(1);
    blast(rig, at(0, 1, 39));
    expect(rig.input.rumbles[1]?.strength).toBeGreaterThan(rig.input.rumbles[0]?.strength ?? 1);
  });

  it('adds chromatic boost, a screen flash and hit-stop only when the blast is close', () => {
    const far = createTestRig();
    blast(far, at(0, 1, 20, { visual: 'large' }));
    expect(far.render.post.chromaticBoost).toBe(0);
    expect(far.render.flashes).toEqual([]);
    expect(far.time.hitstops).toEqual([]);

    const close = createTestRig();
    blast(close, at(0, 1, 38, { visual: 'large', selfDamageMul: 0 }));
    expect(close.render.post.chromaticBoost).toBeGreaterThan(0.3);
    expect(close.render.flashes.length).toBe(1);
    expect(close.render.flashes[0]?.intensity).toBeGreaterThan(0.1);
    expect(close.time.hitstops.length).toBe(1);
    expect(close.time.hitstops[0]).toBeLessThanOrEqual(0.25);

    // A small look never freezes time; chromaticBoost is an impulse: the strongest writer wins.
    const small = createTestRig();
    small.render.post.chromaticBoost = 0.9;
    blast(small, at(0, 1, 39, { visual: 'small', selfDamageMul: 0 }));
    expect(small.time.hitstops).toEqual([]);
    expect(small.render.post.chromaticBoost).toBe(0.9);
  });

  it('does not flash the screen through a wall, nor freeze time after the run ended', () => {
    const rig = createTestRig([box(-6, 0, 38.4, 6, 6, 38.6)]);
    blast(rig, at(0, 1, 37.5, { visual: 'large', selfDamageMul: 0 }));
    expect(rig.render.flashes).toEqual([]);
    expect(rig.render.post.chromaticBoost).toBeGreaterThan(0);

    const over = createTestRig();
    over.game.mode = 'gameover';
    blast(over, at(0, 1, 38, { visual: 'large', selfDamageMul: 0 }));
    expect(over.fxIds('explosion')).toEqual(['explosionLarge']);
    expect(over.time.hitstops).toEqual([]);
    expect(over.input.rumbles).toEqual([]);
  });

  it('lets a chain ring out as a ripple of sounds while every blast resolves at once', () => {
    const rig = createTestRig();
    for (let i = 0; i < 4; i++) rig.combat.explode(at(i * 2, 1, 30));
    rig.step();
    const delays = rig.audio.sounds.filter((s) => s.id === 'explosionLarge').map((s) => s.delay);
    expect(delays.length).toBe(4);
    expect(delays[0]).toBe(0);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 1);
    expect(delays[3]).toBeLessThan(0.2);
  });
});
