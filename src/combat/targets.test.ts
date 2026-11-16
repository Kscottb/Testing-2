/**
 * Hit targets and traces: ray / sphere maths, nearest hit, nearest sphere per target, thick rays,
 * piercing order and uniqueness, radius queries, faction filtering. (Allocation: alloc.test.ts.)
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { COL } from '../core/constants';
import { makeHitSphere, makePierceResult, makeShotHit } from '../core/make';
import type { HitTarget, TraceOptions } from '../core/types';
import { raySphere } from './targets';
import { box, createTestRig } from './testkit';

const PLAYER_SHOT: TraceOptions = { faction: 'player' };
const origin = new THREE.Vector3(0, 1, 10);
const forward = new THREE.Vector3(0, 0, -1);

describe('raySphere', () => {
  it('returns the entry distance of a head-on ray', () => {
    expect(raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 2, 100)).toBeCloseTo(8, 10);
  });

  it('returns the entry distance of an off-centre ray', () => {
    // Offset 1 from the axis of a sphere of radius 2: half chord = sqrt(3).
    expect(raySphere(1, 0, 0, 0, 0, -1, 0, 0, -10, 2, 100)).toBeCloseTo(10 - Math.sqrt(3), 10);
  });

  it('misses beside, behind and beyond the limit', () => {
    expect(raySphere(2.01, 0, 0, 0, 0, -1, 0, 0, -10, 2, 100)).toBe(-1);
    expect(raySphere(0, 0, 0, 0, 0, 1, 0, 0, -10, 2, 100)).toBe(-1);
    expect(raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 2, 7.99)).toBe(-1);
    expect(raySphere(0, 0, 0, 0, 0, -1, 0, 0, -10, 2, 8.01)).toBeCloseTo(8, 10);
  });

  it('enters at 0 when the ray starts inside, whatever its direction', () => {
    expect(raySphere(0, 0, -9, 0, 0, -1, 0, 0, -10, 2, 100)).toBe(0);
    expect(raySphere(0, 0, -9, 0, 0, 1, 0, 0, -10, 2, 100)).toBe(0);
    expect(raySphere(0, 0, -9, 1, 0, 0, 0, 0, -10, 2, 0)).toBe(0);
  });

  it('grazes a tangent ray without NaN', () => {
    const t = raySphere(2, 0, 0, 0, 0, -1, 0, 0, -10, 2, 100);
    expect(Number.isNaN(t)).toBe(false);
    expect(t === -1 || Math.abs(t - 10) < 1e-3).toBe(true);
  });
});

describe('traceShot', () => {
  it('reports a miss with the end point of the ray', () => {
    const rig = createTestRig();
    const out = makeShotHit();
    expect(rig.combat.traceShot(origin, forward, 25, PLAYER_SHOT, out)).toBe(false);
    expect(out.kind).toBe('none');
    expect(out.distance).toBe(25);
    expect(out.point.toArray()).toEqual([0, 1, -15]);
    expect(out.target).toBeNull();
    expect(out.sphereIndex).toBe(-1);
    expect(out.boxId).toBe(-1);
  });

  it('returns the nearest of several targets, whatever the registration order', () => {
    const rig = createTestRig();
    const far = rig.target({ z: -10 });
    const near = rig.target({ z: 0 });
    const mid = rig.target({ z: -5 });
    const out = makeShotHit();
    expect(rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out)).toBe(true);
    expect(out.kind).toBe('target');
    expect(out.target).toBe(near);
    expect(out.distance).toBeCloseTo(9.5, 10);
    expect(out.point.z).toBeCloseTo(0.5, 10);
    // Normal: from the sphere centre to the hit point.
    expect(out.normal.z).toBeCloseTo(1, 10);
    expect(out.sphereIndex).toBe(0);
    void far;
    void mid;
  });

  it('lets the world stop the ray before a target behind it, and a target before the world behind it', () => {
    const rig = createTestRig([box(-3, 0, -2.2, 3, 4, -2, { surface: 'plating' })]);
    const behind = rig.target({ z: -6 });
    const out = makeShotHit();
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.kind).toBe('world');
    expect(out.distance).toBeCloseTo(12, 10);
    expect(out.surface).toBe('plating');
    expect(out.boxId).toBeGreaterThanOrEqual(0);
    expect(out.normal.toArray()).toEqual([0, 0, 1]);
    expect(out.target).toBeNull();

    const front = rig.target({ z: 3 });
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.kind).toBe('target');
    expect(out.target).toBe(front);
    expect(out.boxId).toBe(-1);

    // worldMask 0 ignores the world altogether.
    rig.combat.unregister(front.id);
    rig.combat.traceShot(origin, forward, 100, { faction: 'player', worldMask: 0 }, out);
    expect(out.target).toBe(behind);
    // A mask the wall does not answer to lets the ray through as well.
    rig.combat.traceShot(origin, forward, 100, { faction: 'player', worldMask: COL.PROJECTILE }, out);
    expect(out.kind).toBe('world');
  });

  it('filters by faction, ignoreId and alive', () => {
    const rig = createTestRig();
    const friend = rig.target({ faction: 'player', z: 5 });
    const enemy = rig.target({ faction: 'enemy', z: 0 });
    const out = makeShotHit();
    // The player's shot passes his own faction.
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.target).toBe(enemy);
    // An enemy shot passes enemies and finds the player-faction target.
    rig.combat.traceShot(origin, forward, 100, { faction: 'enemy' }, out);
    expect(out.target).toBe(friend);
    // Neutral hits everyone: the nearest.
    rig.combat.traceShot(origin, forward, 100, { faction: 'neutral' }, out);
    expect(out.target).toBe(friend);
    // ignoreId skips exactly that target.
    rig.combat.traceShot(origin, forward, 100, { faction: 'neutral', ignoreId: friend.id }, out);
    expect(out.target).toBe(enemy);
    // Dead targets are skipped.
    enemy.alive = false;
    expect(rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out)).toBe(false);
  });

  it('picks the nearest enabled sphere of a target along the ray', () => {
    const rig = createTestRig();
    const target = rig.target({ z: 0, radius: 1 });
    // A weak point poking out of the front (toward +Z) of the body.
    const weak = makeHitSphere(0.3, 'weak');
    weak.center.set(0, 1, 0.9);
    target.spheres.push(weak);
    target.boundRadius = 1.3;
    const out = makeShotHit();

    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.part).toBe('weak');
    expect(out.sphereIndex).toBe(1);
    expect(out.distance).toBeCloseTo(10 - 1.2, 10);

    // From behind the body comes first.
    rig.combat.traceShot(new THREE.Vector3(0, 1, -10), new THREE.Vector3(0, 0, 1), 100, PLAYER_SHOT, out);
    expect(out.part).toBe('body');
    expect(out.sphereIndex).toBe(0);

    // A disabled sphere does not exist.
    weak.enabled = false;
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.part).toBe('body');
    expect(out.distance).toBeCloseTo(9, 10);
  });

  it('keeps a sphere hittable that pokes out of a bound radius that was set too small', () => {
    const rig = createTestRig();
    const target = rig.target({ z: 0, radius: 0.5 });
    const horn = makeHitSphere(0.25, 'weak');
    horn.center.set(0, 3, 0);
    target.spheres.push(horn);
    // boundRadius stays 0.5: the horn is 2 m outside of it.
    const out = makeShotHit();
    const high = new THREE.Vector3(0, 3, 10);
    // Posed after registration: the broad phase learns it at the next update.
    rig.step();
    expect(rig.combat.traceShot(high, forward, 100, PLAYER_SHOT, out)).toBe(true);
    expect(out.part).toBe('weak');
    // Registered with the horn already in place: known at once.
    rig.combat.register(target);
    expect(rig.combat.traceShot(high, forward, 100, PLAYER_SHOT, out)).toBe(true);
  });

  it('thickens the ray for targets only', () => {
    const rig = createTestRig([box(-3, 0, -2.2, 3, 4, -2)]);
    const target = rig.target({ x: 1.2, z: 0, radius: 0.5 });
    const out = makeShotHit();
    // The thin ray passes 0.7 m beside the sphere and reaches the wall.
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.kind).toBe('world');
    // 0.8 m of thickness catches it; the hit point lies on the real sphere.
    rig.combat.traceShot(origin, forward, 100, { faction: 'player', radius: 0.8 }, out);
    expect(out.kind).toBe('target');
    expect(out.target).toBe(target);
    expect(out.point.distanceTo(target.center)).toBeCloseTo(0.5, 6);
    expect(out.normal.length()).toBeCloseTo(1, 6);
    // The wall is where it was: thickness does not apply to the world.
    rig.combat.unregister(target.id);
    rig.combat.traceShot(origin, forward, 100, { faction: 'player', radius: 0.8 }, out);
    expect(out.distance).toBeCloseTo(12, 10);
  });

  it('a ray that starts inside a sphere hits it at distance 0', () => {
    const rig = createTestRig();
    const target = rig.target({ z: 0, radius: 1 });
    const out = makeShotHit();
    rig.combat.traceShot(new THREE.Vector3(0, 1, 0.5), forward, 100, PLAYER_SHOT, out);
    expect(out.target).toBe(target);
    expect(out.distance).toBe(0);
    expect(out.point.toArray()).toEqual([0, 1, 0.5]);
    // Dead centre: the normal falls back to the reversed ray instead of NaN.
    rig.combat.traceShot(target.center, forward, 100, PLAYER_SHOT, out);
    expect(out.normal.z).toBe(1);
    expect(Math.abs(out.normal.x) + Math.abs(out.normal.y)).toBe(0);
  });

  it('answers a broken ray with nothing and without NaN', () => {
    const rig = createTestRig();
    rig.target({ z: 0 });
    const out = makeShotHit();
    expect(rig.combat.traceShot(origin, new THREE.Vector3(NaN, 0, 0), 100, PLAYER_SHOT, out)).toBe(false);
    expect(out.kind).toBe('none');
    expect(Number.isFinite(out.point.x + out.point.y + out.point.z)).toBe(true);
    expect(rig.combat.traceShot(origin, forward, 0, PLAYER_SHOT, out)).toBe(false);
    expect(rig.combat.traceShot(origin, forward, Infinity, PLAYER_SHOT, out)).toBe(false);
    const pierce = makePierceResult();
    expect(rig.combat.tracePierce(origin, new THREE.Vector3(NaN, 0, 0), 100, PLAYER_SHOT, pierce)).toBe(0);
    expect(Number.isFinite(pierce.end.x + pierce.end.y + pierce.end.z)).toBe(true);
  });

  it('applies no damage and plays nothing', () => {
    const rig = createTestRig();
    const target = rig.target({ z: 0 });
    const out = makeShotHit();
    const pierce = makePierceResult();
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    rig.combat.tracePierce(origin, forward, 100, PLAYER_SHOT, pierce);
    rig.step();
    expect(target.taken).toEqual([]);
    expect(rig.fx.spawns).toEqual([]);
    expect(rig.audio.sounds).toEqual([]);
    expect(rig.hits).toEqual([]);
  });
});

describe('tracePierce', () => {
  it('returns every target once, near to far, up to the world', () => {
    const rig = createTestRig([box(-3, 0, -20.2, 3, 4, -20, { surface: 'grate' })]);
    const c = rig.target({ z: -12 });
    const a = rig.target({ z: 4 });
    const hidden = rig.target({ z: -25 });
    const b = rig.target({ z: -3, radius: 1 });
    // Three overlapping spheres on one target: still one entry, with the nearest sphere.
    const front = makeHitSphere(0.4, 'weak');
    front.center.set(0, 1, -2.2);
    const back = makeHitSphere(0.6, 'armor');
    back.center.set(0, 1, -3.6);
    b.spheres.push(front, back);
    b.boundRadius = 1.3;
    rig.target({ faction: 'player', z: 0 });
    rig.target({ x: 5, z: 0 });

    const out = makePierceResult();
    const n = rig.combat.tracePierce(origin, forward, 100, PLAYER_SHOT, out);
    expect(n).toBe(3);
    expect(out.count).toBe(3);
    expect(out.hits.slice(0, 3).map((h) => h.target)).toEqual([a, b, c]);
    expect(out.hits[1]?.part).toBe('weak');
    expect(out.hits[1]?.sphereIndex).toBe(1);
    for (let i = 1; i < n; i++) expect(out.hits[i]?.distance).toBeGreaterThan(out.hits[i - 1]?.distance ?? Infinity);
    expect(out.hitWorld).toBe(true);
    expect(out.surface).toBe('grate');
    expect(out.end.z).toBeCloseTo(-20, 10);
    expect(out.endNormal.toArray()).toEqual([0, 0, 1]);
    expect(out.boxId).toBeGreaterThanOrEqual(0);
    void hidden;
  });

  it('ends at maxDist when nothing stops it', () => {
    const rig = createTestRig();
    rig.target({ z: 0 });
    rig.target({ z: -40 });
    const out = makePierceResult();
    expect(rig.combat.tracePierce(origin, forward, 30, PLAYER_SHOT, out)).toBe(1);
    expect(out.hitWorld).toBe(false);
    expect(out.boxId).toBe(-1);
    expect(out.end.toArray()).toEqual([0, 1, -20]);
  });

  it('keeps the nearest targets when more are on the line than the result holds', () => {
    const rig = createTestRig();
    const targets: HitTarget[] = [];
    // Registered far to near, so the overflow has to displace earlier entries.
    for (let i = 9; i >= 0; i--) targets[i] = rig.target({ z: -i * 3, radius: 0.4 });
    const out = makePierceResult(4);
    expect(rig.combat.tracePierce(origin, forward, 100, PLAYER_SHOT, out)).toBe(4);
    expect(out.hits.map((h) => h.target)).toEqual(targets.slice(0, 4));
    expect(new Set(out.hits).size).toBe(4);
  });
});

describe('queryRadius', () => {
  it('collects live targets whose bounding sphere touches the query sphere', () => {
    const rig = createTestRig();
    const inside = rig.target({ x: 2, z: 0 });
    const touching = rig.target({ x: 5.4, z: 0, radius: 0.5 });
    const outside = rig.target({ x: 5.6, z: 0, radius: 0.5 });
    const friend = rig.target({ faction: 'player', x: -1, z: 0 });
    const dead = rig.target({ x: 1, z: 0 });
    dead.alive = false;
    const out: HitTarget[] = [inside, inside, inside, inside, inside, inside];
    const center = new THREE.Vector3(0, 1, 0);
    expect(rig.combat.queryRadius(center, 5, 'enemy', out)).toBe(2);
    expect(out).toEqual([inside, touching]);
    expect(rig.combat.queryRadius(center, 5, 'player', out)).toBe(1);
    expect(out).toEqual([friend]);
    expect(rig.combat.queryRadius(center, 5, 'any', out)).toBe(3);
    expect(rig.combat.queryRadius(center, 0.1, 'enemy', out)).toBe(0);
    expect(out.length).toBe(0);
    void outside;
  });
});

describe('registry', () => {
  it('replaces an entry registered twice and forgets an unregistered one', () => {
    const rig = createTestRig();
    const first = rig.target({ z: 0 });
    const second = rig.target({ z: -5, detached: true });
    (second as { id: number }).id = first.id;
    rig.combat.register(second);
    expect(rig.combat.getTarget(first.id)).toBe(second);
    const out = makeShotHit();
    rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out);
    expect(out.target).toBe(second);
    rig.combat.unregister(first.id);
    expect(rig.combat.getTarget(first.id)).toBeUndefined();
    expect(rig.combat.traceShot(origin, forward, 100, PLAYER_SHOT, out)).toBe(false);
    // Unknown ids are a no-op.
    rig.combat.unregister(123456);
  });
});
