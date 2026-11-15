import { TIME_SCALE_SOURCES } from './constants';
import { clamp, clamp01 } from './math';
import type { TimeScaleSource, TimeState } from './types';

/** TimeState plus the mutators only core/game.ts may call. */
export interface TimeCore extends TimeState {
  /**
   * Advance one substep.
   * @param stepDt     real seconds of this substep (already clamped to MAX_STEP)
   * @param simulating world clock runs (menu / playing / gameover / victory)
   * @param playing    player clock runs (playing only)
   * @param substep    index of this substep within its frame (default 0)
   * @param substeps   number of substeps of the frame (default 1)
   */
  advance(stepDt: number, simulating: boolean, playing: boolean, substep?: number, substeps?: number): void;
  /** Record the wall-clock delta of the frame (once per frame, before the substeps). */
  beginFrame(realDt: number): void;
  /** Zero the run clocks and drop every time-scale request. */
  reset(): void;
}

const HITSTOP_SCALE = 0.05;
const HITSTOP_MAX = 0.25;

export function createTime(): TimeCore {
  const scales = {} as Record<TimeScaleSource, number>;
  /** Remaining real seconds per request; Infinity = until cleared; 0 = inactive. */
  const left = {} as Record<TimeScaleSource, number>;
  for (const source of TIME_SCALE_SOURCES) {
    scales[source] = 1;
    left[source] = 0;
  }

  const effective = (): number => {
    let s = 1;
    for (const source of TIME_SCALE_SOURCES) {
      if (left[source] > 0 && scales[source] < s) s = scales[source];
    }
    return s;
  };

  const time: TimeCore = {
    now: 0,
    dt: 0,
    unscaledDt: 0,
    playerDt: 0,
    realDt: 1 / 60,
    elapsed: 0,
    scale: 1,
    frame: 0,
    substep: 0,
    substeps: 1,
    runTime: 0,

    setScale(source: TimeScaleSource, scale: number, seconds?: number): void {
      scales[source] = clamp01(Number.isFinite(scale) ? scale : 1);
      left[source] = seconds === undefined ? Infinity : Math.max(0, Number.isFinite(seconds) ? seconds : 0);
      if (left[source] === 0) scales[source] = 1;
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
    advance(stepDt: number, simulating: boolean, playing: boolean, substep = 0, substeps = 1): void {
      // The scale is the minimum of the requests in EVERY mode (readers never see a fake 0 while paused);
      // the deltas are what stop when the clocks do.
      const scale = effective();
      mutable.scale = scale;
      mutable.dt = simulating ? stepDt * scale : 0;
      mutable.unscaledDt = playing && scale > 0 ? stepDt : 0;
      mutable.playerDt = playing ? mutable.unscaledDt : mutable.dt;
      mutable.now += mutable.dt;
      mutable.runTime += mutable.unscaledDt;
      mutable.frame++;
      mutable.substep = substep;
      mutable.substeps = substeps;
      // Timed requests expire in real time, but only while the simulation runs (not while paused).
      if (simulating) {
        for (const source of TIME_SCALE_SOURCES) {
          const remaining = left[source];
          if (remaining > 0 && remaining !== Infinity) {
            left[source] = Math.max(0, remaining - stepDt);
            if (left[source] === 0) scales[source] = 1;
          }
        }
      }
    },
    reset(): void {
      for (const source of TIME_SCALE_SOURCES) {
        scales[source] = 1;
        left[source] = 0;
      }
      mutable.now = 0;
      mutable.dt = 0;
      mutable.unscaledDt = 0;
      mutable.playerDt = 0;
      mutable.scale = 1;
      mutable.runTime = 0;
    },
  };
  // The public interface is readonly; core mutates through this alias.
  const mutable = time as { -readonly [K in keyof TimeCore]: TimeCore[K] };
  return time;
}
