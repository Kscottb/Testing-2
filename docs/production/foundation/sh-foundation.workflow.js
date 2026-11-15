export const meta = {
  name: 'sh-foundation',
  description: 'Static Horizon: build the frozen engine contract, walking skeleton, physics/nav and test harness',
  phases: [
    { title: 'Architect', detail: 'contracts + core + gray-box stubs + tools' },
    { title: 'Harden', detail: 'physics/nav implementation + two contract critics' },
    { title: 'Finalize', detail: 'apply contract fixes, pass all gates' },
  ],
}

const SCRATCH = '/tmp/claude-0/-home-user-Testing-2/6bb73113-d5ad-55b7-9619-608c6eaa77e8/scratchpad'
const BRIEF = SCRATCH + '/BRIEF.md'

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    gates: {
      type: 'object',
      properties: {
        typecheck: { type: 'string' },
        unitTests: { type: 'string' },
        build: { type: 'string' },
        smoke: { type: 'string' },
      },
    },
    contractRequests: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files', 'gates', 'openIssues'],
}

const GAPS = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          area: { type: 'string' },
          problem: { type: 'string' },
          proposedChange: { type: 'string' },
        },
        required: ['severity', 'area', 'problem', 'proposedChange'],
      },
    },
    overallAssessment: { type: 'string' },
  },
  required: ['gaps', 'overallAssessment'],
}

const ARCH_PROMPT = [
  'You are the lead engine architect of STATIC HORIZON, an original browser FPS. First read the production brief: ' + BRIEF + ' (read all of it, carefully).',
  '',
  'Repo: /home/user/Testing-2. It already contains package.json (dependencies installed: three 0.187, typescript, vite, vitest), tsconfig.json (strict, verbatimModuleSyntax -> use "import type" for type-only imports), vite.config.ts, .gitignore. Nothing else. Do not change those four files. Do not run any state-changing git command. Do not install packages.',
  '',
  'YOUR JOB: build the FOUNDATION: the frozen code contract plus a walking skeleton (a runnable gray-box game). Immediately after you, about twelve engineers will each replace one stub system with a full production implementation, IN PARALLEL, WITHOUT TALKING TO EACH OTHER. They will only have the brief and your code. Whether their work integrates on the first try depends entirely on how complete, precise and well-documented your interfaces are. Think like the person who will be blamed for every integration bug. Spend your effort on the contract; keep stubs tiny.',
  '',
  '=== DELIVERABLES ===',
  '',
  '1) index.html + src/main.ts. index.html: a full-viewport app shell (#app > canvas#game + div#ui), obeys the sandbox rules in brief section 2 (height:100% on html/body, color-scheme dark, colour tokens on :root, explicit body background, safe-area aware). A minimal inline boot/loading state so the first paint is never blank, plus a visible fatal-error panel (WebGL2 unavailable, uncaught init error) written in plain language. Title: "Static Horizon".',
  '',
  '2) src/core/types.ts: THE CONTRACT. One file, heavily doc-commented (units, ownership, who calls it, when, invariants). It must define at least:',
  '   - id unions: WeaponId (vector|breaker|lance|hornet), EnemyType (skitter|riveter|wasp|tick|lancer|bulwark|conductor), ZoneId (deck|refinery|spire), PickupType, PerkId, Difficulty, GameMode (boot|menu|playing|paused|gameover|victory), DirectorPhase (idle|warmup|combat|cleared|supplyDrop|perkSelect|intermission|bossIntro|boss|done), TimeOfDayId (dusk|twilight|stormnight|eclipse), DamageType, Faction, HitPart (body|weak|shield|armor), QualityPreset (low|medium|high|ultra), InputAction, LookMode, MusicState, ProjectileKind, and two BIG exhaustive unions FxId and SoundId covering every effect and sound the brief implies (every weapon: fire/reload stages/dry/switch/charge; player: footsteps, jump, land, slide, dash, hurt, shield break/recharge, low health, overclock start/loop/end, melee swing/hit; every enemy: spawn, idle motif, attack telegraph, attack, hurt, death; boss per-phase attacks; explosions small/large/plasma/shock; impacts per surface; pickups; gates; supply drop; UI hover/click/confirm/back/perk; wave start/clear stingers; lightning/thunder; etc). Be generous: a missing id blocks a parallel engineer.',
  '   - System lifecycle interface: init (once), reset (start of every run; must restore pristine state), update(dt), optional lateUpdate, optional onModeChange, dispose. Document exactly which systems update in which GameMode and the frame order.',
  '   - GameContext: scene, camera, viewScene + viewCamera (first-person weapon layer rendered after the world with cleared depth), canvas, uiRoot, events, input, settings, storage, rng, time, mods, game (state machine facade), and every system interface: collision, nav, world, render, player, weapons, combat, enemies, director, fx, audio, ui.',
  '   - TimeState: now (sim seconds), dt (scaled world dt), unscaledDt, scale, frame; layered time-scale requests keyed by source (overclock, hitstop, slowmo, perkSelect -> effective scale is the min); hitstop(seconds). Define clearly which systems use dt vs unscaledDt (player movement/look, weapons handling and UI use unscaled-with-pause; world/enemies/projectiles/fx use scaled).',
  '   - Typed EventMap + EventBus (on/once/off/emit, returns unsubscribe). Events for: game mode changes, run start/end, wave start/clear, director phase, intermission, enemy spawned/damaged/killed (with type, position, weapon, crit, score), player damaged (with direction for indicators)/healed/died/shield broken/shield recharged, weapon fired/reload start/reloaded/switched/unlocked/empty, hit confirmed (hitmarker: crit/kill/shield), pickup spawned/collected, perk offered/chosen, score and combo changes, multikill callouts, announce (banner text), zone unlocked, gate state, supply drop, boss spawned/phase/defeated, overclock start/end/ready, time-of-day change, settings change, input device/look-mode change, quality change.',
  '   - Input: actions (isDown/justPressed/justReleased), move axes combined across devices, look delta consumption, capture (pointer lock) request/release with graceful fallback look modes (locked | free = unlocked mouse movement + edge-turn + arrow keys | touch | gamepad), virtual buttons/axes/look for touch UI and the bot, last active device, binding labels for UI prompts, per-frame poll/endFrame.',
  '   - Settings (sensitivity, invertY, fov, master/music/sfx volume, quality, screen-shake scale, reduce-flashes, show fps, aim assist, difficulty last used) with persistence + change events; Storage wrapper (try/catch, in-memory fallback); best score / best wave persistence.',
  '   - CollisionWorld: static AABB boxes with flags/masks (solid, player-clip, enemy-clip, blocks-projectiles, blocks-sight), enable/disable by id (gates), move-and-slide for an AABB with auto step-up returning grounded/hit info, raycast (slab) with mask and hit normal, overlap queries, iteration for the minimap, world bounds.',
  '   - NavGrid: 2.5D grid (1 m cells) with walkable + height per cell, built from the collision world plus world hints; shared flow field toward a target (update request, sample direction, distance-to-target), A* path, random reachable point in an annulus, region walkability toggle (gates), zone id per cell, line-of-sight helper.',
  '   - WorldSystem: bounds, zones (name, aabb, unlocked), player start, spawn points by zone and kind (ground|air|heavy), drop pads, gates (open/close), zoneAt, groundHeightAt, boss arena, cinematic camera path points for the menu, minimap footprint data, jump pads/hazards handled internally.',
  '   - RenderSystem: renderer access, render(), resize, quality presets + dynamic resolution, mutable PostFx params (damage flash, low health, overclock, dash blur, flash colour, chromatic boost, saturation, exposure), time-of-day set/transition + readable lighting state (sun direction/colour, ambient) for other systems, lightning flash, worldToScreen helper, render stats, cinematic camera ownership when not playing.',
  '   - PlayerSystem: feet position, eye position, velocity, yaw/pitch, forward, grounded/crouching/sliding/sprinting, hp/shield with maxima, alive, invulnerability, takeDamage(DamageInfo) -> DamageResult, heal, addShield, launch(velocity), teleport, setLook, getAimRay, addRecoil, addShake(trauma), ads coupling (weapons sets ads amount + zoom; player applies fov + speed), dash state, Overclock state (charge, active, time left, addCharge), speed multipliers.',
  '   - WeaponSystem: per-weapon runtime state (unlocked, mag, reserve, reloading + progress, charge), current weapon, unlock, switchTo, addAmmo, refill, grenades count/cap, crosshair spread, ads amount, shots-fired/hit counters.',
  '   - CombatSystem: HitTarget registration (id, faction, alive, world-space hit spheres with HitPart, takeDamage callback), traceShot against world + targets (nearest), piercing trace (all targets along a ray until world), applyDamage, explode (radial damage with falloff, LOS, self-damage multiplier, owner, visual size) which owns its own fx/audio/shake, projectile spawning (kind, position, velocity, faction, damage, splash, gravity, bounce, fuse, homing, owner) with combat owning projectile simulation + visuals, radius queries, player registered as a target for enemy fire.',
  '   - EnemySystem: spawn(type, position, opts) -> EnemyHandle, live list, alive count, per-type count, nearest query, radius query, killAll, boss handle (name, hp, maxHp, phase), enemy kind registry so kinds live in separate files. EnemyHandle: id, type, position, velocity, radius, height, hp, maxHp, alive, aimPoint, zone, isBoss.',
  '   - DirectorSystem: startRun(difficulty), wave index/total, phase, enemies remaining, intermission time left, score, combo (multiplier, time left, count), run stats (kills, shots, hits, accuracy, crits, damage dealt/taken, time, best combo, perks, grade), current perk offer + choosePerk(index), owned perks with stacks, live pickups list, current objective (text + optional world position), debug skip-to-wave.',
  '   - Modifiers (ctx.mods): plain mutable struct written by perks, read by player/weapons/director; reset every run. Cover every perk in the brief.',
  '   - FxSystem: spawn(FxId, position, opts {normal, dir, scale, color}), tracer, beam (with duration), decal, damageNumber, pooled dynamic light flash, ground telegraph ring/circle handle (position, radius, duration, colour, cancel), lightning bolt, trail attach/detach handles for projectiles, weather set, clear.',
  '   - AudioSystem: unlock on gesture, play (2D), playAt (3D), loops with handles (position, volume, pitch, stop with fade), listener update, music state + intensity, volumes from settings, global pitch/filter follow of time scale, stopAll.',
  '   - UiSystem: lifecycle, fatal error display, whether UI currently wants the pointer free.',
  '   - Data table types: WeaponDef, EnemyDef, WaveDef (timed spawn groups by type/count/zone), PerkDef, DifficultyDef, PickupDef, TimeOfDay schedule by wave.',
  '   - DamageInfo / DamageResult, the DebugApi type of window.__SH.',
  '   Design every interface for the FULL game in the brief, not for your stubs. Prefer plain data + small methods. Vectors passed in are never retained by the callee unless documented; "out" parameters for results to avoid allocation. Document the Feedback ownership rule (brief section 6) next to FxSystem/AudioSystem, including the short explicit list of events FX/Audio/Render ARE allowed to react to (game mode, wave/boss/time-of-day state for music, weather and lighting).',
  '',
  '3) src/core/*: real, complete implementations of: events.ts, context creation, game.ts (state machine boot->menu->playing<->paused->gameover|victory, frame pipeline with the documented update order, dt clamp to 1/30 with up to 3 substeps, error containment: a throwing system is reported to __SH.errors and the fatal panel, never a silent dead loop), loop.ts (requestAnimationFrame loop, plus MANUAL mode when the URL has ?test=1 where the simulation only advances through __SH.step), input.ts (COMPLETE and production quality: keyboard, mouse, wheel, pointer lock with rejection handling and re-lock cooldown tolerance, automatic fallback to free look when lock is unavailable, gamepad with deadzones and standard mapping, virtual inputs, preventDefault on game keys, auto-pause when capture is lost unexpectedly or the tab is hidden, but NOT when the game released capture on purpose e.g. perk select), settings.ts, storage.ts, math.ts (damp, clamp, lerp, angle helpers, safe normalise), rng.ts (seeded), pool.ts, palette.ts (the colour script from the brief as constants), time handling, debug.ts.',
  '',
  '4) src/core/debug.ts: window.__SH with: ready flag, errors array (window error + unhandledrejection + contained system exceptions), ctx, state() JSON snapshot (mode, phase, wave, score, combo, enemies alive, player pos/hp/shield/overclock, weapon id/mag/reserve, fps, draw calls, triangles, sim time), start(difficulty), step(seconds, {render, dt}) for manual mode, renderFrame(), god(on), giveAll(), setWave(n), spawn(type,x,y,z), killAll(), teleport, look(yaw,pitch), lookAtPoint, press(action, seconds), setCamera(pos,target)/releaseCamera() free camera override for screenshots, setTimeOfDay, hideUi(on), setQuality, damagePlayer, choosePerk, unlockZone, bot(on, opts). The BOT is an autopilot that plays through ctx interfaces + virtual input: aims at the nearest visible enemy aimPoint, fires, reloads, cycles unlocked weapons, moves/strafes using the nav grid, walks to pickups, picks perks, occasionally dashes, throws grenades, melees and triggers Overclock, so every code path gets exercised in soak tests.',
  '',
  '5) src/data/*.ts: typed baseline tuning tables filled with the numbers from the brief (weapons, enemies, 10 waves, perks, difficulties, pickups, time-of-day schedule).',
  '',
  '6) src/physics/ and src/nav/: put the interfaces in types.ts and write simple-but-correct baseline implementations (brute-force is fine). Another engineer hardens and unit-tests them right after you.',
  '',
  '7) One STUB per remaining system, each exactly at src/<dir>/index.ts exporting a factory "create<Name>System(ctx)" that returns the interface: world, render, player, weapons, combat, enemies, director, fx, audio, ui. Stubs are tiny (aim for well under 150 lines each), start with the comment "// STUB: replaced by the <dir> team", and are just functional enough for a gray-box loop: flat floor + a few boxes + one gate, basic renderer without post, walking/jumping player with mouse look, hitscan rifle, capsule enemies that walk at the player and hurt on contact, a director that runs the wave table through spawn/clear/perk/intermission and reaches victory, no-op fx/audio that still satisfy the interface, a bare-bones DOM UI (start button with difficulty, text HUD, perk choice buttons, pause, game over/victory with restart).',
  '',
  '8) tools/ (plain Node ESM .mjs; get Playwright with createRequire(import.meta.url)("playwright") because it is installed globally, NOT in package.json; chromium.launch() needs no options and WebGL2 works headless via SwiftShader; import vite normally):',
  '   - tools/harness.mjs: launchGame({mode: "dev"|"dist", port, width, height, touch, query}) -> {page, errors, sh(fn,...args), step(seconds, opts), shot(file), close}. dev mode starts a Vite dev server programmatically on the given port with strictPort and its own cacheDir (node_modules/.vite-<port>) so several agents can run servers at once; dist mode serves ./dist with a tiny static server. Always loads the page with ?test=1, collects console errors + page errors, waits for __SH.ready.',
  '   - tools/smoke.mjs [--mode dev|dist] [--port N]: boots, checks menu mode, starts a run, steps, verifies movement input moves the player, firing consumes ammo, a spawned enemy can be killed and raises score, killAll advances the wave flow through perk choice to the next wave, pause/resume works, restart twice leaves clean state, no errors. Prints a JSON result and exits non-zero on failure.',
  '   - tools/campaign.mjs [--mode] [--port] [--god 0|1]: runs the bot through the whole campaign in manual stepping with rendering mostly skipped (render one frame every N steps), reports per-wave sim time, final mode, errors, NaN checks on player/enemy positions; fails on stall or error.',
  '   - tools/shots.mjs --out <dir> [--mode] [--port] [--size WxH]: a screenshot tour (menu, gameplay in each zone and time-of-day, each enemy type lined up in front of the camera, each weapon viewmodel, perk screen, pause, game over, victory, plus a 390x844 touch layout).',
  '',
  '=== GATES (all must pass before you finish) ===',
  'npx tsc --noEmit  (zero errors)  |  npm run build  |  node tools/smoke.mjs --mode dist  |  node tools/campaign.mjs --mode dist --god 1  (bot reaches victory). Use dev-server port 5200 if you need one. Put temporary files only under ' + SCRATCH + '/foundation. Clean up any processes you start.',
  '',
  'Report: summary, files written, gate results (exact pass/fail), and openIssues (anything in the contract you are unsure about).',
].join('\n')

const PHYS_PROMPT = [
  'You are the physics and navigation engineer of STATIC HORIZON. Read the brief: ' + BRIEF + ' . Then read src/core/types.ts fully (the frozen contract) and the baseline code in src/physics/ and src/nav/ in /home/user/Testing-2.',
  '',
  'You OWN src/physics/** and src/nav/** (including tests). Replace the baseline with production implementations of the CollisionWorld and NavGrid interfaces exactly as declared in src/core/types.ts. You may NOT edit anything else; if the contract is missing something you need, work within it and list the request in contractRequests.',
  '',
  'CollisionWorld requirements: thousands of static AABBs with a uniform-grid (or BVH) broadphase; robust swept move-and-slide for an AABB character (no tunnelling at 30 m/s with dt up to 1/30, no sticking on seams between adjacent boxes, no jitter standing on edges, slides along walls, ceiling bumps cancel upward velocity), automatic step-up to the documented height with correct grounded reporting, step-down snapping when walking down stairs (so stair-stepped ramps feel smooth), enable/disable boxes (gates) reflected immediately in all queries, slab raycasts with correct normals and mask filtering (starting inside a box must be handled deterministically), sphere/box overlap queries, zero allocations per query (out params / reused scratch).',
  '',
  'NavGrid requirements: build from the collision world + world hints as the contract defines; per-cell walkability with agent-radius clearance and height, connectivity only across height differences an agent can step; Dijkstra flow field toward a target position that 60+ agents can sample each frame (bilinear or neighbour-smoothed direction so agents do not zig-zag; agents in unwalkable cells get steered back to the nearest walkable cell), time-sliced or cheap enough to rebuild several times per second on a 150 x 90 grid (measure it; target < 2 ms per rebuild), A* path query with string-pulling or simple smoothing, random reachable point in an annulus, region toggles for gates that invalidate the flow field, line of sight via the collision raycast, zone lookup.',
  '',
  'Write thorough vitest unit tests next to the code (src/physics/*.test.ts, src/nav/*.test.ts): sweeps, corner cases, seams, step-up/step-down, tunnelling, raycast normals/masks/inside-start, disabled boxes, flow-field correctness around obstacles and through gates, unreachable targets, path validity, performance assertions with generous margins. Run: npx vitest run src/physics src/nav. Type-check only your dirs: npx tsc --noEmit 2>&1 | grep -E "^src/(physics|nav)/" must print nothing.',
  '',
  'Do not run npm run build. Do not run git state-changing commands. Temp files only under ' + SCRATCH + '/physics. Report summary, files, gates (typecheck, unitTests with counts), contractRequests, openIssues.',
].join('\n')

const CRITIC_COMMON = [
  'You are a senior gameplay/engine engineer doing a pre-implementation contract review for STATIC HORIZON. Read the brief: ' + BRIEF + ' . Then read, completely: src/core/types.ts, every other file in src/core/, src/data/, and skim every stub src/*/index.ts and tools/ in /home/user/Testing-2.',
  '',
  'Context: right after your review, separate engineers will implement each system below IN PARALLEL with no communication, coding only against src/core/types.ts. Any gap you miss becomes an integration bug. DO NOT EDIT ANY FILE. You are read-only.',
  '',
  'For each system listed below, mentally implement the full production version described in the brief, step by step, and write down every place where the contract is missing, ambiguous, wrong or awkward: a method/field/event/enum member you would need (check FxId and SoundId exhaustively against what your systems must trigger), unclear units or coordinate conventions, unclear ownership (who creates/destroys/updates, who triggers the fx/audio for a moment), lifecycle holes (reset between runs, mode changes, pause), update-order problems (one-frame lag, stale reads), time-scale semantics (Overclock: world slowed, player not), performance traps (APIs that force allocation or O(n^2)), things two systems would both do or neither would do, debug/test API holes that block automated verification, and over-engineering that should be deleted. Also review src/core implementations (game.ts frame pipeline, input.ts pointer-lock/fallback logic, time scaling, error containment, the bot) for real bugs.',
  '',
  'Output concrete findings: severity (blocker = an engineer cannot build the feature; major = will cause an integration bug or bad feel; minor = polish), area, problem, and proposedChange written as exact TypeScript signatures / event payloads / enum members to add or change. No vague advice. Aim for completeness: 15-40 findings is normal.',
].join('\n')

const CRITIC_GAMEPLAY = CRITIC_COMMON + '\n\nYOUR SYSTEMS: player (movement, camera feel, vitals, dash, Overclock), weapons (4 guns, viewmodels in the view scene, ADS, recoil, grenades, melee), combat (hit volumes, traces, damage pipeline, projectiles incl. homing/bouncing/mortars, explosions), enemies (manager, 6 kinds with distinct AI, attack tokens, lightning-strike spawning), the boss THE CONDUCTOR (3 phases, sweep laser, lightning strikes, shock rings, summons, weak points, staged death), director (waves, spawn placement, pickups, perks -> modifiers, score/combo/multikills, supply drops and weapon unlocks, zone unlocks, perk select flow with frozen world, intermission, objectives, run stats and grade), and the autopilot bot.'

const CRITIC_PRESENTATION = CRITIC_COMMON + '\n\nYOUR SYSTEMS: world (three-zone level built from boxes, stair-stepped ramps, gates, hazards, jump pads, spawn points, drop pads, minimap data, materials and procedural textures), render (renderer, sky dome, sun + shadows, time-of-day transitions, lightning, post-processing chain with the view-scene composite, quality presets, dynamic resolution, menu/death/victory cinematic cameras), fx (particles, tracers, beams, decals, damage numbers, telegraph rings, lightning bolts, trails, weather, fixed light pool, everything other systems will call), audio (synth engine, every SoundId, 3D voices, loops, adaptive music states and intensity, time-scale pitch, volumes), ui (boot, main menu with difficulty and settings, HUD with vitals/ammo/crosshair/hitmarkers/damage direction/wave/score/combo/objective/boss bar/minimap/pickup and kill feed/announcer banners, perk select, pause, settings, game over and victory stats, touch controls, gamepad and keyboard navigation, binding prompts), input and platform robustness (pointer lock fallback, sandboxed iframe, phone), and the tools/ harness.'

phase('Architect')
const arch = await agent(ARCH_PROMPT, { label: 'architect', phase: 'Architect', schema: REPORT })
if (!arch) throw new Error('architect agent failed')
log('Architect done: ' + arch.summary.slice(0, 300))

phase('Harden')
const [phys, cg, cp] = await parallel([
  () => agent(PHYS_PROMPT, { label: 'physics+nav', phase: 'Harden', schema: REPORT }),
  () => agent(CRITIC_GAMEPLAY, { label: 'critic:gameplay', phase: 'Harden', schema: GAPS }),
  () => agent(CRITIC_PRESENTATION, { label: 'critic:presentation', phase: 'Harden', schema: GAPS }),
])
const gaps = [cg, cp].filter(Boolean).flatMap(c => c.gaps)
log('Contract gaps found: ' + gaps.length + ' (blockers: ' + gaps.filter(g => g.severity === 'blocker').length + ', major: ' + gaps.filter(g => g.severity === 'major').length + ')')

phase('Finalize')
const FINALIZE_PROMPT = [
  'You are the lead engine architect of STATIC HORIZON finishing the FOUNDATION before a dozen engineers build on it in parallel. Read the brief: ' + BRIEF + ' . Then read all of src/core/, src/data/, src/physics/, src/nav/, the stubs src/*/index.ts and tools/ in /home/user/Testing-2.',
  '',
  'Two reviewers examined the contract from the point of view of the engineers who must implement every system, and the physics/nav engineer filed requests. Their findings are below as JSON. Your job: make the contract complete and unambiguous, then prove the skeleton still works.',
  '',
  '- Apply every blocker and major finding unless it is factually wrong (if you reject one, say why in openIssues). Apply minor findings when they are cheap and clearly right. Where two findings conflict, choose the simpler contract. Do not add speculative features beyond the brief.',
  '- Keep src/core/types.ts as the single source of truth with precise doc comments (units, ownership, call timing, time-scale semantics). After you finish it is FROZEN.',
  '- Update core implementations, data tables, stubs, the bot, debug API and tools to match. The physics/nav implementations in src/physics and src/nav were just rewritten by their engineer with unit tests: adapt them only as far as contract changes require and keep their tests passing.',
  '- Fix real bugs the reviewers found in core (frame pipeline, input capture/fallback, time scaling, error containment).',
  '- Do not run state-changing git commands; do not install packages; do not edit package.json/tsconfig/vite config.',
  '',
  'GATES (all must pass): npx tsc --noEmit (zero errors) | npx vitest run | npm run build | node tools/smoke.mjs --mode dist | node tools/campaign.mjs --mode dist --god 1 (bot reaches victory) | node tools/shots.mjs --mode dist --out ' + SCRATCH + '/foundation/shots (look at two or three of the PNGs with the Read tool to confirm the page really renders). Temp files only under ' + SCRATCH + '/foundation. Clean up processes you start.',
  '',
  'Report: summary of contract changes, files, exact gate results, openIssues (including rejected findings with reasons).',
  '',
  'PHYSICS/NAV ENGINEER REPORT:',
  JSON.stringify(phys || { note: 'physics agent returned nothing; verify src/physics and src/nav yourself and harden if weak' }, null, 1),
  '',
  'REVIEW FINDINGS:',
  JSON.stringify(gaps, null, 1),
].join('\n')
const fin = await agent(FINALIZE_PROMPT, { label: 'finalize-contract', phase: 'Finalize', schema: REPORT })

return { arch, phys, gapCount: gaps.length, gaps, fin }
