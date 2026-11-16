# Assignment: RENDER

Own everything between the scene graph and the pixels: renderer setup, sky, sun/shadows, time-of-day, the look
of the storm, post-processing, quality + dynamic resolution, the first-person view-scene composite, and the
cinematic cameras used when the player is not in control. Replace the stub in `src/render/index.ts`; keep the
factory `createRenderSystem(ctx)`. Where this text and `src/core/types.ts` differ, the contract wins.

- **Renderer**: WebGL2. **Both scenes are always drawn into a linear HDR target (HalfFloat, RGBA8 fallback) —
  on every quality preset, low included.** The renderer itself never tone-maps: filmic tone mapping (ACES or
  AgX — pick by eye) and sRGB encoding happen once, in your final pass. Every other team writes its shaders and
  emissive levels against that promise, and bloom starts at a linear luminance of about 1. Soft shadows from
  the single sun (map size per preset; texel-snapped shadow frustum that follows the player so shadows never
  shimmer), pixel ratio capped per preset. `resize()` is called by core only, at the start of a frame — no
  ResizeObserver of your own. Survive context loss/restore and a zero-size canvas without throwing.
- **Lights**: the sun and hemisphere in the world scene and a small fixed rig in the view scene (it includes
  the muzzle light behind `muzzleFlash`) are yours. The light count never changes after `init()`.
- **Sky** (custom shader dome): we are inside a gas giant's upper atmosphere. Gradient atmosphere, sun disc
  with glow, a bright **planetary ring arc** spanning the sky, 2 small moons, hash stars at night, layered
  animated FBM cloud banks around the horizon, a soft **cloud sea** far below the rig (seen past the deck edge),
  clouds that glow from inside toward a lightning flash when one is requested, and for *eclipse* a red-magenta
  storm vortex above the boss arena centre. Keep it cheap (< 1 ms at 1080p on an iGPU): low octave counts, or
  render the sky to a small cube target that updates one face per frame. Scene fog matched to the horizon.
- **Image-based lighting**: PMREM environment from the sky, set on both scenes, so metal reads as metal;
  regenerate only when time-of-day changes (time-sliced, never per frame).
- **Time-of-day**: keyframes for dusk / twilight / stormnight / eclipse (sun direction, colour, intensity,
  hemisphere colours, fog, exposure, bloom, grade, star/ring visibility, storm amount) with smooth multi-second
  transitions that run on real time (also while paused). The director decides when (`setTimeOfDay`); you never
  advance the schedule yourself, and `reset()` snaps to dusk. Publish the `LightingState` so FX and world can
  match what you draw.
- **Lightning — you react, you never schedule**: `lightningFlash(intensity, direction)` gives a few frames of
  white-violet key-light flicker, the sky glow and a small capped post flash. Its callers are fx weather (the
  ambient storm), the enemy manager (arrivals) and the boss. You never start a strike yourself and you never
  play a sound — thunder is not yours.
- **Reduce flashes**: you cap the post flash (`screenFlash` and the lightning one) and the lightning boosts.
  Callers always pass the full value.
- **View scene**: light the first-person weapon layer consistently with the world (own rig + same environment)
  and composite it after the world with cleared depth, before bloom. Draw it only while playing or paused with
  a live player and no free camera. Its camera's FOV is fixed and written by nobody; both aspects are yours.
- **Post chain**: world → view scene → bloom → one combined final pass (vignette, radial chromatic aberration,
  film grain, colour grade, damage and shield flash, low-health pulse + desaturation, Overclock treatment — cool
  tint, contrast, edge streaks —, dash radial blur, ADS vignette, full-screen flash colour, saturation,
  exposure: everything in `PostFxParams`) → tone map/output → AA (FXAA or SMAA). The reactive params are
  gameplay feedback and the UI is forbidden to fake them: draw them on **every** preset. Presets only switch
  bloom, the decorative film effects, shadows and resolution. Impulses decay in your `update`; you read every
  param at draw time and `reset()` restores the defaults.
- **Quality**: low / medium / high / ultra from `data/quality.ts`. `'auto'` is resolved once, in `init()`, by
  the device rule of the contract, and is never written back into settings. Dynamic resolution is a governor on
  `resolutionScale` and nothing else (thresholds and pacing in the contract): it never touches shadows, bloom
  or particle caps, never reallocates a target, never emits `'quality:changed'`, and is off in test mode.
  Report render stats per the contract.
- **Shader warm-up**: `warm(object, layer)` compiles against the right scene's lights, fog and environment so
  nothing compiles mid-fight; the program count must not grow during play or across restarts.
- **Cinematic cameras** — in menu, game over and victory only, never under the debug free camera, and never
  while playing or paused (the player owns the camera then): menu = the world's camera path, evaluated with
  exactly the curve the contract defines (the world validates a clear 1 m tube along it, so any handheld drift
  must stay well inside); game over = ease to a pull-back behind and above where the player fell, then a slow
  orbit; victory = an orbit of the boss arena on the ring the world keeps clear. Exact numbers in the contract.
- Verify with harness screenshots at each time-of-day and each quality preset (low has no bloom or film
  effects, but the same HDR path and the same reactive post); look at them and iterate until the sky and
  lighting are genuinely striking. Check there is no banding, no blown-out white, and that enemies' red and
  the player's cyan accents stay readable in every time-of-day.

## Contract pointers

- **You implement** `RenderSystem` (types.ts §13) with `PostFxParams`, `LightingState`, `QualityParams`,
  `RenderStats`, `ScreenPoint`. Read closely: the doc block above `RenderSystem` (QUALITY, DYNAMIC RESOLUTION,
  CINEMATIC CAMERAS) and every method doc (`render`, `resize`, `setQuality`, `screenFlash`, `setTimeOfDay`,
  `lightningFlash`, `muzzleFlash`, `viewToWorld`, `warm`); `CinematicShot` and `WorldSystem.bossArena` (§12);
  the camera / view-scene docs of `GameContext`, `DebugFlags.freeCamera` and `testMode` (§4);
  `SettingsData.quality` / `dynamicResolution` / `reduceFlashes` (§9); `'timeOfDay:changed'`,
  `'quality:changed'`, `'view:resize'` (§7); `TimeOfDayDef` (§24); in the header: FRAME PIPELINE, CLOCKS (you
  run on `realDt`, every frame, in every mode), FEEDBACK OWNERSHIP RULE (the events render may react to),
  LEVELS / IMPULSES, and all of RENDERING CONVENTIONS — you are the one who makes its promises true.
- **Feedback you trigger**: none of your own. You provide the reactions others call: `screenFlash` (combat, the
  boss), `lightningFlash` (fx weather, enemy manager, the boss), `muzzleFlash` (weapons) and the post params
  (each with its named writer). **Never**: schedule lightning; play any sound; write `ctx.camera` while playing
  or paused; write a setting; emit `'quality:changed'` outside `setQuality`; resize on your own; add or remove
  a light after `init()`.
- **Data tables you may tune**: `src/data/timeOfDay.ts` and `src/data/quality.ts` (values only). FX reads the
  weather id and lightning rate from your time-of-day rows and its caps from your quality rows.
- **Files you own**: `src/render/**`.
- **Verify with**: `__SH.setTimeOfDay(id, seconds)`, `__SH.setQuality(setting)`, `__SH.setCamera(…)` /
  `releaseCamera()`, `__SH.renderFrame()`. Post params are read at draw time: set
  `__SH.ctx.render.post.lowHealth = 1` (and so on), then render a frame. `__SH.ctx.render.lightningFlash(1)`,
  `.screenFlash(0xffffff, 1)`, `.muzzleFlash(…)`. `__SH.state()` → `quality`, `resolutionScale`, `timeOfDay`,
  `drawCalls`, `triangles`, `programs`; `__SH.budget()` per scene root. `__SH.menu()` and
  `__SH.endRun(false | true)` show the three cinematic cameras. `tools/shots.mjs` for the tour (it forces the
  high preset); harness options `dpr`, `width`, `height`. The governor and ambient lightning are off in test
  mode: use `launchGame({ test: false })` to watch the governor, and
  `__SH.ctx.settings.set('reduceFlashes', true)` for the capped path.
