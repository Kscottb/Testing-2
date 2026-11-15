// STUB: replaced by the world team
import * as THREE from 'three';
import { COL, ZONE_IDS } from '../core/constants';
import { aabbContainsXZ } from '../core/math';
import { PALETTE } from '../core/palette';
import type { Aabb, DropPad, GameContext, GateInfo, MinimapRect, NavBuildHints, SpawnKind, SpawnPoint, WorldSystem, ZoneId, ZoneInfo } from '../core/types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const NAMES: Record<ZoneId, string> = { deck: 'LANDING DECK', refinery: 'REFINERY', spire: 'CORE SPIRE' };
/** Doorways per zone boundary: [gate kind, minZ, maxZ]. */
const DOORS = [['side', -18, -12], ['main', -4, 4]] as const;

/** Gray-box rig: one flat floor split into three 60 m zones by walls with a main and a side energy gate each. */
export function createWorldSystem(ctx: GameContext): WorldSystem {
  const group = new THREE.Group();
  group.name = 'world';
  const bounds: Aabb = { minX: -90, minY: -1, minZ: -30, maxX: 90, maxY: 40, maxZ: 30 };
  // The zone rectangles tile the bounds along X without gaps: zoneAt never returns null inside them.
  const zones: Mutable<ZoneInfo>[] = ZONE_IDS.map((id, index) => {
    const minX = -90 + index * 60;
    return { id, name: NAMES[id], index, unlocked: index === 0, aabb: { ...bounds, minX, maxX: minX + 60 }, center: new THREE.Vector3(minX + 30, 0, 0) };
  });
  const gates: (Mutable<GateInfo> & { mesh: THREE.Mesh })[] = [];
  const spawns: SpawnPoint[] = [];
  const dropPads: DropPad[] = [];
  const rects: MinimapRect[] = [];
  const spawnCache = new Map<string, SpawnPoint[]>();
  const material = (color: number, opacity = 1): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.8, transparent: opacity < 1, depthWrite: opacity >= 1, opacity, emissive: opacity < 1 ? color : 0 });
  const mats = { floor: material(PALETTE.hullGraphite), wall: material(PALETTE.hullWhite), crate: material(PALETTE.safetyOrange), gate: material(PALETTE.player, 0.35) };

  const box = (a: Aabb, mat: THREE.Material, kind: MinimapRect['kind'], flags: number = COL.SOLID, tag = ''): THREE.Mesh => {
    // Gates can vanish: decals must not stick to them.
    ctx.collision.addBox({ ...a, flags, tag, decals: !tag.startsWith('gate:') });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(a.maxX - a.minX, a.maxY - a.minY, a.maxZ - a.minZ), mat);
    mesh.position.set((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2);
    group.add(mesh);
    rects.push({ minX: a.minX, minZ: a.minZ, maxX: a.maxX, maxZ: a.maxZ, kind, level: a.maxY, zone: world.zoneAt(mesh.position.x, mesh.position.z), gateId: null });
    return mesh;
  };
  const b = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Aabb => ({ minX, minY, minZ, maxX, maxY, maxZ });

  const world: WorldSystem = {
    bounds,
    zones,
    zone: (id) => zones[ZONE_IDS.indexOf(id)] as ZoneInfo,
    playerStart: { position: new THREE.Vector3(-78, 0, 0), yaw: -Math.PI / 2 },
    spawnPoints(zone?: ZoneId, kind?: SpawnKind): readonly SpawnPoint[] {
      const key = `${zone ?? '*'}/${kind ?? '*'}`;
      let list = spawnCache.get(key);
      if (!list) {
        list = spawns.filter((s) => (!zone || s.zone === zone) && (!kind || s.kind === kind));
        spawnCache.set(key, list);
      }
      return list;
    },
    dropPads,
    gates,
    jumpPads: [],
    hazards: [],
    // The gray box has no gate animation, so `instant` changes nothing but the (silent) feedback.
    setGateOpen(id: string, open: boolean, instant = false): void {
      const gate = gates.find((g) => g.id === id);
      if (!gate || gate.open === open) return;
      gate.open = open;
      gate.mesh.visible = !open;
      ctx.collision.setEnabledByTag(gate.tag, !open);
      ctx.nav.setRegionWalkable(gate.aabb, open);
      if (!instant) {
        ctx.fx.spawn(open ? 'gateOpen' : 'gateClose', gate.position);
        ctx.audio.playAt(open ? 'gateOpen' : 'gateClose', gate.position);
      }
      ctx.events.emit('gate:state', { gateId: id, open, from: gate.from, to: gate.to });
    },
    unlockZone(zone: ZoneId): void {
      const info = zones[ZONE_IDS.indexOf(zone)] as Mutable<ZoneInfo>;
      if (info.unlocked) return;
      info.unlocked = true;
      for (const gate of gates) if (gate.to === zone) world.setGateOpen(gate.id, true);
      ctx.fx.spawn('zoneUnlock', info.center);
      ctx.audio.play('zoneUnlock');
      ctx.events.emit('zone:unlocked', { zone, name: info.name });
    },
    zoneAt: (x, z) => zones.find((zone) => aabbContainsXZ(zone.aabb, x, z))?.id ?? null,
    // Real floors only: boxes that block BOTH the player and projectiles, never gates (setup / debug query, not per frame).
    groundHeightAt(x: number, z: number, fromY = bounds.maxY): number {
      const floor = COL.PLAYER | COL.PROJECTILE;
      let best = -Infinity;
      for (const c of ctx.collision.boxes) {
        if (!c.enabled || (c.flags & floor) !== floor || c.tag.startsWith('gate:')) continue;
        if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && c.maxY <= fromY + 1e-4 && c.maxY > best) best = c.maxY;
      }
      return best;
    },
    bossArena: { center: new THREE.Vector3(60, 0, 0), radius: 22, hoverHeight: 10 },
    cinematicPath: [
      { position: new THREE.Vector3(-95, 14, 26), target: new THREE.Vector3(-60, 2, 0), seconds: 14 },
      { position: new THREE.Vector3(0, 22, 34), target: new THREE.Vector3(0, 2, 0), seconds: 14 },
      { position: new THREE.Vector3(95, 16, -26), target: new THREE.Vector3(60, 4, 0), seconds: 14 },
    ],
    minimap: { bounds, rects },
    killY: -12,
    navHints(): NavBuildHints {
      return {
        bounds,
        cellSize: 1,
        zones: zones.map((z) => ({ id: z.id, aabb: z.aabb })),
        blocked: [],
        ignoreTags: gates.map((g) => g.tag),
        closedRegions: gates.filter((g) => !g.open).map((g) => g.aabb),
        seeds: [world.playerStart.position],
        maxStep: 0.75,
        agentHeight: 1.6,
        agentRadius: 0.4,
      };
    },

    init(): void {
      box(b(-90, -1, -30, 90, 0, 30), mats.floor, 'floor');
      box(b(-91, 0, -31, 91, 3, -30), mats.wall, 'wall');
      box(b(-91, 0, 30, 91, 3, 31), mats.wall, 'wall');
      box(b(-91, 0, -30, -90, 3, 30), mats.wall, 'wall');
      box(b(90, 0, -30, 91, 3, 30), mats.wall, 'wall');
      for (let i = 0; i < 2; i++) {
        const x = -30 + i * 60;
        const from = ZONE_IDS[i] as ZoneId;
        const to = ZONE_IDS[i + 1] as ZoneId;
        // Wall band with two doorways; each gate is 1 m thick so it covers the nav cell centres across it.
        let wallFrom = -30;
        for (const [kind, minZ, maxZ] of DOORS) {
          box(b(x - 0.5, 0, wallFrom, x + 0.5, 4, minZ), mats.wall, 'wall');
          const aabb = b(x - 0.5, 0, minZ, x + 0.5, 4, maxZ);
          const id = `${from}-${to}:${kind}`;
          const mesh = box(aabb, mats.gate, 'gate', COL.GATE, `gate:${id}`);
          (rects[rects.length - 1] as Mutable<MinimapRect>).gateId = id;
          gates.push({ id, from, to, open: false, position: new THREE.Vector3(x, 0, (minZ + maxZ) / 2), aabb, tag: `gate:${id}`, mesh });
          wallFrom = maxZ;
        }
        box(b(x - 0.5, 0, wallFrom, x + 0.5, 4, 30), mats.wall, 'wall');
      }
      let spawnId = 0;
      for (const zone of zones) {
        const cx = zone.center.x;
        for (const [dx, dz] of [[-12, -14], [10, 12], [-6, 16], [14, -10]] as const) {
          box(b(cx + dx - 1.2, 0, dz - 1.2, cx + dx + 1.2, 1.6, dz + 1.2), mats.crate, 'cover');
        }
        box(b(cx - 3, 0, -3, cx + 3, 0.4, 3), mats.wall, 'dropPad');
        dropPads.push({ id: zone.index, position: new THREE.Vector3(cx, 0.4, 0), zone: zone.id });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + 0.3;
          const x = cx + Math.cos(a) * 22;
          const z = Math.sin(a) * 22;
          spawns.push({ id: spawnId++, position: new THREE.Vector3(x, 0, z), zone: zone.id, kind: 'ground' });
          if (i % 2 === 0) spawns.push({ id: spawnId++, position: new THREE.Vector3(x, 6.5, z), zone: zone.id, kind: 'air' });
          if (i % 4 === 1) spawns.push({ id: spawnId++, position: new THREE.Vector3(x * 0.98, 0, z * 0.8), zone: zone.id, kind: 'heavy' });
        }
      }
      ctx.collision.finalize();
      ctx.scene.add(group);
    },
    reset(): void {
      // Instant: no animation, fx or sound while resetting.
      for (const gate of gates) world.setGateOpen(gate.id, false, true);
      for (const zone of zones) zone.unlocked = zone.index === 0;
    },
    update(): void {
      // Gameplay rules (here: only the fall-out rule) run while playing with a live player; animation would run always.
      if (ctx.game.mode !== 'playing' || !ctx.player.alive) return;
      if (ctx.player.position.y < world.killY) {
        ctx.player.teleport(world.playerStart.position, world.playerStart.yaw);
        ctx.fx.spawn('respawn', world.playerStart.position);
        ctx.audio.play('fallRespawn');
      }
    },
    dispose(): void {
      ctx.scene.remove(group);
      ctx.collision.clear();
    },
  };
  return world;
}
