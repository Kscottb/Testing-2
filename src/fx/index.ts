// STUB: replaced by the fx team
import type { BeamHandle, FxSystem, GameContext, TelegraphHandle, TrailHandle, WeatherId } from '../core/types';

const DEAD_BEAM: BeamHandle = { active: false, set() {}, setIntensity() {}, setColor() {}, stop() {} };
const DEAD_TELEGRAPH: TelegraphHandle = { active: false, setPosition() {}, setRadius() {}, cancel() {} };
const DEAD_TRAIL: TrailHandle = { active: false, detach() {} };

/** Gray-box FX: every call is accepted and does nothing; handles are permanently dead. */
export function createFxSystem(ctx: GameContext): FxSystem {
  let weather: WeatherId = 'clear';
  return {
    spawn() {},
    tracer() {},
    beam: () => DEAD_BEAM,
    decal() {},
    damageNumber() {},
    lightFlash() {},
    telegraph: () => DEAD_TELEGRAPH,
    lightningBolt() {},
    attachTrail: () => DEAD_TRAIL,
    setWeather(id: WeatherId): void {
      weather = id;
    },
    get weather() {
      return weather;
    },
    clear() {},
    particleCount: 0,
    init(): void {
      // The real system creates its 6 pooled point lights here and follows 'timeOfDay:changed'.
      void ctx;
    },
    reset() {},
    update() {},
    dispose() {},
  };
}
