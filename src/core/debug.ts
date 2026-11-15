/**
 * window.__SH — the automation / debugging surface (see DebugApi in core/types.ts).
 */
import { ENEMIES } from '../data/enemies';
import type { Bot } from './bot';
import { WEAPON_IDS, ZONE_IDS } from './constants';
import type { CoreContext } from './context';
import { showFatalPanel } from './fatal';
import type { GameCore } from './game';
import type { Loop } from './loop';
import { makeDamageInfo } from './make';
import { dirToPitch, dirToYaw } from './math';
import type {
  BotOptions,
  DebugApi,
  DebugState,
  Difficulty,
  EnemyType,
  InputAction,
  QualityPreset,
  StepOptions,
  TimeOfDayId,
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

export function createDebugApi(ctx: CoreContext, game: GameCore, loop: Loop, bot: Bot): DebugApi {
  const damage = makeDamageInfo();

  const state = (): DebugState => {
    const { player, weapons, director, enemies, render, time, input } = ctx;
    const boss = enemies.boss;
    const offer = director.perkOffer;
    const unlocked: WeaponId[] = WEAPON_IDS.filter((id) => weapons.weapons[id].unlocked);
    const zones = {} as Record<ZoneId, boolean>;
    for (const id of ZONE_IDS) zones[id] = ctx.world.zone(id).unlocked;
    return {
      mode: game.mode,
      difficulty: game.difficulty,
      phase: director.phase,
      wave: director.wave,
      totalWaves: director.totalWaves,
      score: director.score,
      combo: director.combo.multiplier,
      enemiesAlive: enemies.aliveCount,
      enemiesRemaining: director.enemiesRemaining,
      pickups: director.pickups.length,
      projectiles: ctx.combat.projectileCount,
      boss: boss ? { hp: boss.hp, maxHp: boss.maxHp, phase: boss.phase } : null,
      perkOffer: offer ? [...offer] : null,
      player: {
        x: player.position.x,
        y: player.position.y,
        z: player.position.z,
        yaw: player.yaw,
        pitch: player.pitch,
        hp: player.hp,
        shield: player.shield,
        alive: player.alive,
        grounded: player.grounded,
        overclock: player.overclock.charge,
        overclockActive: player.overclock.active,
      },
      weapon: {
        id: weapons.current.id,
        mag: weapons.current.mag,
        reserve: weapons.current.reserve,
        reloading: weapons.current.reloading,
        unlocked,
      },
      grenades: weapons.grenades,
      stats: { ...director.stats, perks: [...director.stats.perks] },
      zones,
      timeOfDay: render.timeOfDay,
      quality: render.quality,
      lookMode: input.lookMode,
      device: input.device,
      fps: game.fps,
      drawCalls: render.stats.drawCalls,
      triangles: render.stats.triangles,
      simTime: time.now,
      frame: time.frame,
      timeScale: time.scale,
      errors: game.errors.length,
    };
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
      const handle = ctx.enemies.spawn(type, { x: px, y: py, z: pz }, { instant: true });
      return handle ? handle.id : -1;
    },
    killAll(): number {
      return ctx.enemies.killAll(false);
    },
    enemies() {
      return ctx.enemies.list.map((e) => ({
        id: e.id,
        type: e.type,
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
        hp: e.hp,
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
    setQuality(preset: QualityPreset): void {
      ctx.render.setQuality(preset);
    },
    damagePlayer(amount: number): void {
      damage.amount = amount;
      damage.type = 'hazard';
      damage.faction = 'neutral';
      damage.sourceId = 0;
      damage.weapon = 'world';
      damage.part = 'body';
      damage.critScale = 1;
      damage.point.copy(ctx.player.eye);
      damage.dir.set(0, 0, 0);
      damage.knockback = 0;
      damage.splash = false;
      damage.silent = false;
      ctx.combat.applyDamage(ctx.player.targetId, damage);
    },
    choosePerk(index: number): boolean {
      return ctx.director.choosePerk(index);
    },
    unlockZone(zone: ZoneId): void {
      ctx.world.unlockZone(zone);
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
