# Assignment: AUDIO

All sound is synthesised with WebAudio. Replace the stub in `src/audio/index.ts`; keep the factory
`createAudioSystem(ctx)`. Where this text and `src/core/types.ts` differ, the contract wins.

- **Engine**: `unlock()` creates the AudioContext on its first call and resumes it on every call; until the
  context is running, `play` / `playAt` / `loop` are silent no-ops and nothing is scheduled — no backlog may
  burst out later. Suspend while the page is hidden. Buses: sfx, ambience, ui, music → master →
  compressor/limiter → destination; reverb send (ConvolverNode with a generated impulse response). Volumes
  follow settings live. No public method ever throws: catch at the boundary, report once, fall back to no-ops.
- **One-shots**: every `SoundId` has a recipe in an exhaustive `Record<SoundId, …>` (compiler-enforced). Render
  each recipe once into an AudioBuffer with `OfflineAudioContext` (allowed at any time, also in `init()`;
  lazily or progressively, without frame hitches) and play it through a pooled voice. Give frequently repeated
  sounds (gunshots, impacts, footsteps) 3–4 rendered variations plus random pitch/gain (from `ctx.cosmeticRng`)
  so they never machine-gun.
- **Design quality**: weapons are layered — sharp transient, pitched body thump, filtered noise tail, a sweep —
  and each gun has its own character (rifle: tight crack; scattergun: huge low boom + pump clack; rail: charge
  whine → supersonic snap + ring-out; launcher: thump + whoosh). Explosions carry sub-bass and debris crackle.
  Each enemy has a signature motif (see brief). UI sounds are small, dry and precise. Nothing harsh or piercing;
  peaks controlled; overall mix leaves headroom for 30 voices.
- **Voices**: cap (~32) with priority + distance culling, per-id minimum retrigger interval, start delays, 3D
  positioning with PannerNode (cheap panning model by default), listener synced each frame from `ctx.camera`.
  Voices and loops may carry an `owner` id; `stopOwner(id)` cuts them, pending delays included.
- **Loops**: every `LoopId` in an exhaustive `Record<LoopId, …>`, controlled through handles that follow the
  contract's HANDLE RULE (a dead handle is a no-op for ever; a shared dead handle while locked). At most 12
  positional loops are audible — virtualise the rest and swap them back in; handles stay valid.
- **Ambience beds**: the storm wind and the static-rain hiss are your own internal layers (they have no id).
  Drive them from `ctx.render.timeOfDay` and `ctx.render.lighting.storm`; sync in `init()` and at the end of
  `reset()`, not only on the event. Thunder and the other storm one-shots are not yours to start.
- **Slow motion, pause, freeze** are handled here and nowhere else (gameplay never stops a loop for them).
  The slow-motion treatment (pitch drop + low-pass, formula in the contract) follows only the `overclock`,
  `slowmo` and `bossStaging` time-scale requests — never hit-stop, the perk freeze or debug — and only touches
  voices flagged `timeScaled`; music gets the low-pass at half depth, UI sounds nothing. Paused: sfx + ambience
  buses are suspended with a short fade and resumed, UI sounds and the ducked music continue. Smooth, no
  zipper noise.
- **Adaptive music**: a look-ahead step sequencer on the audio clock (not frame time). Dark, driving synth score
  in a minor mode: sub pulse, bass line, arpeggio, pad chords, synthesised kick/snare/hats, lead. States:
  menu (pads + sparse arp), calm/intermission, combat (layers and filter open with the 0–1 intensity value,
  smoothed), boss (faster, heavier, own motif), victory stinger, defeat stinger. Transitions land on bar lines.
  At least 16 bars of composed pattern variation per state so it does not loop obnoxiously. **You drive it
  yourself**: derive state and intensity from the events the contract allows you plus enemy count and player
  health. No gameplay system feeds you; `setMusicState` / `setMusicIntensity` are debug overrides.
- **Reset**: audio is reset first. `stopAll()` silences sfx + ambience only — never the ui bus (the click that
  started the run keeps ringing) and never the music — then re-sync the beds.
- You cannot hear, so verify by measurement: implement `measure(id)` and write `tools/audio-check.mjs` (through
  the harness) that measures every SoundId and every LoopId and asserts: not silent, no NaN, peak ≤ 1.0,
  sensible duration, printing RMS/peak/duration per id; and that runs the music scheduler for 30 s per state
  offline (or with a suspended-clock shim) asserting bounded levels. Fix anything out of range. Also add vitest
  coverage for pure logic (voice stealing, sequencer pattern stepping, intensity smoothing).

## Contract pointers

- **You implement** `AudioSystem` (types.ts §22) with `SoundOptions`, `LoopOptions`, `LoopHandle`, `AudioMeter`.
  Read closely: the whole doc block above `AudioSystem` (LOCKING, SLOW-MOTION TREATMENT, PAUSE AND FREEZE,
  POSITIONAL LOOPS, MUSIC, reset); the `SoundId` / `LoopId` unions with their owner comments (§2), including
  which enemy sounds carry an `owner`; the HANDLE RULE at `BeamHandle` (§21); `TimeState.getScale` (§6); in
  the header: CLOCKS (you run on `realDt`, every frame, in every mode), FEEDBACK OWNERSHIP RULE (the audio line
  and the list of events you may react to), LEVELS / IMPULSES / HANDLES, ERROR CONTAINMENT, LIFECYCLE ORDER.
- **Feedback you trigger**: the music, the stingers of the music state machine (victory / defeat on
  `'run:end'`) and your wind / static-rain beds. **Never**: any `SoundId` or `LoopId` on your own initiative —
  every one-shot and loop is started by its owning system through `play` / `playAt` / `loop` (thunder, crackle,
  gusts: fx weather; wave, perk and pickup sounds: director; interface sounds: ui; and so on). Never subscribe
  to a gameplay event to make a sound. `setMuffle` is written by the player only; you implement it.
- **Data tables you may tune**: none.
- **Files you own**: `src/audio/**`, plus the one new file `tools/audio-check.mjs`.
- **Verify with**: `__SH.sound(id)`; `__SH.ctx.audio.measure(id)` (works while locked) and `.meter`;
  `__SH.state()` → `musicState`, `musicIntensity`, `audioState`, `voices`; `__SH.ctx.audio.setMusicState(…)` /
  `setMusicIntensity(…)` to force a state; `__SH.setWave(n)`, `__SH.overclock()`, `__SH.pause()` to walk the
  music, slow-motion and pause paths. `launchGame({ test: false })` runs the real frame loop, and its `args`
  option passes Chromium flags (e.g. `--autoplay-policy=no-user-gesture-required`) when you need a running
  context without a gesture.
