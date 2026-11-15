/**
 * Game state machine + frame pipeline + error containment. The ordering documented at the top of
 * core/types.ts is implemented here and nowhere else.
 */
import * as THREE from 'three';
import { MAX_FRAME_DT, MAX_STEP, MAX_SUBSTEPS, STORAGE_KEYS } from './constants';
import type { CoreContext } from './context';
import { hideBootScreen, setBootProgress, showFatalPanel } from './fatal';
import { resetModifiers } from './make';
import { clamp } from './math';
import type { BestRecord, DebugError, Difficulty, Game, GameMode, System } from './types';

/** Free camera used by window.__SH.setCamera (applied by the pipeline right before rendering). */
export interface CameraOverride {
  active: boolean;
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  /** Vertical FOV in degrees; 0 keeps the camera's current FOV. */
  fov: number;
}

/** The Game facade plus what only core (main.ts, loop.ts, debug.ts) may touch. */
export interface GameCore extends Game {
  /** Initialise every system in lifecycle order, then enter the menu. Rejects after a fatal error. */
  boot(): Promise<void>;
  /** Run one frame of the pipeline. `render` false skips the draw (fast manual stepping). */
  frame(realDt: number, render?: boolean): void;
  /** Draw without advancing anything (screenshots). */
  renderOnly(): void;
  /** True once a fatal error stopped the game. */
  readonly fatal: boolean;
  /** Every error recorded so far (window.__SH.errors is this array). */
  readonly errors: DebugError[];
  readonly cameraOverride: CameraOverride;
  /** Autopilot hook called at the start of every frame (before input.poll). */
  botUpdate: ((realDt: number) => void) | null;
  /** Record an error without going through a system (window error handlers). */
  recordError(source: string, error: unknown): DebugError;
  dispose(): void;
}

const CONSECUTIVE_FAILURES_FATAL = 3;
/** A call that keeps failing now and then (never 3 in a row) is still fatal after this many failures. */
const TOTAL_FAILURES_FATAL = 30;
const MAX_RECORDED_ERRORS = 200;
/** Seconds after an automatic pause during which the pause action cannot resume. */
const PAUSE_TOGGLE_GUARD = 0.25;

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ?? '' };
  if (typeof error === 'string') return { message: error, stack: '' };
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: '' };
  } catch {
    return { message: String(error), stack: '' };
  }
}

export function createGame(ctx: CoreContext): GameCore {
  const { events, input, time } = ctx;
  const errors: DebugError[] = [];
  const failStreak = new Map<string, number>();
  const failTotal = new Map<string, number>();
  const cameraOverride: CameraOverride = {
    active: false,
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    fov: 0,
  };

  let mode: GameMode = 'boot';
  let difficulty: Difficulty = ctx.settings.data.difficulty;
  let runIndex = 0;
  let fatal = false;
  let fps = 60;
  let booted = false;
  let resizeObserver: ResizeObserver | null = null;
  let autoPausedAt = -Infinity;

  const storedBest = ctx.storage.getJson<Partial<BestRecord>>(STORAGE_KEYS.BEST, {});
  const best: BestRecord = {
    score: Number.isFinite(storedBest.score) ? Math.max(0, Number(storedBest.score)) : 0,
    wave: Number.isFinite(storedBest.wave) ? Math.max(0, Number(storedBest.wave)) : 0,
    grade: typeof storedBest.grade === 'string' ? storedBest.grade : '',
    runs: Number.isFinite(storedBest.runs) ? Math.max(0, Number(storedBest.runs)) : 0,
    victories: Number.isFinite(storedBest.victories) ? Math.max(0, Number(storedBest.victories)) : 0,
  };

  /** Lifecycle order (init, reset, onModeChange, dispose in reverse). */
  const systems = (): [string, System][] => [
    ['world', ctx.world],
    ['render', ctx.render],
    ['fx', ctx.fx],
    ['audio', ctx.audio],
    ['combat', ctx.combat],
    ['player', ctx.player],
    ['weapons', ctx.weapons],
    ['enemies', ctx.enemies],
    ['director', ctx.director],
    ['ui', ctx.ui],
  ];

  // --- errors ---------------------------------------------------------------------------------
  const recordError = (source: string, error: unknown): DebugError => {
    const { message, stack } = describe(error);
    const entry: DebugError = { source, message, stack, at: time.elapsed };
    if (errors.length < MAX_RECORDED_ERRORS) errors.push(entry);
    console.error(`[static-horizon] ${source}: ${message}`, error);
    return entry;
  };

  const raiseFatal = (source: string, message: string, stack: string): void => {
    if (fatal) return;
    fatal = true;
    try {
      input.releaseCapture();
    } catch {
      // Input is the least of our problems now.
    }
    const title = 'Static Horizon hit a problem';
    const text =
      source.startsWith('init') || !booted
        ? 'The game could not start. Reloading the page usually fixes this.'
        : 'The game ran into an error it could not recover from. Reload the page to play again.';
    showFatalPanel(title, text, `${source}: ${message}${stack ? `\n${stack}` : ''}`);
    try {
      if (ctx.ui) ctx.ui.showFatal(title, text);
    } catch {
      // The built-in panel is already visible.
    }
    try {
      events.emit('game:error', { source, message, fatal: true });
    } catch {
      // Never let reporting throw.
    }
  };

  const reportError = (source: string, error: unknown, isFatal = false): void => {
    const entry = recordError(source, error);
    if (isFatal) {
      raiseFatal(source, entry.message, entry.stack);
    } else {
      events.emit('game:error', { source, message: entry.message, fatal: false });
    }
  };

  /** A contained system exception: record it, escalate when the same call keeps failing. */
  const contain = (key: string, error: unknown): void => {
    const streak = (failStreak.get(key) ?? 0) + 1;
    const total = (failTotal.get(key) ?? 0) + 1;
    failStreak.set(key, streak);
    failTotal.set(key, total);
    const entry = recordError(key, error);
    if (streak >= CONSECUTIVE_FAILURES_FATAL || total >= TOTAL_FAILURES_FATAL) raiseFatal(key, entry.message, entry.stack);
    else events.emit('game:error', { source: key, message: entry.message, fatal: false });
  };

  const ok = (key: string): void => {
    if (failStreak.size > 0 && failStreak.has(key)) failStreak.delete(key);
  };

  /** `key` is the full error source, e.g. 'update:player' (literal strings: no per-frame allocation). */
  const update = (key: string, system: System, dt: number): void => {
    try {
      system.update(dt);
      ok(key);
    } catch (error) {
      contain(key, error);
    }
  };

  const late = (key: string, system: System, dt: number): void => {
    if (!system.lateUpdate) return;
    try {
      system.lateUpdate(dt);
      ok(key);
    } catch (error) {
      contain(key, error);
    }
  };

  // --- mode -----------------------------------------------------------------------------------
  const wantsPointer = (): boolean => {
    try {
      return ctx.ui.wantsPointer();
    } catch (error) {
      contain('wantsPointer:ui', error);
      return true;
    }
  };

  const uiConsumesPause = (): boolean => {
    try {
      return ctx.ui.consumesPauseAction();
    } catch (error) {
      contain('consumesPauseAction:ui', error);
      return false;
    }
  };

  const applyPointerPolicy = (): void => {
    if (mode === 'playing' && !wantsPointer()) {
      if (!input.wantsCapture) input.requestCapture();
    } else if (input.wantsCapture) {
      input.releaseCapture();
    }
  };

  const setMode = (next: GameMode, force = false): void => {
    if (next === mode && !force) return;
    const prev = mode;
    mode = next;
    for (const [name, system] of systems()) {
      if (!system.onModeChange) continue;
      try {
        system.onModeChange(next, prev);
      } catch (error) {
        contain(`onModeChange:${name}`, error);
      }
    }
    events.emit('game:mode', { mode: next, prev });
    applyPointerPolicy();
  };

  const resetAll = (): void => {
    time.reset();
    resetModifiers(ctx.mods);
    input.clearVirtual();
    for (const [name, system] of systems()) {
      try {
        system.reset();
      } catch (error) {
        contain(`reset:${name}`, error);
      }
    }
  };

  const unlockAudio = (): void => {
    try {
      ctx.audio.unlock();
    } catch (error) {
      contain('unlock:audio', error);
    }
  };

  // --- facade ---------------------------------------------------------------------------------
  const startRun = (next: Difficulty): void => {
    if (fatal || mode === 'boot') return;
    difficulty = next;
    runIndex++;
    ctx.settings.set('difficulty', next);
    ctx.rng.seed(ctx.testMode ? 0x51a71c + runIndex : (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0);
    unlockAudio();
    resetAll();
    try {
      ctx.director.startRun(next);
    } catch (error) {
      contain('startRun:director', error);
    }
    // Forced: a restart from 'playing' still notifies everyone (onModeChange('playing', 'playing')).
    setMode('playing', true);
    events.emit('run:start', { difficulty: next, runIndex });
  };

  const pause = (): void => {
    if (mode === 'playing') setMode('paused');
  };

  const resume = (): void => {
    if (mode === 'paused') setMode('playing');
  };

  const endRun = (victory: boolean): void => {
    if (mode !== 'playing') return;
    const stats = ctx.director.stats;
    const score = ctx.director.score;
    const wave = ctx.director.wave;
    const newBestScore = score > best.score;
    const newBestWave = wave > best.wave;
    best.runs++;
    if (victory) best.victories++;
    if (newBestScore) {
      best.score = score;
      best.grade = stats.grade;
    }
    if (newBestWave) best.wave = wave;
    ctx.storage.setJson(STORAGE_KEYS.BEST, best);
    setMode(victory ? 'victory' : 'gameover');
    events.emit('run:end', { victory, stats, score, wave, newBestScore, newBestWave });
  };

  const toMenu = (): void => {
    if (fatal || mode === 'boot') return;
    resetAll();
    setMode('menu');
  };

  // --- camera override ------------------------------------------------------------------------
  const applyCameraOverride = (): void => {
    ctx.debug.freeCamera = cameraOverride.active;
    if (!cameraOverride.active) return;
    const camera = ctx.camera;
    camera.position.copy(cameraOverride.position);
    camera.lookAt(cameraOverride.target);
    if (cameraOverride.fov > 0 && camera.fov !== cameraOverride.fov) {
      camera.fov = cameraOverride.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  };

  // --- pipeline -------------------------------------------------------------------------------
  const simulate = (): void => {
    const dt = time.dt;
    if (mode === 'playing') {
      if (time.scale > 0) {
        const pdt = time.unscaledDt;
        update('update:player', ctx.player, pdt);
        update('update:weapons', ctx.weapons, pdt);
        update('update:enemies', ctx.enemies, dt);
        update('update:combat', ctx.combat, dt);
        update('update:world', ctx.world, dt);
        update('update:director', ctx.director, dt);
        update('update:fx', ctx.fx, dt);
        late('lateUpdate:player', ctx.player, pdt);
        late('lateUpdate:weapons', ctx.weapons, pdt);
        late('lateUpdate:enemies', ctx.enemies, dt);
        late('lateUpdate:combat', ctx.combat, dt);
        late('lateUpdate:world', ctx.world, dt);
        late('lateUpdate:director', ctx.director, dt);
        late('lateUpdate:fx', ctx.fx, dt);
      } else {
        update('update:director', ctx.director, 0);
      }
    } else if (mode === 'gameover' || mode === 'victory') {
      update('update:enemies', ctx.enemies, dt);
      update('update:combat', ctx.combat, dt);
      update('update:world', ctx.world, dt);
      update('update:fx', ctx.fx, dt);
      late('lateUpdate:enemies', ctx.enemies, dt);
      late('lateUpdate:combat', ctx.combat, dt);
      late('lateUpdate:world', ctx.world, dt);
      late('lateUpdate:fx', ctx.fx, dt);
    } else if (mode === 'menu') {
      update('update:world', ctx.world, dt);
      update('update:fx', ctx.fx, dt);
      late('lateUpdate:world', ctx.world, dt);
      late('lateUpdate:fx', ctx.fx, dt);
    }
  };

  const isSimulating = (): boolean => mode === 'menu' || mode === 'playing' || mode === 'gameover' || mode === 'victory';

  const draw = (): void => {
    applyCameraOverride();
    try {
      ctx.render.render();
      ok('render:render');
    } catch (error) {
      contain('render:render', error);
    }
  };

  const frame = (realDtIn: number, render = true): void => {
    if (fatal || mode === 'boot') return;
    const realDt = clamp(Number.isFinite(realDtIn) ? realDtIn : 0, 0, MAX_FRAME_DT);
    time.beginFrame(realDt);

    if (game.botUpdate) {
      try {
        game.botUpdate(realDt);
      } catch (error) {
        contain('update:bot', error);
      }
    }

    input.poll(realDt);
    if (input.justPressed('pause') && !uiConsumesPause()) {
      // Some browsers deliver the Esc keydown that also dropped pointer lock (which already paused
      // us through 'input:capture'): ignore a resume request that arrives right behind a pause.
      if (mode === 'playing') pause();
      else if (mode === 'paused' && time.elapsed - autoPausedAt > PAUSE_TOGGLE_GUARD) resume();
    }
    applyPointerPolicy();
    ctx.uiRoot.style.visibility = ctx.debug.hideUi ? 'hidden' : '';

    const steps = isSimulating() ? clamp(Math.ceil(realDt / MAX_STEP - 1e-6), 1, MAX_SUBSTEPS) : 1;
    const stepDt = realDt / steps;
    for (let i = 0; i < steps; i++) {
      input.setEdgesVisible(i === 0);
      time.advance(stepDt, isSimulating(), mode === 'playing');
      simulate();
      if (fatal) return;
    }
    input.setEdgesVisible(true);

    applyCameraOverride();
    update('update:render', ctx.render, realDt);
    update('update:audio', ctx.audio, realDt);
    update('update:ui', ctx.ui, realDt);
    if (fatal) return;
    if (render) draw();
    input.endFrame();

    if (realDt > 0) fps += (1 / realDt - fps) * 0.05;
  };

  const renderOnly = (): void => {
    if (fatal || mode === 'boot') return;
    draw();
  };

  // --- boot -----------------------------------------------------------------------------------
  const resize = (): void => {
    if (fatal) return;
    try {
      ctx.render.resize();
      events.emit('view:resize', { width: ctx.render.width, height: ctx.render.height });
    } catch (error) {
      contain('resize:render', error);
    }
  };

  const onInputCapture = (e: { captured: boolean; intentional: boolean }): void => {
    if (e.intentional || mode !== 'playing') return;
    autoPausedAt = time.elapsed;
    pause();
  };

  const onFirstGesture = (): void => {
    if (booted && !fatal) unlockAudio();
  };

  const boot = async (): Promise<void> => {
    const list = systems();
    const total = list.length + 1;
    let done = 0;
    for (const [name, system] of list) {
      setBootProgress(`Initialising ${name}`, done / total);
      events.emit('boot:progress', { label: name, fraction: done / total });
      try {
        await system.init();
      } catch (error) {
        reportError(`init:${name}`, error, true);
        throw error;
      }
      if (name === 'world') {
        try {
          ctx.nav.build(ctx.collision, ctx.world.navHints());
        } catch (error) {
          reportError('init:nav', error, true);
          throw error;
        }
      }
      done++;
    }
    setBootProgress('Ready', 1);
    events.emit('boot:progress', { label: 'ready', fraction: 1 });

    events.on('input:capture', onInputCapture);
    window.addEventListener('resize', resize);
    window.addEventListener('pointerdown', onFirstGesture);
    window.addEventListener('keydown', onFirstGesture);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(ctx.canvas);
    }
    resize();

    resetAll();
    booted = true;
    setMode('menu');
    if (fatal) throw new Error('boot failed');
    hideBootScreen(ctx.testMode);
  };

  const dispose = (): void => {
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointerdown', onFirstGesture);
    window.removeEventListener('keydown', onFirstGesture);
    events.off('input:capture', onInputCapture);
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    for (const [name, system] of systems().reverse()) {
      try {
        system.dispose();
      } catch (error) {
        recordError(`dispose:${name}`, error);
      }
    }
    input.dispose();
  };

  const game: GameCore = {
    get mode(): GameMode {
      return mode;
    },
    get difficulty(): Difficulty {
      return difficulty;
    },
    get runIndex(): number {
      return runIndex;
    },
    best,
    get fps(): number {
      return fps;
    },
    startRun,
    restart(): void {
      startRun(difficulty);
    },
    pause,
    resume,
    endRun,
    toMenu,
    reportError,
    boot,
    frame,
    renderOnly,
    get fatal(): boolean {
      return fatal;
    },
    errors,
    cameraOverride,
    botUpdate: null,
    recordError,
    dispose,
  };
  return game;
}
