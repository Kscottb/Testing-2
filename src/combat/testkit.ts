/**
 * Test support for the combat suites: a GameContext made of the REAL collision world, event bus, clock
 * maths and rng, with recording stand-ins for fx, audio, player, render and input — no DOM, no WebGL.
 * Nothing in the game imports this file.
 */
import * as THREE from 'three';
import { createEventBus } from '../core/events';
import { clearDamageResult, makeDamageInfo, makeDamageResult, makeHitSphere, makeModifiers } from '../core/make';
import { createRng } from '../core/rng';
import { createCollisionWorld } from '../physics';
import type {
  Aabb,
  BoxDesc,
  CollisionWorld,
  CombatSystem,
  DamageInfo,
  DamageResult,
  EventMap,
  Faction,
  FxSystem,
  GameContext,
  GameMode,
  HitPart,
  HitTarget,
  LoopHandle,
  TelegraphHandle,
  TrailHandle,
  Vec3Like,
} from '../core/types';
import { createCombatSystem } from './index';

export interface FxCall {
  id: string;
  x: number;
  y: number;
  z: number;
  radius: number | undefined;
  scale: number | undefined;
  color: number | undefined;
  nx: number;
  ny: number;
  nz: number;
  /** opts.dir (defaults to the normal). */
  dx: number;
  dy: number;
  dz: number;
}

export interface SoundCall {
  id: string;
  positional: boolean;
  x: number;
  y: number;
  z: number;
  volume: number;
  pitch: number;
  delay: number;
  priority: number;
  owner: number;
}

export interface TelegraphCall {
  kind: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  seconds: number;
  owner: number;
  active: boolean;
  progress: number;
}

export interface TrailCall {
  kind: string;
  /** The retained live vector. */
  position: THREE.Vector3;
  color: number | undefined;
  owner: number;
  active: boolean;
}

export interface LoopCall {
  id: string;
  owner: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
}

export interface TestTarget extends HitTarget {
  hp: number;
  /** Every DamageInfo.amount that reached takeDamage, in order. */
  taken: number[];
  /** Copies of the last info that arrived. */
  lastInfo: DamageInfo | null;
  /** Called at the end of takeDamage (chain reactions, removal). */
  onDamage: ((info: DamageInfo, result: DamageResult) => void) | null;
}

export interface TargetSpec {
  faction?: Faction;
  x?: number;
  y?: number;
  z?: number;
  radius?: number;
  hp?: number;
  part?: HitPart;
  /** Leave it unregistered. */
  detached?: boolean;
}

export interface TestRig {
  ctx: GameContext;
  combat: CombatSystem;
  collision: CollisionWorld;
  bounds: Aabb;
  /** Mutable clock: set `scale`, then call step(). */
  time: { dt: number; unscaledDt: number; playerDt: number; now: number; scale: number; hitstops: number[] };
  /** Projectiles in flight, by the trail each one attached: `position` is the live drawn position. */
  game: { mode: GameMode; errors: { source: string; message: string }[] };
  fx: {
    spawns: FxCall[];
    decals: { kind: string; x: number; y: number; z: number; size: number | undefined; boxId: number | undefined }[];
    numbers: { x: number; y: number; z: number; amount: number; crit: boolean; shield: boolean; kill: boolean; targetId: number }[];
    lights: { x: number; y: number; z: number; color: number; intensity: number; radius: number; seconds: number; key: number }[];
    telegraphs: TelegraphCall[];
    trails: TrailCall[];
    cancelled: number[];
  };
  audio: { sounds: SoundCall[]; loops: LoopCall[]; stopped: number[]; unlocked: boolean };
  player: {
    target: TestTarget;
    eye: THREE.Vector3;
    shakes: { x: number; y: number; z: number; trauma: number; radius: number }[];
    alive: boolean;
  };
  render: { flashes: { color: number; intensity: number }[]; post: { chromaticBoost: number }; warmed: number };
  input: { rumbles: { strength: number; seconds: number }[] };
  hits: EventMap['hit:confirmed'][];
  /** A fresh damage info (player bullet by default). */
  info(amount: number, over?: Partial<DamageInfo>): DamageInfo;
  /** Create (and register) a one-sphere target with simple hp arithmetic. */
  target(spec?: TargetSpec): TestTarget;
  /** Advance one substep of `stepDt` real seconds under the current time scale (world dt = stepDt * scale). */
  step(stepDt?: number): void;
  /** step() repeatedly for `seconds`. */
  run(seconds: number, stepDt?: number): void;
  /** Ids of the effects spawned so far, optionally only those starting with a prefix. */
  fxIds(prefix?: string): string[];
  soundIds(prefix?: string): string[];
}

const FLOOR: BoxDesc = { minX: -60, minY: -1, minZ: -60, maxX: 60, maxY: 0, maxZ: 60 };

/** A rig over a 120 m floor (top at y = 0) plus any extra boxes. The player target stands at (0, 0, 40). */
export function createTestRig(boxes: BoxDesc[] = [], withFloor = true): TestRig {
  const collision = createCollisionWorld();
  if (withFloor) collision.addBox(FLOOR);
  for (const box of boxes) collision.addBox(box);
  collision.finalize();
  const bounds: Aabb = { minX: -60, minY: -1, minZ: -60, maxX: 60, maxY: 40, maxZ: 60 };

  let nextId = 0;
  // Plain data fields (what core's clock exposes), written by step().
  const time = {
    dt: 0.5,
    unscaledDt: 0.5,
    playerDt: 0.5,
    now: 0.5,
    scale: 1,
    substep: 0,
    substeps: 1,
    hitstops: [] as number[],
    hitstop(seconds: number): void {
      time.hitstops.push(seconds);
    },
  };
  time.dt = time.unscaledDt = time.playerDt = time.now = 0;
  const game = { mode: 'playing' as GameMode, errors: [] as { source: string; message: string }[] };
  const fx: TestRig['fx'] = { spawns: [], decals: [], numbers: [], lights: [], telegraphs: [], trails: [], cancelled: [] };
  const audio: TestRig['audio'] = { sounds: [], loops: [], stopped: [], unlocked: true };
  const render: TestRig['render'] = { flashes: [], post: { chromaticBoost: 0 }, warmed: 0 };
  const input: TestRig['input'] = { rumbles: [] };
  const hits: EventMap['hit:confirmed'][] = [];
  const events = createEventBus();
  events.on('hit:confirmed', (e) => hits.push({ ...e, point: e.point.clone() }));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  const fakeFx = {
    spawn(id: string, p: Vec3Like, o?: { radius?: number; scale?: number; color?: number; normal?: Vec3Like; dir?: Vec3Like }): void {
      const n = o?.normal ?? { x: 0, y: 1, z: 0 };
      const d = o?.dir ?? n;
      fx.spawns.push({ id, x: p.x, y: p.y, z: p.z, radius: o?.radius, scale: o?.scale, color: o?.color, nx: n.x, ny: n.y, nz: n.z, dx: d.x, dy: d.y, dz: d.z });
    },
    decal(kind: string, p: Vec3Like, _n: Vec3Like, size?: number, boxId?: number): void {
      fx.decals.push({ kind, x: p.x, y: p.y, z: p.z, size, boxId });
    },
    damageNumber(p: Vec3Like, amount: number, o?: { crit?: boolean; shield?: boolean; kill?: boolean; targetId?: number }): void {
      fx.numbers.push({ x: p.x, y: p.y, z: p.z, amount, crit: o?.crit ?? false, shield: o?.shield ?? false, kill: o?.kill ?? false, targetId: o?.targetId ?? 0 });
    },
    lightFlash(p: Vec3Like, color: number, intensity: number, radius: number, seconds: number, key = 0): void {
      fx.lights.push({ x: p.x, y: p.y, z: p.z, color, intensity, radius, seconds, key });
    },
    telegraph(o: { kind: string; position: Vec3Like; radius: number; seconds: number; owner?: number }): TelegraphHandle {
      const call: TelegraphCall = { kind: o.kind, x: o.position.x, y: o.position.y, z: o.position.z, radius: o.radius, seconds: o.seconds, owner: o.owner ?? 0, active: true, progress: 0 };
      fx.telegraphs.push(call);
      return {
        get active() {
          return call.active;
        },
        setPosition(): void {},
        setRadius(): void {},
        setProgress(value: number): void {
          call.progress = value;
        },
        cancel(): void {
          call.active = false;
        },
      };
    },
    attachTrail(kind: string, position: THREE.Vector3, color?: number, owner = 0): TrailHandle {
      const call: TrailCall = { kind, position, color, owner, active: true };
      fx.trails.push(call);
      return {
        get active() {
          return call.active;
        },
        detach(): void {
          call.active = false;
        },
      };
    },
    cancelOwner(ownerId: number): void {
      fx.cancelled.push(ownerId);
      for (const t of fx.telegraphs) if (t.owner === ownerId) t.active = false;
      for (const t of fx.trails) if (t.owner === ownerId) t.active = false;
    },
  };

  const sound = (id: string, positional: boolean, p: Vec3Like | null, o?: Partial<SoundCall>): void => {
    audio.sounds.push({ id, positional, x: p?.x ?? 0, y: p?.y ?? 0, z: p?.z ?? 0, volume: o?.volume ?? 1, pitch: o?.pitch ?? 1, delay: o?.delay ?? 0, priority: o?.priority ?? 1, owner: o?.owner ?? 0 });
  };
  const fakeAudio = {
    get unlocked() {
      return audio.unlocked;
    },
    play: (id: string, o?: Partial<SoundCall>): void => sound(id, false, null, o),
    playAt: (id: string, p: Vec3Like, o?: Partial<SoundCall>): void => sound(id, true, p, o),
    loop(id: string, o?: { position?: Vec3Like; owner?: number }): LoopHandle {
      const call: LoopCall = { id, owner: o?.owner ?? 0, active: true, x: o?.position?.x ?? 0, y: o?.position?.y ?? 0, z: o?.position?.z ?? 0 };
      audio.loops.push(call);
      return {
        get active() {
          return call.active;
        },
        setPosition(p: Vec3Like): void {
          call.x = p.x;
          call.y = p.y;
          call.z = p.z;
        },
        setVolume(): void {},
        setPitch(): void {},
        stop(): void {
          call.active = false;
        },
      };
    },
    stopOwner(ownerId: number): void {
      audio.stopped.push(ownerId);
      for (const l of audio.loops) if (l.owner === ownerId) l.active = false;
    },
  };

  const rig = { collision, bounds, time, game, fx, audio, render, input, hits } as unknown as TestRig;

  const makeTarget = (spec: TargetSpec = {}): TestTarget => {
    const sphere = makeHitSphere(spec.radius ?? 0.5, spec.part ?? 'body');
    sphere.center.set(spec.x ?? 0, spec.y ?? 1, spec.z ?? 0);
    const result = makeDamageResult();
    const target: TestTarget = {
      id: ++nextId,
      faction: spec.faction ?? 'enemy',
      alive: true,
      center: sphere.center,
      boundRadius: sphere.radius,
      spheres: [sphere],
      enemy: null,
      hp: spec.hp ?? 100,
      taken: [],
      lastInfo: null,
      onDamage: null,
      takeDamage(info: DamageInfo): DamageResult {
        clearDamageResult(result, info.part);
        target.taken.push(info.amount);
        target.lastInfo = { ...info, point: info.point.clone(), dir: info.dir.clone() };
        const dealt = Math.min(target.hp, info.amount);
        target.hp -= dealt;
        result.dealt = result.healthDamage = dealt;
        result.crit = info.part === 'weak' && !info.splash;
        if (target.hp <= 0) {
          result.killed = true;
          target.alive = false;
          rig.combat.unregister(target.id);
        }
        target.onDamage?.(info, result);
        return result;
      },
    };
    if (!spec.detached) rig.combat.register(target);
    return target;
  };

  const eye = new THREE.Vector3();
  const playerState = { target: null as unknown as TestTarget, eye, shakes: [] as TestRig['player']['shakes'], alive: true };
  const fakePlayer = {
    eye,
    get alive() {
      return playerState.alive;
    },
    get targetId() {
      return playerState.target.id;
    },
    get center() {
      return playerState.target.center;
    },
    addShake(): void {},
    addShakeAt(p: Vec3Like, trauma: number, radius: number): void {
      playerState.shakes.push({ x: p.x, y: p.y, z: p.z, trauma, radius });
    },
  };

  const ctx = {
    scene,
    camera,
    events,
    collision,
    time,
    game: {
      get mode() {
        return game.mode;
      },
      reportError(source: string, error: unknown): void {
        game.errors.push({ source, message: error instanceof Error ? error.message : String(error) });
      },
    },
    world: { bounds, killY: -12 },
    fx: fakeFx as unknown as FxSystem,
    audio: fakeAudio,
    player: fakePlayer,
    render: {
      post: render.post,
      screenFlash(color: number, intensity: number): void {
        render.flashes.push({ color, intensity });
      },
      warm(): void {
        render.warmed++;
      },
    },
    input: {
      rumble(strength: number, seconds: number): void {
        input.rumbles.push({ strength, seconds });
      },
    },
    mods: makeModifiers(),
    rng: createRng(1),
    cosmeticRng: createRng(2),
    debug: { god: false, infiniteAmmo: false, freezeAi: false, freeCamera: false, hideUi: false, bot: false },
    testMode: true,
    nextId: () => ++nextId,
  } as unknown as GameContext;

  rig.ctx = ctx;
  rig.combat = createCombatSystem(ctx);
  ctx.combat = rig.combat;
  rig.combat.init();

  // The player: a target far from the origin, where the scenarios happen.
  playerState.target = makeTarget({ faction: 'player', x: 0, y: 1, z: 40, radius: 0.6, hp: 1000 });
  eye.set(0, 1.65, 40);
  camera.position.copy(eye);
  rig.player = playerState;

  rig.info = (amount: number, over: Partial<DamageInfo> = {}): DamageInfo => {
    const info = makeDamageInfo();
    info.amount = amount;
    info.faction = 'player';
    info.sourceId = playerState.target.id;
    info.weapon = 'vector';
    info.dir.set(0, 0, -1);
    const { point, dir, ...rest } = over;
    Object.assign(info, rest);
    if (point) info.point.copy(point);
    if (dir) info.dir.copy(dir);
    return info;
  };
  rig.target = makeTarget;
  rig.step = (stepDt = 1 / 60): void => {
    const playing = game.mode === 'playing';
    const simulating = playing || game.mode === 'gameover' || game.mode === 'victory' || game.mode === 'menu';
    time.dt = simulating ? stepDt * time.scale : 0;
    time.unscaledDt = playing && time.scale > 0 ? stepDt : 0;
    time.playerDt = playing ? time.unscaledDt : time.dt;
    time.now += time.dt;
    rig.combat.update(time.dt);
  };
  rig.run = (seconds: number, stepDt = 1 / 60): void => {
    for (let n = Math.round(seconds / stepDt); n > 0; n--) rig.step(stepDt);
  };
  rig.fxIds = (prefix = ''): string[] => fx.spawns.map((s) => s.id).filter((id) => id.startsWith(prefix));
  rig.soundIds = (prefix = ''): string[] => audio.sounds.map((s) => s.id).filter((id) => id.startsWith(prefix));
  return rig;
}

/** Shorthand for a box description. */
export function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, extra: Partial<BoxDesc> = {}): BoxDesc {
  return { minX, minY, minZ, maxX, maxY, maxZ, ...extra };
}
