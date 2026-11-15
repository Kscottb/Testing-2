import { clamp, clamp01 } from './math';
import type { TimeScaleSource, TimeState } from './types';

/** TimeState plus the mutators only core/game.ts may call. */
export interface TimeCore extends TimeState {
  /**
   * Advance one substep.
   * @param stepDt     real seconds of this substep (already clamped to MAX_STEP)
   * @param simulating world clock runs (menu / playing / gameover / victory)
   * @param playing    player clock runs (playing only)
   */
  advance(stepDt: number, simulating: boolean, playing: boolean): void;
  /** Record the wall-clock delta of the frame (once per frame, before the substeps). */
  beginFrame(realDt: number): void;
  /** Zero the run clocks and drop every time-scale request. */
  reset(): void;
}

const SOURCES: readonly TimeScaleSource[] = ['overclock', 'hitstop', 'slowmo', 'perkSelect', 'cinematic', 'debug'];
const HITSTOP_SCALE = 0.05;
const HITSTOP_MAX = 0.25;

export function createTime(): TimeCore {
  const scales: Record<TimeScaleSource, number> = {
    overclock: 1,
    hitstop: 1,
    slowmo: 1,
    perkSelect: 1,
    cinematic: 1,
    debug: 1,
  };
  /** Remaining real seconds per request; Infinity = until cleared; 0 = inactive. */
  const left: Record<TimeScaleSource, number> = {
    overclock: 0,
    hitstop: 0,
    slowmo: 0,
    perkSelect: 0,
    cinematic: 0,
    debug: 0,
  };

  const effective = (): number => {
    let s = 1;
    for (const source of SOURCES) {
      if (left[source] > 0 && scales[source] < s) s = scales[source];
    }
    return s;
  };

  const time: TimeCore = {
    now: 0,
    dt: 0,
    unscaledDt: 0,
    realDt: 1 / 60,
    elapsed: 0,
    scale: 1,
    frame: 0,
    runTime: 0,

    setScale(source: TimeScaleSource, scale: number, seconds?: number): void {
      scales[source] = clamp01(Number.isFinite(scale) ? scale : 1);
      left[source] = seconds === undefined ? Infinity : Math.max(0, seconds);
    },
    clearScale(source: TimeScaleSource): void {
      scales[source] = 1;
      left[source] = 0;
    },
    getScale(source: TimeScaleSource): number {
      return left[source] > 0 ? scales[source] : 1;
    },
    hitstop(seconds: number): void {
      const s = clamp(Number.isFinite(seconds) ? seconds : 0, 0, HITSTOP_MAX);
      if (s <= 0) return;
      scales.hitstop = HITSTOP_SCALE;
      left.hitstop = Math.max(left.hitstop === Infinity ? 0 : left.hitstop, s);
    },

    beginFrame(realDt: number): void {
      mutable.realDt = realDt;
      mutable.elapsed += realDt;
    },
    advance(stepDt: number, simulating: boolean, playing: boolean): void {
      const scale = simulating ? effective() : 0;
      mutable.scale = scale;
      mutable.dt = simulating ? stepDt * scale : 0;
      mutable.unscaledDt = playing && scale > 0 ? stepDt : 0;
      mutable.now += mutable.dt;
      mutable.runTime += mutable.unscaledDt;
      mutable.frame++;
      // Timed requests expire in real time, but only while the simulation runs (not while paused).
      if (simulating) {
        for (const source of SOURCES) {
          const remaining = left[source];
          if (remaining > 0 && remaining !== Infinity) {
            left[source] = Math.max(0, remaining - stepDt);
            if (left[source] === 0) scales[source] = 1;
          }
        }
      }
    },
    reset(): void {
      for (const source of SOURCES) {
        scales[source] = 1;
        left[source] = 0;
      }
      mutable.now = 0;
      mutable.dt = 0;
      mutable.unscaledDt = 0;
      mutable.scale = 1;
      mutable.runTime = 0;
    },
  };
  // The public interface is readonly; core mutates through this alias.
  const mutable = time as { -readonly [K in keyof TimeCore]: TimeCore[K] };
  return time;
}
