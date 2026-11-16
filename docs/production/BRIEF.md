# STATIC HORIZON — production brief (shared by every agent)

Repo root: `/home/user/Testing-2`. This brief is the creative + technical direction. Once `src/core/types.ts`
exists, **the code contract in `src/core/` wins over this brief** wherever they differ in API detail; this brief
still governs design intent, art direction, budgets and working rules.

## 1. What we are building

An original, single-player, browser-based **first-person wave shooter** with the production values of a
premium game: tight gunfeel, readable enemies, spectacle, strong audio, polished UI. Everything is procedural —
**no external asset files at all** (no images, models, audio files, fonts files in repo). Meshes are built from
code, textures from canvas/shaders, sound from WebAudio synthesis.

**Fiction.** *STATIC HORIZON.* Deep-atmosphere refinery platform **MERIDIAN-7** floats in the storm bands of the
gas giant Vesper. A rogue machine swarm — "the Static" — has taken the rig, riding in on lightning. You are a
lone salvage marshal with a power suit and a job: clear the rig, zone by zone, then bring down **THE CONDUCTOR**,
the storm-core machine nesting on the Core Spire.

**Pillars**
1. *Gunfeel first* — every shot has recoil, flash, tracer, impact, sound, hit confirmation. Zero input lag.
2. *Momentum* — sprint, slide, dash, jump pads; the player is fast and stays moving.
3. *Readable chaos* — each enemy has a distinct silhouette, colour, sound and telegraph. Deaths are never unfair.
4. *Spectacle on a budget* — sky, storm, bloom, particles and time-of-day do the heavy lifting at 60 fps.
5. *It just works* — boots instantly, no crashes, runs on a mid laptop iGPU, playable with mouse+keyboard,
   gamepad, and touch.

## 2. Hard technical rules

- TypeScript (strict), Vite, **three@0.187** (`import * as THREE from 'three'`, addons from `three/addons/...`).
  No other runtime dependencies. Never `npm install` anything. WebGLRenderer (WebGL2), not WebGPU.
- Units: metres, seconds, radians. Y up. Player yaw 0 looks down **-Z**; positive yaw turns left, positive
  pitch looks up. Colours passed as numbers are sRGB `0xRRGGBB`.
- No external network requests at runtime except an optional Google Fonts stylesheet link (must degrade to a
  system fallback stack). No asset files.
- The game is later repackaged as a single inline page inside a sandboxed frame. Therefore:
  - never call `alert/confirm/prompt`, `window.open`, `window.print`, or trigger downloads;
  - `localStorage` only inside try/catch, and the game must work when it throws or is empty;
  - **pointer lock and fullscreen are optional**: always handle rejection; the game must be fully playable
    without pointer lock (fallback look modes) — see Input;
  - audio may only start after a user gesture (the Start button);
  - never depend on URL query strings in normal play (test mode is opt-in: `?test=1`, or a host frame named
    `sh-test` where no query string exists);
  - size the app with `height:100%` on `html, body` (not `100vh`); edge-anchored UI adds
    `env(safe-area-inset-*, 0px)` to its padding; side gutters ≥ 16px.
  - single deliberate dark look: set `color-scheme: dark` on `:root`, define every colour as a CSS custom
    property on `:root`, give `body` an explicit background.
- Performance budget (target 60 fps at 1080p on integrated graphics, "High" preset):
  - lights: 1 shadow-casting directional sun + 1 hemisphere (render) + a **fixed pool of 6 point lights owned by
    FX**, plus render's small fixed light rig for the first-person layer. Nobody else adds a light, and the
    light count never changes at runtime (it recompiles every shader; park unused pool lights at intensity 0).
    World geometry, enemies and weapons use emissive materials + bloom instead of real lights.
  - draw calls: world ≤ 150 (merge static geometry per material, InstancedMesh for repeats), each regular enemy
    ≤ 8 meshes (boss ≤ 40), all FX ≤ 25 batches, viewmodel ≤ 12. ≤ 600k triangles on screen.
  - no per-frame heap allocation in hot paths: module-level scratch vectors, pools for projectiles / particles /
    enemies / DOM nodes. No `new THREE.Vector3` inside `update`.
  - `MeshStandardMaterial` (shared instances) for lit surfaces; no `MeshPhysicalMaterial`; additive particles
    with `depthWrite:false`.
- Robustness: never let a NaN reach a transform (guard normalisation of zero vectors, clamp dt). Every system
  must survive `reset()` → new run, repeatedly, with no leaked state, meshes, listeners or audio nodes.
- Code style: named exports only, no default exports; no `any` in public APIs; short doc comments on public
  members only. No markdown/doc files. No TODOs left behind — finish what you start.

## 3. Game design

### Controls
Keyboard/mouse: WASD move · mouse look · LMB fire · RMB aim-down-sights · R reload · Space jump · Shift sprint ·
C crouch / slide (never bind Ctrl — Ctrl+W closes the tab) · Q dash · F Overclock · V melee · G grenade ·
1-4 weapons · wheel cycle · Esc/P pause · 1/2/3 choose perk. Arrow keys also turn the view (fallback look).
Gamepad: LS move · RS look · RT fire · LT aim · X reload · A jump · B crouch/slide · LB dash · RB grenade ·
Y next weapon · D-pad down previous weapon · R3 melee · L3 sprint · D-pad up Overclock · Start pause ·
X/Y/B choose perk (never the D-pad: it navigates menus).
Touch: left virtual stick (auto-sprint at full deflection) · right half drag-to-look · on-screen buttons for
fire / jump / dash / reload / grenade / melee / weapon swap / Overclock / pause. Touch + gamepad get mild aim
assist.

### Player
- Health 100, Shield 100 (shield regenerates 25/s after 4 s without damage; health only via pickups/perks).
- Walk 6.5 m/s, sprint 9.5, crouch 3.5, ADS ×0.6. Jump apex 1.25 m, gravity 24, coyote 0.1 s, jump buffer
  0.12 s, good air control. Slide: sprint + crouch → 12 m/s decaying over 0.9 s. Dash (Q): 0.16 s at 24 m/s in
  move direction, 2.5 s cooldown, 0.15 s of invulnerability.
- Collision AABB 0.7 × 1.8 × 0.7 (crouch 1.1 tall), eye 1.65 (crouch 1.0), auto step-up 0.45 m.
- **OVERCLOCK** (signature ability, F): a meter charged by kills (more for weak-point kills and combos). At 100,
  activate for 6 s: world time scale drops to 0.4 while the player moves, aims and shoots at full speed; no ammo
  consumption (grenades are still used up); strong audiovisual treatment.

### Arsenal (start with VECTOR; others arrive by supply drop after waves 1, 4, 6)
| id | name | behaviour |
|---|---|---|
| `vector` | VECTOR-7 pulse rifle | auto hitscan, 720 rpm, 14 dmg, mag 36, mild recoil pattern, ADS 1.35× |
| `breaker` | BREAKER scattergun | 9 pellets × 11 dmg, 75 rpm pump, mag 6, brutal close range, strong knockback |
| `lance` | LANCE rail rifle | hold to charge 0.6 s — fires by itself at full charge, letting go earlier cancels; piercing beam 160 dmg through all targets, mag 5, ADS 2.5× scope |
| `hornet` | HORNET micro-missile launcher | rockets 45 m/s, 90 splash dmg r=5 m (self damage ×0.35), mag 4 |
Plus frag grenades (G; carry 2; 140 dmg r=6.5 m; bounce; 1.6 s fuse) and a suit melee strike (V; 80 dmg, 2.4 m
cone, 0.7 s cooldown, small lunge). Weak-point hits are crits (default ×2). Ammo: magazine + reserve, refilled by
pickups. Falloff on vector/breaker. Dynamic crosshair spread (move/jump/fire widen it; crouch/ADS tighten it).

### Enemies — "the Static" (all mechanical; no skeletal rigs, use procedural animation)
| id | role | notes |
|---|---|---|
| `skitter` | swarm melee crawler | HP 40, 7.5 m/s, leaps from ~5 m, 10 dmg bite; arrives in packs |
| `riveter` | hovering gun platform | HP 90, 4 m/s, strafes at 10-28 m, 3-round plasma bursts (32 m/s bolts, 9 dmg); weak point: eye. Hovers low but paths on the nav grid like a ground unit (only wasp and boss truly fly) |
| `wasp` | flying harasser | HP 55, 9 m/s at 4-9 m altitude, strafing runs with rapid light bolts (5 dmg) |
| `tick` | rolling bomb | HP 30, 9.5 m/s, accelerating beeps, detonates at 2.2 m (45 dmg r=5, hurts enemies too → chain reactions); explodes when shot |
| `lancer` | tripod sniper | HP 120, holds 25-45 m, 1.6 s visible tracking laser that locks 0.3 s before a 40 dmg beam; relocates |
| `bulwark` | heavy assault frame | HP 600, 2.6 m/s, frontal energy shield (250, regenerates), lobbed mortars with ground telegraph (35 dmg r=4.5), close-range stomp shockwave; weak point: rear reactor vents ×2.5 |
| `conductor` | BOSS | see below |

**THE CONDUCTOR** (wave 10, Core Spire): colossal floating storm-core machine. ~9000 HP (scaled by difficulty).
Three phases at 100/66/33 %: (1) bolt volleys + a slow rotating sweep-laser to jump over or slide under + summons
skitters; (2) adds telegraphed lightning strikes (ground circles) and missile salvos + summons wasps;
(3) enraged — faster patterns, expanding shock rings to jump, summons ticks. Glowing capacitor weak points take
crit damage. Big staged death: chain explosions, slow motion, white-out, victory.

AI rules: ground units path with a shared flow field on the nav grid; flyers steer directly with obstacle
avoidance; separation between units; line-of-sight checks before firing; a global *attack token* budget so the
player is never shot by everything at once; every ranged attack has an audiovisual telegraph ≥ 0.35 s. Enemies
spawn via a **lightning-strike arrival**: a ground ring telegraph (~0.8 s), a bolt from the sky, then the machine
(the boss skips it and stages its own intro).

### Structure
- One continuous map, three zones opening west→east: **Landing Deck** (waves 1-3) → **Refinery** (unlocks after
  wave 3) → **Core Spire** (unlocks after wave 6; boss arena). Energy gates between zones.
- 10 waves. Wave 10 is the boss. Between waves: zone unlock and weapon supply drop (when due), then **perk
  choice** (pick 1 of up to 3, world frozen while choosing), then a short intermission countdown.
- Time-of-day arc tied to progress: waves 1-3 *Amber Dusk* → 4-6 *Violet Twilight* → 7-9 *Stormnight* (lightning,
  rain-like static) → boss *Eclipse* (red-magenta vortex over the Spire).
- Perks (roguelite, some stack): damage, fire rate, mag size, reload speed, max shield, max health, faster shield
  regen, move speed, double jump, dash cooldown/charges, life on kill, chain-lightning rounds, explosive crit
  kills, scavenger (more ammo), Overclock gain, grenadier, crit damage, last stand.
- Pickups dropped by enemies: ammo, health cell, shield cell, grenade; magnetise within 3 m; expire after 25 s.
- Score: base × combo multiplier (kills within 4 s build combo up to ×8), weak-point and multi-kill bonuses with
  callouts, wave-clear bonus, end-of-run grade (S/A/B/C/D), best score persisted.
- Difficulty: Recruit / Veteran / Nightmare (enemy damage & health multipliers, wave density).
- Main menu shows the live 3D rig with a slow cinematic camera. Pause, settings, game over, victory screens.

## 4. Art direction — "storm-lit industrial sci-fi"

- **World**: weathered off-white and graphite hull plating, safety-orange trim, hazard striping, stencilled
  signage (pad numbers, warnings), exposed pipe racks, tanks, antenna masts, railings, cyan guidance strips and
  red beacons (emissive). Big readable shapes first; detail via procedural normal/roughness textures.
- **Sky**: we are *inside* a gas giant's upper atmosphere: a sea of towering cloud below and around, a low sun,
  a bright ring arc across the sky, small moons, stars at night, lightning inside distant cloud banks.
- **Colour script**: environment = desaturated teal/graphite shadows with warm key light. **Cyan `#35e0ff` =
  player / friendly / interactable. Hot orange-red `#ff4a1c` = enemy. Magenta `#ff2a7a` = elite / boss.
  Hazard yellow `#ffc21a` = danger telegraph. White-violet `#c9b8ff` = lightning.** Never use these accents for
  anything else; this is how the player reads a fight.
- **Enemies**: dark gunmetal chassis, one saturated emissive accent, exaggerated silhouettes distinct from 30 m.
- **Weapons (first-person)**: graphite + off-white shells, cyan emissive readouts; chunky and legible.
- **Post**: the frame is always rendered in linear HDR and tone-mapped once in render's final pass, on every
  quality preset (presets only switch bloom, film effects, shadows and resolution). ACES-style filmic tone map,
  HDR bloom on emissives, subtle vignette + chromatic aberration + grain, colour grade per time-of-day.
  Reactive: damage flash, low-health desaturation/pulse, Overclock treatment — drawn by render only, never by
  CSS overlays.
- **UI**: precise military-tech HUD — thin lines, cut corners, small caps with letter-spacing, generous negative
  space; cyan primary, amber warning, red danger. Type: a characterful display face for titles (e.g. "Chakra
  Petch"), a condensed UI face (e.g. "Barlow Condensed"), a mono for data (e.g. "Share Tech Mono"); each with a
  real fallback stack. No emoji. UI motion is fast (120-220 ms) and purposeful; respect `prefers-reduced-motion`.

## 5. Audio direction

100 % synthesised with WebAudio. Weapons are layered (transient click + body thump + noise tail + pitch sweep),
loud and punchy with per-shot variation. Enemies each have a signature motif (skitter chitter, tick beeps,
lancer charge whine, bulwark servo groans). Explosions have sub-bass. Spatialised 3D sound (PannerNode), light
generated-impulse reverb, master compressor/limiter (no clipping with 30 simultaneous voices; voice cap +
priority). Adaptive music: dark driving synth score built from layers (pad, bass, arp, drums, lead) whose mix
follows combat intensity; distinct menu ambience, boss theme, victory and defeat stingers. Storm wind and
static-rain beds are audio's own; the storm's one-shots (thunder, crackle, gusts) are scheduled by FX weather
together with the lightning they belong to. Audio drives the music by itself from game events.

## 6. Architecture

```
index.html                 static shell: canvas, #ui, boot screen, fatal panel, design tokens (ownership: §7)
src/main.ts                bootstrap (finished)
src/core/                  FOUNDATION: types.ts (the code contract), constants, events, context, game.ts (state
                           machine + frame pipeline), loop, input, settings, storage, time, math, make, rng, pool,
                           palette, fatal, debug (window.__SH), bot
src/data/                  tuning tables: weapons, enemies, projectiles, waves, perks, pickups, difficulty,
                           timeOfDay, quality (who may tune which: types.ts header "DATA TABLES")
src/physics/               CollisionWorld: static AABBs, move-and-slide with step-up, raycasts, overlap (finished)
src/nav/                   2.5D nav grid, flow fields, paths (finished)
src/combat/                hit targets, traces, damage routing, projectiles, explosions, hit-confirm feedback
src/world/                 level layout, builder, materials/textures, props, gates, hazards, jump pads
src/render/                renderer, sky, lighting + time-of-day, post FX, quality + dynamic resolution, cinematic
                           cams, the reaction to lightning (it never schedules it)
src/player/                controller, camera feel + shake, vitals, dash, Overclock
src/weapons/               weapon logic, first-person viewmodels + animation, grenades, melee
src/enemies/               index.ts = the manager · kinds/<type>.ts = one file per enemy kind · kinds/index.ts =
                           the registration list · boss/ = helpers of the conductor (layout fixed by types.ts)
src/director/              waves, spawning, pickups, perks, score/combo, progression, supply drops, end of run
src/fx/                    particles, decals, tracers/beams, bolts, telegraphs, trails, damage numbers, light pool,
                           weather incl. the ambient storm (lightning + thunder scheduling)
src/audio/                 engine, SFX synth library, adaptive music, wind / static-rain beds
src/ui/                    HUD, menus, perk select, settings, minimap, touch controls, CSS
tools/                     Playwright harness + smoke / campaign / screenshot CLIs (part of the foundation)
```

- Every system implements the lifecycle in `src/core/types.ts` and receives the shared `GameContext`. Systems talk
  through **interfaces on the context** (queries/commands) and the **typed event bus** (notifications).
  A factory only stores `ctx` (the other systems do not exist yet); real work starts in `init()`. `reset()` is
  silent and idempotent — no fx, no sounds, no animations — and it kills every audio loop, so loops are started
  from `update`, never from `init()` or `reset()`.
- **Feedback ownership rule**: the gameplay system that owns a moment triggers its own FX and audio by explicit
  calls (`ctx.fx...`, `ctx.audio...`, `ctx.render...`). Every FxId / SoundId / LoopId in `types.ts` is declared
  in the union of its one owner; your assignment's "Contract pointers" names yours. FX and Audio do *not*
  subscribe to gameplay events to spawn effects/sounds (so nothing double-fires), except the small set listed in
  `types.ts` (music follows game/wave state; weather and ambience beds follow time-of-day). The ambient storm is
  FX weather's: it schedules each strike and calls render (flash) and audio (thunder); render and audio never
  start one themselves. UI is the opposite: it never gets called by gameplay; it reads state from the context
  each frame and listens to events.
- Time: `ctx.time` carries three clocks — scaled `dt` (enemies, combat, world, director, fx), `unscaledDt`
  (player, weapons: full speed during Overclock) and `realDt` (render, audio, ui: never stops) — plus `playerDt`
  for player-owned things inside world-clock systems. Overclock, hit-stop, slow-motion and the perk-select
  freeze are layered requests on the world time scale (one owner per source); nobody multiplies dt by hand.
- The world is static axis-aligned boxes for collision (ramps are stair-stepped in collision with a smooth
  visual mesh). Level heights are terraces, never overlapping walkable layers, so the nav grid is 2.5D.
- First-person weapons render in a separate view scene/camera composited after the world (no wall clipping).
- A debug/test API on `window.__SH` (state snapshot, manual stepping, spawn, teleport, camera, time-of-day,
  god mode, autopilot bot) exists for automated verification; keep it working.

## 7. Working rules for agents (several agents edit this repo at the same time)

- **Only create/edit files inside the paths you are assigned** — the exact list is under "Contract pointers" in
  your assignment. Other directories are being written by other agents right now. Read anything; write only
  your own. `src/main.ts`, `src/physics`, `src/nav` and `tools/` are finished foundation code: use them, do not
  edit them (the one exception is named in the audio assignment).
- `src/core/**` is frozen for everyone. If you believe it needs a change, do NOT edit it: finish your work
  against the current contract (work around locally if needed) and report the request in your final output.
- `index.html` belongs to the UI engineer, and to nobody else: styles and the static shell only (no game logic).
  Core drives the boot screen and the fatal panel through it, so `#game`, `#ui`, `#boot`, `#boot-bar`,
  `#boot-label`, `#fatal`, `#fatal-title`, `#fatal-message`, `#fatal-detail`, `#fatal-reload`, the inline
  safety-net script and the module script tag must keep working exactly as they do now.
- `src/data/*.ts`: the table types, export names and shapes are frozen; only the values are tuned, and only by
  the owner named in the `types.ts` header (repeated in your assignment). Everyone else reads the tables and
  never hard-codes a copy of a number.
- Never run state-changing git commands (no commit, add, stash, checkout, reset, clean, restore). Never install
  packages. Never edit package.json, tsconfig, vite config.
- Type-check with `npx tsc --noEmit 2>&1 | grep -E "^src/<your-dir>/"` — errors in other directories belong to
  other agents mid-edit; ignore them. Your own files must be error-free. Run your unit tests with
  `npx vitest run src/<your-dir>` (tests are `src/<dir>/*.test.ts` and run in node: no DOM, no WebGL, no
  AudioContext — keep the logic under test free of them).
- Do not run `npm run build` or anything that writes `dist/` unless your assignment says so.
- For visual checks use the harness in `tools/` in **dev mode on your assigned port** (never another port, never
  kill processes you did not start): `tools/smoke.mjs`, `tools/shots.mjs` and `tools/campaign.mjs` take
  `--port`, and your own throwaway scripts (kept in your scratch directory) can import `launchGame` from
  `tools/harness.mjs` and drive `window.__SH`. The harness opens the page in test mode: the simulation only
  advances through `step()`. The sandboxed-frame mode (`embed: 'sandbox'`) needs a `dist` build and is therefore
  an integration check, not yours. If the page fails to load because of errors outside your directory, wait
  ~90 s and retry (max 3 times), then carry on without the visual check and say so in your report.
- Put temporary files only under the scratch directory given in your assignment — never in the repo.
- Report honestly: what is done, what is not, what you could not verify.

## 8. Rulings on questions the contract leaves open

These settle points where two engineers could otherwise guess differently. The contract still wins on API detail.

- **Boss volume**: the Conductor hovers at `bossArena.center` + `hoverHeight`; the conductor row's `hoverMin` /
  `hoverMax` are **offsets** around that anchor (its bob range), not absolute altitudes. The world keeps a clear
  cylinder around the anchor — radius 12 m, from 5 m above the arena floor up to 26 m — free of **all** geometry,
  solid or visual. The central spire ends below it (it may continue above 26 m only as distant set dressing
  outside the cylinder).
- **FX recipes are particles only**: an `fx.spawn` recipe never contains a decal or a light. The owner of the
  moment calls `fx.decal` and `fx.lightFlash` itself.
- **`audio.duck`** has no gameplay caller: only the audio system uses it internally (for example under stingers).
- **Reactive post params** (damage vignette, low-health pulse, Overclock treatment, dash blur, ADS vignette,
  chromatic boost) are drawn on **every** quality preset; `filmEffects` only switches the constant cosmetic
  vignette / aberration / grain.
- **Time of day**: `WaveDef.timeOfDay` (director's table) is authoritative. `TimeOfDayDef.waveFrom/waveTo` are
  informational and nothing derives the schedule from them.
- **Colour of elites**: lancer and bulwark use the elite magenta accent (`#ff2a7a`) like the boss; skitter,
  riveter, wasp and tick use the enemy orange-red. The elite engineer sets the accent in their rows.
- **Wide enemies**: the nav grid is built for a 0.4 m agent. The bulwark steers by the nav grid with its centre
  and additionally keeps its body out of walls with collision overlap probes; the world keeps every route a
  heavy unit needs (from heavy spawn points to the open floor of its zone) at least 4 m wide.
- **Air spawns**: the arrival telegraph ring goes on the floor under the hover point.
- **Difficulty and the boss**: the conductor reads the run's difficulty from the director to scale its cadence;
  there is no modifier field for it.
- **`WeaponDef.moveMul`**: weapons apply it through `player.setSpeedMultiplier('weapon', …)` and restore it on
  mode change and reset.
- **Footsteps on `glass` and `energy`** surfaces fall back to the `metal` step sounds.
- **Damage number colours**: body hits near-white (`#e8f1f5`); weak-point hits pale gold (`#fff2b0`) and larger;
  armour hits dim grey (`#8aa0ad`) and smaller; shield-absorbed hits pale cyan (`#9fefff`). Never hazard yellow.
- **Tick packs** may detonate within one simulation substep (the explosion queue resolves chains immediately);
  no artificial ripple delay.
- **Boss intro** is timed by the director's `bossIntro` phase as the contract says; the boss appears at its
  anchor wherever the player is, and the objective marker leads the player to the Spire.
- **Interrupted work**: if your directory already contains more than the stub when you start, a previous attempt
  at your assignment was interrupted. Read what is there and continue from it; do not start over.
