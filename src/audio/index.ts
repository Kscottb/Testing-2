// STUB: replaced by the audio team
import type { AudioSystem, GameContext, LoopHandle, MusicState } from '../core/types';

const DEAD_LOOP: LoopHandle = { active: false, setPosition() {}, setVolume() {}, setPitch() {}, stop() {} };

/** Gray-box audio: silent. Every call is accepted; loops are permanently dead handles. */
export function createAudioSystem(ctx: GameContext): AudioSystem {
  let unlocked = false;
  let music: MusicState = 'silent';
  let intensity = 0;
  return {
    unlock(): void {
      unlocked = true;
    },
    get unlocked() {
      return unlocked;
    },
    play() {},
    playAt() {},
    loop: () => DEAD_LOOP,
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
    voiceCount: 0,
    init(): void {
      void ctx;
    },
    reset() {},
    update() {},
    dispose() {},
  };
}
