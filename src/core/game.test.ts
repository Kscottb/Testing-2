/**
 * core/game.ts with recording stand-ins for the ten systems: the lifecycle order, the frame pipeline,
 * the clocks and the error-containment rules documented at the top of core/types.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from './constants';
import { createContext } from './context';
import type { CoreContext } from './context';
import { createGame } from './game';
import type { GameCore } from './game';
import { installFakeDom } from './testkit';
import type { FakeDom } from './testkit';
import type { BestRecord, GameMode } from './types';

const NAMES = ['world', 'render', 'fx', 'audio', 'combat', 'player', 'weapons', 'enemies', 'director', 'ui'] as const;
type Name = (typeof NAMES)[number];
type Overrides = Partial<Record<Name, Record<string, unknown>>>;

interface Rig {
  ctx: CoreContext;
  game: GameCore;
  /** Every recorded call in order: 'init:world', 'update:player', 'late:player', 'render', ... */
  log: string[];
  /** The dt each system's update() received last. */
  dts: Partial<Record<Name, number>>;
  /** What the fake UI answers to core's two questions. */
  ui: { wantsPointer: boolean; consumesPause: boolean };
}

let dom: FakeDom;
let rigs: Rig[];

/** A context whose systems only record what core does with them; `overrides` replaces single methods. */
function rig(overrides: Overrides = {}): Rig {
  const log: string[] = [];
  const dts: Partial<Record<Name, number>> = {};
  const ui = { wantsPointer: false, consumesPause: false };
  const ctx = createContext({
    canvas: dom.canvas as unknown as HTMLCanvasElement,
    uiRoot: { style: {} } as unknown as HTMLElement,
    testMode: true,
    onEventError: () => undefined,
  });
  const game = createGame(ctx);
  ctx.game = game;
  const extras: Overrides = {
    world: { navHints: () => ({}) },
    render: { render: () => log.push('render'), resize: () => log.push('resize'), warm: () => log.push('warm'), width: 1280, height: 720 },
    audio: { unlock: () => log.push('unlock') },
    player: { lateUpdate: () => log.push('late:player') },
    director: { startRun: () => log.push('startRun'), stats: { grade: 'B' }, score: 1234, wave: 3 },
    ui: { wantsPointer: () => ui.wantsPointer, consumesPauseAction: () => ui.consumesPause, showFatal: () => log.push('showFatal') },
  };
  const slots = ctx as unknown as Record<string, unknown>;
  slots.collision = {};
  slots.nav = { build: () => log.push('nav:build') };
  for (const name of NAMES) {
    slots[name] = {
      init: () => log.push(`init:${name}`),
      reset: () => log.push(`reset:${name}`),
      update: (dt: number) => {
        log.push(`update:${name}`);
        dts[name] = dt;
      },
      dispose: () => undefined,
      ...extras[name],
      ...overrides[name],
    };
  }
  const made = { ctx, game, log, dts, ui };
  rigs.push(made);
  return made;
}

/** A booted rig sitting in the menu with an empty log. */
async function booted(overrides: Overrides = {}): Promise<Rig> {
  const made = rig(overrides);
  await made.game.boot();
  made.log.length = 0;
  return made;
}

/** A booted rig in a running game with an empty log. */
async function playing(overrides: Overrides = {}): Promise<Rig> {
  const made = await booted(overrides);
  made.game.startRun('veteran');
  made.log.length = 0;
  return made;
}

const count = (log: string[], entry: string): number => log.filter((line) => line === entry).length;
const boom = (): never => {
  throw new Error('boom');
};
const FRAME_TAIL = ['update:render', 'update:audio', 'update:ui', 'render'];

beforeEach(() => {
  dom = installFakeDom();
  rigs = [];
  // Every contained error is also printed: keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const made of rigs) made.game.dispose();
  dom.restore();
  vi.restoreAllMocks();
});

describe('lifecycle', () => {
  it('initialises in order, builds the nav grid right after the world, warms shaders last, resets audio first', async () => {
    const { game, log } = rig();
    expect(game.mode).toBe('boot');
    await game.boot();
    expect(game.mode).toBe('menu');
    expect(log.filter((line) => line.startsWith('init:') || line === 'nav:build')).toEqual([
      'init:world',
      'nav:build',
      'init:render',
      'init:fx',
      'init:audio',
      'init:combat',
      'init:player',
      'init:weapons',
      'init:enemies',
      'init:director',
      'init:ui',
    ]);
    // Both scenes are warmed once, after the last init and before the first reset.
    expect(count(log, 'warm')).toBe(2);
    expect(log.indexOf('warm')).toBeGreaterThan(log.indexOf('init:ui'));
    expect(log.indexOf('warm')).toBeLessThan(log.indexOf('reset:audio'));
    expect(log.filter((line) => line.startsWith('reset:'))).toEqual([
      'reset:audio',
      'reset:world',
      'reset:render',
      'reset:fx',
      'reset:combat',
      'reset:player',
      'reset:weapons',
      'reset:enemies',
      'reset:director',
      'reset:ui',
    ]);
  });

  it('a failing init is fatal for every system, sound included', async () => {
    const { game, log } = rig({ audio: { init: boom } });
    await expect(game.boot()).rejects.toThrow('boom');
    expect(game.fatal).toBe(true);
    expect(game.errors[0]?.source).toBe('init:audio');
    // Nothing after the broken system was initialised, and the game never leaves boot.
    expect(log).not.toContain('init:combat');
    expect(game.mode).toBe('boot');
    game.startRun('veteran');
    expect(game.mode).toBe('boot');
  });

  it('startRun unlocks audio, resets everything, starts the director and reports every mode change', async () => {
    const modes: string[] = [];
    const events: string[] = [];
    const { ctx, game, log } = await booted({
      player: { onModeChange: (mode: GameMode, prev: GameMode) => modes.push(`${prev}>${mode}`) },
    });
    ctx.events.on('game:mode', (e) => events.push(`${e.prev}>${e.mode}`));
    ctx.events.on('run:start', (e) => events.push(`run ${e.runIndex} ${e.difficulty}`));
    ctx.time.setScale('overclock', 0.4);
    ctx.mods.damageMul = 5;
    game.startRun('nightmare');
    expect(log[0]).toBe('unlock');
    expect(log.slice(1, 3)).toEqual(['reset:audio', 'reset:world']);
    expect(log[log.length - 1]).toBe('startRun');
    // Core resets its own state before the systems: clock, modifiers, virtual input.
    expect(ctx.time.scale).toBe(1);
    expect(ctx.time.getScale('overclock')).toBe(1);
    expect(ctx.mods.damageMul).toBe(1);
    expect(game.mode).toBe('playing');
    expect(game.difficulty).toBe('nightmare');
    expect(ctx.settings.data.difficulty).toBe('nightmare');
    expect(game.runIndex).toBe(1);
    // A restart while playing still notifies everyone.
    game.restart();
    expect(game.runIndex).toBe(2);
    expect(modes).toEqual(['boot>menu', 'menu>playing', 'playing>playing']);
    expect(events).toEqual(['menu>playing', 'run 1 nightmare', 'playing>playing', 'run 2 nightmare']);
    game.toMenu();
    expect(game.mode).toBe('menu');
    expect(modes[modes.length - 1]).toBe('playing>menu');
  });

  it('endRun works from playing only, stores the record and emits run:end', async () => {
    const { ctx, game } = await booted();
    const ends: { victory: boolean; score: number; wave: number; newBestScore: boolean; newBestWave: boolean }[] = [];
    ctx.events.on('run:end', (e) => ends.push({ victory: e.victory, score: e.score, wave: e.wave, newBestScore: e.newBestScore, newBestWave: e.newBestWave }));
    game.endRun(true);
    expect(game.mode).toBe('menu');
    game.startRun('veteran');
    game.endRun(true);
    expect(game.mode).toBe('victory');
    expect(ends).toEqual([{ victory: true, score: 1234, wave: 3, newBestScore: true, newBestWave: true }]);
    expect(game.best).toEqual({ score: 1234, wave: 3, grade: 'B', runs: 1, victories: 1 });
    expect(ctx.storage.getJson<Partial<BestRecord>>(STORAGE_KEYS.BEST, {}).score).toBe(1234);
    // A second call (the other end-of-run event arriving late) changes nothing.
    game.endRun(false);
    expect(game.mode).toBe('victory');
    expect(ends.length).toBe(1);
    game.restart();
    game.endRun(false);
    expect(game.mode).toBe('gameover');
    expect(ends[1]).toEqual({ victory: false, score: 1234, wave: 3, newBestScore: false, newBestWave: false });
    expect(game.best.runs).toBe(2);
    expect(game.best.victories).toBe(1);
  });
});

describe('frame pipeline', () => {
  it('updates the systems in the documented order, each on its clock', async () => {
    const { ctx, game, log, dts } = await playing();
    game.frame(1 / 60);
    expect(log).toEqual([
      'update:player',
      'update:weapons',
      'update:enemies',
      'update:combat',
      'update:world',
      'update:director',
      'update:fx',
      'late:player',
      ...FRAME_TAIL,
    ]);
    // Overclock: the world slows down, the player and the presentation do not.
    ctx.time.setScale('overclock', 0.4);
    game.frame(1 / 60);
    for (const name of ['player', 'weapons', 'render', 'audio', 'ui'] as const) expect(dts[name]).toBeCloseTo(1 / 60, 9);
    for (const name of ['enemies', 'combat', 'world', 'director', 'fx'] as const) expect(dts[name]).toBeCloseTo(0.4 / 60, 9);
    expect(ctx.time.playerDt).toBeCloseTo(1 / 60, 9);
    expect(ctx.time.realDt).toBeCloseTo(1 / 60, 9);
  });

  it('splits long frames into at most three substeps of at most 1/30 s; render, audio and ui run once', async () => {
    const { ctx, game, log, dts } = await playing();
    game.frame(0.05);
    expect(count(log, 'update:player')).toBe(2);
    expect(dts.player).toBeCloseTo(0.025, 9);
    expect(count(log, 'update:render')).toBe(1);
    expect(dts.render).toBeCloseTo(0.05, 9);
    expect(ctx.time.substeps).toBe(2);
    // A hitch is clamped to 0.1 s of simulation.
    log.length = 0;
    const before = ctx.time.now;
    game.frame(2);
    expect(count(log, 'update:player')).toBe(3);
    expect(count(log, 'late:player')).toBe(3);
    expect(count(log, 'render')).toBe(1);
    expect(ctx.time.now - before).toBeCloseTo(0.1, 9);
    // Broken deltas never reach a system.
    game.frame(Number.NaN);
    expect(dts.player).toBe(0);
    // render: false skips the draw only (fast manual stepping).
    log.length = 0;
    game.frame(1 / 60, false);
    expect(log).toContain('update:ui');
    expect(log).not.toContain('render');
  });

  it('runs only what each mode allows', async () => {
    const { ctx, game, log } = await playing();
    game.pause();
    game.frame(1 / 60);
    expect(log).toEqual(FRAME_TAIL);
    expect(ctx.time.dt).toBe(0);
    expect(ctx.time.unscaledDt).toBe(0);

    game.resume();
    game.endRun(false);
    log.length = 0;
    game.frame(1 / 60);
    expect(log).toEqual(['update:enemies', 'update:combat', 'update:world', 'update:fx', ...FRAME_TAIL]);
    // The player clock follows the world clock once the run is over (corpses, late projectiles).
    expect(ctx.time.unscaledDt).toBe(0);
    expect(ctx.time.playerDt).toBeCloseTo(1 / 60, 9);

    game.toMenu();
    log.length = 0;
    game.frame(1 / 60);
    expect(log).toEqual(['update:world', 'update:fx', ...FRAME_TAIL]);
  });

  it('hard freeze: only the director runs, once per frame, with dt 0', async () => {
    const { ctx, game, log, dts } = await playing();
    ctx.time.setScale('perkSelect', 0);
    const before = ctx.time.now;
    game.frame(0.1);
    expect(log).toEqual(['update:director', ...FRAME_TAIL]);
    expect(dts.director).toBe(0);
    expect(ctx.time.now).toBe(before);
    expect(ctx.time.scale).toBe(0);
    // Pausing on top of the freeze stops the director too and keeps the scale.
    game.pause();
    log.length = 0;
    game.frame(0.1);
    expect(log).toEqual(FRAME_TAIL);
    expect(ctx.time.scale).toBe(0);
    game.resume();
    ctx.time.clearScale('perkSelect');
    log.length = 0;
    game.frame(1 / 60);
    expect(log[0]).toBe('update:player');
  });

  it('shows input edges to the first substep and to the presentation, never to later substeps', async () => {
    const seen: boolean[] = [];
    let uiSaw = false;
    const made = await playing({
      player: { update: () => seen.push(made.ctx.input.justPressed('jump')) },
      ui: { update: () => (uiSaw = made.ctx.input.justPressed('jump')) },
    });
    const { ctx, game } = made;
    ctx.input.pressVirtual('jump');
    game.frame(0.1);
    expect(seen).toEqual([true, false, false]);
    expect(uiSaw).toBe(true);
    game.frame(1 / 60);
    expect(seen[3]).toBe(false);
    expect(uiSaw).toBe(false);
  });

  it('applies a pending resize at the start of a frame and announces it', async () => {
    const { ctx, game, log } = await playing();
    const sizes: string[] = [];
    ctx.events.on('view:resize', (e) => sizes.push(`${e.width}x${e.height}`));
    game.frame(1 / 60);
    expect(log).not.toContain('resize');
    dom.window.dispatch('resize');
    expect(log).not.toContain('resize');
    game.frame(1 / 60);
    expect(count(log, 'resize')).toBe(1);
    expect(log.indexOf('resize')).toBeLessThan(log.lastIndexOf('update:player'));
    expect(sizes).toEqual(['1280x720']);
  });
});

describe('pause and pointer policy', () => {
  it('the pause action toggles pause unless the UI consumes it', async () => {
    const { ctx, game, ui } = await playing();
    ctx.input.pressVirtual('pause');
    game.frame(1 / 60);
    expect(game.mode).toBe('paused');
    ctx.input.pressVirtual('pause');
    game.frame(1 / 60);
    expect(game.mode).toBe('playing');
    // A nested panel swallows the action itself.
    ui.consumesPause = true;
    ctx.input.pressVirtual('pause');
    game.frame(1 / 60);
    expect(game.mode).toBe('playing');
  });

  it('pauses when the pointer is taken away, and a pause key right behind that does not resume', async () => {
    const { ctx, game } = await playing();
    // Deliberate releases (the UI took the pointer) never pause.
    ctx.events.emit('input:capture', { captured: false, intentional: true });
    expect(game.mode).toBe('playing');
    ctx.events.emit('input:capture', { captured: false, intentional: false });
    expect(game.mode).toBe('paused');
    // The Esc that dropped the pointer lock often arrives as a key press too.
    ctx.input.pressVirtual('pause');
    game.frame(1 / 60);
    expect(game.mode).toBe('paused');
    for (let i = 0; i < 3; i++) game.frame(0.1);
    ctx.input.pressVirtual('pause');
    game.frame(1 / 60);
    expect(game.mode).toBe('playing');
  });

  it('keeps the pointer captured while playing unless the UI wants it', async () => {
    const { ctx, game, ui } = await booted();
    expect(ctx.input.wantsCapture).toBe(false);
    game.startRun('veteran');
    expect(ctx.input.wantsCapture).toBe(true);
    ui.wantsPointer = true;
    game.frame(1 / 60);
    expect(ctx.input.wantsCapture).toBe(false);
    ui.wantsPointer = false;
    game.frame(1 / 60);
    expect(ctx.input.wantsCapture).toBe(true);
    game.pause();
    expect(ctx.input.wantsCapture).toBe(false);
    game.resume();
    expect(ctx.input.wantsCapture).toBe(true);
    game.endRun(true);
    expect(ctx.input.wantsCapture).toBe(false);
  });
});

describe('error containment', () => {
  it('a throwing system is recorded and the frame carries on; ten failures in a row are fatal', async () => {
    const { ctx, game, log } = await playing({ player: { update: boom } });
    const reported: boolean[] = [];
    ctx.events.on('game:error', (e) => reported.push(e.fatal));
    for (let i = 0; i < 9; i++) game.frame(1 / 60);
    expect(game.fatal).toBe(false);
    expect(game.errors.length).toBe(9);
    expect(game.errors[0]?.source).toBe('update:player');
    expect(game.errors[0]?.message).toBe('boom');
    expect(count(log, 'update:weapons')).toBe(9);
    expect(count(log, 'render')).toBe(9);
    game.frame(1 / 60);
    expect(game.fatal).toBe(true);
    expect(log).toContain('showFatal');
    expect(reported).toEqual([...Array<boolean>(9).fill(false), true]);
    // The loop is dead: nothing runs any more, and no run can be started.
    const size = log.length;
    game.frame(1 / 60);
    game.startRun('veteran');
    expect(log.length).toBe(size);
  });

  it('a success resets the streak, but thirty failures in total are fatal as well', async () => {
    let calls = 0;
    const { game } = await playing({
      player: {
        update: () => {
          if (calls++ % 2 === 0) boom();
        },
      },
    });
    for (let i = 0; i < 57; i++) game.frame(1 / 60);
    expect(game.errors.length).toBe(29);
    expect(game.fatal).toBe(false);
    game.frame(1 / 60);
    game.frame(1 / 60);
    expect(game.errors.length).toBe(30);
    expect(game.fatal).toBe(true);
  });

  it('sound and particles never take the game down: after three failures the call is no longer made', async () => {
    let fxCalls = 0;
    let audioCalls = 0;
    const { game, log } = await playing({
      fx: { update: () => (fxCalls++, boom()) },
      audio: { update: () => (audioCalls++, boom()), unlock: boom },
    });
    for (let i = 0; i < 40; i++) game.frame(1 / 60);
    expect(game.fatal).toBe(false);
    expect(fxCalls).toBe(3);
    expect(audioCalls).toBe(3);
    const sources = game.errors.map((e) => e.source);
    expect(sources.filter((source) => source.startsWith('update:')).sort()).toEqual(['update:audio', 'update:audio', 'update:audio', 'update:fx', 'update:fx', 'update:fx']);
    expect(count(log, 'update:ui')).toBe(40);
    // A broken unlock() (it already failed once when this run started) is tried three times, then left alone.
    expect(sources.filter((source) => source === 'unlock:audio').length).toBe(1);
    for (let i = 0; i < 5; i++) game.restart();
    expect(game.fatal).toBe(false);
    expect(game.errors.filter((e) => e.source === 'unlock:audio').length).toBe(3);
    expect(game.mode).toBe('playing');
  });

  it('reportError: thirty reports from one source are fatal, except for audio and fx', async () => {
    const { game } = await playing();
    for (let i = 0; i < 29; i++) game.reportError('enemy:tick', new Error('broken tick'));
    for (let i = 0; i < 60; i++) game.reportError(i % 2 === 0 ? 'audio' : 'fx', 'cosmetic');
    for (let i = 0; i < 29; i++) game.reportError('projectile:rocket', { odd: true });
    expect(game.fatal).toBe(false);
    game.reportError('enemy:tick', new Error('broken tick'));
    expect(game.fatal).toBe(true);
  });

  it('reportError with the fatal flag stops the game at once', async () => {
    const { game, log } = await playing();
    game.reportError('render', new Error('context lost'), true);
    expect(game.fatal).toBe(true);
    expect(log).toContain('showFatal');
  });
});
