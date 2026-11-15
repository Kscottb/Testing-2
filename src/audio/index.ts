// STUB: replaced by the audio team
import type { AudioMeter, AudioSystem, GameContext, LoopHandle, MusicState } from '../core/types';

/** The shared frozen dead handle of the HANDLE RULE. */
const DEAD_LOOP: LoopHandle = Object.freeze({ active: false, setPosition() {}, setVolume() {}, setPitch() {}, stop() {} });

/** Gray-box audio: silent. Every call is accepted; loops are permanently dead handles. */
export function createAudioSystem(ctx: GameContext): AudioSystem {
  const meter: AudioMeter = { state: 'locked', peak: 0, rms: 0, clipped: 0, voices: 0, loops: 0 };
  let music: MusicState = 'silent';
  let intensity = 0;
  return {
    unlock(): void {
      // The real system creates / resumes its AudioContext here; the stub only tracks the state.
      meter.state = 'running';
    },
    get unlocked() {
      return meter.state === 'running';
    },
    play() {},
    playAt() {},
    loop: () => DEAD_LOOP,
    stopOwner() {},
    setMusicState(state: MusicState | null): void {
      music = state ?? 'silent';
    },
    get musicState() {
      return music;
    },
    setMusicIntensity(value: number | null): void {
      intensity = value ?? 0;
    },
    get musicIntensity() {
      return intensity;
    },
    duck() {},
    setMuffle() {},
    stopAll() {},
    meter,
    measure: () => Promise.resolve({ seconds: 0, peak: 0, rms: 0 }),
    init(): void {
      void ctx;
    },
    reset() {},
    update() {},
    dispose() {},
  };
}
