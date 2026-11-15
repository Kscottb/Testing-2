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

/** A system call that throws this many times in a row is fatal. */
const CONSECUTIVE_FAILURES_FATAL = 10;
/** A call (or a reportError source) that keeps failing now and then is still fatal after this many failures. */
const TOTAL_FAILURES_FATAL = 30;
/** Calls that can never be fatal (see isSoft) are simply no longer made after this many failures. */
const SOFT_FAILURES_DISABLE = 3;
const MAX_RECORDED_ERRORS = 200;
/** Seconds after an automatic pause during which the pause action cannot resume. */
const PAUSE_TOGGLE_GUARD = 0.25;

/**
 * Sound, particles, the bot and a resize may never take the game down: a WebAudio or particle bug costs
 * sound or sparks, not the run. (Failures during init are a different matter and stay fatal.)
 */
function isSoft(key: string): boolean {
  return (
    key === 'audio' ||
    key === 'fx' ||
    key.endsWith(':audio') ||
    key.endsWith(':fx') ||
    key === 'update:bot' ||
    key === 'resize:render'
  );
}

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
  /** Soft calls that failed too often and are no longer made. */
  const disabled = new Set<string>();
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
  /** The canvas changed size: applied at the start of the next frame, never between a draw and its paint. */
  let resizePending = true;

  const storedBest = ctx.storage.getJson<Partial<BestRecord>>(STORAGE_KEYS.BEST, {});
  const best: BestRecord = {
    score: Number.isFinite(storedBest.score) ? Math.max(0, Number(storedBest.score)) : 0,
    wave: Number.isFinite(storedBest.wave) ? Math.max(0, Number(storedBest.wave)) : 0,
    grade: typeof storedBest.grade === 'string' ? storedBest.grade : '',
    runs: Number.isFinite(storedBest.runs) ? Math.max(0, Number(storedBest.runs)) : 0,
    victories: Number.isFinite(storedBest.victories) ? Math.max(0, Number(storedBest.victories)) : 0,
  };

  /** Lifecycle order (init, onModeChange, dispose in reverse). */
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

  /**
   * Reset order: audio FIRST (its stopAll must not kill what the other systems set up in their own
   * reset), then the lifecycle order.
   */
  const resetOrder = (): [string, System][] => {
    const list = systems();
    return [...list.filter(([name]) => name === 'audio'), ...list.filter(([name]) => name !== 'audio')];
  };

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
      return;
    }
    // Errors reported by the systems themselves (one broken enemy, one event handler) count per source:
    // a source that keeps failing is as fatal as a system call that does — unless it is sound or fx.
    const total = (failTotal.get(source) ?? 0) + 1;
    failTotal.set(source, total);
    if (total >= TOTAL_FAILURES_FATAL && !isSoft(source)) raiseFatal(source, entry.message, entry.stack);
    else events.emit('game:error', { source, message: entry.message, fatal: false });
  };

  /** A contained system exception: record it, escalate when the same call keeps failing. */
  const contain = (key: string, error: unknown): void => {
    const streak = (failStreak.get(key) ?? 0) + 1;
    const total = (failTotal.get(key) ?? 0) + 1;
    failStreak.set(key, streak);
    failTotal.set(key, total);
    const entry = recordError(key, error);
    if (isSoft(key)) {
      if (total >= SOFT_FAILURES_DISABLE) disabled.add(key);
      events.emit('game:error', { source: key, message: entry.message, fatal: false });
      return;
    }
    if (streak >= CONSECUTIVE_FAILURES_FATAL || total >= TOTAL_FAILURES_FATAL) raiseFatal(key, entry.message, entry.stack);
    else events.emit('game:error', { source: key, message: entry.message, fatal: false });
  };

  const ok = (key: string): void => {
    if (failStreak.size > 0 && failStreak.has(key)) failStreak.delete(key);
  };

  const skip = (key: string): boolean => disabled.size > 0 && disabled.has(key);

  /** Contained call for the rare paths (mode changes, resets, unlock). Hot paths spell the try/catch out. */
  const guarded = (key: string, fn: () => void): void => {
    if (skip(key)) return;
    try {
      fn();
      ok(key);
    } catch (error) {
      contain(key, error);
    }
  };

  /** `key` is the full error source, e.g. 'update:player' (literal strings: no per-frame allocation). */
  const update = (key: string, system: System, dt: number): void => {
    if (skip(key)) return;
    try {
      system.update(dt);
      ok(key);
    } catch (error) {
      contain(key, error);
    }
  };

  const late = (key: string, system: System, dt: number): void => {
    if (!system.lateUpdate || skip(key)) return;
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
      const wants = ctx.ui.wantsPointer();
      ok('wantsPointer:ui');
      return wants;
    } catch (error) {
      contain('wantsPointer:ui', error);
      return true;
    }
  };

  const uiConsumesPause = (): boolean => {
    try {
      const consumes = ctx.ui.consumesPauseAction();
      ok('consumesPauseAction:ui');
      return consumes;
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
      guarded(`onModeChange:${name}`, () => system.onModeChange?.(next, prev));
    }
    events.emit('game:mode', { mode: next, prev });
    applyPointerPolicy();
  };

  const resetAll = (): void => {
    time.reset();
    resetModifiers(ctx.mods);
    input.clearVirtual();
    for (const [name, system] of resetOrder()) {
      guarded(`reset:${name}`, () => system.reset());
    }
  };

  const unlockAudio = (): void => {
    guarded('unlock:audio', () => ctx.audio.unlock());
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
    guarded('startRun:director', () => ctx.director.startRun(next));
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
  const simulate = (firstSubstep: boolean): void => {
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
      } else if (firstSubstep) {
        // Hard freeze (perk select): only the director runs, once per FRAME — it polls input edges,
        // which exist in the first substep only, and must not see one frame as several.
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

  const requestResize = (): void => {
    resizePending = true;
  };

  /**
   * Resizing reallocates the drawing buffer, which clears it: doing that inside the ResizeObserver
   * callback (after the frame was drawn, before it is painted) would present a blank frame.
   */
  const applyResize = (): void => {
    resizePending = false;
    if (fatal || skip('resize:render')) return;
    try {
      ctx.render.resize();
      ok('resize:render');
    } catch (error) {
      contain('resize:render', error);
      return;
    }
    events.emit('view:resize', { width: ctx.render.width, height: ctx.render.height });
  };

  const frame = (realDtIn: number, render = true): void => {
    if (fatal || mode === 'boot') return;
    const realDt = clamp(Number.isFinite(realDtIn) ? realDtIn : 0, 0, MAX_FRAME_DT);
    time.beginFrame(realDt);
    if (resizePending) applyResize();

    if (game.botUpdate && !skip('update:bot')) {
      try {
        game.botUpdate(realDt);
        ok('update:bot');
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
      time.advance(stepDt, isSimulating(), mode === 'playing', i, steps);
      simulate(i === 0);
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
    if (resizePending) applyResize();
    draw();
  };

  // --- boot -----------------------------------------------------------------------------------
  const onInputCapture = (e: { captured: boolean; intentional: boolean }): void => {
    if (e.intentional || mode !== 'playing') return;
    autoPausedAt = time.elapsed;
    pause();
  };

  /**
   * Every user gesture (re)unlocks audio: a context created outside a qualifying gesture stays
   * suspended, and which event grants activation differs per browser (pointerup / touchend / click on
   * iOS, pointerdown / keydown elsewhere).
   */
  const onGesture = (): void => {
    if (booted && !fatal) unlockAudio();
  };
  const GESTURE_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;

  /** Let the browser paint. setTimeout rather than rAF so hidden tabs and manual stepping still boot. */
  const nextTask = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const boot = async (): Promise<void> => {
    const list = systems();
    const total = list.length + 2;
    let done = 0;
    for (const [name, system] of list) {
      setBootProgress(`Initialising ${name}`, done / total);
      // Awaiting a synchronous init() only yields a microtask: without a real task boundary the
      // boot bar would never repaint between systems.
      await nextTask();
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

    // Every system has built its meshes by now (also the pooled, hidden ones): compile all shaders
    // once so nothing compiles in the middle of a fight.
    setBootProgress('Warming up', done / total);
    await nextTask();
    guarded('warm:render', () => {
      ctx.render.warm(ctx.scene, 'world');
      ctx.render.warm(ctx.viewScene, 'view');
    });
    setBootProgress('Ready', 1);

    events.on('input:capture', onInputCapture);
    window.addEventListener('resize', requestResize);
    for (const name of GESTURE_EVENTS) window.addEventListener(name, onGesture);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(requestResize);
      resizeObserver.observe(ctx.canvas);
    }
    applyResize();

    resetAll();
    booted = true;
    setMode('menu');
    if (fatal) throw new Error('boot failed');
    hideBootScreen(ctx.testMode);
  };

  const dispose = (): void => {
    window.removeEventListener('resize', requestResize);
    for (const name of GESTURE_EVENTS) window.removeEventListener(name, onGesture);
    events.off('input:capture', onInputCapture);
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = null;
    ctx.settings.flush();
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
