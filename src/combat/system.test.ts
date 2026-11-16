/**
 * The system as a whole: factory and lifecycle, the scene root and its meshes, the fixed order inside
 * update, and what a frame draws.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MAX_PROJECTILES, RENDER_ORDER } from '../core/constants';
import type { GameContext } from '../core/types';
import { createCombatSystem } from './index';
import { box, createTestRig } from './testkit';
import type { TestRig } from './testkit';

const meshes = (rig: TestRig): THREE.InstancedMesh[] => {
  const found: THREE.InstancedMesh[] = [];
  rig.ctx.scene.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) found.push(o as THREE.InstancedMesh);
  });
  return found;
};
const mesh = (rig: TestRig, name: string): THREE.InstancedMesh => {
  const found = meshes(rig).find((m) => m.name === name);
  if (!found) throw new Error(`no mesh ${name}`);
  return found;
};

describe('lifecycle', () => {
  it('the factory only stores the context', () => {
    // No system exists yet when the factories run: touching one would throw here.
    const bare = {
      get collision(): never {
        throw new Error('touched ctx.collision in the factory');
      },
      get fx(): never {
        throw new Error('touched ctx.fx in the factory');
      },
      get audio(): never {
        throw new Error('touched ctx.audio in the factory');
      },
      get render(): never {
        throw new Error('touched ctx.render in the factory');
      },
      get player(): never {
        throw new Error('touched ctx.player in the factory');
      },
      get scene(): never {
        throw new Error('touched ctx.scene in the factory');
      },
    } as unknown as GameContext;
    expect(() => createCombatSystem(bare)).not.toThrow();
  });

  it('init adds exactly one root named after the system and warms it', () => {
    const rig = createTestRig();
    const roots = rig.ctx.scene.children.filter((c) => c.name === 'combat');
    expect(roots.length).toBe(1);
    expect(rig.ctx.scene.children.length).toBe(1);
    expect(rig.render.warmed).toBe(1);
    // One mesh per solid kind plus the shared glow, all hidden while nothing flies.
    const all = meshes(rig);
    expect(all.map((m) => m.name).sort()).toEqual(['projectile:bossMissile', 'projectile:glow', 'projectile:grenade', 'projectile:mortar', 'projectile:rocket']);
    for (const m of all) {
      expect(m.visible).toBe(false);
      expect(m.count).toBe(0);
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
      expect(m.frustumCulled).toBe(false);
    }
  });

  it('follows the rendering conventions for its glow', () => {
    const rig = createTestRig();
    const glow = mesh(rig, 'projectile:glow');
    const material = glow.material as THREE.ShaderMaterial;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.fog).toBe(true);
    expect(material.toneMapped).toBe(true);
    expect(glow.renderOrder).toBe(RENDER_ORDER.FX_ADDITIVE);
    expect(material.fragmentShader).not.toContain('tonemapping_fragment');
    expect(material.fragmentShader).not.toContain('colorspace_fragment');
    expect(material.fragmentShader).toContain('fog_fragment');
    expect(material.vertexShader).toContain('fog_vertex');
    expect(material.uniforms.fogColor).toBeDefined();
    // The instance colour exists before the first compile, so the program never changes.
    expect(glow.instanceColor).not.toBeNull();
    // Solid ordnance: one shared lit material, no light of its own.
    const bodies = meshes(rig).filter((m) => m !== glow);
    expect(new Set(bodies.map((m) => m.material)).size).toBe(1);
    expect((bodies[0]?.material as THREE.Material).type).toBe('MeshStandardMaterial');
    let lights = 0;
    rig.ctx.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    expect(lights).toBe(0);
  });

  it('draws what flies: instances per kind, never more than the pools hold', () => {
    const rig = createTestRig();
    const launch = (kind: 'rocket' | 'grenade' | 'mortar' | 'bossMissile' | 'plasmaBolt' | 'lightBolt' | 'bossBolt', y: number): number =>
      rig.combat.spawnProjectile({ kind, faction: 'enemy', ownerId: 0, damage: 1, position: { x: 0, y, z: 0 }, velocity: { x: 3, y: 0, z: 0 } });
    launch('rocket', 5);
    launch('rocket', 6);
    launch('grenade', 7);
    launch('mortar', 8);
    launch('bossMissile', 9);
    launch('plasmaBolt', 10);
    launch('lightBolt', 11);
    const last = launch('bossBolt', 12);
    rig.step();
    expect(mesh(rig, 'projectile:rocket').count).toBe(2);
    expect(mesh(rig, 'projectile:grenade').count).toBe(1);
    expect(mesh(rig, 'projectile:mortar').count).toBe(1);
    expect(mesh(rig, 'projectile:bossMissile').count).toBe(1);
    const glow = mesh(rig, 'projectile:glow');
    expect(glow.count).toBe(16);
    expect(glow.visible).toBe(true);
    // The instance sits where the projectile is drawn, and holds no NaN.
    const rocket = mesh(rig, 'projectile:rocket');
    expect(rocket.instanceMatrix.array[12]).toBeCloseTo(3 / 60, 6);
    expect(rocket.instanceMatrix.array[13]).toBe(5);
    for (const m of meshes(rig)) {
      for (let i = 0; i < m.count * 16; i++) expect(Number.isFinite(m.instanceMatrix.array[i])).toBe(true);
    }
    const colors = (glow.instanceColor as THREE.InstancedBufferAttribute).array;
    for (let i = 0; i < glow.count * 3; i++) expect(Number.isFinite(colors[i])).toBe(true);
    // A basis that is orthonormal: the body is neither sheared nor scaled.
    const m = rocket.instanceMatrix.array;
    const x = new THREE.Vector3(m[0], m[1], m[2]);
    const y = new THREE.Vector3(m[4], m[5], m[6]);
    const z = new THREE.Vector3(m[8], m[9], m[10]);
    expect(x.length()).toBeCloseTo(1, 6);
    expect(y.length()).toBeCloseTo(1, 6);
    expect(z.length()).toBeCloseTo(1, 6);
    expect(x.dot(y)).toBeCloseTo(0, 6);
    expect(x.clone().cross(y).dot(z)).toBeCloseTo(1, 6);
    // Its nose (+Y of the mesh) points where it flies.
    expect(y.x).toBeCloseTo(1, 6);

    // Removing one updates the picture at once, without waiting for the next update.
    rig.combat.removeProjectile(last);
    expect(glow.count).toBe(14);
    rig.combat.clearProjectiles();
    expect(glow.visible).toBe(false);
    expect(rocket.visible).toBe(false);
    expect(rocket.count).toBe(0);

    // A full house fits the buffers.
    for (let i = 0; i < MAX_PROJECTILES + 5; i++) launch('bossMissile', 3 + i * 0.2);
    rig.step();
    expect(mesh(rig, 'projectile:bossMissile').count).toBe(MAX_PROJECTILES);
    expect(glow.count).toBe(MAX_PROJECTILES * 2);
    rig.combat.reset();
    expect(meshes(rig).every((each) => !each.visible && each.count === 0)).toBe(true);
  });

  it('dispose removes the root, the projectiles and the registry', () => {
    const rig = createTestRig();
    const enemy = rig.target();
    rig.combat.spawnProjectile({ kind: 'rocket', faction: 'player', ownerId: 0, damage: 1, position: { x: 0, y: 5, z: 0 }, velocity: { x: 1, y: 0, z: 0 } });
    rig.combat.dispose();
    expect(rig.ctx.scene.children.length).toBe(0);
    expect(rig.combat.projectileCount).toBe(0);
    expect(rig.combat.getTarget(enemy.id)).toBeUndefined();
    // Still harmless afterwards.
    expect(() => {
      rig.combat.reset();
      rig.combat.update(1 / 60);
    }).not.toThrow();
  });
});

describe('update order', () => {
  it('advances projectiles, then resolves blasts, then flushes the feedback — all in one substep', () => {
    const rig = createTestRig([box(9, 0, -5, 10, 6, 5)]);
    const bystander = rig.target({ x: 7, z: 2, hp: 1e6 });
    rig.combat.spawnProjectile({ kind: 'rocket', faction: 'player', ownerId: rig.player.target.id, damage: 110, splashRadius: 5, splashDamage: 90, weapon: 'hornet', position: { x: 0, y: 1, z: 0 }, velocity: { x: 45, y: 0, z: 0 } });
    let steps = 0;
    while (rig.combat.projectileCount > 0 && steps < 100) {
      // Until the very substep of the impact nothing has happened.
      expect(rig.fx.spawns.length).toBe(0);
      expect(rig.hits.length).toBe(0);
      rig.step();
      steps++;
    }
    // The substep in which the rocket struck the wall also resolved its blast and confirmed the hit.
    expect(steps).toBeLessThan(20);
    expect(rig.fxIds('explosion')).toEqual(['explosionLarge']);
    expect(bystander.taken.length).toBe(1);
    expect(rig.hits.map((h) => h.targetId)).toEqual([bystander.id]);
    expect(rig.fx.numbers.length).toBe(1);
    expect(rig.soundIds('hit')).toEqual(['hitConfirm']);
  });

  it('keeps working through game over and victory, and stands still while paused or frozen', () => {
    const rig = createTestRig();
    const target = rig.target({ x: 4, hp: 1e6, faction: 'neutral' });
    rig.game.mode = 'gameover';
    rig.combat.explode({ position: { x: 0, y: 1, z: 0 }, radius: 6, damage: 10, faction: 'enemy' });
    rig.step();
    expect(target.taken.length).toBe(1);
    rig.game.mode = 'victory';
    rig.combat.spawnProjectile({ kind: 'plasmaBolt', faction: 'enemy', ownerId: 0, damage: 3, position: { x: 0, y: 1, z: 0 }, velocity: { x: 30, y: 0, z: 0 } });
    rig.run(0.3);
    expect(target.taken.length).toBe(2);
    // The perk freeze: scale 0, core calls nobody — and an update(0) would not move anything either.
    rig.game.mode = 'playing';
    rig.time.scale = 0;
    const id = rig.combat.spawnProjectile({ kind: 'rocket', faction: 'player', ownerId: 0, damage: 3, position: { x: 0, y: 5, z: 0 }, velocity: { x: 30, y: 0, z: 0 } });
    rig.run(0.3);
    expect(rig.fx.trails.find((t) => t.owner === id)?.position.x).toBe(0);
  });
});
