/**
 * Allocation: the per-frame paths of combat — traces, the projectile update and the instance buffers —
 * cost no heap at all, not even a boxed number. Kept in a file of its own: the measurement depends on
 * the type feedback of the process, which the other suites would muddy.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { makePierceResult, makeShotHit } from '../core/make';
import type { HitTarget, TraceOptions } from '../core/types';
import { ALLOC_LIMIT_BYTES, WARM_UP_CALLS, boxOneNumberPerCall, bytesPerCall } from '../physics/heapmeter';
import { box, createTestRig } from './testkit';

// A machine shared with other jobs: no test here may fail because it was starved of CPU.
vi.setConfig({ testTimeout: 120_000 });

describe('allocation', () => {
  it('the meter sees a single boxed number per call', () => {
    boxOneNumberPerCall(WARM_UP_CALLS);
    expect(bytesPerCall(boxOneNumberPerCall)).toBeGreaterThan(ALLOC_LIMIT_BYTES);
  });

  it('traces, piercing traces and radius queries do not allocate', () => {
    const rig = createTestRig([box(-30, 0, -30.2, 30, 6, -30)]);
    for (let i = 0; i < 48; i++) rig.target({ x: ((i * 7) % 13) - 6, z: -i * 0.5, radius: 0.4 + (i % 3) * 0.1 });
    const out = makeShotHit();
    const pierce = makePierceResult();
    const dir = new THREE.Vector3(0.5, 0, -0.5);
    const from = new THREE.Vector3(0.5, 1, 12);
    const opts: TraceOptions = { faction: 'player', radius: 0.1 };
    const found: HitTarget[] = [];
    let hits = 0;
    const work = (calls: number): number => {
      for (let i = 0; i < calls; i++) {
        // Plain field writes: the loop under measurement must not box numbers itself.
        from.x = ((i * 31) % 17) * 0.5 - 4;
        const lean = (((i * 13) % 11) - 5) * 0.02;
        const len = Math.sqrt(lean * lean + 1);
        dir.x = lean / len;
        dir.z = -1 / len;
        if (rig.combat.traceShot(from, dir, 80, opts, out)) hits++;
        hits += rig.combat.tracePierce(from, dir, 80, opts, pierce);
        hits += rig.combat.queryRadius(from, 14, 'enemy', found);
      }
      return hits;
    };
    work(WARM_UP_CALLS);
    expect(bytesPerCall(work)).toBeLessThan(ALLOC_LIMIT_BYTES);
    expect(hits).toBeGreaterThan(0);
  });

  it('a substep with a sky full of projectiles does not allocate', () => {
    const rig = createTestRig([box(-30, 0, -30.2, 30, 6, -30)]);
    // The recording stand-ins of the rig allocate by design: silence the one that is called per frame.
    (rig.ctx.fx as { lightFlash: unknown }).lightFlash = (): void => {};
    for (let i = 0; i < 24; i++) rig.target({ x: ((i * 7) % 13) - 6, y: 12, z: -i, radius: 0.5 });
    const launch = rig.combat.spawnProjectile.bind(rig.combat);
    const far = { lifetime: 1e9 };
    for (let i = 0; i < 30; i++) {
      launch({ kind: 'plasmaBolt', faction: 'enemy', ownerId: 0, damage: 9, position: { x: i - 15, y: 2, z: 0 }, velocity: { x: 0.3, y: 0, z: 32 }, ...far });
    }
    for (let i = 0; i < 16; i++) {
      launch({ kind: 'lightBolt', faction: 'enemy', ownerId: 0, damage: 5, position: { x: i - 8, y: 4, z: 3 }, velocity: { x: 0, y: -1, z: 42 }, ...far });
    }
    for (let i = 0; i < 10; i++) {
      launch({ kind: 'bossBolt', faction: 'enemy', ownerId: 0, damage: 12, position: { x: i * 2 - 10, y: 8, z: -5 }, velocity: { x: 0, y: 0, z: 30 }, ...far });
    }
    for (let i = 0; i < 12; i++) {
      launch({ kind: 'bossMissile', faction: 'enemy', ownerId: 0, damage: 22, splashRadius: 3.5, homing: 1.6, position: { x: i * 2 - 12, y: 9, z: -8 }, velocity: { x: 20, y: 0, z: 0 }, ...far });
    }
    for (let i = 0; i < 8; i++) {
      launch({ kind: 'rocket', faction: 'player', ownerId: rig.player.target.id, damage: 110, splashRadius: 5, position: { x: i - 4, y: 3, z: 30 }, velocity: { x: 0, y: 0.2, z: -45 }, visualOrigin: { x: i - 3.8, y: 2.8, z: 30 }, ...far });
    }
    for (let i = 0; i < 8; i++) {
      launch({ kind: 'mortar', faction: 'enemy', ownerId: 0, damage: 35, splashRadius: 4.5, gravity: 24, landingTelegraph: 4.5, position: { x: i * 3 - 12, y: 1, z: 10 }, velocity: { x: 0, y: 12, z: 6 }, ...far });
    }
    // Grenades: some in flight, some long since at rest on the floor.
    for (let i = 0; i < 6; i++) {
      launch({ kind: 'grenade', faction: 'player', ownerId: rig.player.target.id, damage: 0, splashRadius: 6.5, gravity: 18, bounce: 0.42, fuse: 1e9, position: { x: i * 2, y: 0.2 + (i % 2) * 6, z: 20 }, velocity: { x: 1, y: 0, z: 0 }, ...far });
    }
    expect(rig.combat.projectileCount).toBe(90);
    // Let the low grenades settle, with real steps.
    for (let i = 0; i < 20; i++) rig.step(1 / 60);

    // From here on time crawls, so nothing lands while the meter runs.
    rig.time.dt = rig.time.unscaledDt = rig.time.playerDt = 1e-7;
    const combat = rig.combat;
    const work = (calls: number): number => {
      for (let i = 0; i < calls; i++) combat.update(1e-7);
      return combat.projectileCount;
    };
    const before = rig.combat.projectileCount;
    expect(before).toBeGreaterThan(80);
    work(WARM_UP_CALLS);
    // Per substep, for all ninety of them together.
    expect(bytesPerCall(work)).toBeLessThan(ALLOC_LIMIT_BYTES);
    expect(rig.combat.projectileCount).toBe(before);
    expect(rig.game.errors).toEqual([]);
  });
});
