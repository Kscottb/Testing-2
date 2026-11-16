# Assignment: FX

Every transient visual in world space: particles, tracers, beams, decals, explosion recipes, debris, lightning
bolts, telegraphs, trails, damage numbers, weather with the ambient storm, and the fixed pool of dynamic
lights. Other systems call you constantly; you must be fast, allocation-free in steady state, and never throw.
Replace the stub in `src/fx/index.ts`; keep the factory `createFxSystem(ctx)`. Where this text and
`src/core/types.ts` differ, the contract wins.

- **Particle core**: pooled, CPU-simulated, drawn as instanced quads that face the camera **in the vertex
  shader** — you run before the frame's final camera is known, so never read `ctx.camera` on the CPU.
  Velocity-stretched option for sparks/streaks; procedural sprite atlas (soft glow, hard spark, smoke puff,
  ring, shard, flare, digit glyphs). Per-particle colour-over-life, size-over-life, drag, gravity, rotation,
  ground bounce for debris. Every pool is allocated once in `init()` at the `FX_CAPS` sizes; a quality change
  only lowers the active caps. ≤ 25 draw batches for all FX, GPU buffers written at most once per rendered
  frame, graceful degradation when a pool is full (drop the oldest low-priority particles). The quality preset
  thins secondary particles only — never telegraphs, beams, tracers, bolts, damage numbers or the core flash
  of an explosion.
- **Effect library**: an exhaustive `Record<FxId, …>` (the compiler must force every id to exist). Two kinds of
  id: a BURST is the complete, self-ending effect in one call; a STREAM id is one short puff that its owner
  re-spawns while the state lasts — you never sustain or follow one. Honour the spawn options: an explosion
  must visually cover exactly the `radius` it is given. Each effect is a layered recipe of particles, e.g. a
  large explosion = white core flash + orange fireball puffs + fast sparks + slow smoke + ground shock ring +
  debris shards. **A recipe never places a decal, never takes a pooled light and never draws a bolt**: the
  owner of the moment calls `decal`, `lightFlash` and `lightningBolt` itself, or the moment would double up.
  Impacts differ per surface. Enemy deaths differ per enemy type and scale with the enemy's size. Colours from
  `core/palette.ts`: enemy fire orange-red, elite / boss magenta, player tech cyan, lightning white-violet,
  danger telegraphs hazard yellow — and those five for nothing else. HDR colours so bloom reacts.
- **Tracers & beams**: tracers are instant stretched streaks. Beams are one-shot (rail shot: thick core +
  spiral + fade; an enemy laser shot) or **persistent handles** moved every frame (lancer lock laser, boss
  sweep laser).
- **Lightning bolts**: procedurally jagged, branching, flickering for a few frames, with an optional pooled
  light at the far end; used for enemy arrivals, chain lightning, the boss and your own storm. The caller adds
  the impact burst, the sound and the sky flash.
- **Telegraphs**: every `TelegraphKind`. Timed ones fill over world-time seconds and vanish; persistent ones
  show whatever their owner sets, and a `shock` ring is drawn exactly at its radius — it is the damage front.
  They sit on the ground without z-fighting on any terrace height. Gameplay-critical: never thinned by quality
  and never refused below the pool cap.
- **Decals**: pooled, surface-aligned quads with polygon offset (bullet holes, scorch marks…), fade out. The
  live cap comes from the quality params; skip boxes flagged as not taking decals and drop decals whose box is
  switched off (gates).
- **Trails**: follow a retained, live position vector (rocket smoke, grenade wisp, plasma glow, supply pod);
  detach lets the trail finish gracefully.
- **Damage numbers**: pooled in-world billboards from a digit atlas; rise, pop and fade; hits on one target
  merge into one growing number; crits larger and brighter, kills emphasised, shield-absorbed hits in the
  shield colour — never hazard yellow, which is reserved for danger telegraphs. Readable against any
  background (outline/shadow). A no-op when the setting is off. Score popups are the UI's, not yours.
- **Weather + the ambient storm**: drifting ember/dust motes near the camera, cloud wisps crossing the deck,
  streaking "static rain", and the near-camera streaks of the eclipse vortex (the vortex in the sky is
  render's). Weather follows the time of day by itself; sync it in `init()` and at the end of `reset()`, not
  only on the event. **The ambient storm is yours and only yours**: you schedule each strike at the rate the
  time-of-day table gives, may draw a distant bolt, call `render.lightningFlash` for the sky and scene, and
  play the thunder with its distance delay, plus crackle and gust one-shots — the only sounds you ever make.
- **Light pool**: exactly 6 point lights created once in `init()` and never added/removed; intensity on the
  contract's normalised scale, fading over the requested time; when all are busy the weakest is stolen; a
  keyed call refreshes its own slot (the only way to move or pulse a light).
- **Clocks**: effects advance on scaled world time (slow motion slows them) unless they were created with clock
  `'player'`, which runs on `ctx.time.playerDt` so the player's own muzzle flashes, tracers and rail beam stay
  crisp during Overclock.
- **Reduce flashes**: your part is exactly two things — halve `lightFlash` intensity and stop bolt strobing.
  Full-screen flashes are render's, and render caps them; you always pass the full value on.
- `cancelOwner(id)` ends every beam, telegraph and trail of one entity. `clear()` returns every pool and
  invalidates every handle but keeps the weather; `reset()` is `clear()` plus the weather sync, silently.
- Verify with harness screenshots: fire every effect family in front of a free camera mid-life (step the sim a
  few frames), look at them, iterate until they read as punchy and deliberate — not confetti. Add a vitest for
  pool exhaustion / reset / handle invalidation / NaN safety of the simulation core (no WebGL needed there).

## Contract pointers

- **You implement** `FxSystem` (types.ts §21) with `FxSpawnOptions`, `TracerOptions`, `BeamOptions`,
  `TelegraphOptions`, `LightningOptions`, `DamageNumberOptions`, the four handle types and `FxStats`. Read
  closely: the doc block above `FxSystem` and every method doc (`spawn`, `decal`, `lightFlash`, `telegraph`,
  `setWeather`); the HANDLE RULE at `BeamHandle`; every `*FxId` union with its owner comment and "(STREAM)"
  marks, plus `TelegraphKind`, `BeamKind`, `TrailKind`, `DecalKind` (§2); `QualityParams`,
  `RenderSystem.lightningFlash` and `LightingState` (§13); `TimeOfDayDef` (§24); `SettingsData.reduceFlashes` /
  `damageNumbers` (§9); `FX_STREAM_IDS`, `FX_CAPS`, `RENDER_ORDER` in `core/constants.ts`; in the header: FRAME
  PIPELINE (you update in playing, gameover, victory and menu — not while paused or perk-frozen), CLOCKS,
  FEEDBACK OWNERSHIP RULE (the fx line and the list of events you may react to), ERROR CONTAINMENT, RENDERING
  CONVENTIONS (linear HDR output from custom shaders, fog, render order, one root named `fx` holding the lights).
- **Feedback you trigger**: only the ambient storm — your own distant `lightningBolt`, `render.lightningFlash`,
  and the `WeatherSoundId` one-shots (`thunderNear`, `thunderFar`, `lightningCrack`, `staticCrackle`,
  `windGust`). **Never**: any other sound; `render.screenFlash`; camera shake; anything in reaction to a
  gameplay event (no effect is ever spawned from the bus — owners call you); the wind / static-rain beds
  (audio); the sky vortex and the scene lighting (render); a seventh light.
- **Data tables you may tune**: none. You read `TIME_OF_DAY` (weather id, lightning rate) and the quality
  params; both belong to render.
- **Files you own**: `src/fx/**`.
- **Verify with**: `__SH.fx(id, x, y, z)` fires any `FxId`; `__SH.ctx.fx.beam / telegraph / lightningBolt /
  lightFlash / decal / damageNumber / attachTrail / setWeather` cover the rest (in test mode ambient strikes
  stay off until `setWeather` is called from outside); `__SH.setCamera(…)`, `step` a few frames, `shot`;
  `__SH.ctx.fx.stats` (batches ≤ 25) and `__SH.budget().fx`; `__SH.state()` → `particles`, `weather`;
  `__SH.setQuality(…)`, `__SH.setTimeOfDay(…)`; `__SH.overclock()` to compare world-clock and player-clock
  effects; `__SH.ctx.settings.set('reduceFlashes', true)` for the reduced path (test mode starts with it off).
