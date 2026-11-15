// STUB: replaced by the fx team
import * as THREE from 'three';
import { TIME_OF_DAY } from '../data/timeOfDay';
import type { BeamHandle, FxStats, FxSystem, GameContext, TelegraphHandle, TrailHandle, WeatherId } from '../core/types';

// The shared frozen dead handles of the HANDLE RULE: every call on them is a no-op for ever.
const DEAD_BEAM: BeamHandle = Object.freeze({ active: false, set() {}, setIntensity() {}, setColor() {}, stop() {} });
const DEAD_TELEGRAPH: TelegraphHandle = Object.freeze({ active: false, setPosition() {}, setRadius() {}, setProgress() {}, cancel() {} });
const DEAD_TRAIL: TrailHandle = Object.freeze({ active: false, detach() {} });

/** Gray-box FX: every call is accepted and does nothing; handles are permanently dead. */
export function createFxSystem(ctx: GameContext): FxSystem {
  const root = new THREE.Group();
  root.name = 'fx';
  const stats: FxStats = { particles: 0, decals: 0, beams: 0, telegraphs: 0, trails: 0, lights: 0, batches: 0 };
  let weather: WeatherId = 'clear';
  /** Never rely on 'timeOfDay:changed' for the initial state: sync in init() and after every reset(). */
  const syncWeather = (): void => {
    weather = TIME_OF_DAY[ctx.render.timeOfDay].weather;
  };
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
    cancelOwner() {},
    setWeather(id: WeatherId): void {
      weather = id;
    },
    get weather() {
      return weather;
    },
    clear() {},
    stats,
    init(): void {
      // The real system creates its 6 pooled point lights (and every pool) under this root.
      ctx.scene.add(root);
      ctx.events.on('timeOfDay:changed', syncWeather);
      syncWeather();
    },
    reset(): void {
      syncWeather();
    },
    update() {},
    dispose(): void {
      ctx.events.off('timeOfDay:changed', syncWeather);
      ctx.scene.remove(root);
    },
  };
}
