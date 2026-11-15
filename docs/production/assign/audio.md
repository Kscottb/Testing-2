# Assignment: AUDIO  (you own `src/audio/**`, and you may add `tools/audio-check.mjs`)

All sound is synthesised with WebAudio. Replace the stub in `src/audio/index.ts`; keep the factory signature.

- **Engine**: AudioContext created/resumed only from `unlock()` (user gesture). Buses: sfx, ui, ambience, music
  → master → compressor/limiter → destination; reverb send (ConvolverNode with a generated impulse response).
  Volumes follow settings live. Everything is a silent no-op if WebAudio is unavailable or not yet unlocked —
  never throw, never queue up a backlog that bursts on unlock.
- **One-shots**: every `SoundId` has a recipe in an exhaustive `Record<SoundId, …>` (compiler-enforced). Render
  each recipe once into an AudioBuffer with `OfflineAudioContext` (lazily on first use or progressively after
  unlock, without frame hitches) and play it through a pooled voice. Give frequently repeated sounds (gunshots,
  impacts, footsteps) 3–4 rendered variations plus random pitch/gain so they never machine-gun.
- **Design quality**: weapons are layered — sharp transient, pitched body thump, filtered noise tail, a sweep —
  and each gun has its own character (rifle: tight crack; scattergun: huge low boom + pump clack; rail: charge
  whine → supersonic snap + ring-out; launcher: thump + whoosh). Explosions carry sub-bass and debris crackle.
  Each enemy has a signature motif (see brief). UI sounds are small, dry and precise. Nothing harsh or piercing;
  peaks controlled; overall mix leaves headroom for 30 voices.
- **Voices**: cap (~32) with priority + distance culling, per-id minimum retrigger interval, 3D positioning with
  PannerNode (cheap panning model by default), listener updated each frame from the camera.
- **Loops** with handles (position / volume / pitch / stop-with-fade): storm wind bed, Overclock loop, low-health
  heartbeat, rail charge, sniper charge whine, boss hum, slide scrape, etc. as the SoundId list requires.
- **Time scale**: when world time slows (Overclock, death, boss kill) pitch SFX down and sweep a low-pass on the
  sfx/music buses as the contract describes; smooth, no zipper noise. Paused = muffled music, sfx suspended.
- **Adaptive music**: a look-ahead step sequencer on the audio clock (not frame time). Dark, driving synth score
  in a minor mode: sub pulse, bass line, arpeggio, pad chords, synthesised kick/snare/hats, lead. States:
  menu (pads + sparse arp), calm/intermission, combat (layers and filter open with the 0–1 intensity value,
  smoothed), boss (faster, heavier, own motif), victory stinger, defeat stinger. Transitions land on bar lines.
  At least 16 bars of composed pattern variation per state so it does not loop obnoxiously.
- You cannot hear, so verify by measurement: write `tools/audio-check.mjs` (Playwright via the harness or a bare
  page) that renders every SoundId through OfflineAudioContext and asserts: not silent, no NaN, peak ≤ 1.0,
  sensible duration, and prints RMS/peak/duration per id; and that runs the music scheduler for 30 s per state
  offline (or with a suspended-clock shim) asserting bounded levels. Fix anything out of range. Also add vitest
  coverage for pure logic (voice stealing, sequencer pattern stepping, intensity smoothing).
