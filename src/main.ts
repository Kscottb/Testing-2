/**
 * Bootstrap: build the context, create every system, boot the game, start the loop.
 * Nothing here depends on URL parameters in normal play; `?test=1` only switches the loop to manual
 * stepping for the automated tools.
 */
import { createAudioSystem } from './audio';
import { createCombatSystem } from './combat';
import { createBot } from './core/bot';
import { createContext } from './core/context';
import { createDebugApi, installErrorCapture, reportBootFailure } from './core/debug';
import { hasWebGL2, setBootProgress, showFatalPanel } from './core/fatal';
import { createGame } from './core/game';
import type { GameCore } from './core/game';
import { createLoop } from './core/loop';
import { createDirectorSystem } from './director';
import { createEnemySystem } from './enemies';
import { createFxSystem } from './fx';
import { createNavGrid } from './nav';
import { createCollisionWorld } from './physics';
import { createPlayerSystem } from './player';
import { createRenderSystem } from './render';
import { createUiSystem } from './ui';
import { createWeaponSystem } from './weapons';
import { createWorldSystem } from './world';

function isTestMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('test') === '1';
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game');
  const uiRoot = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !uiRoot) {
    throw new Error('index.html is missing #game or #ui');
  }

  if (!hasWebGL2()) {
    showFatalPanel(
      'Graphics not available',
      'Static Horizon needs WebGL 2, which this browser or device does not provide. ' +
        'Try a current version of Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is switched on.',
    );
    return;
  }

  const testMode = isTestMode();
  // The game object is needed by the event-error hook before it exists; late-bind it.
  let game: GameCore | null = null;
  const ctx = createContext({
    canvas,
    uiRoot,
    testMode,
    onEventError: (name, error) => {
      if (game) game.reportError(`event:${name}`, error);
      else console.error(`[static-horizon] event:${name}`, error);
    },
  });
  game = createGame(ctx);
  ctx.game = game;
  installErrorCapture(game);

  // Services first, then systems. Factories only store ctx; real work starts in init().
  ctx.collision = createCollisionWorld();
  ctx.nav = createNavGrid();
  ctx.world = createWorldSystem(ctx);
  ctx.render = createRenderSystem(ctx);
  ctx.fx = createFxSystem(ctx);
  ctx.audio = createAudioSystem(ctx);
  ctx.combat = createCombatSystem(ctx);
  ctx.player = createPlayerSystem(ctx);
  ctx.weapons = createWeaponSystem(ctx);
  ctx.enemies = createEnemySystem(ctx);
  ctx.director = createDirectorSystem(ctx);
  ctx.ui = createUiSystem(ctx);

  const loop = createLoop(game, testMode);
  const bot = createBot(ctx);
  const api = createDebugApi(ctx, game, loop, bot);

  setBootProgress('Powering up suit systems', 0);
  try {
    await game.boot();
  } catch {
    // game.boot already recorded the error and raised the fatal panel (window.__SH.fatal is true).
    return;
  }
  loop.start();
  api.ready = true;
}

main().catch((error: unknown) => {
  console.error('[static-horizon] boot failed', error);
  reportBootFailure(error);
});
