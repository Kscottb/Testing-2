import * as THREE from 'three';
import { createEventBus } from './events';
import { createInput } from './input';
import { makeModifiers } from './make';
import { createRng } from './rng';
import { createSettings } from './settings';
import { createStorage } from './storage';
import { createTime } from './time';
import type { TimeCore } from './time';
import type { DebugFlags, Game, GameContext } from './types';

export interface ContextOptions {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  /** Automation mode (opt-in, see GameContext.testMode): manual stepping, fixed seeds, no pointer lock. */
  testMode: boolean;
  /** Receives exceptions thrown by event handlers. */
  onEventError: (eventName: string, error: unknown) => void;
}

/** GameContext as core sees it: the clock is mutable and `game` is attached right after creation. */
export interface CoreContext extends GameContext {
  readonly time: TimeCore;
  game: Game;
}

/**
 * Build the shared context: scenes, cameras and every core service. The system slots
 * (collision ... ui) are assigned by main.ts before anything is initialised.
 */
export function createContext(options: ContextOptions): CoreContext {
  const { canvas, uiRoot, testMode } = options;
  const aspect = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 16 / 9;

  const scene = new THREE.Scene();
  scene.name = 'world';
  const camera = new THREE.PerspectiveCamera(78, aspect, 0.1, 3000);
  camera.name = 'worldCamera';
  camera.rotation.order = 'YXZ';

  const viewScene = new THREE.Scene();
  viewScene.name = 'view';
  const viewCamera = new THREE.PerspectiveCamera(58, aspect, 0.01, 20);
  viewCamera.name = 'viewCamera';

  const events = createEventBus(options.onEventError);
  const storage = createStorage();
  const settings = createSettings(storage, events, testMode);
  const input = createInput({ canvas, events, settings, testMode });
  const debug: DebugFlags = {
    god: false,
    infiniteAmmo: false,
    freezeAi: false,
    freeCamera: false,
    hideUi: false,
    bot: false,
  };

  let idCounter = 0;
  const unset = null as unknown;

  const ctx = {
    scene,
    camera,
    viewScene,
    viewCamera,
    canvas,
    uiRoot,
    events,
    input,
    settings,
    storage,
    rng: createRng(testMode ? 0x51a71c : (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0),
    cosmeticRng: createRng(testMode ? 0xc05e71c : (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0),
    time: createTime(),
    mods: makeModifiers(),
    game: unset,
    debug,
    testMode,
    nextId: (): number => ++idCounter,
    collision: unset,
    nav: unset,
    world: unset,
    render: unset,
    player: unset,
    weapons: unset,
    combat: unset,
    enemies: unset,
    director: unset,
    fx: unset,
    audio: unset,
    ui: unset,
  } as CoreContext;
  return ctx;
}
