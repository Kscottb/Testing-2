import type { GameCore } from './game';

export interface Loop {
  /** Begin ticking (no-op in manual mode apart from drawing one frame). */
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** True when the simulation only advances through window.__SH.step (`?test=1`). */
  readonly manual: boolean;
}

/**
 * requestAnimationFrame driver. In manual mode nothing is scheduled: tests advance the game with
 * window.__SH.step() and draw with renderFrame().
 */
export function createLoop(game: GameCore, manual: boolean): Loop {
  let running = false;
  let handle = 0;
  let last = 0;

  const tick = (now: number): void => {
    if (!running) return;
    if (game.fatal) {
      running = false;
      return;
    }
    const dt = last > 0 ? (now - last) / 1000 : 1 / 60;
    last = now;
    try {
      game.frame(dt, true);
    } catch (error) {
      // game.frame contains system errors itself; this only catches bugs in the pipeline.
      game.reportError('loop', error, true);
      running = false;
      return;
    }
    handle = requestAnimationFrame(tick);
  };

  return {
    start(): void {
      if (running) return;
      if (manual) {
        game.frame(0, true);
        return;
      }
      running = true;
      last = 0;
      handle = requestAnimationFrame(tick);
    },
    stop(): void {
      running = false;
      if (handle) cancelAnimationFrame(handle);
      handle = 0;
    },
    get running(): boolean {
      return running;
    },
    manual,
  };
}
