/**
 * Projectiles: continuous collision, the two clocks, bounces, fuses and lifetimes, homing, direct hit vs
 * splash, shoot-down, landing prediction, whiz-by, pool exhaustion, error containment, reset.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MAX_PROJECTILES } from '../core/constants';
import { makeShotHit } from '../core/make';
import { PALETTE } from '../core/palette';
import type { ProjectileOptions } from '../core/types';
import { box, createTestRig } from './testkit';
import type { TestRig } from './testkit';

type Shot = Partial<ProjectileOptions> & { kind: ProjectileOptions['kind'] };

/** Launch a projectile (the player's by default) from (0, 1, 0) along +X. */
function fire(rig: TestRig, shot: Shot): number {
  const faction = shot.faction ?? 'player';
  return rig.combat.spawnProjectile({
    position: { x: 0, y: 1, z: 0 },
    velocity: { x: 30, y: 0, z: 0 },
    faction,
    ownerId: faction === 'player' ? rig.player.target.id : 0,
    damage: 10,
    ...shot,
  });
}

/** Live drawn position of a projectile (the vector its trail follows). */
function where(rig: TestRig, id: number): THREE.Vector3 {
  const trail = rig.fx.trails.find((t) => t.owner === id);
  if (!trail) throw new Error(`no trail for projectile ${id}`);
  return trail.position;
}

describe('continuous collision', () => {
  it('does not tunnel through a 0.2 m wall at 60 m/s with dt 1/30', () => {
    for (const offset of [0, 0.37, 0.93, 1.41, 1.99]) {
      const rig = createTestRig([box(10, 0, -5, 10.2, 5, 5, { surface: 'plating' })]);
      const behind = rig.target({ x: 12, hp: 1e6 });
      fire(rig, { kind: 'plasmaBolt', position: { x: offset, y: 1, z: 0 }, velocity: { x: 60, y: 0, z: 0 } });
      rig.run(0.5, 1 / 30);
      expect(rig.combat.projectileCount).toBe(0);
      expect(behind.taken).toEqual([]);
      const impact = rig.fx.spawns.find((s) => s.id === 'impactPlasma');
      expect(impact, `offset ${offset}`).toBeDefined();
      expect(impact?.x).toBeCloseTo(10, 6);
      expect(impact?.nx).toBe(-1);
    }
  });

  it('does not tunnel through a small target at 60 m/s with dt 1/30', () => {
    for (const offset of [0, 0.5, 1.1, 1.7]) {
      const rig = createTestRig();
      const target = rig.target({ x: 15, radius: 0.3, hp: 1e6 });
      fire(rig, { kind: 'lightBolt', position: { x: offset, y: 1, z: 0 }, velocity: { x: 60, y: 0, z: 0 }, damage: 5 });
      rig.run(0.5, 1 / 30);
      expect(target.taken, `offset ${offset}`).toEqual([5]);
      expect(rig.combat.projectileCount).toBe(0);
    }
  });

  it('reaches the same impact whatever the frame rate', () => {
    const impacts: number[] = [];
    for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
      const rig = createTestRig();
      fire(rig, { kind: 'mortar', velocity: { x: 9, y: 11, z: 0 }, gravity: 24, splashRadius: 4, damage: 35 });
      rig.run(3, dt);
      const blast = rig.fx.spawns.find((s) => s.id === 'explosionLarge');
      impacts.push(blast?.x ?? NaN);
    }
    expect(impacts[1]).toBeCloseTo(impacts[0] ?? NaN, 1);
    expect(impacts[2]).toBeCloseTo(impacts[0] ?? NaN, 1);
    // The analytic range of that arc from 1 m up.
    const t = (11 + Math.sqrt(121 + 48)) / 24;
    expect(impacts[1]).toBeCloseTo(9 * t, 1);
  });

  it('uses its collision radius against targets but not against the world', () => {
    const rig = createTestRig([box(8, 0, 0.1, 9, 5, 5)]);
    // Passes 0.1 m beside a wall corner: a point against the world.
    const near = rig.target({ x: 20, z: 0.6, radius: 0.5, hp: 1e6 });
    fire(rig, { kind: 'plasmaBolt', radius: 0.2 });
    rig.run(1);
    // 0.6 m off the path, radius 0.5 + 0.2 = 0.7: struck.
    expect(near.taken).toEqual([10]);
    expect(rig.fxIds('impact')).toEqual([]);
  });

  it('never hits its owner or its own faction', () => {
    const rig = createTestRig();
    const owner = rig.target({ x: 0.2, hp: 1e6 });
    const mate = rig.target({ x: 5, hp: 1e6 });
    const foe = rig.target({ faction: 'player', x: 10, hp: 1e6 });
    fire(rig, { kind: 'plasmaBolt', faction: 'enemy', ownerId: owner.id });
    rig.run(1);
    expect(owner.taken).toEqual([]);
    expect(mate.taken).toEqual([]);
    expect(foe.taken).toEqual([10]);
  });

  it('hands the direct hit to the victim exactly as launched', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 10, part: 'weak', hp: 1e6 });
    fire(rig, { kind: 'rocket', damage: 110, weapon: 'hornet', critScale: 1.5, knockback: 8, creditPlayer: true });
    rig.run(1);
    const info = target.lastInfo;
    expect(target.taken).toEqual([110]);
    expect(info?.type).toBe('explosion');
    expect(info?.faction).toBe('player');
    expect(info?.sourceId).toBe(rig.player.target.id);
    expect(info?.weapon).toBe('hornet');
    expect(info?.part).toBe('weak');
    expect(info?.sphereIndex).toBe(0);
    expect(info?.critScale).toBe(1.5);
    expect(info?.knockback).toBe(8);
    expect(info?.splash).toBe(false);
    expect(info?.creditPlayer).toBe(true);
    expect(info?.dir.x).toBeCloseTo(1, 6);
    // The point lies on the struck sphere.
    expect(info?.point.distanceTo(target.center)).toBeCloseTo(0.5, 5);
  });
});

describe('launch', () => {
  it('never starts a shell beyond the wall its shooter is hugging', () => {
    // The player stands at z = 40; a thin wall 0.4 m in front of him, an enemy behind it.
    const rig = createTestRig([box(-4, 0, 39.4, 4, 5, 39.6)]);
    const behind = rig.target({ x: 0, y: 1.65, z: 37, hp: 1e6 });
    // Weapons launch at eye + forward * 0.6: that point lies beyond the wall.
    fire(rig, { kind: 'rocket', position: { x: 0, y: 1.65, z: 39.2 }, velocity: { x: 0, y: 0, z: -45 }, damage: 110, splashRadius: 5, splashDamage: 90, selfDamageMul: 0.35 });
    rig.run(0.3);
    expect(rig.combat.projectileCount).toBe(0);
    expect(behind.taken).toEqual([]);
    const blast = rig.fx.spawns.find((s) => s.id === 'explosionLarge');
    expect(blast?.z).toBeGreaterThan(39.6);
    expect(blast?.z).toBeLessThan(39.8);
    // He blew it up in his own face.
    expect(rig.player.target.taken.length).toBe(1);
  });

  it('still lets the shooter fire over low cover and from an open muzzle', () => {
    // A 1.2 m crate right in front of the player: the muzzle at eye height clears it.
    const rig = createTestRig([box(-1, 0, 39.3, 1, 1.2, 39.6)]);
    const target = rig.target({ x: 0, y: 1.65, z: 30, hp: 1e6 });
    fire(rig, { kind: 'rocket', position: { x: 0, y: 1.65, z: 39.4 }, velocity: { x: 0, y: 0, z: -45 }, damage: 110 });
    rig.run(0.4);
    expect(target.taken).toEqual([110]);
  });

  it('a shootable projectile never collides with its own hit target, whatever its faction', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'bossMissile', faction: 'neutral', ownerId: 0, position: { x: 0, y: 9, z: 0 }, velocity: { x: 5, y: 0, z: 0 }, splashRadius: 3 });
    rig.run(0.5);
    expect(rig.combat.projectileCount).toBe(1);
    expect(rig.combat.getTarget(id)?.alive).toBe(true);
    expect(rig.fx.spawns).toEqual([]);
  });
});

describe('clocks', () => {
  it('moves the player\'s projectiles at full speed and the others on scaled time', () => {
    const rig = createTestRig();
    rig.time.scale = 0.4;
    const mine = fire(rig, { kind: 'rocket', velocity: { x: 45, y: 0, z: 0 } });
    const theirs = fire(rig, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 0, y: 3, z: 0 }, velocity: { x: 32, y: 0, z: 0 } });
    rig.run(0.5);
    expect(where(rig, mine).x).toBeCloseTo(45 * 0.5, 4);
    expect(where(rig, theirs).x).toBeCloseTo(32 * 0.5 * 0.4, 4);
  });

  it('lets the clock option override the faction default', () => {
    const rig = createTestRig();
    rig.time.scale = 0.4;
    const slowMine = fire(rig, { kind: 'rocket', clock: 'world' });
    const fastTheirs = fire(rig, { kind: 'plasmaBolt', faction: 'enemy', clock: 'player', position: { x: 0, y: 3, z: 0 } });
    rig.run(0.5);
    expect(where(rig, slowMine).x).toBeCloseTo(30 * 0.5 * 0.4, 4);
    expect(where(rig, fastTheirs).x).toBeCloseTo(30 * 0.5, 4);
  });

  it('runs fuse and lifetime on the projectile\'s own clock', () => {
    const rig = createTestRig();
    rig.time.scale = 0.4;
    fire(rig, { kind: 'grenade', velocity: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 30, z: 0 }, fuse: 1, splashRadius: 3 });
    fire(rig, { kind: 'grenade', faction: 'enemy', velocity: { x: 0, y: 0, z: 0 }, position: { x: 9, y: 30, z: 0 }, fuse: 1, splashRadius: 3 });
    rig.run(1.01);
    // One real second: the player's fuse is over, the enemy's has 0.6 s of world time left.
    expect(rig.fxIds('explosion').length).toBe(1);
    expect(rig.combat.projectileCount).toBe(1);
    rig.run(1.5);
    expect(rig.fxIds('explosion').length).toBe(2);
  });

  it('stands still while paused and keeps flying after the run ended', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'rocket' });
    rig.game.mode = 'paused';
    rig.run(0.5);
    expect(where(rig, id).x).toBe(0);
    // Game over: the player clock equals the world clock, nothing freezes in mid-air.
    rig.game.mode = 'gameover';
    rig.run(0.5);
    expect(where(rig, id).x).toBeCloseTo(15, 4);
  });

  it('accepts a zero step', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'rocket' });
    rig.step(0);
    rig.combat.update(0);
    expect(where(rig, id).x).toBe(0);
    expect(rig.game.errors).toEqual([]);
  });
});

describe('bounce, fuse and lifetime', () => {
  it('loses energy with every bounce, comes to rest, and bursts when the fuse ends', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'grenade', position: { x: 0, y: 3, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, gravity: 18, bounce: 0.42, fuse: 4, splashRadius: 6.5, splashDamage: 140, damage: 0 });
    const pos = where(rig, id);
    const apexes: number[] = [];
    let rising = false;
    let last = pos.y;
    for (let i = 0; i < 60 * 3.5; i++) {
      rig.step();
      if (pos.y > last + 1e-9) rising = true;
      else if (rising && pos.y < last - 1e-9) {
        apexes.push(last);
        rising = false;
      }
      last = pos.y;
      // Never through the floor: the shell rests on its radius.
      expect(pos.y).toBeGreaterThan(0.1);
    }
    expect(apexes.length).toBeGreaterThanOrEqual(2);
    // Drop height above the resting height is 2.88 m; restitution 0.42 keeps 0.42^2 of the energy.
    expect((apexes[0] ?? 0) - 0.12).toBeCloseTo(2.88 * 0.42 * 0.42, 1);
    for (let i = 1; i < apexes.length; i++) expect(apexes[i]).toBeLessThan(apexes[i - 1] ?? 0);
    // At rest on the floor, one radius up.
    expect(pos.y).toBeCloseTo(0.12, 2);
    const resting = pos.clone();
    rig.run(0.3);
    expect(pos.distanceTo(resting)).toBe(0);
    expect(rig.combat.projectileCount).toBe(1);
    // Bounce feedback: an effect and a positional sound per real bounce, none while resting.
    expect(rig.fxIds('grenadeBounce').length).toBeGreaterThanOrEqual(2);
    expect(rig.fxIds('grenadeBounce').length).toBe(rig.soundIds('grenadeBounce').length);
    expect(rig.fxIds('grenadeBounce').length).toBeLessThan(8);
    expect(rig.audio.sounds.filter((s) => s.id === 'grenadeBounce').every((s) => s.owner === 0)).toBe(true);

    rig.run(0.5);
    expect(rig.combat.projectileCount).toBe(0);
    const burst = rig.fx.spawns.find((s) => s.id === 'explosionLarge');
    expect(burst?.radius).toBe(6.5);
    expect(burst?.x).toBeCloseTo(resting.x, 6);
  });

  it('keeps part of its speed along the floor, rolls out and stops', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'grenade', position: { x: 0, y: 1, z: 0 }, velocity: { x: 12, y: 2, z: 0 }, gravity: 18, bounce: 0.42, fuse: 6, damage: 0 });
    const pos = where(rig, id);
    rig.run(5);
    expect(pos.x).toBeGreaterThan(6);
    expect(pos.x).toBeLessThan(30);
    expect(pos.y).toBeCloseTo(0.12, 2);
    const stopped = pos.x;
    rig.run(0.5);
    expect(pos.x).toBe(stopped);
  });

  it('bounces off a wall and never ends up inside it', () => {
    const rig = createTestRig([box(6, 0, -5, 7, 6, 5)]);
    const id = fire(rig, { kind: 'grenade', position: { x: 0, y: 1.5, z: 0 }, velocity: { x: 19, y: 3, z: 0 }, gravity: 18, bounce: 0.42, fuse: 3, damage: 0 });
    const pos = where(rig, id);
    let maxX = 0;
    for (let i = 0; i < 150; i++) {
      rig.step();
      maxX = Math.max(maxX, pos.x);
    }
    expect(maxX).toBeGreaterThan(5.5);
    expect(maxX).toBeLessThanOrEqual(6 - 0.12 + 1e-6);
    // It came back off the wall.
    expect(pos.x).toBeLessThan(5.5);
  });

  it('rolls off a ledge and falls again', () => {
    // A 2 m high platform ending at x = 4.
    const rig = createTestRig([box(-6, 0, -4, 4, 2, 4)]);
    const id = fire(rig, { kind: 'grenade', position: { x: 1.5, y: 2.3, z: 0 }, velocity: { x: 10, y: 0, z: 0 }, gravity: 18, bounce: 0.3, fuse: 6, damage: 0 });
    const pos = where(rig, id);
    // First it rolls along the platform, one radius above it...
    rig.run(0.25);
    expect(pos.x).toBeLessThan(4);
    expect(pos.y).toBeCloseTo(2.12, 2);
    // ...then over the edge and down to the floor.
    rig.run(4);
    expect(pos.x).toBeGreaterThan(4);
    expect(pos.y).toBeCloseTo(0.12, 2);
  });

  it('bursts on contact with a hostile target, in flight and at rest', () => {
    const rig = createTestRig();
    const flying = rig.target({ x: 8, y: 1.2, hp: 1e6 });
    fire(rig, { kind: 'grenade', position: { x: 0, y: 1.2, z: 0 }, velocity: { x: 19, y: 3, z: 0 }, gravity: 18, bounce: 0.42, fuse: 3, splashRadius: 6.5, splashDamage: 140, damage: 0 });
    rig.run(1);
    expect(rig.combat.projectileCount).toBe(0);
    // No direct damage to double up with: the blast, at full strength, is what the struck target gets.
    expect(flying.taken.length).toBe(1);
    expect(flying.taken[0]).toBeGreaterThan(135);
    expect(flying.lastInfo?.splash).toBe(true);
    expect(rig.fxIds('explosionLarge').length).toBe(1);

    const rig2 = createTestRig();
    const id = fire(rig2, { kind: 'grenade', position: { x: 0, y: 0.3, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, gravity: 18, bounce: 0.42, fuse: 30, splashRadius: 6.5, splashDamage: 140, damage: 0 });
    rig2.run(1.5);
    expect(rig2.combat.projectileCount).toBe(1);
    // An enemy walks onto the resting shell.
    const walker = rig2.target({ x: 3, y: 0.6, radius: 0.6, hp: 1e6 });
    for (let i = 0; i < 120 && rig2.combat.projectileCount > 0; i++) {
      walker.center.x -= 0.05;
      rig2.step();
    }
    expect(rig2.combat.projectileCount).toBe(0);
    expect(walker.center.x).toBeGreaterThan(0.3);
    expect(rig2.fxIds('explosionLarge').length).toBe(1);
    void id;
  });

  it('bursts exactly where the fuse ends, whatever the frame rate', () => {
    const burstAt: number[] = [];
    for (const dt of [1 / 30, 1 / 60, 1 / 97]) {
      const rig = createTestRig();
      fire(rig, { kind: 'rocket', position: { x: 0, y: 10, z: 0 }, velocity: { x: 20, y: 0, z: 0 }, fuse: 0.775, splashRadius: 5 });
      rig.run(1.2, dt);
      burstAt.push(rig.fx.spawns.find((s) => s.id === 'explosionLarge')?.x ?? NaN);
    }
    for (const x of burstAt) expect(x).toBeCloseTo(20 * 0.775, 6);
  });

  it('expires silently at the end of its lifetime', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'rocket', position: { x: 0, y: 10, z: 0 }, velocity: { x: 5, y: 0, z: 0 }, lifetime: 0.5, splashRadius: 5 });
    rig.run(0.6);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.soundIds()).toEqual([]);
    expect(rig.fx.cancelled).toContain(id);
    // Default lifetime: 8 s.
    const rig2 = createTestRig([], false);
    fire(rig2, { kind: 'plasmaBolt', velocity: { x: 1, y: 0, z: 0 } });
    rig2.run(7.9, 1 / 30);
    expect(rig2.combat.projectileCount).toBe(1);
    rig2.run(0.2, 1 / 30);
    expect(rig2.combat.projectileCount).toBe(0);
  });

  it('is removed once it leaves the world bounds', () => {
    const rig = createTestRig([], false);
    fire(rig, { kind: 'plasmaBolt', velocity: { x: 40, y: 0, z: 0 }, lifetime: 60 });
    fire(rig, { kind: 'grenade', velocity: { x: 0, y: 0, z: 0 }, gravity: 2, lifetime: 60 });
    rig.run(1.4);
    expect(rig.combat.projectileCount).toBe(2);
    rig.run(0.4);
    // 64 m east at 40 m/s: gone. The shell is still falling toward the lower margin.
    expect(rig.combat.projectileCount).toBe(1);
    rig.run(1.5);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.fx.spawns).toEqual([]);
  });
});

describe('impact', () => {
  it('deals the direct hit to the struck target only, and the splash to everyone else', () => {
    const rig = createTestRig();
    const struck = rig.target({ x: 10, hp: 1e6 });
    const neighbour = rig.target({ x: 10, z: 2.5, hp: 1e6 });
    fire(rig, { kind: 'rocket', velocity: { x: 45, y: 0, z: 0 }, damage: 110, splashRadius: 5, splashDamage: 90, weapon: 'hornet', selfDamageMul: 0.35 });
    rig.run(0.5);
    // No double dip: the direct hit only.
    expect(struck.taken).toEqual([110]);
    expect(struck.lastInfo?.splash).toBe(false);
    // The neighbour takes splash with falloff, never the direct damage.
    expect(neighbour.taken.length).toBe(1);
    expect(neighbour.taken[0]).toBeLessThan(90);
    expect(neighbour.taken[0]).toBeGreaterThan(30);
    expect(neighbour.lastInfo?.splash).toBe(true);
    expect(neighbour.lastInfo?.weapon).toBe('hornet');
    // One blast, sized to the splash radius, with the look of the kind.
    const blast = rig.fx.spawns.filter((s) => s.id.startsWith('explosion'));
    expect(blast.map((s) => s.id)).toEqual(['explosionLarge']);
    expect(blast[0]?.radius).toBe(5);
    // The direct hit sparked at once; both victims are confirmed in the update that resolved the blast.
    expect(rig.fxIds('hitEnemy').length).toBe(1);
    expect(rig.hits.map((h) => h.targetId).sort()).toEqual([struck.id, neighbour.id].sort());
  });

  it('defaults the splash damage to the direct damage and the look to the kind', () => {
    const rig = createTestRig();
    const near = rig.target({ x: 20, z: 0.9, hp: 1e6 });
    fire(rig, { kind: 'bossMissile', faction: 'neutral', ownerId: 0, damage: 22, splashRadius: 3.5, position: { x: 0, y: 0.5, z: 0 }, velocity: { x: 20, y: -0.5, z: 0 } });
    rig.run(1.2);
    expect(rig.fxIds('explosion')).toEqual(['explosionSmall']);
    expect(near.taken.length).toBe(1);
    expect(near.taken[0]).toBeGreaterThan(22 * 0.2);
    expect(near.taken[0]).toBeLessThanOrEqual(22);
  });

  it('bursts on the world with a scorch on the surface it struck', () => {
    const rig = createTestRig([box(10, 0, -5, 11, 6, 5)]);
    const hidden = rig.target({ x: 12, hp: 1e6 });
    const open = rig.target({ x: 8, z: 2, hp: 1e6 });
    fire(rig, { kind: 'rocket', velocity: { x: 45, y: 0, z: 0 }, position: { x: 0, y: 3, z: 0 }, damage: 110, splashRadius: 5, splashDamage: 90 });
    rig.run(0.5);
    expect(rig.fxIds('explosion')).toEqual(['explosionLarge']);
    expect(rig.fx.decals.length).toBe(1);
    expect(rig.fx.decals[0]?.kind).toBe('scorch');
    expect(rig.fx.decals[0]?.x).toBeCloseTo(10, 4);
    expect(rig.fx.decals[0]?.y).toBeCloseTo(3, 4);
    expect(open.taken.length).toBe(1);
    // The blast starts on the near side of the wall: what stands behind it is safe.
    expect(hidden.taken).toEqual([]);
  });

  it('marks the world where a shell without splash lands: effect, sound, decal, no owner', () => {
    const rig = createTestRig([box(10, 0, -5, 11, 6, 5, { surface: 'grate' })]);
    fire(rig, { kind: 'plasmaBolt', faction: 'enemy' });
    fire(rig, { kind: 'lightBolt', faction: 'enemy', position: { x: 0, y: 2, z: 0 } });
    fire(rig, { kind: 'bossBolt', faction: 'enemy', position: { x: 0, y: 3, z: 0 } });
    rig.run(0.5);
    expect(rig.fxIds('impact')).toEqual(['impactPlasma', 'impactBolt', 'impactPlasma']);
    expect(rig.soundIds('impact')).toEqual(['impactPlasma', 'impactPlasma', 'impactPlasma']);
    expect(rig.audio.sounds.every((s) => s.owner === 0 && s.positional)).toBe(true);
    expect(rig.fx.decals.map((d) => d.kind)).toEqual(['plasmaBurn', 'plasmaBurn', 'plasmaBurn']);
    // Energy reads by faction; the conductor's by the elite accent.
    expect(rig.fx.spawns[0]?.color).toBe(PALETTE.enemy);
    expect(rig.fx.spawns[2]?.color).toBe(PALETTE.elite);
    expect(rig.fx.spawns[0]?.nx).toBe(-1);
    // No explosion package for a bolt.
    expect(rig.fxIds('explosion')).toEqual([]);
    expect(rig.player.shakes).toEqual([]);
  });

  it('lets an energy surface answer with its own shimmer', () => {
    const rig = createTestRig([box(10, 0, -5, 11, 6, 5, { surface: 'energy', flags: 7, decals: false })]);
    fire(rig, { kind: 'plasmaBolt', faction: 'enemy' });
    rig.run(0.5);
    expect(rig.fxIds('impact')).toEqual(['impactEnergy']);
    expect(rig.soundIds('impact')).toEqual(['impactEnergy']);
  });

  it('gives a plasma blast the accent of what fired it', () => {
    const rig = createTestRig([box(10, 0, -5, 11, 6, 5)]);
    fire(rig, { kind: 'bossBolt', faction: 'enemy', splashRadius: 3 });
    rig.run(0.5);
    const blast = rig.fx.spawns.find((s) => s.id === 'explosionPlasma');
    expect(blast?.color).toBe(PALETTE.elite);
    expect(rig.fx.lights[0]?.color).toBe(PALETTE.elite);
  });

  it('plays nothing of its own when it strikes the player', () => {
    const rig = createTestRig();
    fire(rig, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 0, y: 1, z: 30 }, velocity: { x: 0, y: 0, z: 32 }, damage: 9 });
    rig.run(0.5);
    expect(rig.player.target.taken).toEqual([9]);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.hits).toEqual([]);
    expect(rig.fx.numbers).toEqual([]);
  });
});

describe('homing', () => {
  it('converges on its target at constant speed with a limited turn rate', () => {
    const rig = createTestRig();
    // Launched at right angles to the player (who stands at z = 40).
    const id = fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 0, y: 6, z: 10 }, velocity: { x: 20, y: 0, z: 0 }, homing: 1.6, damage: 22, splashRadius: 3.5 });
    const pos = where(rig, id);
    const prev = pos.clone();
    let turned = 0;
    let lastDir: THREE.Vector3 | null = null;
    let steps = 0;
    while (rig.combat.projectileCount > 0 && steps < 600) {
      rig.step();
      steps++;
      if (rig.combat.projectileCount === 0) break;
      const moved = pos.clone().sub(prev);
      // Constant speed while homing.
      expect(moved.length()).toBeCloseTo(20 / 60, 5);
      const dir = moved.normalize();
      if (lastDir) {
        const angle = dir.angleTo(lastDir);
        // Never faster than the turn rate.
        expect(angle).toBeLessThanOrEqual(1.6 / 60 + 1e-6);
        turned += angle;
      }
      lastDir = dir;
      prev.copy(pos);
    }
    expect(rig.combat.projectileCount).toBe(0);
    expect(steps).toBeLessThan(600);
    expect(rig.player.target.taken[0]).toBe(22);
    expect(turned).toBeGreaterThan(1);
  });

  it('homes on the player by default for enemy fire, on nothing for the player\'s', () => {
    const rig = createTestRig();
    rig.target({ x: 0, z: -30, hp: 1e6 });
    const mine = fire(rig, { kind: 'rocket', homing: 3, position: { x: 0, y: 10, z: 0 } });
    rig.run(0.5);
    expect(where(rig, mine).z).toBe(0);
    expect(where(rig, mine).x).toBeCloseTo(15, 4);
  });

  it('homes on an explicit target and flies straight once that target is gone', () => {
    const rig = createTestRig();
    const prey = rig.target({ x: 0, y: 10, z: -30, hp: 1e6 });
    const id = fire(rig, { kind: 'rocket', homing: 3, targetId: prey.id, position: { x: 0, y: 10, z: 0 }, velocity: { x: 20, y: 0, z: 0 }, damage: 50 });
    rig.run(0.4);
    const pos = where(rig, id);
    expect(pos.z).toBeLessThan(-0.5);
    prey.alive = false;
    const a = pos.clone();
    rig.step();
    const b = pos.clone();
    rig.step();
    // Straight line from here on.
    expect(pos.clone().sub(b).normalize().dot(b.clone().sub(a).normalize())).toBeCloseTo(1, 9);
  });

  it('turns around a target dead astern instead of producing NaN', () => {
    const rig = createTestRig();
    fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 0, y: 1, z: 30 }, velocity: { x: 0, y: 0, z: -20 }, homing: 2.5, damage: 22 });
    rig.run(6);
    expect(rig.game.errors).toEqual([]);
    expect(rig.player.target.taken).toEqual([22]);
  });
});

describe('shoot-down', () => {
  it('registers a shootable projectile as a hit target that hostile fire destroys harmlessly', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 0, y: 2, z: 37 }, velocity: { x: 0, y: 0, z: 0.5 }, damage: 22, splashRadius: 3.5 });
    const target = rig.combat.getTarget(id);
    expect(target).toBeDefined();
    expect(target?.faction).toBe('enemy');
    expect(target?.enemy).toBeNull();
    expect(target?.spheres.length).toBe(1);
    expect(target?.alive).toBe(true);
    rig.step();

    // The player's shot finds it...
    const out = makeShotHit();
    const dir = new THREE.Vector3(0, 2 - 1.65, -3).normalize();
    expect(rig.combat.traceShot(rig.player.eye, dir, 50, { faction: 'player', ignoreId: rig.player.target.id }, out)).toBe(true);
    expect(out.kind).toBe('target');
    expect(out.target?.id).toBe(id);

    // ...and any damage of his destroys it.
    const info = rig.info(14, { part: out.part, sphereIndex: out.sphereIndex });
    info.point.copy(out.point);
    const result = rig.combat.applyDamage(out.target ?? 0, info);
    expect(result.killed).toBe(true);
    expect(result.dealt).toBe(14);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.combat.getTarget(id)).toBeUndefined();
    expect(rig.fx.cancelled).toContain(id);
    expect(rig.audio.stopped).toContain(id);

    rig.step();
    // A small burst, but no blast damage: the player 3 m away is untouched.
    const burst = rig.fx.spawns.find((s) => s.id === 'explosionSmall');
    expect(burst).toBeDefined();
    expect(burst?.radius).toBeLessThan(3.5);
    expect(rig.player.target.taken).toEqual([]);
    // The player is told he got it.
    expect(rig.hits.length).toBe(1);
    expect(rig.hits[0]?.targetId).toBe(id);
    expect(rig.hits[0]?.killed).toBe(true);
    expect(rig.soundIds('hit')).toEqual(['hitKill']);
  });

  it('ignores damage of its own faction and survives a silent probe', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 0, y: 5, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, damage: 22, splashRadius: 3.5 });
    expect(rig.combat.applyDamage(id, rig.info(50, { faction: 'enemy' })).dealt).toBe(0);
    expect(rig.combat.projectileCount).toBe(1);
    // A tick blast with friendly fire next to it does not set it off either.
    rig.combat.explode({ position: { x: 0, y: 5, z: 1 }, radius: 5, damage: 45, faction: 'enemy', friendlyFire: true });
    rig.step();
    expect(rig.combat.projectileCount).toBe(1);
    // Neutral damage (a hazard) is hostile to everyone.
    expect(rig.combat.applyDamage(id, rig.info(1, { faction: 'neutral' })).killed).toBe(true);
    expect(rig.combat.projectileCount).toBe(0);
  });

  it('is destroyed by the splash of the player\'s rocket, and by a direct hit of it', () => {
    const rig = createTestRig();
    const missile = fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 12, y: 3, z: 0 }, velocity: { x: 0, y: 0, z: 0.1 }, damage: 22, splashRadius: 3.5 });
    const second = fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 12, y: 3, z: 2 }, velocity: { x: 0, y: 0, z: 0.1 }, damage: 22, splashRadius: 3.5 });
    fire(rig, { kind: 'rocket', position: { x: 0, y: 3, z: 0 }, velocity: { x: 45, y: 0, z: 0 }, damage: 110, splashRadius: 5, splashDamage: 90, weapon: 'hornet' });
    rig.run(0.6);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.combat.getTarget(missile)).toBeUndefined();
    expect(rig.combat.getTarget(second)).toBeUndefined();
    // The rocket's own blast, and one harmless pop per missile.
    expect(rig.fxIds('explosionLarge').length).toBe(1);
    expect(rig.fxIds('explosionSmall').length).toBe(2);
    expect(rig.hits.filter((h) => h.killed).length).toBe(2);
    expect(rig.game.errors).toEqual([]);
  });

  it('non-shootable kinds are not targets', () => {
    const rig = createTestRig();
    for (const kind of ['rocket', 'grenade', 'plasmaBolt', 'lightBolt', 'mortar', 'bossBolt'] as const) {
      const id = fire(rig, { kind, faction: 'enemy', position: { x: 0, y: 20, z: 0 } });
      expect(rig.combat.getTarget(id)).toBeUndefined();
    }
  });
});

describe('landing telegraph and flight sounds', () => {
  it('marks the predicted impact of a lobbed shell for exactly its flight time', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'mortar', faction: 'enemy', velocity: { x: 10, y: 12, z: 0 }, gravity: 24, damage: 35, splashRadius: 4.5, landingTelegraph: 4.5 });
    // y(t) = 1 + 12 t - 12 t^2 = 0.
    const flight = (12 + Math.sqrt(144 + 48)) / 24;
    expect(rig.fx.telegraphs.length).toBe(1);
    const marker = rig.fx.telegraphs[0];
    expect(marker?.kind).toBe('mortar');
    expect(marker?.radius).toBe(4.5);
    expect(marker?.owner).toBe(id);
    expect(marker?.x).toBeCloseTo(10 * flight, 1);
    expect(marker?.y).toBeCloseTo(0, 6);
    expect(marker?.seconds).toBeCloseTo(flight, 2);
    // It lands where and when the marker said.
    let landedAt = 0;
    for (let i = 1; i <= 200 && rig.combat.projectileCount > 0; i++) {
      rig.step();
      landedAt = i / 60;
    }
    expect(landedAt).toBeCloseTo(flight, 1);
    const blast = rig.fx.spawns.find((s) => s.id === 'explosionLarge');
    expect(blast?.x).toBeCloseTo(marker?.x ?? NaN, 1);
    // Gone with the shell.
    expect(marker?.active).toBe(false);
  });

  it('puts the marker on the floor below when the shell will strike a wall, and none when it leaves the world', () => {
    const rig = createTestRig([box(8, 0, -5, 9, 12, 5)]);
    fire(rig, { kind: 'mortar', faction: 'enemy', velocity: { x: 10, y: 12, z: 0 }, gravity: 24, splashRadius: 4.5, landingTelegraph: 4.5 });
    const marker = rig.fx.telegraphs[0];
    expect(marker?.y).toBeCloseTo(0, 6);
    expect(marker?.x).toBeLessThan(8);
    expect(marker?.x).toBeGreaterThan(7);

    const empty = createTestRig([], false);
    fire(empty, { kind: 'mortar', faction: 'enemy', velocity: { x: 10, y: 12, z: 0 }, gravity: 24, splashRadius: 4.5, landingTelegraph: 4.5 });
    expect(empty.fx.telegraphs).toEqual([]);
    // No marker unless asked for.
    const plain = createTestRig();
    fire(plain, { kind: 'mortar', faction: 'enemy', velocity: { x: 10, y: 12, z: 0 }, gravity: 24, splashRadius: 4.5 });
    expect(plain.fx.telegraphs).toEqual([]);
  });

  it('drives the marker itself for a shell on the player clock', () => {
    const rig = createTestRig();
    rig.time.scale = 0.4;
    fire(rig, { kind: 'mortar', faction: 'enemy', clock: 'player', velocity: { x: 10, y: 12, z: 0 }, gravity: 24, splashRadius: 4.5, landingTelegraph: 4.5 });
    const marker = rig.fx.telegraphs[0];
    expect(marker?.seconds).toBe(0);
    rig.run(0.5);
    expect(marker?.progress).toBeGreaterThan(0.4);
    expect(marker?.progress).toBeLessThan(0.55);
  });

  it('whistles once when a mortar starts to fall, bound to the shell', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'mortar', faction: 'enemy', velocity: { x: 10, y: 12, z: 0 }, gravity: 24, splashRadius: 4.5 });
    rig.run(0.45);
    expect(rig.soundIds('mortarWhistle')).toEqual([]);
    rig.run(0.2);
    const whistles = rig.audio.sounds.filter((s) => s.id === 'mortarWhistle');
    expect(whistles.length).toBe(1);
    expect(whistles[0]?.owner).toBe(id);
    expect(whistles[0]?.positional).toBe(true);
    rig.run(1);
    expect(rig.soundIds('mortarWhistle').length).toBe(1);
    // Whatever was bound to the shell is cut when it is gone.
    expect(rig.audio.stopped).toContain(id);
  });

  it('attaches the trail and the fly loop of its kind, and ends both with the projectile', () => {
    const rig = createTestRig([box(20, 0, -5, 21, 6, 5)]);
    const id = fire(rig, { kind: 'rocket', splashRadius: 5 });
    expect(rig.fx.trails.map((t) => [t.kind, t.owner])).toEqual([['rocket', id]]);
    expect(rig.audio.loops.map((l) => [l.id, l.owner])).toEqual([['rocketLoop', id]]);
    rig.run(0.3);
    // The loop follows the shell.
    expect(rig.audio.loops[0]?.x).toBeCloseTo(9, 4);
    expect(rig.audio.loops[0]?.active).toBe(true);
    rig.run(0.6);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.fx.trails[0]?.active).toBe(false);
    expect(rig.audio.loops[0]?.active).toBe(false);
    expect(rig.fx.cancelled.filter((owner) => owner === id).length).toBe(1);
    expect(rig.audio.stopped.filter((owner) => owner === id).length).toBe(1);
    // Combat plays no launch sound.
    expect(rig.soundIds().filter((s) => !s.startsWith('explosion'))).toEqual([]);
  });

  it('acquires a fly loop later when audio was locked at launch', () => {
    const rig = createTestRig();
    rig.audio.unlocked = false;
    fire(rig, { kind: 'rocket', velocity: { x: 1, y: 0, z: 0 } });
    rig.run(0.3);
    expect(rig.audio.loops).toEqual([]);
    rig.audio.unlocked = true;
    rig.run(1);
    expect(rig.audio.loops.length).toBe(1);
  });

  it('carries one travelling light with the newest rocket of the player', () => {
    const rig = createTestRig();
    const first = fire(rig, { kind: 'rocket', velocity: { x: 1, y: 0, z: 0 } });
    const second = fire(rig, { kind: 'rocket', velocity: { x: 1, y: 0, z: 0 }, position: { x: 0, y: 3, z: 0 } });
    fire(rig, { kind: 'rocket', faction: 'enemy', velocity: { x: 1, y: 0, z: 0 }, position: { x: 0, y: 5, z: 0 } });
    rig.step();
    expect(rig.fx.lights.map((l) => l.key)).toEqual([second]);
    expect(rig.fx.lights[0]?.color).toBe(PALETTE.player);
    void first;
  });

  it('draws from the visual origin and blends onto the simulated path', () => {
    const rig = createTestRig();
    const id = fire(rig, { kind: 'rocket', velocity: { x: 45, y: 0, z: 0 }, visualOrigin: { x: 0, y: 0.8, z: 0.3 } });
    const pos = where(rig, id);
    // The trail starts at the muzzle...
    expect(pos.toArray()).toEqual([0, 0.8, 0.3]);
    rig.step();
    expect(pos.x).toBeCloseTo(0.75, 6);
    expect(pos.z).toBeGreaterThan(0.25);
    expect(pos.z).toBeLessThan(0.3);
    const lateral: number[] = [];
    for (let i = 0; i < 12; i++) {
      rig.step();
      lateral.push(pos.z);
    }
    // ...converges monotonically, and after 0.15 s it IS the simulated path.
    for (let i = 1; i < lateral.length; i++) expect(lateral[i]).toBeLessThanOrEqual(lateral[i - 1] ?? 0);
    expect(pos.z).toBe(0);
    expect(pos.y).toBe(1);
    // The simulation itself never moved off its line: a target on it is struck dead centre.
    const rig2 = createTestRig();
    const target = rig2.target({ x: 3, radius: 0.2, hp: 1e6 });
    fire(rig2, { kind: 'rocket', velocity: { x: 45, y: 0, z: 0 }, visualOrigin: { x: 0, y: 0.2, z: 1.5 } });
    rig2.run(0.2);
    expect(target.taken).toEqual([10]);
  });
});

describe('whiz-by', () => {
  it('plays once when an enemy shell passes within 2 m of the eye without hitting', () => {
    const rig = createTestRig();
    // Past the eye (0, 1.65, 40), 1 m to the side.
    fire(rig, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 1, y: 1.65, z: 20 }, velocity: { x: 0, y: 0, z: 32 } });
    rig.run(0.5);
    expect(rig.soundIds('bulletWhiz')).toEqual([]);
    rig.run(0.3);
    const whiz = rig.audio.sounds.filter((s) => s.id === 'bulletWhiz');
    expect(whiz.length).toBe(1);
    expect(whiz[0]?.positional).toBe(true);
    expect(whiz[0]?.owner).toBe(0);
    // At the closest point of the pass.
    expect(whiz[0]?.z).toBeCloseTo(40, 4);
    expect(whiz[0]?.x).toBe(1);
    rig.run(0.5);
    expect(rig.soundIds('bulletWhiz').length).toBe(1);
  });

  it('stays silent for a wide miss, a hit, the player\'s own shots and a dead player', () => {
    const wide = createTestRig();
    fire(wide, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 2.5, y: 1.65, z: 20 }, velocity: { x: 0, y: 0, z: 32 } });
    wide.run(1);
    expect(wide.soundIds('bulletWhiz')).toEqual([]);

    const hit = createTestRig();
    fire(hit, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 0, y: 1, z: 20 }, velocity: { x: 0, y: 0, z: 32 } });
    hit.run(1);
    expect(hit.player.target.taken.length).toBe(1);
    expect(hit.soundIds('bulletWhiz')).toEqual([]);

    const own = createTestRig();
    fire(own, { kind: 'rocket', position: { x: 1, y: 1.65, z: 20 }, velocity: { x: 0, y: 0, z: 45 } });
    own.run(1);
    expect(own.soundIds('bulletWhiz')).toEqual([]);

    const dead = createTestRig();
    dead.player.alive = false;
    dead.player.target.alive = false;
    fire(dead, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 1, y: 1.65, z: 20 }, velocity: { x: 0, y: 0, z: 32 } });
    dead.run(1);
    expect(dead.soundIds('bulletWhiz')).toEqual([]);
  });
});

describe('pool, removal and reset', () => {
  it('lets the oldest make room, silently, at the cap', () => {
    const rig = createTestRig();
    const ids: number[] = [];
    for (let i = 0; i < MAX_PROJECTILES; i++) ids.push(fire(rig, { kind: 'plasmaBolt', position: { x: 0, y: 1 + i * 0.3, z: 0 }, velocity: { x: 1, y: 0, z: 0 } }));
    expect(rig.combat.projectileCount).toBe(MAX_PROJECTILES);
    expect(new Set(ids).size).toBe(MAX_PROJECTILES);
    const extra = fire(rig, { kind: 'plasmaBolt', position: { x: 0, y: 50, z: 0 }, velocity: { x: 1, y: 0, z: 0 } });
    expect(rig.combat.projectileCount).toBe(MAX_PROJECTILES);
    expect(extra).toBeGreaterThan(0);
    // The oldest is gone, without a sound or an effect; the second oldest is still there.
    expect(rig.combat.removeProjectile(ids[0] ?? 0)).toBe(false);
    expect(rig.fx.cancelled).toEqual([ids[0]]);
    expect(rig.audio.stopped).toEqual([ids[0]]);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.combat.removeProjectile(ids[1] ?? 0)).toBe(true);
    expect(rig.combat.projectileCount).toBe(MAX_PROJECTILES - 1);
  });

  it('keeps the cap through thousands of launches and impacts', () => {
    const rig = createTestRig([box(15, 0, -30, 16, 30, 30)]);
    for (let frame = 0; frame < 600; frame++) {
      for (let n = 0; n < 4; n++) fire(rig, { kind: frame % 2 ? 'plasmaBolt' : 'bossMissile', faction: 'enemy', position: { x: 0, y: 1 + ((frame + n) % 20), z: n * 2 - 20 }, velocity: { x: 12 + n, y: 0, z: 0 }, splashRadius: n === 0 ? 3 : 0 });
      rig.step();
      expect(rig.combat.projectileCount).toBeLessThanOrEqual(MAX_PROJECTILES);
    }
    expect(rig.game.errors).toEqual([]);
    rig.combat.clearProjectiles();
    expect(rig.combat.projectileCount).toBe(0);
    // No missile target leaked.
    const found: never[] = [];
    expect(rig.combat.queryRadius({ x: 0, y: 0, z: 0 }, 1000, 'enemy', found)).toBe(0);
  });

  it('removes one projectile, with or without its blast', () => {
    const rig = createTestRig();
    const quiet = fire(rig, { kind: 'rocket', splashRadius: 5, position: { x: 0, y: 10, z: 0 } });
    const loud = fire(rig, { kind: 'rocket', splashRadius: 5, position: { x: 0, y: 20, z: 0 } });
    const dud = fire(rig, { kind: 'plasmaBolt', position: { x: 0, y: 30, z: 0 } });
    expect(rig.combat.removeProjectile(quiet)).toBe(true);
    expect(rig.combat.removeProjectile(loud, true)).toBe(true);
    expect(rig.combat.removeProjectile(dud, true)).toBe(true);
    expect(rig.combat.removeProjectile(quiet)).toBe(false);
    expect(rig.combat.removeProjectile(424242, true)).toBe(false);
    expect(rig.combat.projectileCount).toBe(0);
    // Its blast is queued like any other: nothing yet.
    expect(rig.fx.spawns).toEqual([]);
    rig.step();
    const blasts = rig.fx.spawns.filter((s) => s.id === 'explosionLarge');
    expect(blasts.length).toBe(1);
    expect(blasts[0]?.y).toBe(20);
  });

  it('clears one faction or all, without detonating, and leaves queued blasts alone', () => {
    const rig = createTestRig();
    fire(rig, { kind: 'rocket', splashRadius: 5, position: { x: 0, y: 10, z: 0 } });
    const missile = fire(rig, { kind: 'bossMissile', faction: 'enemy', splashRadius: 3, position: { x: 0, y: 20, z: 0 } });
    fire(rig, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 0, y: 30, z: 0 } });
    rig.combat.explode({ position: { x: 0, y: 1, z: 0 }, radius: 3, damage: 1, faction: 'neutral' });
    rig.combat.clearProjectiles('enemy');
    expect(rig.combat.projectileCount).toBe(1);
    expect(rig.combat.getTarget(missile)).toBeUndefined();
    rig.combat.clearProjectiles();
    expect(rig.combat.projectileCount).toBe(0);
    rig.step();
    // Only the blast that was already queued.
    expect(rig.fxIds('explosion')).toEqual(['explosionSmall']);
  });

  it('survives the field being cleared from inside a direct hit (a boss going down)', () => {
    const rig = createTestRig();
    const boss = rig.target({ x: 10, y: 3, radius: 1.5, hp: 50 });
    boss.onDamage = (_info, result): void => {
      if (result.killed) rig.combat.clearProjectiles('enemy');
    };
    for (let i = 0; i < 20; i++) fire(rig, { kind: 'bossBolt', faction: 'enemy', position: { x: 10, y: 3, z: i + 3 }, velocity: { x: 0, y: 0, z: 1 }, ownerId: boss.id });
    const neighbour = rig.target({ x: 10, y: 3, z: -3, hp: 1e6 });
    const rocket = fire(rig, { kind: 'rocket', position: { x: 0, y: 3, z: 0 }, velocity: { x: 45, y: 0, z: 0 }, damage: 110, splashRadius: 5, splashDamage: 90 });
    for (let i = 0; i < 20; i++) fire(rig, { kind: 'bossBolt', faction: 'enemy', position: { x: 10, y: 3, z: -i - 30 }, velocity: { x: 0, y: 0, z: -1 }, ownerId: boss.id });
    rig.run(0.5);
    expect(boss.alive).toBe(false);
    expect(rig.combat.projectileCount).toBe(0);
    // The rocket still went off: its splash reached the neighbour.
    expect(neighbour.taken.length).toBe(1);
    expect(rig.fxIds('explosionLarge').length).toBe(1);
    expect(rig.game.errors).toEqual([]);
    expect(rig.fx.cancelled).toContain(rocket);
    // The pool is whole again.
    for (let i = 0; i < MAX_PROJECTILES; i++) fire(rig, { kind: 'lightBolt', position: { x: 0, y: 20 + i, z: 0 } });
    expect(rig.combat.projectileCount).toBe(MAX_PROJECTILES);
  });

  it('does not advance a shell launched from inside the pass until the next substep', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 3, hp: 5 });
    let spawned = 0;
    target.onDamage = (): void => {
      spawned = fire(rig, { kind: 'plasmaBolt', faction: 'enemy', position: { x: 3, y: 9, z: 0 }, velocity: { x: 0, y: 0, z: 30 } });
    };
    fire(rig, { kind: 'lightBolt' });
    rig.run(0.2);
    expect(spawned).toBeGreaterThan(0);
    const z = where(rig, spawned).z;
    // The bolt meets the target's surface (2.38 m out) in its 5th substep of 0.5 m; the shell born in
    // that substep flew the 7 that followed, not the one it was born in.
    expect(z).toBeCloseTo((12 - 5) * 0.5, 4);
  });

  it('reports a projectile whose step throws, removes it, and carries on', () => {
    const rig = createTestRig();
    const broken = rig.target({ x: 3, hp: 1e6 });
    broken.takeDamage = (): never => {
      throw new Error('victim exploded badly');
    };
    const healthy = rig.target({ x: 3, y: 5, hp: 1e6 });
    const bad = fire(rig, { kind: 'rocket', splashRadius: 5 });
    fire(rig, { kind: 'plasmaBolt', position: { x: 0, y: 5, z: 0 } });
    expect(() => rig.run(0.5)).not.toThrow();
    expect(rig.game.errors).toEqual([{ source: 'projectile:rocket', message: 'victim exploded badly' }]);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.fx.cancelled).toContain(bad);
    // The one behind it in the list still flew and hit.
    expect(healthy.taken).toEqual([10]);
  });

  it('refuses a launch with broken numbers, reporting it a few times at most', () => {
    const rig = createTestRig();
    for (let i = 0; i < 5; i++) expect(fire(rig, { kind: 'rocket', velocity: { x: NaN, y: 0, z: 0 } })).toBe(0);
    expect(fire(rig, { kind: 'rocket', position: { x: 0, y: Infinity, z: 0 } })).toBe(0);
    expect(fire(rig, { kind: 'rocket', damage: NaN })).toBe(0);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.game.errors.length).toBe(3);
    expect(rig.game.errors[0]?.source).toBe('combat:spawnProjectile');
    rig.step();
  });

  it('reset removes every projectile silently and keeps other owners\' registrations', () => {
    const rig = createTestRig();
    const enemy = rig.target({ x: 30, hp: 1e6 });
    const rocket = fire(rig, { kind: 'rocket', splashRadius: 5 });
    const missile = fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 0, y: 9, z: 0 }, splashRadius: 3 });
    fire(rig, { kind: 'mortar', faction: 'enemy', velocity: { x: 3, y: 12, z: 0 }, gravity: 24, splashRadius: 4, landingTelegraph: 4 });
    rig.run(0.2);
    const sounds = rig.audio.sounds.length;
    rig.combat.reset();
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.audio.sounds.length).toBe(sounds);
    expect(rig.fx.trails.every((t) => !t.active)).toBe(true);
    expect(rig.fx.telegraphs.every((t) => !t.active)).toBe(true);
    expect(rig.audio.loops.every((l) => !l.active)).toBe(true);
    expect(rig.fx.cancelled).toContain(rocket);
    // The missile was combat's own target: gone. The enemy and the player are their owners' business.
    expect(rig.combat.getTarget(missile)).toBeUndefined();
    expect(rig.combat.getTarget(enemy.id)).toBe(enemy);
    expect(rig.combat.getTarget(rig.player.target.id)).toBe(rig.player.target);
    // Idempotent, and nothing comes back.
    rig.combat.reset();
    rig.run(2);
    expect(rig.fx.spawns).toEqual([]);
    expect(enemy.taken).toEqual([]);
  });

  it('behaves exactly the same in a second run', () => {
    const play = (rig: TestRig): string => {
      const enemy = rig.target({ x: 20, z: 1, hp: 500 });
      fire(rig, { kind: 'rocket', velocity: { x: 45, y: 0, z: 0 }, damage: 110, splashRadius: 5, splashDamage: 90 });
      fire(rig, { kind: 'grenade', velocity: { x: 12, y: 5, z: 2 }, gravity: 18, bounce: 0.42, fuse: 1.6, splashRadius: 6.5, splashDamage: 140, damage: 0 });
      fire(rig, { kind: 'bossMissile', faction: 'enemy', position: { x: 5, y: 6, z: 10 }, velocity: { x: 20, y: 0, z: 0 }, homing: 1.6, damage: 22, splashRadius: 3.5 });
      rig.run(3);
      const log = JSON.stringify([enemy.taken, rig.player.target.taken.slice(), rig.fx.spawns.map((s) => [s.id, s.x, s.y, s.z])]);
      rig.combat.unregister(enemy.id);
      return log;
    };
    const rig = createTestRig();
    const first = play(rig);
    rig.combat.reset();
    rig.player.target.taken.length = 0;
    rig.fx.spawns.length = 0;
    const second = play(rig);
    expect(second).toBe(first);
    expect(first).toContain('explosionLarge');
  });
});
