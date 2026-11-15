/**
 * window.__SH — the automation / debugging surface (see DebugApi in core/types.ts).
 */
import type * as THREE from 'three';
import { ENEMIES } from '../data/enemies';
import type { Bot } from './bot';
import { PERK_IDS, WEAPON_IDS, ZONE_IDS } from './constants';
import type { CoreContext } from './context';
import { showFatalPanel } from './fatal';
import type { GameCore } from './game';
import type { Loop } from './loop';
import { clearDamageInfo, makeDamageInfo } from './make';
import { dirToPitch, dirToYaw, safeNormalize } from './math';
import type {
  BotOptions,
  DebugApi,
  DebugState,
  Difficulty,
  EnemyType,
  FxId,
  HitPart,
  InputAction,
  PerkId,
  QualitySetting,
  SoundId,
  StepOptions,
  TimeOfDayId,
  UiScreen,
  WeaponId,
  ZoneId,
} from './types';

declare global {
  interface Window {
    __SH?: DebugApi;
  }
}

/** Errors that browsers raise for harmless reasons and that must not fail automated runs. */
function isBenign(message: string): boolean {
  return message.includes('ResizeObserver loop');
}

/**
 * Install global error capture. Safe to call before anything else exists: errors that happen during
 * boot raise the fatal panel, later ones are only recorded.
 */
export function installErrorCapture(game: GameCore): void {
  window.addEventListener('error', (e: ErrorEvent) => {
    const message = e.message || 'Unknown error';
    if (isBenign(message)) return;
    game.recordError('window', e.error ?? message);
    if (game.mode === 'boot' && !game.fatal) game.reportError('window', e.error ?? message, true);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    game.recordError('promise', e.reason ?? 'Unhandled promise rejection');
  });
}

type Budget = { visibleMeshes: number; triangles: number };

/** Count the visible drawables and their triangles below `root` into `into`. */
function countDrawables(root: THREE.Object3D, into: Budget): void {
  if (!root.visible) return;
  const drawable = root as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
  if (drawable.isMesh || drawable.isPoints || drawable.isLine || drawable.isSprite) {
    into.visibleMeshes++;
    const geometry = drawable.geometry as THREE.BufferGeometry | undefined;
    if (drawable.isMesh && geometry) {
      const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      let vertices = geometry.index ? geometry.index.count : position ? position.count : 0;
      if (Number.isFinite(geometry.drawRange.count)) vertices = Math.min(vertices, geometry.drawRange.count);
      const instanced = root as THREE.InstancedMesh;
      const instances = instanced.isInstancedMesh ? instanced.count : 1;
      into.triangles += Math.floor(vertices / 3) * instances;
    }
  }
  for (const child of root.children) countDrawables(child, into);
}

export function createDebugApi(ctx: CoreContext, game: GameCore, loop: Loop, bot: Bot): DebugApi {
  const damage = makeDamageInfo();

  const state = (): DebugState => {
    const { player, weapons, director, enemies, render, time, input, fx, audio } = ctx;
    const boss = enemies.boss;
    const offer = director.perkOffer;
    const unlocked: WeaponId[] = WEAPON_IDS.filter((id) => weapons.weapons[id].unlocked);
    const zones = {} as Record<ZoneId, boolean>;
    for (const id of ZONE_IDS) zones[id] = ctx.world.zone(id).unlocked;
    const perks: Partial<Record<PerkId, number>> = {};
    for (const id of PERK_IDS) {
      const stacks = director.perkStacks(id);
      if (stacks > 0) perks[id] = stacks;
    }
    let spawning = 0;
    let dying = 0;
    for (const enemy of enemies.list) {
      if (enemy.dying) dying++;
      else if (enemy.alive && enemy.spawning) spawning++;
    }
    return {
      mode: game.mode,
      difficulty: game.difficulty,
      phase: director.phase,
      wave: director.wave,
      totalWaves: director.totalWaves,
      score: director.score,
      combo: director.combo.multiplier,
      objective: director.objective.text,
      enemiesAlive: enemies.aliveCount,
      enemiesSpawning: spawning,
      enemiesDying: dying,
      enemiesRemaining: director.enemiesRemaining,
      tokensInUse: enemies.tokensInUse,
      pickups: director.pickups.length,
      projectiles: ctx.combat.projectileCount,
      boss: boss
        ? { hp: boss.hp, maxHp: boss.maxHp, phase: boss.phase, invulnerable: boss.invulnerable, dying: boss.dying }
        : null,
      perkOffer: offer ? [...offer] : null,
      perks,
      player: {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        vx: player.velocity.x,
        vy: player.velocity.y,
        vz: player.velocity.z,
        yaw: player.yaw,
        pitch: player.pitch,
        hp: player.hp,
        shield: player.shield,
        alive: player.alive,
        grounded: player.grounded,
        crouching: player.crouching,
        sliding: player.sliding,
        sprinting: player.sprinting,
        invulnerable: player.invulnerable,
        dashCharges: player.dash.charges,
        overclock: player.overclock.charge,
        overclockReady: player.overclock.ready,
        overclockActive: player.overclock.active,
        lastStand: player.lastStandCharges,
      },
      weapon: {
        id: weapons.current.id,
        mag: weapons.current.mag,
        reserve: weapons.current.reserve,
        reloading: weapons.current.reloading,
        charge: weapons.current.charge,
        spread: weapons.spread,
        ads: weapons.adsAmount,
        switching: weapons.switching,
        unlocked,
      },
      grenades: weapons.grenades,
      stats: { ...director.stats, perks: [...director.stats.perks] },
      zones,
      timeOfDay: render.timeOfDay,
      weather: fx.weather,
      quality: render.quality,
      resolutionScale: render.resolutionScale,
      lookMode: input.lookMode,
      device: input.device,
      uiScreen: ctx.ui.screen,
      musicState: audio.musicState,
      musicIntensity: audio.musicIntensity,
      audioState: audio.meter.state,
      voices: audio.meter.voices,
      particles: fx.stats.particles,
      fps: game.fps,
      drawCalls: render.stats.drawCalls,
      triangles: render.stats.triangles,
      geometries: render.stats.geometries,
      textures: render.stats.textures,
      programs: render.stats.programs,
      simTime: time.now,
      frame: time.frame,
      timeScale: time.scale,
      errors: game.errors.length,
    };
  };

  const spawnAt = (type: EnemyType, x: number, y: number, z: number, instant: boolean): number => {
    const handle = ctx.enemies.spawn(type, { x, y, z }, { instant });
    return handle ? handle.id : -1;
  };

  const api: DebugApi = {
    ready: false,
    get fatal(): boolean {
      return game.fatal;
    },
    manual: loop.manual,
    errors: game.errors,
    ctx,
    state,

    start(difficulty?: Difficulty): DebugState {
      game.startRun(difficulty ?? 'veteran');
      return state();
    },
    step(seconds: number, opts?: StepOptions): DebugState {
      const dt = opts?.dt !== undefined && opts.dt > 0 ? opts.dt : 1 / 60;
      const frames = Math.max(0, Math.round(seconds / dt));
      const every = opts?.render === true ? 1 : typeof opts?.render === 'number' ? Math.max(1, opts.render) : 0;
      if (frames === 0) {
        game.frame(0, every > 0);
      }
      for (let i = 0; i < frames && !game.fatal; i++) {
        game.frame(dt, every > 0 && (i + 1) % every === 0);
      }
      return state();
    },
    renderFrame(): void {
      game.renderOnly();
    },
    pause(): void {
      game.pause();
    },
    resume(): void {
      game.resume();
    },
    menu(): void {
      game.toMenu();
    },
    endRun(victory: boolean): void {
      game.endRun(victory);
    },
    god(on: boolean): void {
      ctx.debug.god = on;
    },
    infiniteAmmo(on: boolean): void {
      ctx.debug.infiniteAmmo = on;
    },
    freezeAi(on: boolean): void {
      ctx.debug.freezeAi = on;
    },
    giveAll(): void {
      for (const id of WEAPON_IDS) {
        if (!ctx.weapons.weapons[id].unlocked) ctx.weapons.unlock(id, false);
      }
      ctx.weapons.refill();
      for (const zone of ZONE_IDS) {
        if (!ctx.world.zone(zone).unlocked) ctx.world.unlockZone(zone);
      }
    },
    setWave(wave: number): void {
      ctx.director.debugSkipToWave(wave);
    },
    spawn(type: EnemyType, x?: number, y?: number, z?: number): number {
      const player = ctx.player;
      const def = ENEMIES[type];
      const px = x ?? player.position.x - Math.sin(player.yaw) * 8;
      const pz = z ?? player.position.z - Math.cos(player.yaw) * 8;
      let py = y;
      if (py === undefined) {
        const ground = ctx.world.groundHeightAt(px, pz);
        py = (Number.isFinite(ground) ? ground : player.position.y) + (def.flying ? (def.hoverMin + def.hoverMax) / 2 : 0);
      }
      return spawnAt(type, px, py, pz, true);
    },
    spawnArriving(type: EnemyType, x: number, y: number, z: number): number {
      return spawnAt(type, x, y, z, false);
    },
    killAll(): number {
      return ctx.enemies.killAll(false);
    },
    damageEnemy(id: number, amount: number, part: HitPart = 'body'): { dealt: number; killed: boolean } {
      const target = ctx.combat.getTarget(id);
      if (!target || !target.enemy) return { dealt: 0, killed: false };
      clearDamageInfo(damage);
      damage.amount = amount;
      damage.type = 'bullet';
      damage.faction = 'player';
      damage.sourceId = ctx.player.targetId;
      damage.weapon = 'vector';
      damage.part = part;
      damage.point.copy(target.center);
      damage.dir.subVectors(target.center, ctx.player.eye);
      safeNormalize(damage.dir, 0, 0, -1);
      const result = ctx.combat.applyDamage(target, damage);
      return { dealt: result.dealt, killed: result.killed };
    },
    enemies() {
      return ctx.enemies.list.map((e) => ({
        id: e.id,
        type: e.type,
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
        hp: e.hp,
        alive: e.alive,
      }));
    },
    teleport(x: number, y: number, z: number, yaw?: number, pitch?: number): void {
      ctx.player.teleport({ x, y, z }, yaw, pitch);
    },
    look(yaw: number, pitch: number): void {
      ctx.player.setLook(yaw, pitch);
    },
    lookAtPoint(x: number, y: number, z: number): void {
      const eye = ctx.player.eye;
      const dx = x - eye.x;
      const dy = y - eye.y;
      const dz = z - eye.z;
      ctx.player.setLook(dirToYaw(dx, dz), dirToPitch(dx, dy, dz));
    },
    press(action: InputAction, seconds?: number): void {
      ctx.input.pressVirtual(action, seconds);
    },
    move(x: number, y: number): void {
      ctx.input.setVirtualMove(x, y);
    },
    setCamera(position: [number, number, number], target: [number, number, number], fov?: number): void {
      const o = game.cameraOverride;
      o.active = true;
      o.position.set(position[0], position[1], position[2]);
      o.target.set(target[0], target[1], target[2]);
      o.fov = fov ?? 0;
      ctx.debug.freeCamera = true;
    },
    releaseCamera(): void {
      game.cameraOverride.active = false;
      ctx.debug.freeCamera = false;
    },
    setTimeOfDay(id: TimeOfDayId, seconds = 0): void {
      ctx.render.setTimeOfDay(id, seconds);
    },
    hideUi(on: boolean): void {
      ctx.debug.hideUi = on;
      ctx.uiRoot.style.visibility = on ? 'hidden' : '';
    },
    setQuality(setting: QualitySetting): void {
      ctx.render.setQuality(setting);
    },
    damagePlayer(amount: number): void {
      clearDamageInfo(damage);
      damage.amount = amount;
      damage.type = 'hazard';
      damage.faction = 'neutral';
      damage.weapon = 'world';
      damage.point.copy(ctx.player.center);
      ctx.combat.applyDamage(ctx.player.targetId, damage);
    },
    choosePerk(index: number): boolean {
      return ctx.director.choosePerk(index);
    },
    givePerk(id: PerkId): boolean {
      return ctx.director.grantPerk(id);
    },
    overclock(): boolean {
      ctx.player.addOverclockCharge(1000);
      return ctx.player.activateOverclock();
    },
    unlockZone(zone: ZoneId): void {
      ctx.world.unlockZone(zone);
    },
    ui(screen: UiScreen | null): void {
      ctx.ui.debugShow(screen);
    },
    fx(id: FxId, x: number, y: number, z: number): void {
      ctx.fx.spawn(id, { x, y, z });
    },
    sound(id: SoundId): void {
      ctx.audio.play(id);
    },
    budget(): Record<string, Budget> {
      const out: Record<string, Budget> = {};
      const add = (prefix: string, scene: THREE.Scene): void => {
        for (const root of scene.children) {
          const key = prefix + (root.name || '(unnamed)');
          const entry = out[key] ?? (out[key] = { visibleMeshes: 0, triangles: 0 });
          countDrawables(root, entry);
        }
      };
      add('', ctx.scene);
      add('view:', ctx.viewScene);
      return out;
    },
    bot(on: boolean, opts?: BotOptions): void {
      bot.setEnabled(on, opts);
      game.botUpdate = on ? bot.update : null;
    },
  };

  window.__SH = api;
  return api;
}

/** Last-resort reporter for failures before the game object exists (main.ts). */
export function reportBootFailure(error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  showFatalPanel(
    'Static Horizon could not start',
    'Something went wrong while loading the game. Reloading the page usually fixes this.',
    message,
  );
}
