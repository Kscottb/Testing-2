/**
 * The shared frozen dead handles of the HANDLE RULE: returned when a pool is exhausted or the system is
 * not running; every call on them is a no-op for ever.
 */
import type { BeamHandle, TelegraphHandle, TrailHandle } from '../core/types';

export const DEAD_BEAM: BeamHandle = Object.freeze({
  active: false,
  set(): void {},
  setIntensity(): void {},
  setColor(): void {},
  stop(): void {},
});

export const DEAD_TELEGRAPH: TelegraphHandle = Object.freeze({
  active: false,
  setPosition(): void {},
  setRadius(): void {},
  setProgress(): void {},
  cancel(): void {},
});

export const DEAD_TRAIL: TrailHandle = Object.freeze({
  active: false,
  detach(): void {},
});
