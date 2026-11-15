/**
 * STATIC HORIZON — THE CODE CONTRACT.
 *
 * This file is types only (no runtime code). Import with `import type { ... } from '../core/types'`.
 * It is FROZEN: nobody edits anything under src/core. If you believe it needs a change, finish your work
 * against it and report the request. Where the brief or an assignment text differs from this file, this
 * file wins.
 *
 * Runtime companions living next to it:
 *   - core/constants.ts  id lists, collision flag bits, pipeline constants, FX_STREAM_IDS, FX_CAPS,
 *                        RENDER_ORDER, PLAYER numbers
 *   - core/make.ts       allocation helpers for the plain-data structs below (DamageInfo, RayHit, ...)
 *   - core/math.ts       damp / clamp / angle helpers, yawPitchToDir, safe normalise
 *   - core/palette.ts    the colour script
 *   - data/*.ts          tuning tables typed by the *Def interfaces at the end of this file
 *
 * PARALLEL-WORK CONVENTIONS (exact paths and export names; this is what keeps independent work from colliding)
 *   - One owner per directory. Each owner replaces `src/<dir>/index.ts` and keeps its factory export, which
 *     src/main.ts imports by exactly this name:
 *       src/world    createWorldSystem      src/render   createRenderSystem    src/fx       createFxSystem
 *       src/audio    createAudioSystem      src/combat   createCombatSystem    src/player   createPlayerSystem
 *       src/weapons  createWeaponSystem     src/enemies  createEnemySystem     src/director createDirectorSystem
 *       src/ui       createUiSystem
 *     All take `(ctx: GameContext)` and return the system interface of this file. Further files of a system
 *     live in its own directory. src/physics (createCollisionWorld) and src/nav (createNavGrid) are finished.
 *   - ENEMIES is written by three engineers ONE AFTER ANOTHER in src/enemies. The layout is fixed:
 *       src/enemies/index.ts               the manager (EnemySystem); first engineer
 *       src/enemies/kinds/<type>.ts        ONE file per EnemyType, exporting `export const <type>Kind: EnemyKind`
 *                                          — skitterKind, tickKind, riveterKind (first engineer), waspKind,
 *                                          lancerKind, bulwarkKind (second), conductorKind (third)
 *       src/enemies/kinds/index.ts         `export const ENEMY_KINDS: readonly EnemyKind[]` — the ONLY place a
 *                                          kind is registered: one import line + one array entry per kind
 *       src/enemies/kinds/placeholder.ts   `export function placeholderKind(type: EnemyType): EnemyKind` — the
 *                                          gray-box stand-in. The manager's init() registers every entry of
 *                                          ENEMY_KINDS and then placeholderKind(type) for each EnemyType that
 *                                          is still missing, so all ten waves stay playable at every stage
 *       src/enemies/boss/**                helper files of the conductor kind only
 *     Kinds talk to the manager only through EnemyActor / EnemyBehavior and the EnemySystem services.
 *   - Unit tests: `src/<dir>/*.test.ts` (vitest, node environment: no DOM, no WebGL, no AudioContext).
 *   - tools/ belongs to core; the audio owner may add tools/audio-check.mjs.
 *
 * DATA TABLES (src/data)
 *   The table TYPES (section 24) are frozen. The table VALUES are tuned by their owning team in the next
 *   phase — everyone else reads them and never hard-codes a copy of a number:
 *     weapons.ts -> weapons team · enemies.ts -> enemies teams (each engineer only the rows of the kinds
 *     he builds; he may ADD keys to that row's `tuning`) · projectiles.ts -> combat team ·
 *     waves.ts, perks.ts, pickups.ts, difficulty.ts -> director team · timeOfDay.ts, quality.ts -> render team.
 *   Exported names and shapes of the tables never change.
 *
 * GLOBAL CONVENTIONS
 *   - Units: metres, seconds, radians. Y is up. Right-handed (three.js). Player yaw 0 looks down -Z,
 *     positive yaw turns LEFT (counter-clockwise seen from above), positive pitch looks UP.
 *     forward(yaw,pitch) = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)).
 *   - Colours passed as numbers are 0xRRGGBB (sRGB hex), exactly like `new THREE.Color(hex)`.
 *   - Vectors and option objects passed INTO a method are read during the call and never retained by the
 *     callee unless the doc says "retained". Callers in update paths reuse module-level objects.
 *     Results are written into caller-provided "out" objects so hot paths never allocate.
 *   - Vector3 properties exposed by a system (e.g. `player.position`) are LIVE and READ-ONLY for everyone
 *     except the owning system: read them, copy them, never write them, never keep them across a reset.
 *   - Event payloads and returned result structs may be reused by the emitter/callee: copy what you keep.
 *   - Ids: `ctx.nextId()` hands out unique positive integers. 0 always means "none / the world".
 *   - Factories `createXSystem(ctx)` must only store `ctx`. Other systems are not constructed yet at that
 *     point; touch them from `init()` onwards.
 *   - Randomness: gameplay uses ctx.rng, presentation (fx, audio, render, ui, cosmetic animation) uses
 *     ctx.cosmeticRng. Nobody calls Math.random (screenshots and soak runs must be repeatable).
 *   - Sandboxed embedding: the game also ships as one inline page inside a sandboxed frame. No query string,
 *     pointer lock and fullscreen may be refused, localStorage may throw (use ctx.storage only), and
 *     alert/confirm/prompt/window.open are forbidden. Nothing may depend on any of them.
 *
 * FRAME PIPELINE (implemented in core/game.ts — the single source of truth for ordering)
 *
 *   frame(realDt):                                   realDt is clamped to [0, 0.1]
 *     pending canvas resize -> render.resize() + 'view:resize'   (never between a draw and its paint)
 *     input.poll(realDt)
 *     core hotkeys: `pause` action toggles playing <-> paused (unless ui.consumesPauseAction())
 *     pointer policy (see Input.requestCapture)
 *     substeps = playing/menu/gameover/victory ? min(3, ceil(realDt / (1/30))) : 1
 *     for each substep (stepDt = realDt / substeps, so stepDt <= 1/30):
 *        time.advance(stepDt)                        fills dt / unscaledDt / playerDt / scale / now / substep
 *        mode === 'playing' and NOT hard-frozen (time.scale > 0):
 *            player.update(unscaledDt)   -> weapons.update(unscaledDt)
 *            enemies.update(dt)          -> combat.update(dt) -> world.update(dt)
 *            director.update(dt)         -> fx.update(dt)
 *            then lateUpdate in the same order for systems that define it
 *        mode === 'playing' and hard-frozen (time.scale === 0, e.g. perk select):
 *            director.update(0), in the FIRST substep of the frame only (it polls perk1..3)
 *        mode === 'gameover' | 'victory':
 *            enemies.update(dt) -> combat.update(dt) -> world.update(dt) -> fx.update(dt)  (+ lateUpdate)
 *        mode === 'menu':
 *            world.update(dt) -> fx.update(dt)        (+ lateUpdate)
 *        mode === 'paused' | 'boot':  nothing
 *        (input edges — justPressed/justReleased — and look deltas are only visible in the FIRST substep)
 *     render.update(realDt) -> audio.update(realDt) -> ui.update(realDt)        every frame, every mode
 *     render.render()
 *     input.endFrame()
 *
 * LIFECYCLE ORDER
 *   init  : world -> (core builds ctx.nav from ctx.collision + world.navHints()) -> render -> fx -> audio
 *           -> combat -> player -> weapons -> enemies -> director -> ui -> core warms every shader
 *           (ctx.render.warm(ctx.scene) and warm(ctx.viewScene, 'view'), see RenderSystem.warm)
 *   reset : AUDIO FIRST, then world -> render -> fx -> combat -> player -> weapons -> enemies -> director
 *           -> ui. Called once right after boot, before every run and when returning to the menu. Core resets
 *           ctx.time, ctx.mods and the virtual input BEFORE the systems.
 *
 * CLOCKS (see TimeState)
 *   - player, weapons            : ctx.time.unscaledDt  (full speed during Overclock / slow motion)
 *   - enemies, combat, world,
 *     director, fx               : ctx.time.dt          (scaled world time)
 *   - render, audio, ui          : ctx.time.realDt      (never stops, also while paused / in menus)
 *   Things inside world-clock systems that belong to the player run on ctx.time.playerDt instead
 *   (= unscaledDt while playing, dt in every other mode): player-faction projectiles (combat), effects
 *   spawned with clock 'player' (fx), corpse timers (enemies), the death delay and the boss-defeat wait
 *   (director). Timers that must run during the perk-select hard freeze compare ctx.time.elapsed stamps.
 *   update(dt) may receive dt === 0 (hard freeze, manual frame(0)): never divide by dt.
 *
 * FEEDBACK OWNERSHIP RULE (who triggers FX + audio — exactly one owner per moment, nothing double-fires)
 *   The gameplay system that owns a moment calls ctx.fx / ctx.audio / ctx.render explicitly. Every FxId,
 *   SoundId and LoopId below is declared inside the union of its ONE owner (WeaponsFxId, CombatSoundId ...);
 *   the Shared* unions are building blocks for whoever owns the moment they describe.
 *   - weapons : muzzle flash, fire/reload/dry/switch sounds, tracers and beams of player shots, casings,
 *               WORLD-surface impacts of player hitscan / beam / melee (shared impact ids + decal), recoil,
 *               melee swing, chain-lightning arcs, explosive-crit blasts (through combat.explode).
 *   - combat  : everything about a HIT ON AN ENEMY TARGET by the player (hit spark by HitPart, damage
 *               number, hit-confirm sound, 'hit:confirmed'); every explosion (combat.explode owns flash,
 *               particles, decal, sound, light, shake, rumble); projectile visuals, trails, fly loops,
 *               bounces, whiz-by, landing telegraphs and projectile impacts on the world. Combat plays NO
 *               launch sound: the shooter does.
 *   - enemies : manager — spawn arrival (telegraph ring, bolt, flash, `<type>Spawn` sound); kinds — idle
 *               motifs, attack telegraphs, attack + launch sounds/fx, hurt flash + hurt sound of the
 *               victim, death fx + sound, boss staging.
 *   - player  : footsteps, jump/land/slide/dash, everything about a hit ON THE PLAYER (hitPlayer fx, hurt +
 *               shield sounds, damage flash), heal / life-steal pulse, Overclock treatment, low-health
 *               state, camera shake, its ctx.render.post fields, audio.setMuffle.
 *   - director: wave stingers, countdown ticks, `announce` banners, pickups, supply drops, the perk-pick
 *               sound, combo / multikill sounds.
 *   - world   : gates, zone unlock, jump pads, hazards, beacons, fall-out respawn.
 *   - ui      : its own interface sounds (hover, click, pause, perk offer, run start, end-screen reveal).
 *   - fx      : the ambient storm only (weather one-shots: thunder, crackle, gusts).
 *   - audio   : music, stingers of the music state machine, continuous wind / static-rain beds.
 *   FX and AUDIO never subscribe to gameplay events to spawn effects or sounds. The ONLY events they
 *   (and RENDER) may react to are:
 *     'game:mode', 'run:start', 'run:end', 'settings:changed', 'quality:changed', 'view:resize',
 *     'timeOfDay:changed' (fx: weather, audio: wind/ambience beds),
 *     'wave:start', 'wave:clear', 'director:phase', 'boss:spawned', 'boss:phase', 'boss:defeated'
 *       (audio only: adaptive MUSIC state/intensity — never one-shot sounds).
 *   UI is the opposite: gameplay never calls UI. UI reads ctx state every frame and listens to events.
 *
 * LEVELS, IMPULSES AND HANDLES THAT OUTLIVE THEIR OWNER
 *   - A LEVEL (PostFxParams levels, audio.setMuffle, player.setSpeedMultiplier, time.setScale) has ONE
 *     writer. The owner writes it only while its effect is active and writes the default exactly once
 *     when the effect ends. PLAYER and WEAPONS implement onModeChange: when the new mode is neither
 *     'playing' nor 'paused' they restore every level they own, stop their loops and clear their time
 *     scale (their update no longer runs, so nothing else would).
 *   - Everything positional that belongs to an entity (sounds, loops, beams, telegraphs, trails) is
 *     started with `owner: <entity id>`; the enemy manager / combat call ctx.audio.stopOwner(id) and
 *     ctx.fx.cancelOwner(id) when that entity dies or is removed, so a forgotten handle never hums on.
 *   - Gameplay systems never stop or restart loops for pause or the perk freeze: audio suspends them.
 *   - Persistent ambient loops (world, director) are acquired lazily inside update():
 *     `if (!handle.active && ctx.audio.unlocked) handle = ctx.audio.loop(id, opts)` — never in init() or
 *     reset() (audio is locked before the first gesture and reset() kills every loop).
 *
 * ERROR CONTAINMENT
 *   - Core wraps every System call (see System). On top of that the enemy manager wraps EVERY EnemyBehavior
 *     call and combat wraps its per-projectile step in try/catch: report with
 *     ctx.game.reportError('enemy:<type>' | 'projectile:<kind>', error), remove that one entity silently,
 *     never rethrow — one broken entity must not take the frame or the run down.
 *   - AudioSystem and FxSystem never throw from any public non-lifecycle method: they catch at the
 *     boundary, call ctx.game.reportError('audio' | 'fx', error) once and fall back to no-ops (shared dead
 *     handles). A sound or particle bug costs sound or sparks, never the run.
 *
 * RENDERING CONVENTIONS (so independently built meshes look like one game)
 *   - Colour: hex numbers are sRGB (three.js colour management on). Use core/palette.ts; the five accent
 *     colours carry gameplay meaning and must not be used for anything else.
 *   - Scene roots: each system adds exactly ONE root Object3D to a scene and names it after itself:
 *     'world', 'render' (sky + lights), 'fx' (incl. its 6 lights), 'combat', 'enemies', 'director' in
 *     ctx.scene; 'weapons' and 'render' (view light rig) in ctx.viewScene. window.__SH.budget() counts
 *     meshes and triangles per root against the budgets of the brief.
 *   - Lighting: NO system adds lights except render (sun + hemisphere in ctx.scene, a small rig in
 *     ctx.viewScene) and fx (its fixed pool of 6 point lights). Light count never changes at runtime.
 *   - Pipeline: render draws BOTH scenes into a linear HDR target (HalfFloat, RGBA8 fallback) on EVERY
 *     quality preset, including low; renderer.toneMapping stays NoToneMapping, and tone mapping + sRGB
 *     encoding happen only in render's final pass (this overrides "low preset: no composer" in the render
 *     assignment). Bloom acts above a linear luminance of ~1.0.
 *   - Glow: give a surface `emissive` + `emissiveIntensity` of 2..8 (or an additive MeshBasicMaterial with a
 *     colour multiplied above 1). Lit surfaces stay below 1 and never bloom. Do not set `toneMapped = false`.
 *   - Materials: shared MeshStandardMaterial instances for lit surfaces (no MeshPhysicalMaterial). Render
 *     sets scene.environment for both scenes. Materials are never shared between ctx.scene and ctx.viewScene.
 *   - Custom shaders (ShaderMaterial, onBeforeCompile): output LINEAR scene-referred colour and do NOT
 *     include the tonemapping_fragment / colorspace_fragment chunks. World-space ones set `fog: true`,
 *     merge THREE.UniformsLib.fog and include fog_pars_vertex / fog_vertex / fog_pars_fragment /
 *     fog_fragment. Hex colours reach uniforms and attributes only through `new THREE.Color(hex)`
 *     (sRGB -> linear). onBeforeCompile users set customProgramCacheKey.
 *   - Textures are created in init(). Canvas albedo / emissive textures: colorSpace = THREE.SRGBColorSpace;
 *     normal / roughness / data maps: NoColorSpace; anisotropy 4.
 *   - No shader recompiles after init(): never set material.needsUpdate, never add or remove a map, never
 *     toggle flatShading / vertexColors / alphaTest / transparent, never toggle light.visible or
 *     light.castShadow, never switch scene.fog or scene.environment between null and a value. Animate
 *     uniforms and numeric material properties only. Pooled objects are hidden, never created per frame;
 *     every system that pools hidden meshes calls ctx.render.warm(object) for one of each in init().
 *   - Transparency: every transparent or additive material sets depthWrite:false and its mesh sets
 *     `renderOrder` from RENDER_ORDER (core/constants.ts): SKY -100, OPAQUE 0, DECAL 10, TELEGRAPH 12,
 *     WORLD_TRANSPARENT 20, PICKUP 25, ENEMY_SHIELD 30, FX_ALPHA 40, BEAM 50, FX_ADDITIVE 60, WEATHER 70,
 *     DAMAGE_NUMBER 80. Decals and telegraphs also use polygonOffset(-2, -2). Batched / instanced meshes
 *     whose origin is not their content set frustumCulled = false. The sky uses depthTest:false and is
 *     excluded from fog.
 *   - Shadows: render owns the one shadow-casting sun. World geometry: castShadow + receiveShadow.
 *     Enemies: castShadow. Projectiles, fx, pickups and everything in ctx.viewScene: no shadows.
 *   - Fog/background/sky belong to render. Keep `material.fog` at its default (true) for world-space
 *     meshes so they sit in the atmosphere.
 *   - Everything a system adds to a scene is removed again in its dispose().
 */

import type * as THREE from 'three';

// ---------------------------------------------------------------------------------------------------
// 1. Primitive shapes
// ---------------------------------------------------------------------------------------------------

/** Anything with x/y/z. THREE.Vector3 satisfies it; so does a literal. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned box in world space, flat numbers (no allocation, JSON friendly). */
export interface Aabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Returned by every subscribe-style call; calling it more than once is a safe no-op. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------------------------------
// 2. Id unions
// ---------------------------------------------------------------------------------------------------

export type WeaponId = 'vector' | 'breaker' | 'lance' | 'hornet';
export type EnemyType = 'skitter' | 'riveter' | 'wasp' | 'tick' | 'lancer' | 'bulwark' | 'conductor';
/** West -> east. `deck` is unlocked at run start, `refinery` after wave 3, `spire` after wave 6. */
export type ZoneId = 'deck' | 'refinery' | 'spire';
/** `weapon` is the supply-drop crate (PickupState.weapon says which). */
export type PickupType = 'ammo' | 'health' | 'shield' | 'grenade' | 'weapon';
export type PerkId =
  | 'damage'
  | 'fireRate'
  | 'magSize'
  | 'reloadSpeed'
  | 'maxShield'
  | 'maxHealth'
  | 'shieldRegen'
  | 'moveSpeed'
  | 'doubleJump'
  | 'dashCharge'
  | 'lifeOnKill'
  | 'chainLightning'
  | 'explosiveCrits'
  | 'scavenger'
  | 'overclockGain'
  | 'grenadier'
  | 'critDamage'
  | 'lastStand';
export type Difficulty = 'recruit' | 'veteran' | 'nightmare';
export type GameMode = 'boot' | 'menu' | 'playing' | 'paused' | 'gameover' | 'victory';
/**
 * Run flow owned by the director:
 * idle -> warmup -> combat -> cleared -> [supplyDrop] -> perkSelect -> intermission -> combat ...
 * wave 10: intermission -> bossIntro -> boss -> done -> ctx.game.endRun(true).
 */
export type DirectorPhase =
  | 'idle'
  | 'warmup'
  | 'combat'
  | 'cleared'
  | 'supplyDrop'
  | 'perkSelect'
  | 'intermission'
  | 'bossIntro'
  | 'boss'
  | 'done';
export type TimeOfDayId = 'dusk' | 'twilight' | 'stormnight' | 'eclipse';
export type WeatherId = 'clear' | 'embers' | 'haze' | 'staticRain' | 'vortex';
export type DamageType =
  | 'bullet'
  | 'pellet'
  | 'rail'
  | 'explosion'
  | 'plasma'
  | 'laser'
  | 'melee'
  | 'shock'
  | 'contact'
  | 'chain'
  | 'fall'
  | 'hazard';
/** `neutral` = the world (hazards, fall damage); neutral damage hurts everyone. */
export type Faction = 'player' | 'enemy' | 'neutral';
/** body = x1, weak = crit (EnemyDef.weakMul), armor = reduced (EnemyDef.armorMul), shield = absorbed by an energy shield. */
export type HitPart = 'body' | 'weak' | 'shield' | 'armor';
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
/** What the user picks. 'auto' (the default) is resolved to a preset by render, once, in init(). */
export type QualitySetting = QualityPreset | 'auto';
export type InputDevice = 'keyboardMouse' | 'gamepad' | 'touch';
/**
 * locked  = pointer lock, raw mouse deltas.
 * free    = no pointer lock available: unlocked mouse movement over the canvas turns the view, the cursor
 *           near a screen edge keeps turning (edge-turn), arrow keys turn too. Fully playable.
 * touch   = look deltas come from the touch UI through Input.addVirtualLookPixels.
 * gamepad = right stick.
 */
export type LookMode = 'locked' | 'free' | 'touch' | 'gamepad';
export type MusicState = 'silent' | 'menu' | 'calm' | 'combat' | 'boss' | 'victory' | 'defeat';
export type SpawnKind = 'ground' | 'air' | 'heavy';
/** Collision surface material: drives footstep and impact fx/sound selection. */
export type SurfaceType = 'metal' | 'plating' | 'grate' | 'glass' | 'energy';
export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';
/** Per-kind defaults (radius, damage type, trail, loop, blast look) live in data/projectiles.ts. */
export type ProjectileKind = 'rocket' | 'grenade' | 'plasmaBolt' | 'lightBolt' | 'mortar' | 'bossBolt' | 'bossMissile';
/**
 * What dealt damage. Player sources are the four weapons plus the suit extras. 'world' marks
 * world-credited damage (hazards, fall, killAll, bounds cull, EnemySystem.kill): kills by it are never
 * rewarded — see 'enemy:killed'.
 */
export type DamageSource =
  | WeaponId
  | 'grenade'
  | 'melee'
  | 'chainLightning'
  | 'explosiveCrit'
  | 'enemy'
  | 'world';
/**
 * One owner per source: 'overclock' player · 'hitstop' anyone, through time.hitstop() only ·
 * 'slowmo' director (player-death slow motion) · 'bossStaging' the conductor kind (phase shifts, staged
 * death) · 'perkSelect' director (the hard freeze) · 'debug' window.__SH.
 */
export type TimeScaleSource = 'overclock' | 'hitstop' | 'slowmo' | 'bossStaging' | 'perkSelect' | 'debug';
export type ScoreReason = 'kill' | 'crit' | 'multikill' | 'waveClear' | 'flawless' | 'boss' | 'pickup' | 'bonus';
export type AnnounceStyle = 'wave' | 'clear' | 'info' | 'warning' | 'reward' | 'zone' | 'boss';
export type ExplosionVisual = 'none' | 'small' | 'large' | 'plasma' | 'shock' | 'boss';
export type DecalKind = 'bulletHole' | 'scorch' | 'plasmaBurn' | 'railBurn' | 'crack' | 'energyMark';
/** Ribbon trails. Combat attaches the projectile ones; `supply` is the director's falling supply pod. */
export type TrailKind = 'rocket' | 'grenade' | 'plasma' | 'bolt' | 'mortar' | 'missile' | 'bossBolt' | 'supply';
/**
 * rail = the player's LANCE shot (one-shot) · laser = an enemy hitscan beam shot (one-shot) ·
 * lockLaser = thin persistent tracking line (lancer) · sweep = thick persistent boss sweep laser.
 * Chain lightning is NOT a beam: it is fx.lightningBolt(from, to, { color: PALETTE.player, branches: 1,
 * light: false }) plus spawn('chainArc') at each victim.
 */
export type BeamKind = 'rail' | 'laser' | 'lockLaser' | 'sweep';
/**
 * Ground danger markers (all drawn flat on the floor, never thinned by quality settings):
 *   ring   static outline at `radius`
 *   circle outline + a disc that fills from the centre to `radius` as the progress runs
 *   spawn  double ring with rotating ticks (enemy arrival); default colour PALETTE.lightning
 *   strike disc + cross-hair (lightning strike)
 *   mortar disc + inward chevrons (lobbed shell)
 *   shock  thin bright outline drawn EXACTLY at `radius`, no fill — the owner drives it every frame with
 *          setRadius() so the visual equals its damage front (boss shock rings, bulwark stomp)
 * Every kind except `spawn` defaults to PALETTE.hazard.
 */
export type TelegraphKind = 'ring' | 'circle' | 'spawn' | 'strike' | 'mortar' | 'shock';
/** Screens of the UI (UiSystem.screen). `hud` = playing with no overlay; `none` = nothing shown (boot, fatal). */
export type UiScreen =
  | 'none'
  | 'menu'
  | 'difficulty'
  | 'settings'
  | 'controls'
  | 'hud'
  | 'perkSelect'
  | 'pause'
  | 'gameover'
  | 'victory';

/**
 * Logical input actions. One physical key may drive several actions (e.g. Digit1 = weapon1 + perk1);
 * the consumer decides by context. Default bindings (core/input.ts):
 *   moveForward/Back/Left/Right  W S A D           (prefer Input.moveX/moveY which merge all devices)
 *   lookLeft/Right/Up/Down       arrow keys        (already folded into Input.consumeLook)
 *   fire LMB/RT · ads RMB/LT · reload R/X · jump Space/A · sprint Shift/L3 · crouch C/B · dash Q/LB
 *   overclock F/D-pad up · melee V/R3 · grenade G/RB · weapon1..4 Digit1..4 · weaponNext wheel down, Y
 *   weaponPrev wheel up, D-pad down · pause Esc, P, Start (handled by core only)
 *   perk1..3 Digit1..3, pad X/Y/B (never the D-pad: it navigates)
 *   uiUp/Down/Left/Right arrows, D-pad, left stick · uiConfirm Enter, A · uiBack Esc, Backspace, B.
 */
export type InputAction =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'lookLeft'
  | 'lookRight'
  | 'lookUp'
  | 'lookDown'
  | 'fire'
  | 'ads'
  | 'reload'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'dash'
  | 'overclock'
  | 'melee'
  | 'grenade'
  | 'weapon1'
  | 'weapon2'
  | 'weapon3'
  | 'weapon4'
  | 'weaponNext'
  | 'weaponPrev'
  | 'pause'
  | 'perk1'
  | 'perk2'
  | 'perk3'
  | 'uiUp'
  | 'uiDown'
  | 'uiLeft'
  | 'uiRight'
  | 'uiConfirm'
  | 'uiBack';

// --- FxId -------------------------------------------------------------------------------------------
// Every id is declared in the union of the ONE system that may trigger it. "(STREAM)" marks the ids
// listed in FX_STREAM_IDS (core/constants.ts): see FxSystem.spawn for burst vs stream semantics.
// Naming: <owner or subject><Moment>.

/**
 * OWNER: WEAPONS (world-space; flashes glued to the viewmodel are weapons-internal meshes). Spawn every
 * one of them with clock 'player' except chainArc and meleeHit.
 */
export type WeaponsFxId =
  | 'muzzleVector'
  | 'muzzleBreaker'
  | 'muzzleLance'
  | 'muzzleHornet'
  | 'casingVector'
  | 'casingBreaker'
  /** (STREAM) while the LANCE charges; pass opts.charge. */
  | 'lanceCharge'
  | 'lanceDischarge'
  | 'hornetBackblast'
  | 'meleeSwing'
  /** Melee connected with a target or the world. */
  | 'meleeHit'
  /** Burst on each victim of a chain-lightning arc (the arc itself is fx.lightningBolt). */
  | 'chainArc';

/**
 * OWNER: COMBAT. hitEnemy* = one spark per damaging ray of a PLAYER hit on an enemy target, chosen by
 * DamageResult.part (never for splash damage). explosion* and shockwaveRing are spawned by
 * combat.explode only, always with opts.radius = the damage radius.
 */
export type CombatFxId =
  | 'hitEnemy'
  | 'hitEnemyWeak'
  | 'hitEnemyArmor'
  | 'hitEnemyShield'
  | 'explosionSmall'
  | 'explosionLarge'
  | 'explosionPlasma'
  | 'explosionShock'
  | 'explosionBoss'
  | 'shockwaveRing'
  /** A bouncing projectile touched the world. */
  | 'grenadeBounce';

/** OWNER: PLAYER. hitPlayer / hitPlayerShield are spawned inside player.takeDamage at info.point. */
export type PlayerFxId =
  | 'hitPlayer'
  | 'hitPlayerShield'
  | 'footDust'
  | 'jumpDust'
  | 'landDust'
  | 'doubleJump'
  /** (STREAM) while sliding. */
  | 'slideSparks'
  | 'dashBurst'
  | 'shieldBreak'
  | 'shieldRecharge'
  /** Inside player.heal (pickups, perks). */
  | 'healPulse'
  /** Life-on-kill perk proc. */
  | 'lifeSteal'
  | 'overclockStart'
  | 'overclockEnd'
  | 'lastStand';

/** OWNER: the ENEMY MANAGER (src/enemies/index.ts): burst where the arrival bolt lands. */
export type EnemyManagerFxId = 'spawnFlash';

/**
 * OWNER: enemy KINDS. Each id belongs to the kind named in it (`death<Type>`, `<type>...`; `boss...` =
 * the conductor kind). enemySmoke / enemySparks are damage-state streams any kind may emit for its
 * own actor.
 */
export type EnemyKindFxId =
  /** (STREAM) */
  | 'enemySmoke'
  /** (STREAM) */
  | 'enemySparks'
  | 'deathSkitter'
  | 'deathRiveter'
  | 'deathWasp'
  | 'deathTick'
  | 'deathLancer'
  | 'deathBulwark'
  | 'deathConductor'
  | 'skitterLeap'
  | 'skitterBite'
  /** (STREAM) */
  | 'riveterCharge'
  | 'riveterMuzzle'
  | 'waspMuzzle'
  /** (STREAM) */
  | 'tickArm'
  /** (STREAM) */
  | 'lancerCharge'
  | 'lancerMuzzle'
  | 'lancerRelocate'
  | 'bulwarkMortarMuzzle'
  | 'bulwarkStomp'
  | 'bulwarkShieldBreak'
  | 'bulwarkShieldRestore'
  | 'bossSpawn'
  /** (STREAM) */
  | 'bossCharge'
  | 'bossVolleyMuzzle'
  /** (STREAM) */
  | 'bossSweepCharge'
  /** (STREAM) where the sweep laser touches the floor. */
  | 'bossSweepHit'
  /** Burst where a telegraphed strike lands (the bolt itself is fx.lightningBolt). */
  | 'bossLightningStrike'
  | 'bossMissileLaunch'
  /** Burst at the origin when a shock ring starts (the moving ring is a 'shock' telegraph). */
  | 'bossShockRing'
  | 'bossSummon'
  | 'bossPhaseShift'
  | 'bossWeakPointBreak'
  | 'bossDeathBurst'
  | 'bossDeathFinal';

/** OWNER: DIRECTOR (pickups, supply drops, perks, wave flow). */
export type DirectorFxId =
  | 'pickupSpawn'
  | 'pickupAmmo'
  | 'pickupHealth'
  | 'pickupShield'
  | 'pickupGrenade'
  | 'pickupExpire'
  | 'supplyLand'
  | 'supplyOpen'
  /** At the crate when its weapon is granted (weapons.unlock itself is silent). */
  | 'weaponUnlock'
  | 'perkChosen'
  | 'waveClear';

/** OWNER: WORLD. */
export type WorldFxId =
  | 'gateOpen'
  | 'gateClose'
  | 'gateDenied'
  /** Inside world.unlockZone. */
  | 'zoneUnlock'
  | 'jumpPad'
  /** (STREAM) */
  | 'steamVent'
  /** (STREAM) */
  | 'sparkShower'
  /** (STREAM) */
  | 'hazardArc'
  /** Where the player is put back after falling off the rig. */
  | 'respawn';

/**
 * BUILDING BLOCKS — no fixed owner: spawned by whichever system owns the moment they describe.
 *   impact<Surface>   something struck world geometry; pick by RayHit.surface / ShotHit.surface, pass
 *                     opts.normal. Callers: weapons (player hitscan, rail, melee), combat (projectile
 *                     impacts), enemy kinds (their own hitscan beams).
 *   impact<Flavour>   the same moment, by damage flavour, added on top of / instead of the surface one.
 *   lightningImpact   generic burst at the end point of an fx.lightningBolt; the caller of the bolt spawns it.
 */
export type SharedFxId =
  | 'impactMetal'
  | 'impactPlating'
  | 'impactGrate'
  | 'impactGlass'
  | 'impactEnergy'
  | 'impactPellet'
  | 'impactRail'
  | 'impactPlasma'
  | 'impactBolt'
  | 'impactLaser'
  | 'lightningImpact';

/**
 * Every visual effect id. FxSystem.spawn must accept ALL of them (an unimplemented id may fall back to a
 * generic burst but must never throw). No FxId draws a lightning bolt: bolts are always fx.lightningBolt.
 */
export type FxId =
  | WeaponsFxId
  | CombatFxId
  | PlayerFxId
  | EnemyManagerFxId
  | EnemyKindFxId
  | DirectorFxId
  | WorldFxId
  | SharedFxId;

// --- SoundId ----------------------------------------------------------------------------------------
// Same rule: every one-shot is declared in the union of the ONE system that may play it.

/** OWNER: UI. newBest is played on 'run:end' when a record fell. The UI plays NO sound when a perk is picked. */
export type UiSoundId =
  | 'uiHover'
  | 'uiClick'
  | 'uiConfirm'
  | 'uiBack'
  | 'uiToggle'
  | 'uiSlider'
  | 'uiError'
  | 'uiPause'
  | 'uiResume'
  | 'uiPerkOffer'
  | 'uiPerkHover'
  /** A difficulty was confirmed and the run starts (survives the reset that follows: UI bus). */
  | 'uiStartRun'
  | 'uiGradeReveal'
  /** Tick of the end-screen stat count-up. */
  | 'uiStatTick'
  | 'newBest';

/** OWNER: WEAPONS (all 2D, the player's own hands). */
export type WeaponsSoundId =
  | 'vectorFire'
  | 'vectorDry'
  | 'vectorReloadOut'
  | 'vectorReloadIn'
  | 'vectorReloadBolt'
  | 'vectorEquip'
  | 'breakerFire'
  | 'breakerPump'
  | 'breakerDry'
  | 'breakerReloadOpen'
  | 'breakerReloadShell'
  | 'breakerReloadClose'
  | 'breakerEquip'
  /** The charge itself is LoopId 'lanceChargeLoop'. */
  | 'lanceChargeCancel'
  | 'lanceFire'
  | 'lanceDry'
  | 'lanceReloadOut'
  | 'lanceReloadIn'
  | 'lanceReloadSeal'
  | 'lanceEquip'
  | 'lanceScopeIn'
  | 'lanceScopeOut'
  | 'hornetFire'
  | 'hornetDry'
  | 'hornetReloadOpen'
  | 'hornetReloadLoad'
  | 'hornetReloadClose'
  | 'hornetEquip'
  | 'weaponSwitch'
  | 'weaponHolster'
  | 'adsIn'
  | 'adsOut'
  | 'lowAmmoClick'
  | 'grenadePin'
  | 'grenadeThrow'
  | 'meleeSwing'
  | 'meleeHit'
  | 'meleeHitWorld'
  /** One per chain-lightning proc. */
  | 'chainZap';

/**
 * OWNER: COMBAT. hit* = ONE 2D sound per enemy target per substep for player hits (priority hitKill >
 * hitCrit > hitShield > hitArmor > hitConfirm). explosion* by combat.explode (explosionDistant replaces
 * the near sound when the blast is more than 40 m from the listener). bulletWhiz = an enemy projectile
 * passing within 2 m of player.eye without hitting. mortarWhistle = a falling 'mortar' projectile.
 */
export type CombatSoundId =
  | 'hitConfirm'
  | 'hitCrit'
  | 'hitKill'
  | 'hitShield'
  | 'hitArmor'
  | 'explosionSmall'
  | 'explosionLarge'
  | 'explosionPlasma'
  | 'explosionShock'
  | 'explosionBoss'
  | 'explosionDistant'
  | 'grenadeBounce'
  | 'bulletWhiz'
  | 'mortarWhistle';

/** OWNER: PLAYER. */
export type PlayerSoundId =
  | 'stepMetal'
  | 'stepPlating'
  | 'stepGrate'
  | 'jump'
  | 'doubleJump'
  | 'land'
  | 'landHard'
  | 'slideStart'
  | 'slideEnd'
  | 'dash'
  | 'dashReady'
  | 'hurt'
  | 'hurtShield'
  | 'shieldBreak'
  | 'shieldRechargeStart'
  | 'shieldRechargeFull'
  | 'lowHealthWarning'
  | 'death'
  | 'lastStand'
  | 'lifeSteal'
  | 'overclockReady'
  | 'overclockStart'
  | 'overclockEnd'
  | 'overclockDenied';

/**
 * OWNER: the ENEMY MANAGER. spawnTelegraph when the arrival ring appears, spawnStrike when the bolt
 * lands, `<type>Spawn` the moment the machine appears (bolt landing, or spawn() itself for instant spawns).
 */
export type EnemyManagerSoundId =
  | 'spawnTelegraph'
  | 'spawnStrike'
  | 'skitterSpawn'
  | 'riveterSpawn'
  | 'waspSpawn'
  | 'tickSpawn'
  | 'lancerSpawn'
  | 'bulwarkSpawn'
  | 'conductorSpawn';

/**
 * OWNER: enemy KINDS — each id by the kind named in it (played positionally with owner: actor.id).
 * Pattern per kind: Idle motif, Telegraph, Attack (the launch / muzzle sound: combat adds none), Hurt
 * (in onDamaged), Death (in onKilled).
 */
export type EnemyKindSoundId =
  | 'skitterIdle'
  | 'skitterStep'
  | 'skitterTelegraph'
  | 'skitterAttack'
  | 'skitterHurt'
  | 'skitterDeath'
  | 'riveterIdle'
  | 'riveterTelegraph'
  | 'riveterAttack'
  | 'riveterHurt'
  | 'riveterDeath'
  | 'waspIdle'
  | 'waspTelegraph'
  | 'waspAttack'
  | 'waspHurt'
  | 'waspDeath'
  | 'tickIdle'
  | 'tickBeep'
  | 'tickTelegraph'
  | 'tickAttack'
  | 'tickHurt'
  | 'tickDeath'
  | 'lancerIdle'
  | 'lancerTelegraph'
  | 'lancerLock'
  | 'lancerAttack'
  | 'lancerRelocate'
  | 'lancerHurt'
  | 'lancerDeath'
  | 'bulwarkIdle'
  | 'bulwarkStep'
  | 'bulwarkTelegraph'
  | 'bulwarkAttack'
  | 'bulwarkStomp'
  | 'bulwarkShieldBreak'
  | 'bulwarkShieldRestore'
  | 'bulwarkHurt'
  | 'bulwarkDeath'
  | 'conductorIdle'
  | 'conductorTelegraph'
  | 'conductorVolley'
  | 'conductorSweepCharge'
  | 'conductorSweepFire'
  | 'conductorLightningCall'
  | 'conductorLightningStrike'
  | 'conductorMissile'
  | 'conductorShockRing'
  | 'conductorSummon'
  | 'conductorHurt'
  | 'conductorWeakPointBreak'
  | 'conductorPhase2'
  | 'conductorPhase3'
  | 'conductorEnrage'
  | 'conductorDeathStart'
  | 'conductorDeathBurst'
  | 'conductorDeathFinal';

/**
 * OWNER: DIRECTOR. intermissionTick = each of the last 3 seconds of a countdown, intermissionEnd = the
 * wave starts. perkAcquire is played inside choosePerk / grantPerk. There is no game-over / victory
 * one-shot: the end-of-run stingers belong to the music (audio, on 'run:end').
 */
export type DirectorSoundId =
  | 'pickupSpawn'
  | 'pickupAmmo'
  | 'pickupHealth'
  | 'pickupShield'
  | 'pickupGrenade'
  | 'pickupExpire'
  | 'pickupDenied'
  | 'supplyIncoming'
  | 'supplyLand'
  | 'supplyOpen'
  | 'weaponUnlock'
  | 'waveStart'
  | 'waveClear'
  | 'waveFlawless'
  | 'bossIntro'
  | 'intermissionTick'
  | 'intermissionEnd'
  | 'comboUp'
  | 'comboMax'
  | 'comboBreak'
  | 'multikill2'
  | 'multikill3'
  | 'multikill4'
  | 'multikill5'
  | 'perkAcquire'
  | 'objective';

/** OWNER: WORLD. */
export type WorldSoundId =
  | 'gateOpen'
  | 'gateClose'
  | 'gateDenied'
  | 'zoneUnlock'
  | 'jumpPad'
  | 'steamVent'
  | 'hazardZap'
  | 'beaconPing'
  | 'fallRespawn';

/** OWNER: FX (the ambient storm scheduled by fx weather — see FxSystem.setWeather). */
export type WeatherSoundId = 'thunderNear' | 'thunderFar' | 'lightningCrack' | 'staticCrackle' | 'windGust';

/**
 * BUILDING BLOCKS — played by whichever system spawns the matching Shared impact fx, at the same point:
 * impact<Surface> for bullets / beams / melee on world geometry, impactPlasma for energy projectiles,
 * ricochet as an occasional extra on glancing hits.
 */
export type SharedSoundId =
  | 'impactMetal'
  | 'impactPlating'
  | 'impactGrate'
  | 'impactGlass'
  | 'impactEnergy'
  | 'impactPlasma'
  | 'ricochet';

/**
 * Every one-shot sound. AudioSystem.play / playAt must accept ALL of them (an unimplemented id may fall
 * back to a generic blip but must never throw).
 */
export type SoundId =
  | UiSoundId
  | WeaponsSoundId
  | CombatSoundId
  | PlayerSoundId
  | EnemyManagerSoundId
  | EnemyKindSoundId
  | DirectorSoundId
  | WorldSoundId
  | WeatherSoundId
  | SharedSoundId;

// --- LoopId -----------------------------------------------------------------------------------------

/** OWNER: WEAPONS. */
export type WeaponsLoopId = 'lanceChargeLoop';
/** OWNER: PLAYER. */
export type PlayerLoopId = 'overclockLoop' | 'heartbeatLoop' | 'slideLoop';
/** OWNER: COMBAT (fly loops of projectiles, by ProjectileDef.loop). */
export type CombatLoopId = 'rocketLoop' | 'missileLoop' | 'mortarLoop';
/** OWNER: enemy KINDS — each by the kind named in it; started with owner: actor.id. */
export type EnemyKindLoopId =
  | 'riveterHover'
  | 'waspBuzz'
  | 'tickRoll'
  | 'lancerLaser'
  | 'bulwarkServo'
  | 'bulwarkShieldHum'
  | 'conductorCore'
  | 'conductorSweep';
/** OWNER: WORLD (acquired lazily in update, see the header). */
export type WorldLoopId = 'gateHum' | 'jumpPadHum' | 'hazardHum' | 'steamHiss';
/** OWNER: DIRECTOR (the landed supply crate). */
export type DirectorLoopId = 'supplyBeacon';

/**
 * Sustained sounds started with AudioSystem.loop and controlled through the returned LoopHandle.
 * The wind / static-rain beds and the music are internal to audio and have no id here.
 */
export type LoopId = WeaponsLoopId | PlayerLoopId | CombatLoopId | EnemyKindLoopId | WorldLoopId | DirectorLoopId;

// ---------------------------------------------------------------------------------------------------
// 3. System lifecycle
// ---------------------------------------------------------------------------------------------------

/**
 * Lifecycle implemented by world, render, fx, audio, combat, player, weapons, enemies, director, ui.
 * Core wraps every call in a try/catch: an exception is recorded in `window.__SH.errors` (which fails
 * every automated check) and the frame carries on. A call that throws 10 times in a row, or 30 times in
 * total, or at all during init, raises the fatal panel and stops the loop — EXCEPT calls into audio and
 * fx (and the resize / bot hooks): those are never fatal; after 3 failures core simply stops calling
 * that method.
 */
export interface System {
  /**
   * One-time setup: build meshes/materials/textures/DOM, add the system's root object to its scene,
   * subscribe to events. All ctx.* systems exist here. May be async (awaited sequentially in lifecycle
   * order; core lets the browser paint between systems). Never start audio, request pointer lock or read
   * localStorage directly from here.
   */
  init(): void | Promise<void>;
  /**
   * Restore the pristine pre-run state: no enemies, projectiles, pickups, timers, tweens, handles or
   * loops left over; gates closed; vitals full. Must be idempotent and safe to call any number of times.
   * Runs silently: no fx, no sounds, no animations (it also runs behind the menu).
   */
  reset(): void;
  /**
   * Called per substep according to the frame pipeline above; `dt` is this system's clock (see CLOCKS).
   * dt may be exactly 0: never divide by it.
   */
  update(dt: number): void;
  /** Optional second pass after every system updated in the same substep (camera, viewmodel, attachments). */
  lateUpdate?(dt: number): void;
  /**
   * Optional: called on every GameMode transition, before the 'game:mode' event is emitted.
   * A restart while already playing reports onModeChange('playing', 'playing').
   */
  onModeChange?(mode: GameMode, prev: GameMode): void;
  /** Remove every scene object, DOM node, listener and audio node the system created. */
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------------
// 4. Context
// ---------------------------------------------------------------------------------------------------

/** Mutable debug switches (written by window.__SH, honoured by the systems named on each flag). */
export interface DebugFlags {
  /** PLAYER: takeDamage ignores all damage while true. */
  god: boolean;
  /** WEAPONS: firing consumes no ammo and grenades are free while true. */
  infiniteAmmo: boolean;
  /** ENEMIES: the manager calls animate() instead of update() while true (EnemySystem.canAttack is false). */
  freezeAi: boolean;
  /**
   * Core applies a free camera before render.update and before rendering. While true RENDER skips the
   * viewmodel layer and never writes ctx.camera (no cinematic camera).
   */
  freeCamera: boolean;
  /** Core hides ctx.uiRoot (visibility:hidden) while true. */
  hideUi: boolean;
  /** True while the autopilot bot drives the virtual input. */
  bot: boolean;
}

/** The one shared object handed to every system factory. */
export interface GameContext {
  /** World scene. Background, fog, environment and ALL lights are owned by render (FX owns its 6 pooled point lights). */
  readonly scene: THREE.Scene;
  /**
   * World camera (rotation.order is 'YXZ': rotation.set(pitch, yaw, roll)). Owner while playing/paused:
   * PLAYER (writes position, rotation, fov, then calls updateProjectionMatrix + updateMatrixWorld so
   * later systems can project). Owner in menu / gameover / victory: RENDER (cinematic camera; it must
   * call updateMatrixWorld too). near/far and aspect are owned by render.
   */
  readonly camera: THREE.PerspectiveCamera;
  /**
   * First-person layer: rendered by render AFTER the world with the depth buffer cleared, so the weapon
   * never clips into walls. WEAPONS owns every mesh in it. RENDER owns its lights/environment and its
   * aspect. The view camera sits at the origin looking down -Z and never moves; its vertical FOV is fixed
   * at 58 degrees and written by NOBODY (weapons animate ADS by moving the model in view space:
   * x right, y up, -z forward). See RenderSystem.viewToWorld for the muzzle position in the world.
   */
  readonly viewScene: THREE.Scene;
  readonly viewCamera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** `#ui` overlay: `pointer-events:none` by default; UI gives interactive children `pointer-events:auto`. Owned by UI. */
  readonly uiRoot: HTMLElement;
  readonly events: EventBus;
  readonly input: Input;
  readonly settings: Settings;
  readonly storage: GameStorage;
  /** Gameplay RNG, reseeded by core at every run start (fixed seed in test mode). */
  readonly rng: Rng;
  /**
   * RNG for everything that does not change the outcome of a run (particles, weather, audio variation,
   * idle animation, UI). Fixed seed in test mode, never reseeded by a run. Use it instead of Math.random.
   */
  readonly cosmeticRng: Rng;
  readonly time: TimeState;
  /** Run modifiers (perks + difficulty). Reset by core before every run. */
  readonly mods: Modifiers;
  readonly game: Game;
  readonly debug: DebugFlags;
  /**
   * Automation mode, strictly opt-in: the page was opened with `?test=1`, or the embedding frame is named
   * 'sh-test'. Effects: the simulation only advances through window.__SH.step (manual stepping), fixed
   * seeds, no pointer lock, no auto-pause on blur, the dynamic-resolution governor and ambient lightning
   * are off, UI transitions are instant. Never true in normal play.
   */
  readonly testMode: boolean;
  /** Unique positive integer ids for entities, hit targets, pickups, projectiles. */
  nextId(): number;

  // Services and systems. Assigned exactly once in main.ts before any init() runs; never reassigned.
  collision: CollisionWorld;
  nav: NavGrid;
  world: WorldSystem;
  render: RenderSystem;
  player: PlayerSystem;
  weapons: WeaponSystem;
  combat: CombatSystem;
  enemies: EnemySystem;
  director: DirectorSystem;
  fx: FxSystem;
  audio: AudioSystem;
  ui: UiSystem;
}

// ---------------------------------------------------------------------------------------------------
// 5. Game state machine facade (core/game.ts)
// ---------------------------------------------------------------------------------------------------

export interface BestRecord {
  /** Best final score of any run. */
  score: number;
  /** Highest wave reached (1-based; totalWaves + 1 is never used — a victory stores totalWaves). */
  wave: number;
  grade: Grade | '';
  runs: number;
  victories: number;
}

/**
 * boot -> menu -> playing <-> paused -> gameover | victory -> (menu | playing).
 * Implemented by core. UI calls startRun / pause / resume / toMenu / restart from its buttons;
 * the DIRECTOR (and nobody else) calls endRun.
 */
export interface Game {
  readonly mode: GameMode;
  /** Difficulty of the current / last run. */
  readonly difficulty: Difficulty;
  /** Increments at every startRun (first run = 1). */
  readonly runIndex: number;
  /** Persisted records, updated by core inside endRun. */
  readonly best: Readonly<BestRecord>;
  /** Smoothed frames per second of the real loop. */
  readonly fps: number;
  /**
   * Start a fresh run from any mode except boot: unlock audio, reset time + mods + every system,
   * director.startRun, mode -> 'playing', emit 'run:start', request pointer capture. Call it
   * synchronously from the click/keydown handler so the browser still considers it a user gesture.
   */
  startRun(difficulty: Difficulty): void;
  /** startRun with the current difficulty. */
  restart(): void;
  /** playing -> paused (no-op otherwise). Releases the pointer. Allowed during perk select. */
  pause(): void;
  /** paused -> playing (no-op otherwise). Re-requests the pointer. */
  resume(): void;
  /**
   * DIRECTOR ONLY. playing -> 'victory' | 'gameover'; stores records and emits 'run:end'.
   * The director finalises its RunStats (seconds, accuracy, grade, victory) BEFORE calling this.
   */
  endRun(victory: boolean): void;
  /** Any mode -> 'menu' after resetting every system (world is empty and alive behind the menu). */
  toMenu(): void;
  /**
   * Record a contained error in window.__SH.errors and emit 'game:error'. `source` names the culprit
   * ('enemy:tick', 'projectile:rocket', 'audio', 'fx', ...). 30 reports from the same source raise the
   * fatal panel, except for the sources 'audio' and 'fx', which never do. `fatal` shows the panel and
   * stops the loop immediately.
   */
  reportError(source: string, error: unknown, fatal?: boolean): void;
}

// ---------------------------------------------------------------------------------------------------
// 6. Time
// ---------------------------------------------------------------------------------------------------

/**
 * Clocks. Core calls advance() once per substep; everything else only reads, or files time-scale
 * requests. The effective world scale is the MINIMUM of all active requests (1 when none).
 *
 *   mode                          dt               unscaledDt             playerDt        realDt
 *   playing                       stepDt * scale   stepDt (0 if scale 0)  = unscaledDt    frame delta
 *   menu / gameover / victory     stepDt * scale   0                      = dt            frame delta
 *   paused / boot                 0                0                      0               frame delta
 *
 * HARD FREEZE: an effective scale of exactly 0 (the director's 'perkSelect' request) freezes the player
 * too — unscaledDt becomes 0 and core only updates the director. Hit-stop and slow motion never reach 0.
 */
export interface TimeState {
  /** Scaled simulation seconds since the last reset (run clock; also ticks in the menu). */
  readonly now: number;
  /** Scaled world delta of the current substep. */
  readonly dt: number;
  /** Player-clock delta of the current substep (see table). */
  readonly unscaledDt: number;
  /**
   * Delta for world-space things that belong to the player (player projectiles, fx with clock 'player',
   * corpse timers, the director's end-of-run waits): unscaledDt while playing, dt in every other mode —
   * so they keep full speed during Overclock and never freeze after the run ended.
   */
  readonly playerDt: number;
  /** Wall-clock delta of the current frame, clamped to 0.1. May be 0 for a manual frame(0). */
  readonly realDt: number;
  /** Wall-clock seconds since boot (sum of realDt), monotonic, never reset. Use for UI / shader phases and freeze-proof timers. */
  readonly elapsed: number;
  /**
   * Effective world time scale (0..1): the minimum of all active requests. It keeps that value while the
   * game is paused or in a menu (dt is 0 there anyway) — "is the game running" is ctx.game.mode, never
   * `scale === 0`. Exactly 0 only during the perk-select hard freeze.
   */
  readonly scale: number;
  /** Substep counter since boot. */
  readonly frame: number;
  /** Index of the current substep within its frame (0-based) and how many substeps this frame has. */
  readonly substep: number;
  readonly substeps: number;
  /** Unscaled seconds actually played this run (sum of unscaledDt). */
  readonly runTime: number;
  /**
   * File or replace the request of `source` (one owner per source, see TimeScaleSource). `scale` is
   * clamped to [0,1]. With `seconds` the request expires by itself after that much REAL time (the
   * countdown stops while the game is paused); without it stays until clearScale(source).
   * Core's reset clears every request.
   */
  setScale(source: TimeScaleSource, scale: number, seconds?: number): void;
  clearScale(source: TimeScaleSource): void;
  /** Current request of one source (1 when none). */
  getScale(source: TimeScaleSource): number;
  /**
   * Impact freeze: world scale 0.05 for `seconds` of real time (clamped to 0.25, longest request wins).
   * Called by the owner of a heavy moment (weapons: melee connect and rail kills; combat: big blasts
   * near the player; the conductor kind: phase breaks). The player clock keeps running.
   */
  hitstop(seconds: number): void;
}

// ---------------------------------------------------------------------------------------------------
// 7. Events
// ---------------------------------------------------------------------------------------------------

/**
 * All bus events. "E:" names the ONLY system allowed to emit the event.
 * Payload objects (and the Vector3 inside them) may be reused by the emitter: copy what you keep.
 */
export interface EventMap {
  /** E: core. Emitted after every system's onModeChange ran. */
  'game:mode': { mode: GameMode; prev: GameMode };
  /** E: core. A contained exception or a fatal error. */
  'game:error': { source: string; message: string; fatal: boolean };
  /** E: core. After all systems were reset and director.startRun ran; mode is already 'playing'. */
  'run:start': { difficulty: Difficulty; runIndex: number };
  /** E: core (inside game.endRun). `stats` is the director's live RunStats object. */
  'run:end': {
    victory: boolean;
    stats: Readonly<RunStats>;
    score: number;
    wave: number;
    newBestScore: boolean;
    newBestWave: boolean;
  };

  /** E: director. Wave `wave` (1-based) begins spawning. UI: no banner here — see 'announce'. */
  'wave:start': { wave: number; total: number; isBoss: boolean; zone: ZoneId };
  /** E: director. Last enemy of the wave died. */
  'wave:clear': { wave: number; total: number; seconds: number; bonus: number; flawless: boolean };
  /** E: director. Every DirectorPhase transition. */
  'director:phase': { phase: DirectorPhase; prev: DirectorPhase; wave: number };
  /** E: director. Intermission countdown started (UI reads director.intermissionLeft for the live value). */
  'intermission:start': { seconds: number; nextWave: number };

  /** E: enemies. At spawn() time, i.e. when the arrival telegraph starts (enemy.spawning is true). */
  'enemy:spawned': { enemy: EnemyHandle };
  /** E: enemies. After hp/shield changed and the enemy survived. */
  'enemy:damaged': { enemy: EnemyHandle; info: Readonly<DamageInfo>; result: Readonly<DamageResult> };
  /**
   * E: enemies. hp reached 0 (for the boss: start of the staged death). `position` is the aim point,
   * `weapon` is info.weapon. Reward rules every listener follows:
   *   byPlayer = info.faction === 'player' || info.creditPlayer  (the player's guns, grenades, perks procs
   *              and chain reactions he started). Score, combo, multikill, Overclock charge, life-on-kill
   *              and explosive crits apply ONLY when byPlayer.
   *   score    = EnemyDef.score when byPlayer and not silent, else 0 (the director applies combo,
   *              difficulty and the 25 % rule for summoned enemies).
   *   world-credited kills (weapon === 'world': hazards, killAll, bounds cull, EnemySystem.kill) and silent
   *              kills (info.silent) are never rewarded at all: no stats.kills, no pickup drop.
   *   every other kill (also enemy-on-enemy without player credit) counts in stats.kills and rolls a drop.
   */
  'enemy:killed': {
    enemy: EnemyHandle;
    type: EnemyType;
    position: THREE.Vector3;
    info: Readonly<DamageInfo>;
    weapon: DamageSource | null;
    crit: boolean;
    byPlayer: boolean;
    score: number;
  };

  /**
   * E: player. Damage actually taken. `dirX/dirZ` = unit horizontal direction FROM the player TOWARD the
   * source = -info.dir flattened and normalised ((0,0) when unknown). `angle` = that direction relative
   * to the view = wrapAngle(dirToYaw(dirX, dirZ) - player.yaw): 0 ahead, +PI/2 left, -PI/2 right, PI
   * behind (UI damage indicators rotate by it). With (0,0) the angle is 0 and the UI shows a full ring.
   */
  'player:damaged': {
    amount: number;
    shieldDamage: number;
    healthDamage: number;
    info: Readonly<DamageInfo>;
    dirX: number;
    dirZ: number;
    angle: number;
  };
  /** E: player (inside heal / addShield, only when something was restored; not for passive shield regeneration). */
  'player:healed': { amount: number; kind: 'health' | 'shield' };
  /** E: player. Shield just reached 0. */
  'player:shieldBroken': { info: Readonly<DamageInfo> };
  /** E: player. Shield regeneration reached the maximum. */
  'player:shieldRecharged': Record<string, never>;
  /** E: player. Health crossed the low-health threshold (30 %) in either direction. */
  'player:lowHealth': { active: boolean };
  /** E: player. hp reached 0 (last stand already consumed). The director ends the run ~1.5 s later. */
  'player:died': { info: Readonly<DamageInfo> };
  /** E: player. Movement notifications (viewmodel bob, UI). `impactSpeed` is the downward speed in m/s. */
  'player:jumped': { double: boolean };
  'player:landed': { impactSpeed: number };
  'player:dashed': { chargesLeft: number };

  /** E: weapons. One trigger pull / one automatic shot (a 9-pellet blast is ONE event). */
  'weapon:fired': { weapon: WeaponId; mag: number; reserve: number };
  /** E: weapons. */
  'weapon:reloadStart': { weapon: WeaponId; seconds: number };
  'weapon:reloaded': { weapon: WeaponId; mag: number; reserve: number };
  'weapon:switched': { weapon: WeaponId; prev: WeaponId };
  /** E: weapons (inside unlock; also on debug giveAll). No sound or fx is attached to it by anyone but the director's crate. */
  'weapon:unlocked': { weapon: WeaponId };
  /** E: weapons. Trigger pulled with an empty magazine and no reserve. */
  'weapon:empty': { weapon: WeaponId };
  'weapon:grenade': { left: number };
  'weapon:melee': { hit: boolean };

  /**
   * E: combat. The PLAYER damaged a hostile target (an enemy, or a shootable enemy projectile): drives
   * the hitmarker. Emitted at most ONCE PER TARGET PER SUBSTEP, from combat.update, with everything that
   * hit that target since the last flush merged: amount = sum dealt, crit = any, killed = any, shield =
   * every hit was absorbed, part = best of weak > body > armor > shield, weapon and point = of the last
   * hit. A 9-pellet blast on one enemy is one event. Never emitted for silent damage.
   */
  'hit:confirmed': {
    targetId: number;
    amount: number;
    crit: boolean;
    killed: boolean;
    shield: boolean;
    part: HitPart;
    weapon: DamageSource | null;
    point: THREE.Vector3;
  };

  /** E: director. */
  'pickup:spawned': { pickup: Readonly<PickupState> };
  'pickup:collected': { pickup: Readonly<PickupState>; type: PickupType; amount: number };
  /** E: director. One to three perk choices are on offer; world is hard-frozen until choosePerk. */
  'perk:offered': { choices: readonly PerkId[] };
  /** E: director (choosePerk: index = offer slot; grantPerk: index = -1). */
  'perk:chosen': { perk: PerkId; index: number; stacks: number };
  /**
   * E: director. `position` is where the score was earned (null for non-spatial bonuses). The floating
   * "+150" popup at that position is drawn by the UI (fx.damageNumber is for damage only).
   */
  'score:changed': { score: number; delta: number; reason: ScoreReason; position: THREE.Vector3 | null };
  /** E: director. Combo count or multiplier changed (multiplier 1 + count 0 = combo ended). */
  'combo:changed': { multiplier: number; count: number; timeLeft: number };
  /** E: director. 2+ kills inside the multi-kill window. `label` e.g. "DOUBLE KILL". UI shows a callout line (not a banner). */
  multikill: { count: number; label: string; bonus: number };
  /**
   * E: director (only). Big banner text. UI shows a banner for every 'announce' and for nothing else:
   * wave start / wave clear / FLAWLESS / zone unlocked / supply drop / boss intro banners all arrive
   * through here. Banner policy (the director paces on it): no queue — the newest banner replaces the
   * current one once that has been visible for 0.5 s.
   */
  announce: { text: string; sub: string; style: AnnounceStyle; seconds: number };

  /** E: world (inside unlockZone). */
  'zone:unlocked': { zone: ZoneId; name: string };
  /** E: world (inside setGateOpen), only when the state actually changes (also for instant changes). */
  'gate:state': { gateId: string; open: boolean; from: ZoneId; to: ZoneId };

  /** E: director. Crate inbound to `position` (a drop pad). */
  'supply:incoming': { weapon: WeaponId; position: THREE.Vector3 };
  'supply:landed': { weapon: WeaponId; position: THREE.Vector3 };
  /** E: director. Crate opened (walked into, or auto-collected on timeout); weapon is now unlocked. */
  'supply:collected': { weapon: WeaponId };

  /** E: enemies (manager), at spawn() of the boss. */
  'boss:spawned': { boss: BossHandle };
  /** E: enemies (inside EnemySystem.setBossPhase, called by the boss kind). */
  'boss:phase': { boss: BossHandle; phase: number; prev: number };
  /**
   * E: enemies (manager), at the START of the staged death (same call as the boss 'enemy:killed'); never
   * for silent kills. `sequenceSeconds` is what the boss kind returned from onKilled: the director waits
   * exactly that long on ctx.time.playerDt, then calls game.endRun(true); it only reacts while its phase
   * is 'boss'.
   */
  'boss:defeated': { boss: BossHandle; position: THREE.Vector3; sequenceSeconds: number };

  /** E: player. */
  'overclock:ready': Record<string, never>;
  'overclock:start': { seconds: number };
  'overclock:end': Record<string, never>;

  /**
   * E: render (inside setTimeOfDay), only when the TARGET id changes. FX switches weather and audio its
   * ambience beds on it — but neither may rely on it for the initial state (see RenderSystem.setTimeOfDay).
   */
  'timeOfDay:changed': { id: TimeOfDayId; prev: TimeOfDayId; seconds: number };
  /** E: core/settings.ts, immediately after a value changed (persisting happens a moment later). */
  'settings:changed': { key: keyof SettingsData; data: Readonly<SettingsData> };
  /** E: core/input.ts. Only on a real change of the active device (button edges, never held levels). */
  'input:device': { device: InputDevice; prev: InputDevice };
  'input:lookMode': { mode: LookMode; prev: LookMode };
  /**
   * E: core/input.ts. Pointer lock was gained or lost, or gameplay input was interrupted.
   * `intentional` is false when the browser or the user took control away while gameplay owned the
   * pointer (Esc out of pointer lock, alt-tab, window blur, hidden tab): core auto-pauses on that.
   * Never emitted with intentional = false in test mode.
   */
  'input:capture': { captured: boolean; intentional: boolean };
  /**
   * E: render, inside setQuality only (a preset was applied). NEVER emitted by the dynamic-resolution
   * governor, which changes nothing but RenderSystem.resolutionScale.
   */
  'quality:changed': { preset: QualityPreset; params: Readonly<QualityParams> };
  /** E: core, after render.resize ran. CSS pixels of the canvas. */
  'view:resize': { width: number; height: number };
}

export type EventName = keyof EventMap;
export type EventHandler<K extends EventName> = (payload: EventMap[K]) => void;

/**
 * Synchronous typed pub/sub. Handlers run in subscription order during emit() (systems subscribe in
 * init(), so in lifecycle order: e.g. the player's 'enemy:killed' handler runs before the director's).
 * A throwing handler is caught and reported (it never breaks the emitter or the other handlers).
 * Subscribing/unsubscribing from inside a handler is safe. Subscribe in init(), never in update().
 */
export interface EventBus {
  on<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe;
  once<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe;
  off<K extends EventName>(name: K, handler: EventHandler<K>): void;
  emit<K extends EventName>(name: K, payload: EventMap[K]): void;
}

// ---------------------------------------------------------------------------------------------------
// 8. Input (core/input.ts)
// ---------------------------------------------------------------------------------------------------

export interface LookDelta {
  /** Radians to ADD to the player yaw this frame (already sign-corrected: mouse right = negative). */
  yaw: number;
  /** Radians to ADD to the player pitch (mouse up = positive; invertY already applied). */
  pitch: number;
}

/**
 * Device-independent input. Keyboard, mouse, wheel, gamepad, touch UI and the bot all merge here.
 * Gameplay code only ever asks for actions, the move axes and the look delta.
 */
export interface Input {
  // --- actions ---------------------------------------------------------------------------------
  /** Held right now (any device or virtual). */
  isDown(action: InputAction): boolean;
  /** Went down since the previous frame. Visible during the first substep and to render/audio/ui. */
  justPressed(action: InputAction): boolean;
  justReleased(action: InputAction): boolean;

  // --- axes ------------------------------------------------------------------------------------
  /** Strafe: -1 left .. +1 right. Merged keyboard + stick + virtual, vector length clamped to 1. */
  readonly moveX: number;
  /** Advance: +1 forward .. -1 back. */
  readonly moveY: number;
  /**
   * Write the look delta accumulated since the last call into `out` and zero the accumulator.
   * Radians, sensitivity + invertY applied, all look sources merged (locked mouse, free mouse +
   * edge-turn, arrow keys, right stick, touch, bot). PLAYER calls it exactly once per update and may
   * scale the result (ADS zoom). Returns `out`. Always (0,0) while the UI owns the pointer.
   */
  consumeLook(out: LookDelta): LookDelta;

  // --- pointer capture -------------------------------------------------------------------------
  /**
   * "Gameplay wants the mouse": try pointer lock; if it is rejected or unavailable (sandboxed frame, no
   * user gesture, cooldown after Esc) fall back to `free` look silently and retry on the next click on
   * the canvas (a click that only re-acquires a lost lock does not fire the weapon). The game is fully
   * playable in `free` look; nothing may assume the lock is ever granted.
   * POLICY (core/game.ts — systems normally never call these two): while mode is 'playing' core keeps
   * capture requested unless `ctx.ui.wantsPointer()` is true; in every other mode it is released.
   */
  requestCapture(): void;
  /** "UI wants the mouse": exit pointer lock on purpose (no auto-pause), ignore mouse look and buttons. */
  releaseCapture(): void;
  /** True while gameplay owns the mouse (locked OR free look). False while the UI owns it. */
  readonly wantsCapture: boolean;
  /** True while pointer lock is actually active. */
  readonly captured: boolean;
  readonly lookMode: LookMode;
  /**
   * Device that produced the most recent input. Starts as 'touch' on touch-only devices, else
   * 'keyboardMouse'. Changes only on real activity (a key, a click, mouse travel, a pad button edge or a
   * stick pushed past half way, a touch) — a pad with resting axes never steals it.
   */
  readonly device: InputDevice;
  /** settings.aimAssist && device !== 'keyboardMouse'. PLAYER adds look friction, WEAPONS add bullet magnetism. */
  readonly aimAssist: boolean;

  // --- virtual input (touch UI, bot, tests) ------------------------------------------------------
  // One shared channel: the touch UI writes it ONLY from its pointer events (never every frame), releases
  // exactly the buttons it holds and zeroes its stick whenever its controls hide, and never calls
  // clearVirtual() — otherwise it would cancel the bot and the tests, which use the same channel.
  /** Hold / release an action as if a key was held. Persists until changed or clearVirtual(). */
  setVirtualButton(action: InputAction, down: boolean): void;
  /** Tap: hold the action for `seconds` of frame time (default: one frame), then release. */
  pressVirtual(action: InputAction, seconds?: number): void;
  /** Virtual stick, same convention as moveX/moveY. Persists until changed. Touch UI: also hold 'sprint' at full deflection. */
  setVirtualMove(x: number, y: number): void;
  /** Add a raw look delta in radians (bot). */
  addVirtualLook(yaw: number, pitch: number): void;
  /** Add a look delta in CSS pixels of finger travel (touch UI): scaled by sensitivity, invertY applied. */
  addVirtualLookPixels(dx: number, dy: number): void;
  /** Touch UI calls this on its first touch so `device` becomes 'touch' (core also detects touchstart). */
  notifyDevice(device: InputDevice): void;
  /** Release every virtual button, zero the virtual stick. CORE (reset) and the bot only. */
  clearVirtual(): void;

  // --- prompts ---------------------------------------------------------------------------------
  /**
   * Short label of the binding: 'R', 'LMB', 'SPACE', 'RT', 'X'; '' if unbound on that device.
   * `device` defaults to the current device (the controls screen passes each device explicitly).
   */
  bindingLabel(action: InputAction, device?: InputDevice): string;
  /**
   * Gamepad rumble, 0..1 strength; silently ignored when unsupported or the pad is not the active device.
   * Callers: PLAYER on damage taken (0.3 + amount / 60 for 0.15 s) and hard landings; WEAPONS per shot
   * (def.shake * 1.5 for 0.06 s); COMBAT for explosions within 12 m of the player.
   */
  rumble(strength: number, seconds: number): void;

  // --- core only -------------------------------------------------------------------------------
  /** Sample devices and compute edges. Core calls it once at the start of every frame. */
  poll(realDt: number): void;
  /** Core hides edges + look for substeps after the first, and re-shows them for render/audio/ui. */
  setEdgesVisible(visible: boolean): void;
  /** Clear edges and any unconsumed look delta. Core calls it once at the end of every frame. */
  endFrame(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------------
// 9. Settings + storage
// ---------------------------------------------------------------------------------------------------

export interface SettingsData {
  /** Look sensitivity multiplier, 0.2 .. 3 (default 1). Applied by Input. */
  sensitivity: number;
  invertY: boolean;
  /** Vertical field of view in degrees at hip, 60 .. 100 (default 78). Applied by PLAYER to ctx.camera. */
  fov: number;
  /** 0 .. 1. Applied by AUDIO. */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  /**
   * Applied by RENDER (it listens to 'settings:changed' and calls its own setQuality). Default 'auto':
   * render resolves it to a preset from the device; a stored preset is always a deliberate user choice.
   */
  quality: QualitySetting;
  /** RENDER may lower the internal resolution to hold the frame rate (see RenderSystem.resolutionScale). */
  dynamicResolution: boolean;
  /** Camera shake multiplier 0 .. 1.5 (default 1). Applied by PLAYER inside addShake. */
  screenShake: number;
  /**
   * Applied by RENDER (caps the post flash and lightning boosts) and FX (halves lightFlash intensity, no
   * bolt strobing). Nobody else checks it: writers always pass the full value. Defaults to the OS
   * "reduce motion" preference when nothing was stored.
   */
  reduceFlashes: boolean;
  /** UI shows the frame counter. */
  showFps: boolean;
  /** Aim assist for gamepad + touch (see Input.aimAssist). */
  aimAssist: boolean;
  /** FX.damageNumber is a no-op when false. */
  damageNumbers: boolean;
  /** Last difficulty picked in the menu. */
  difficulty: Difficulty;
}

/** Persistent user settings. set() clamps, emits 'settings:changed' at once and persists shortly after. */
export interface Settings {
  /** Live values. Read freely every frame. */
  readonly data: Readonly<SettingsData>;
  readonly defaults: Readonly<SettingsData>;
  /** Safe to call on every slider input event: storage is written on a 300 ms trailing timer. */
  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void;
  /** Restore every default (emits one 'settings:changed' per changed key). */
  resetToDefaults(): void;
  /** Write pending changes to storage now (core does it when the page is hidden or closed). */
  flush(): void;
}

/** localStorage wrapper that never throws; falls back to an in-memory map (sandboxed frames). */
export interface GameStorage {
  /** False when localStorage is unavailable and values only live for this page view. */
  readonly persistent: boolean;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Parsed JSON or `fallback` when missing/corrupt. */
  getJson<T>(key: string, fallback: T): T;
  setJson(key: string, value: unknown): void;
}

/** Seeded PRNG (core/rng.ts). */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** -1 or +1. */
  sign(): number;
  /** Random element; throws on an empty array (check the length first — e.g. world.spawnPoints may be empty). */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher-Yates; returns the same array. */
  shuffle<T>(items: T[]): T[];
  /** Restart the sequence. */
  seed(seed: number): void;
}

// ---------------------------------------------------------------------------------------------------
// 10. Collision (src/physics) — static AABB world
// ---------------------------------------------------------------------------------------------------

/**
 * Description of one static box. Flags are the bit constants `COL.*` from core/constants.ts and say
 * WHAT THE BOX BLOCKS:
 *   COL.PLAYER (1) · COL.ENEMY (2) · COL.PROJECTILE (4, also hitscan) · COL.SIGHT (8, AI line of sight)
 *   COL.SOLID = all four · COL.PLAYER_CLIP = PLAYER only (invisible rails, map edge) ·
 *   COL.ENEMY_CLIP = ENEMY only · COL.GATE = PLAYER|ENEMY|PROJECTILE (energy gate: see-through) ·
 *   COL.GLASS = PLAYER|ENEMY|PROJECTILE · COL.RAILING = PLAYER|ENEMY (shoot and see through).
 * Queries take a `mask`: a box is considered when (box.flags & mask) !== 0 and the box is enabled.
 */
export interface BoxDesc extends Aabb {
  /** Default COL.SOLID. */
  flags?: number;
  /** Default 'metal'. */
  surface?: SurfaceType;
  /** Free-form label for lookups. Gate boxes use 'gate:<gate id>', e.g. 'gate:deck-refinery:main'. Default ''. */
  tag?: string;
  /**
   * May decals stick to it? Default true. World sets false on boxes whose collision shape is not the
   * visible surface (stair-stepped ramp boxes) or that can vanish or are see-through (gates, glass).
   */
  decals?: boolean;
}

export interface CollisionBox extends Readonly<Aabb> {
  /** Index into CollisionWorld.boxes; stable for the lifetime of the world. */
  readonly id: number;
  readonly flags: number;
  readonly surface: SurfaceType;
  readonly tag: string;
  readonly decals: boolean;
  readonly enabled: boolean;
}

/** Result of CollisionWorld.raycast (create with makeRayHit()). Only valid when raycast returned true. */
export interface RayHit {
  distance: number;
  point: THREE.Vector3;
  /** Unit normal of the face that was hit (axis aligned). */
  normal: THREE.Vector3;
  boxId: number;
  surface: SurfaceType;
}

/** Result of CollisionWorld.moveAndSlide (create with makeMoveResult()). */
export interface MoveResult {
  /** Standing on a box top after the move. */
  grounded: boolean;
  /** Horizontal motion was blocked along X / Z (caller zeroes that velocity component). */
  hitX: boolean;
  hitZ: boolean;
  /** Upward motion was blocked (caller zeroes upward velocity). */
  hitCeiling: boolean;
  /** Metres climbed by auto step-up during this move (>= 0); use it to smooth the camera. */
  stepped: number;
  /** Metres snapped down to keep ground contact (>= 0). */
  snapped: number;
  /** Box under the feet (-1 when airborne) and its surface. */
  groundBoxId: number;
  groundSurface: SurfaceType;
  /** Last box that blocked horizontal motion (-1 if none). */
  wallBoxId: number;
}

/**
 * Static collision world. Built once by world.init() (addBox ... then finalize()); afterwards only
 * setEnabled changes it (gates). No dynamic bodies: movers call moveAndSlide themselves.
 * Every query is allocation-free and backed by a uniform XZ grid, so per-frame use is fine.
 */
export interface CollisionWorld {
  /** Add a static box; returns its id. Only world.init() adds boxes. */
  addBox(desc: BoxDesc): number;
  /** Call once after the last addBox: computes bounds and the acceleration grid. */
  finalize(): void;
  /** Remove everything (dispose / rebuild). */
  clear(): void;
  /** Toggle a box (gates). Bumps `version`. */
  setEnabled(id: number, enabled: boolean): void;
  /** Toggle every box with this exact tag; returns how many matched. */
  setEnabledByTag(tag: string, enabled: boolean): number;
  /** All boxes including disabled ones (minimap, debug, decal filtering). Never mutate. */
  readonly boxes: readonly CollisionBox[];
  /** Union of all boxes (valid after finalize). */
  readonly bounds: Readonly<Aabb>;
  /** Increments whenever boxes are added or toggled. */
  readonly version: number;

  /**
   * Move an upright AABB (footprint 2*halfWidth square, `height` tall) whose FEET CENTRE is `pos`
   * by `delta`, sliding along obstacles. `pos` is modified in place.
   *   mask     — usually COL.PLAYER or COL.ENEMY.
   *   stepUp   — max ledge height climbed automatically when blocked horizontally (0.45 grounded;
   *              pass a smaller value or 0 while airborne).
   *   snapDown — max distance to snap down onto ground after the move so walking down stairs stays
   *              grounded (pass stepUp when the mover was grounded and is not jumping, else 0).
   * Long moves are sub-stepped internally (no tunnelling up to at least 60 m/s at 30 Hz).
   * A body that clears a low rim in a single stride with no floor within snap reach behind it hops over
   * and continues airborne (it is not reported as a wall hit).
   * Never produces NaN; a zero delta still reports grounded state. Returns `out`.
   */
  moveAndSlide(
    pos: THREE.Vector3,
    halfWidth: number,
    height: number,
    delta: Vec3Like,
    mask: number,
    stepUp: number,
    snapDown: number,
    out: MoveResult,
  ): MoveResult;

  /**
   * Slab raycast against enabled boxes matching `mask`. `dir` must be unit length. Returns true and
   * fills `out` with the NEAREST hit within maxDist. A ray starting inside a box ignores that box.
   */
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number, mask: number, out: RayHit): boolean;
  /** True when nothing matching `mask` (default COL.SIGHT) lies on the segment a -> b. */
  lineOfSight(a: Vec3Like, b: Vec3Like, mask?: number): boolean;
  /** Id of the first enabled box overlapping `box`, or -1. Touching faces do not overlap. */
  overlapBox(box: Aabb, mask: number): number;
  /** Collect the ids of all overlapping boxes into `out` (out.length is set to the count); returns the count. */
  overlapBoxAll(box: Aabb, mask: number, out: number[]): number;
  /** True when a sphere overlaps any matching box. */
  overlapSphere(center: Vec3Like, radius: number, mask: number): boolean;
  /**
   * Highest box top that is <= maxY among enabled boxes matching `mask` (any bit) whose footprint
   * contains (x, z). Returns -Infinity when there is no floor below.
   */
  groundHeight(x: number, z: number, maxY: number, mask: number): number;
}

// ---------------------------------------------------------------------------------------------------
// 11. Navigation (src/nav) — 2.5D grid
// ---------------------------------------------------------------------------------------------------

/** Provided by world.navHints(); consumed by NavGrid.build. */
export interface NavBuildHints {
  /** Grid extent (XZ used; cells start at minX/minZ). At most 512 cells per edge; a larger extent is truncated. */
  bounds: Aabb;
  /** Cell edge in metres (1). */
  cellSize: number;
  /** Zone rectangles used to label cells (first match wins). */
  zones: readonly { id: ZoneId; aabb: Aabb }[];
  /** Regions that are never walkable (hazard pits, clutter). XZ only. */
  blocked: readonly Aabb[];
  /**
   * Collision tags the build must IGNORE — the tags of gate boxes, so the floor under a gate is
   * walkable in the base grid no matter whether the gate is currently closed.
   */
  ignoreTags: readonly string[];
  /**
   * Regions blocked right after the build (the closed gates). Later toggled with setRegionWalkable.
   * Like setRegionWalkable they only affect cells whose CENTRE lies inside the region (inclusive).
   */
  closedRegions: readonly Aabb[];
  /** Flood-fill seeds: only cells connected to a seed are walkable (keeps roofs and crate tops out). */
  seeds: readonly Vec3Like[];
  /**
   * Max height difference between neighbouring cells that still connects them (0.75). This is more than
   * PLAYER.STEP_UP (0.45): ground enemies are moved along the grid (EnemySystem.moveGround), not with
   * moveAndSlide, so a single riser of up to 0.75 m is passable for them but not for the player.
   */
  maxStep: number;
  /** Clearance an agent needs above the floor (1.6) and its half-width (0.4). */
  agentHeight: number;
  agentRadius: number;
}

/** Reusable path buffer (create with makeNavPath()). `points[0..count-1]` are valid. */
export interface NavPath {
  points: THREE.Vector3[];
  count: number;
}

/**
 * 2.5D walkability grid shared by ground AI, the director (spawn validation) and the bot.
 * One walkable height per cell. Flyers ignore it for steering but use heightAt as their floor reference.
 */
export interface NavGrid {
  /**
   * Core calls this once after world.init(). Floors and obstacles are the ENABLED collision boxes with
   * the COL.ENEMY bit, minus hints.ignoreTags. May be called again to rebuild from scratch.
   */
  build(collision: CollisionWorld, hints: NavBuildHints): void;
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originZ: number;
  /** Increments whenever walkability changes (build, setRegionWalkable). */
  readonly version: number;

  /** Cell index (row * cols + col) containing (x, z), or -1 outside the grid. */
  cellAt(x: number, z: number): number;
  /** World centre of a cell (y = floor height) into `out`. */
  cellCenter(cell: number, out: THREE.Vector3): THREE.Vector3;
  isWalkable(x: number, z: number): boolean;
  /**
   * Floor height of the cell at (x, z); `fallback` (default 0) when not walkable / outside. THE cheap
   * per-frame floor query for AI (ground units and flyer altitude) — never world.groundHeightAt per frame.
   */
  heightAt(x: number, z: number, fallback?: number): number;
  /** Zone label of the cell, or null. */
  zoneAt(x: number, z: number): ZoneId | null;
  /** Nearest walkable cell centre within `maxRadius` metres into `out`; false if none. */
  nearestWalkable(pos: Vec3Like, maxRadius: number, out: THREE.Vector3): boolean;
  /**
   * Block or unblock every cell whose CENTRE lies inside `region` (XZ, inclusive). WORLD calls it for
   * gates: a gate region must be at least one cell thick and cover the cell centres across the whole
   * doorway, or it blocks nothing.
   */
  setRegionWalkable(region: Aabb, walkable: boolean): void;
  /** True when a path exists between the two positions (same connected region). */
  isReachable(a: Vec3Like, b: Vec3Like): boolean;

  /**
   * Shared flow field toward one target (the player). The ENEMY MANAGER calls this once per frame (or
   * every few frames); it only recomputes when the target cell or `version` changed. Returns true if
   * recomputed.
   */
  updateFlowField(target: Vec3Like): boolean;
  /**
   * Unit XZ direction (y = 0) that walks toward the flow target from `pos` into `out`.
   * False (out = 0) when `pos` cannot reach the target. Inside the target cell it points straight at it.
   * From an unwalkable cell it steers to the nearest cell centre (within 3 m) that leads to the target.
   * The direction may turn sharply (up to ~130 degrees) from one frame to the next at corners: consumers
   * that show a facing rate-limit their yaw.
   */
  sampleFlow(pos: Vec3Like, out: THREE.Vector3): boolean;
  /** Walking distance in metres from `pos` to the flow target (Infinity when unreachable). */
  flowDistance(pos: Vec3Like): number;

  /**
   * A* from `from` to `to` (both snapped to the nearest walkable cell within 3 m). Fills `out` with a
   * string-pulled list of waypoints ending at `to`. False when no path exists.
   */
  findPath(from: Vec3Like, to: Vec3Like, out: NavPath): boolean;
  /**
   * Random walkable point with minRadius <= distance <= maxRadius from `center`, reachable from
   * `center`. Uses `rng` for sampling. False after 24 failed tries.
   */
  randomPointInAnnulus(center: Vec3Like, minRadius: number, maxRadius: number, rng: Rng, out: THREE.Vector3): boolean;
  /** True when the straight segment a -> b only crosses walkable, step-connected cells. */
  isLineWalkable(a: Vec3Like, b: Vec3Like): boolean;
}

// ---------------------------------------------------------------------------------------------------
// 12. World (src/world)
// ---------------------------------------------------------------------------------------------------

export interface ZoneInfo {
  readonly id: ZoneId;
  /** Display name, e.g. "LANDING DECK". */
  readonly name: string;
  /**
   * The three zone rectangles tile world.bounds along X with no gaps and no overlap (a boundary runs
   * through the middle of the wall band between two zones), so zoneAt never returns null inside bounds —
   * also not inside a gate corridor.
   */
  readonly aabb: Readonly<Aabb>;
  readonly center: THREE.Vector3;
  /** 0 = deck, 1 = refinery, 2 = spire. */
  readonly index: number;
  readonly unlocked: boolean;
}

export interface SpawnPoint {
  readonly id: number;
  /**
   * Ground / heavy: on the floor, guaranteed to be a walkable nav cell with at least 2 m (heavy: 3.5 m)
   * of free space around it. Air: hover position 4-9 m above the floor with clear air around it.
   */
  readonly position: THREE.Vector3;
  readonly zone: ZoneId;
  readonly kind: SpawnKind;
}

export interface DropPad {
  readonly id: number;
  /** Centre of the pad on the floor (a walkable nav cell). */
  readonly position: THREE.Vector3;
  readonly zone: ZoneId;
}

export interface GateInfo {
  /**
   * `<from>-<to>:main` or `<from>-<to>:side` — every zone boundary has both:
   * 'deck-refinery:main', 'deck-refinery:side', 'refinery-spire:main', 'refinery-spire:side'.
   */
  readonly id: string;
  readonly from: ZoneId;
  readonly to: ZoneId;
  readonly open: boolean;
  /** Centre of the doorway on the floor. */
  readonly position: THREE.Vector3;
  /**
   * The blocking volume, also the nav region toggled with it: it must be at least one nav cell (1 m)
   * thick and cover the cell centres across the whole doorway so that a closed gate really disconnects
   * the grid (see NavGrid.setRegionWalkable).
   */
  readonly aabb: Readonly<Aabb>;
  /** Tag of its collision box(es): 'gate:<id>'. */
  readonly tag: string;
}

export interface JumpPadInfo {
  readonly id: number;
  /** Centre of the pad on the floor. */
  readonly position: THREE.Vector3;
  /** Trigger radius in metres. */
  readonly radius: number;
  /** Launch velocity, solved by world for PLAYER.GRAVITY with zero air control (see PlayerSystem.launch). */
  readonly velocity: THREE.Vector3;
  /** Feet position where that arc lands (a walkable nav cell). */
  readonly target: THREE.Vector3;
  readonly zone: ZoneId;
}

/** A damage volume (slag channel, steam vent, arcing conduit). Ground AI never paths through it (nav-blocked). */
export interface HazardInfo {
  readonly aabb: Readonly<Aabb>;
  readonly kind: 'slag' | 'steam' | 'arc';
  /** Damage per second while inside. */
  readonly dps: number;
  /** Intermittent hazards (steam, arcs) toggle this; slag is always active. */
  readonly active: boolean;
}

/**
 * One key of the menu camera path. Render interpolates position and target with a centripetal
 * Catmull-Rom spline over the closed loop of keys (linear time within a segment) and restarts at key 0
 * every time the menu is entered. WORLD guarantees that a tube of 1 m radius along that curve is free of
 * geometry.
 */
export interface CinematicShot {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  /** Seconds to travel to the next key. */
  readonly seconds: number;
  /** Vertical FOV in degrees at this key (default 55). */
  readonly fov?: number;
  /** true: hard cut to the next key instead of travelling to it. */
  readonly cut?: boolean;
}

/** Top-down footprint rectangle for the minimap (world XZ metres). */
export interface MinimapRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly kind: 'floor' | 'ramp' | 'wall' | 'cover' | 'gate' | 'dropPad' | 'jumpPad' | 'hazard';
  /** Top height in metres (terraces 0 / 1.5 / 3, wall tops ...): the UI shades by it. */
  readonly level: number;
  readonly zone: ZoneId | null;
  /** Set for kind 'gate': look the live state up in world.gates. */
  readonly gateId: string | null;
}

/**
 * Static radar data. `rects` are listed in DRAW ORDER (floor, ramp, hazard, pads, cover, wall, gate),
 * at most 400. Radar convention for the UI: at player yaw 0 north (-Z) is up and +X is right; the map
 * rotates by player.yaw.
 */
export interface MinimapData {
  readonly bounds: Readonly<Aabb>;
  readonly rects: readonly MinimapRect[];
}

/**
 * The level. init() builds all meshes under one root named 'world' in ctx.scene, fills ctx.collision
 * (then finalize()) and prepares the data below; the level is built once.
 * update(dt) — animation (gates, beacons, chase lights, slag) runs in every simulated mode; the GAMEPLAY
 * rules run only while ctx.game.mode === 'playing' && ctx.player.alive:
 *   - hazards: every 0.25 s of scaled time, ctx.combat.applyDamage with { amount: dps * 0.25, type
 *     'hazard', faction 'neutral', sourceId 0, weapon 'world', dir zero } on the player AND on every live
 *     enemy whose position is inside an active hazard (so nothing knocked into the slag survives there);
 *   - jump pads: a pad fires when the GROUNDED player's feet are within `radius` of it — player.launch(
 *     pad.velocity) + fx/sound 'jumpPad' — and re-arms 0.5 s later; pads never launch enemies;
 *   - a closed gate touched by the player: 'gateDenied' fx + sound (at most once per second);
 *   - fall-out: player.position.y < killY -> player.teleport(last safe ground) + 25 'fall' damage through
 *     combat.applyDamage (neutral, weapon 'world') + fx 'respawn' + sound 'fallRespawn'.
 * reset() closes every gate INSTANTLY (no animation, fx or sound), locks refinery + spire, re-arms hazards
 * and pads.
 * Layout rules other systems rely on: every zone provides at least 6 'ground', 3 'air' and 2 'heavy'
 * spawn points; everything visible below y = 16 m inside the perimeter is collidable (at least
 * COL.ENEMY | COL.PROJECTILE — flyers and grenades travel there; this overrides "visual only" pipe racks
 * in the world assignment); pure set dressing lives above 16 m or outside the walls. The world's own
 * vitest validates every jump-pad arc (clears geometry, lands on its walkable `target`).
 */
export interface WorldSystem extends System {
  /** Playable volume. The enemy manager kills enemies that leave it; combat removes projectiles that do. */
  readonly bounds: Readonly<Aabb>;
  readonly zones: readonly ZoneInfo[];
  zone(id: ZoneId): ZoneInfo;
  /** Where a run starts (deck). */
  readonly playerStart: { readonly position: THREE.Vector3; readonly yaw: number };
  /**
   * Spawn points filtered by zone and/or kind. Returned arrays are cached: do not mutate. A filtered
   * list may be empty — callers check the length (see DirectorSystem for the fallback order).
   */
  spawnPoints(zone?: ZoneId, kind?: SpawnKind): readonly SpawnPoint[];
  readonly dropPads: readonly DropPad[];
  readonly gates: readonly GateInfo[];
  readonly jumpPads: readonly JumpPadInfo[];
  readonly hazards: readonly HazardInfo[];
  /**
   * Open/close a gate: animation, fx + sound, collision box toggle, nav region toggle and
   * 'gate:state'. Idempotent. `instant` skips animation, fx and sound (reset uses it); collision, nav and
   * the event still happen.
   */
  setGateOpen(id: string, open: boolean, instant?: boolean): void;
  /**
   * Mark a zone unlocked, open every gate leading into it, play 'zoneUnlock' fx + sound, emit
   * 'zone:unlocked'. DIRECTOR calls it (the banner is the director's 'announce'). No-op when already unlocked.
   */
  unlockZone(zone: ZoneId): void;
  /** Zone containing (x, z); null only outside world.bounds. */
  zoneAt(x: number, z: number): ZoneId | null;
  /**
   * Height of the real floor under (x, z) searching down from `fromY` (default: top of the world);
   * -Infinity if none. Only boxes that block BOTH the player and projectiles count, and never gate boxes
   * (tag 'gate:...'), so invisible clips, railings and closed gates are not floors. For setup, spawning
   * and debug — per-frame AI uses ctx.nav.heightAt.
   */
  groundHeightAt(x: number, z: number, fromY?: number): number;
  /**
   * Boss arena on the Core Spire. The boss anchors at center + (0, hoverHeight, 0); EnemyDef.hoverMin /
   * hoverMax of the conductor are only its bob range around that anchor. A boss spawned elsewhere
   * (debug) anchors to its spawn point.
   */
  readonly bossArena: {
    readonly center: THREE.Vector3;
    readonly radius: number;
    readonly hoverHeight: number;
  };
  /** Menu camera path (at least 2 keys), see CinematicShot. */
  readonly cinematicPath: readonly CinematicShot[];
  readonly minimap: MinimapData;
  /** Height below which the player is considered fallen off the rig (and enemies are culled). */
  readonly killY: number;
  /** Nav build input. Core calls it once, right after init(). */
  navHints(): NavBuildHints;
}

// ---------------------------------------------------------------------------------------------------
// 13. Render (src/render)
// ---------------------------------------------------------------------------------------------------

/**
 * Reactive post-processing inputs. Plain mutable numbers written by gameplay, read by render at DRAW time
 * (inside render(), so a value set by a test without stepping is visible to the next frame).
 * IMPULSES decay by themselves inside render.update; writers use `x = Math.max(x, v)` and several
 * systems may write one. LEVELS are states with exactly ONE writer, who writes only while its effect is
 * active and writes the default once when it ends (see the header); render.reset() restores all defaults.
 */
export interface PostFxParams {
  /** IMPULSE 0..1 — red damage vignette (health was hit). Writer: player. */
  damageFlash: number;
  /** IMPULSE 0..1 — cyan edge flash (the shield absorbed a hit). Writer: player. */
  shieldFlash: number;
  /** IMPULSE 0..1 — full-screen colour flash. Written ONLY through RenderSystem.screenFlash (strongest wins). */
  flash: number;
  /** 0xRRGGBB used by `flash`. Written ONLY through RenderSystem.screenFlash. */
  flashColor: number;
  /** IMPULSE 0..1 — extra chromatic aberration. Writers: combat (blasts near the player), player (heavy hits). */
  chromaticBoost: number;
  /** LEVEL 0..1 — low-health desaturation + pulse. Writer: player. */
  lowHealth: number;
  /** LEVEL 0..1 — Overclock treatment. Writer: player. */
  overclock: number;
  /** LEVEL 0..1 — radial dash blur / speed lines. Writer: player. */
  dashBlur: number;
  /** LEVEL 0..1 — ADS vignette. Writer: weapons. */
  adsVignette: number;
  /** LEVEL multiplier (1 = graded default). Writer: director only (death cam; may stay through 'gameover'). */
  saturation: number;
  /** LEVEL multiplier (1 = default). Writer: the conductor kind only (boss staging white-out). */
  exposure: number;
}

/** Readable lighting of the current (possibly mid-transition) time of day. Owned by render. */
export interface LightingState {
  /** Unit vector pointing FROM the scene TOWARD the sun. */
  readonly sunDirection: THREE.Vector3;
  readonly sunColor: THREE.Color;
  readonly sunIntensity: number;
  readonly ambientColor: THREE.Color;
  readonly ambientIntensity: number;
  readonly fogColor: THREE.Color;
  readonly fogDensity: number;
  /** 0 = clear dusk .. 1 = full storm (rain-like static, lightning). */
  readonly storm: number;
  /** 0 = day-ish .. 1 = night (stars, emissives dominate). */
  readonly night: number;
  /** 0..1 current lightning boost of the scene lights (see lightningFlash): fx / world may flicker in sync. */
  readonly flash: number;
}

/** Effective quality parameters (data/quality.ts holds the per-preset baselines). */
export interface QualityParams {
  preset: QualityPreset;
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  /** Vignette / chromatic aberration / grain. */
  filmEffects: boolean;
  /**
   * Multiplier on SECONDARY particle counts (FX reads it). It never thins gameplay-critical visuals:
   * telegraphs, beams, tracers, bolts, damage numbers and the core flash of every explosion.
   */
  particleScale: number;
  /** Max live decals (FX reads it). */
  maxDecals: number;
  /** Multiplier on weather particle density (FX reads it). */
  weatherScale: number;
}

/** Counters of the last rendered frame. */
export interface RenderStats {
  /** All draw calls of the frame: world + view scene + shadow pass + post passes. */
  drawCalls: number;
  /** The shadow-pass and post-pass shares of drawCalls (budget checks subtract them). */
  shadowCalls: number;
  postCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** Compiled shader programs (must not grow during play: see "no shader recompiles"). */
  programs: number;
  /** Effective pixel ratio after dynamic resolution. */
  pixelRatio: number;
  /** CPU milliseconds spent inside the last render(). */
  renderMs: number;
}

export interface ScreenPoint {
  /** CSS pixels relative to the canvas top-left. */
  x: number;
  y: number;
  /** View-space depth in metres (negative = behind the camera). */
  depth: number;
  /** In front of the camera and inside the viewport. */
  visible: boolean;
}

/**
 * Renderer, sky, lighting, time of day, post FX, quality, cinematic cameras.
 * init(): create the WebGLRenderer on ctx.canvas, lights for BOTH scenes, sky, post chain; resolve the
 * 'auto' quality setting. Its roots are named 'render' (one in each scene).
 * update(realDt): time-of-day blending, impulse decay, dynamic resolution, cinematic cameras. Reacts to
 * 'settings:changed' (quality, dynamicResolution, reduceFlashes) and 'game:mode' by itself.
 * reset(): PostFxParams defaults, cancel any lightning flash, setTimeOfDay('dusk', 0).
 * Render NEVER schedules lightning and NEVER plays a sound (the ambient storm is fx weather's).
 *
 * QUALITY. 'auto' is resolved once, in init(): coarse pointer (phone / tablet) -> 'low' when
 * min(screen.width, screen.height) < 800, else 'medium'; desktop whose WEBGL_debug_renderer_info string
 * matches /SwiftShader|llvmpipe|Intel|Iris|UHD|Mali|Adreno|PowerVR/ -> 'medium'; otherwise 'high'.
 * Render never writes the resolved preset back into settings.
 * DYNAMIC RESOLUTION governor: changes ONLY `resolutionScale` (0.5 .. 1, steps <= 0.1, at least 1 s apart,
 * down below 52 fps, up above 58 fps), measures ctx.time.realDt, ignores frames >= 0.1 s and the first 2 s
 * after a mode change or resize, is OFF while ctx.testMode or !settings.dynamicResolution, never touches
 * shadows / bloom / particle caps and never reallocates a target (it renders into a viewport of
 * fixed-size targets).
 *
 * CINEMATIC CAMERAS. Render writes ctx.camera (and calls updateProjectionMatrix after a fov change, then
 * updateMatrixWorld) only while mode is menu / gameover / victory AND !ctx.debug.freeCamera:
 *   menu     — the world's cinematicPath (see CinematicShot);
 *   gameover — from the camera pose at the mode change, ease over 2.5 s to 7 m behind and 4 m above
 *              ctx.player.position (pulled in by collision.raycast with COL.SIGHT), then orbit at
 *              0.1 rad/s looking at player.position + (0, 1, 0);
 *   victory  — orbit ctx.world.bossArena.center at radius bossArena.radius * 1.25 and height
 *              bossArena.hoverHeight * 0.8, 0.12 rad/s, looking at the arena centre.
 * While playing / paused the player owns the camera: render never touches it.
 * The eclipse sky vortex is render's and sits above ctx.world.bossArena.center (fx weather 'vortex' only
 * adds near-camera streaks).
 */
export interface RenderSystem extends System {
  /** For render itself, core and tests. No other system calls methods on it or reads its capabilities. */
  readonly renderer: THREE.WebGLRenderer;
  /**
   * Draw one frame: world scene with ctx.camera, then (only while mode is playing/paused, the player
   * is alive and !ctx.debug.freeCamera) ctx.viewScene with ctx.viewCamera on a cleared depth buffer,
   * then post. Core calls it; nobody else does.
   */
  render(): void;
  /**
   * Match the canvas client size (or the given CSS size): renderer, targets, both camera aspects.
   * Only core calls it, at the start of a frame. A 0 x 0 canvas is clamped to 1 x 1.
   */
  resize(width?: number, height?: number): void;
  /** Canvas size in CSS pixels. */
  readonly width: number;
  readonly height: number;

  /** The RESOLVED preset in use (never 'auto'). */
  readonly quality: QualityPreset;
  /** True while the preset was chosen by render from the device ('auto'), false after an explicit choice. */
  readonly qualityIsAuto: boolean;
  /**
   * Apply a preset (or re-resolve 'auto') immediately and emit 'quality:changed'. settings.set('quality')
   * ends up here. May recompile shaders and reallocate targets — a deliberate, user-triggered hitch.
   */
  setQuality(setting: QualitySetting): void;
  readonly qualityParams: Readonly<QualityParams>;
  /** Current dynamic resolution factor, 0.5 .. 1 (1 while the governor is off). */
  readonly resolutionScale: number;

  /** Mutable reactive post inputs (see PostFxParams). */
  readonly post: PostFxParams;
  /**
   * Full-screen colour flash (explosions near the player: combat; lightning and white-outs: enemy
   * manager / conductor kind; storm: fx weather). Strongest wins: applied only when `intensity` (0..1)
   * exceeds the current post.flash, and then it also sets the colour. Capped by render under reduceFlashes.
   */
  screenFlash(color: number, intensity: number): void;

  /**
   * Blend to another time of day over `seconds` (default 0 = snap) on realDt (the blend continues while
   * paused and during the perk freeze). Called mid-blend it starts from the current blended state.
   * Emits 'timeOfDay:changed' only when the TARGET id changes. DIRECTOR calls it (render.reset() snaps to
   * 'dusk'). FX (weather) and AUDIO (ambience) therefore never rely on the event for the initial state:
   * they sync from `timeOfDay` in init() AND at the end of their reset().
   */
  setTimeOfDay(id: TimeOfDayId, seconds?: number): void;
  /** The target time of day. */
  readonly timeOfDay: TimeOfDayId;
  readonly lighting: LightingState;
  /**
   * Lightning flash of the sky + scene lighting (storm strikes: fx weather; arrival strikes: enemy
   * manager, intensity <= 0.15 and at most one per 0.5 s; boss strikes: conductor kind). intensity 0..1;
   * `direction` = unit vector from the scene toward the bolt (optional). Render boosts sun + hemisphere
   * for 0.25 s with 2-3 flickers (LightingState.flash), glows the sky toward `direction` and adds a post
   * flash of at most 0.35 (0.1 under reduceFlashes). The light count never changes.
   */
  lightningFlash(intensity: number, direction?: Vec3Like): void;
  /**
   * Briefly light the first-person weapon (render owns a muzzle light in the view scene). WEAPONS calls
   * it per shot. `intensity` is normalised 0..1 (1 = a rifle shot at full brightness) and decays in 60 ms.
   */
  muzzleFlash(color: number, intensity: number): void;

  /** Project a world position to canvas CSS pixels with the camera of the last/current frame. Returns out.visible. */
  worldToScreen(world: Vec3Like, out: ScreenPoint): boolean;
  /**
   * Map a point of the first-person layer (view space of ctx.viewCamera, e.g. the muzzle of the
   * viewmodel) to the WORLD point that appears at the same place on screen:
   * out = ctx.camera.matrixWorld * (x * k, y * k, z) with k = tan(camera.fov / 2) / tan(viewCamera.fov / 2),
   * using the camera matrices as they are right now. Returns `out`. WEAPONS start tracers, rail beams,
   * muzzle fx, casings and projectile trails there; the aim itself always comes from player.getAimRay.
   */
  viewToWorld(viewPoint: Vec3Like, out: THREE.Vector3): THREE.Vector3;
  /**
   * Compile the shaders of `object` and its descendants (also hidden or not yet attached ones) against the
   * lights, fog and environment of the given layer's scene ('world' = ctx.scene, default; 'view' =
   * ctx.viewScene) so nothing compiles mid-fight. Callable from any init() after render's: enemies (one
   * actor per kind), weapons (the four viewmodels, layer 'view'), combat (one mesh per ProjectileKind),
   * director (pickups, crate) and fx warm their pooled objects; core warms both whole scenes once after
   * the last init. Never throws.
   */
  warm(object: THREE.Object3D, layer?: 'world' | 'view'): void;
  /** Stats of the last rendered frame. */
  readonly stats: Readonly<RenderStats>;
}

// ---------------------------------------------------------------------------------------------------
// 14. Damage structs
// ---------------------------------------------------------------------------------------------------

/**
 * One instance of damage travelling through combat.applyDamage -> HitTarget.takeDamage.
 * Create with makeDamageInfo() and keep it as module-level scratch (clearDamageInfo() resets every field);
 * victims never retain it.
 */
export interface DamageInfo {
  /**
   * Damage BEFORE victim-side multipliers. Attacker-side factors are already in: weapon damage,
   * ctx.mods.damageMul, falloff, charge. Victim-side factors applied later: HitPart multiplier,
   * energy shields, ctx.mods.damageTakenMul (player only).
   */
  amount: number;
  type: DamageType;
  /** Faction of the attacker. */
  faction: Faction;
  /** HitTarget id of the attacker (player.targetId, enemy.id) or 0 for the world. */
  sourceId: number;
  /** What dealt it (null when not meaningful). 'world' = world-credited, never rewarded. */
  weapon: DamageSource | null;
  /** Part that was struck. Set by combat traces from the hit sphere; 'body' for splash. */
  part: HitPart;
  /**
   * Index into the victim's HitTarget.spheres of the sphere that was struck (ShotHit.sphereIndex), or -1
   * for splash / unknown. Lets a kind tell WHICH weak point or shield plate was hit.
   */
  sphereIndex: number;
  /** Scales the victim's weak-point multiplier (weapon def critScale * ctx.mods.critDamageMul). */
  critScale: number;
  /** World-space impact point. */
  point: THREE.Vector3;
  /** Unit direction the damage travels (attacker -> victim). Zero vector when unknown. */
  dir: THREE.Vector3;
  /**
   * Impulse in m/s along `dir` for a victim of mass 1: the victim's velocity change is knockback / mass
   * (EnemyDef.mass; the player's mass is PLAYER.MASS = 2). Per-ray values add up within a substep and the
   * victim clamps the sum to KNOCKBACK_MAX (12 m/s).
   */
  knockback: number;
  /** Radial damage (explosion / shock): no weak-point crits. */
  splash: boolean;
  /**
   * The player gets the credit for a kill although faction is not 'player' (a chain reaction he started:
   * the blast of a tick he shot). Copied by combat from ExplosionOptions / ProjectileOptions. Default false.
   */
  creditPlayer: boolean;
  /** Suppress every feedback (debug kills). */
  silent: boolean;
}

/** Returned by takeDamage / applyDamage. The object is reused: read it immediately. */
export interface DamageResult {
  /** Total removed from health + shields (0 when ignored). */
  dealt: number;
  healthDamage: number;
  shieldDamage: number;
  /** This damage killed the victim. */
  killed: boolean;
  /** A weak point was struck and the crit multiplier applied. */
  crit: boolean;
  /** Fully stopped by an energy shield / invulnerability (healthDamage 0; shieldDamage may be > 0). */
  absorbed: boolean;
  /** Part that took it (the victim may remap it, e.g. 'body' -> 'shield'). Combat picks its feedback from THIS. */
  part: HitPart;
}

// ---------------------------------------------------------------------------------------------------
// 15. Player (src/player)
// ---------------------------------------------------------------------------------------------------

export interface DashState {
  readonly charges: number;
  readonly maxCharges: number;
  /** Seconds until the next charge returns (0 when full). */
  readonly cooldownLeft: number;
  /** Full recharge time of one charge with perks applied. */
  readonly cooldown: number;
  /** A dash is in progress right now. */
  readonly active: boolean;
}

export interface OverclockState {
  /** 0 .. 100. */
  readonly charge: number;
  /** charge >= 100 and not active. */
  readonly ready: boolean;
  readonly active: boolean;
  /** Seconds of Overclock left (real/unscaled seconds). */
  readonly timeLeft: number;
  /** Full duration with perks applied. */
  readonly duration: number;
}

/**
 * First-person controller, camera feel, vitals, dash, Overclock.
 * init(): registers itself with combat as a HitTarget (faction 'player', id = targetId, center = `center`).
 * update(unscaledDt): consume look, move with ctx.collision.moveAndSlide(COL.PLAYER), vitals regen,
 *   dash, Overclock; then write ctx.camera (position, rotation, fov) + updateMatrixWorld, so weapons and
 *   enemies can project and trace against the new pose in the same substep.
 * lateUpdate(unscaledDt) — the player MUST implement it: rewrite the camera (position, rotation, fov +
 *   updateMatrixWorld) including the recoil, shake and step smoothing that were added during the substep
 *   (weapons.update, combat.explode, hits), so the rendered kick of a shot is never a frame late.
 * onModeChange(mode) — the player MUST implement it: when mode is neither 'playing' nor 'paused', end
 *   Overclock (ctx.time.clearScale('overclock')), write post.lowHealth = post.overclock = post.dashBlur =
 *   0, ctx.audio.setMuffle(0) and stop its loops (see "LEVELS" in the header).
 * Events it listens to: 'enemy:killed' with byPlayer (Overclock charge, the lifeOnKill perk) and
 *   'hit:confirmed' on the boss (1 Overclock point per 150 damage — the boss gives none on death).
 * Overclock points per kill = EnemyDef.overclockCharge * (crit ? 1.5 : 1) * (1 + 0.1 *
 *   (ctx.director.combo.multiplier - 1)), with the multiplier as it stands BEFORE this kill (the player's
 *   handler runs before the director's); no gain while overclock.active.
 * Sprint rule: sprinting needs forward input on the ground and is suppressed by the player itself while
 *   the 'fire' or 'ads' action is held — weapons never have to cancel a sprint.
 * Applies ctx.mods: maxShieldBonus, maxHealthBonus, shieldRegenMul, shieldDelayMul, moveSpeedMul,
 *   extraJumps, dashCooldownMul, extraDashCharges (a newly granted charge arrives full), lifeOnKill,
 *   overclockGainMul, overclockDurationBonus, lastStand, damageTakenMul. Perks arrive mid-run: read the
 *   modifiers live, never cache them.
 * reset(): teleport to world.playerStart, full vitals (with ctx.mods), zero Overclock, clear every
 *   time-scale / post-fx level it owns.
 */
export interface PlayerSystem extends System {
  /** Feet centre. */
  readonly position: THREE.Vector3;
  /** Camera position without shake (feet + eye height). */
  readonly eye: THREE.Vector3;
  /**
   * Body centre = position + (0, height * 0.55, 0); the same vector as its HitTarget.center. ENEMIES aim
   * projectiles and beams here (plus velocity lead) and test line of sight aimPoint -> center — not at
   * `eye`, which sails over a sliding player.
   */
  readonly center: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly yaw: number;
  readonly pitch: number;
  /** Unit view direction (recoil included, shake excluded). */
  readonly forward: THREE.Vector3;
  readonly grounded: boolean;
  readonly crouching: boolean;
  readonly sliding: boolean;
  readonly sprinting: boolean;
  /** Horizontal speed in m/s. */
  readonly speed: number;
  /** Current collision height (1.8 standing, 1.1 crouched) and half width (0.35). */
  readonly height: number;
  readonly halfWidth: number;

  readonly hp: number;
  readonly maxHp: number;
  readonly shield: number;
  readonly maxShield: number;
  readonly alive: boolean;
  /** Dash i-frames, last-stand grace, spawn protection or ctx.debug.god. */
  readonly invulnerable: boolean;
  /** HitTarget id registered with combat. Enemy attacks address the player through combat with it. */
  readonly targetId: number;

  /**
   * Apply damage (reached through combat.applyDamage(player.targetId, info)). Absorbed without any
   * effect while ctx.game.mode !== 'playing', while invulnerable or dead. Otherwise: enemy-faction
   * damage is multiplied by ctx.mods.damageTakenMul; shield first, then health; last stand; knockback =
   * addImpulse(info.dir * info.knockback / PLAYER.MASS). The player owns ALL feedback of being hit:
   * fx 'hitPlayer' / 'hitPlayerShield' at info.point, hurt sounds, post.damageFlash / shieldFlash, shake,
   * rumble, and 'player:damaged' / 'player:shieldBroken' / 'player:died'.
   */
  takeDamage(info: DamageInfo): DamageResult;
  /** Restore health (clamped; Infinity = to full); returns the amount restored. Emits 'player:healed' and spawns 'healPulse' when > 0. */
  heal(amount: number): number;
  /** Restore shield (clamped); returns the amount restored. Emits 'player:healed' { kind: 'shield' } when > 0. */
  addShield(amount: number): number;
  /**
   * Jump-pad launch: REPLACE the velocity and leave the ground. Until the next landing the player keeps
   * the launched horizontal velocity — no air-speed clamp, no air drag; air control may change it by at
   * most 3 m/s in total; gravity is exactly PLAYER.GRAVITY — so a pad arc solved by the world lands where
   * it was aimed. A dash or double jump ends the guarantee. No hard-landing penalty on that landing.
   */
  launch(velocity: Vec3Like): void;
  /**
   * Add a velocity change (melee lunge, knockback, shock waves). The player stays grounded unless the
   * resulting upward speed exceeds 0.5 m/s; the push then decays through normal friction / air control.
   */
  addImpulse(velocity: Vec3Like): void;
  /** Move the feet to `position`, zero the velocity, optionally set the view. */
  teleport(position: Vec3Like, yaw?: number, pitch?: number): void;
  /** Set the view angles (pitch clamped to +-89 degrees). */
  setLook(yaw: number, pitch: number): void;
  /** Eye position and unit aim direction (current recoil in, shake out) into the out vectors. */
  getAimRay(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** Kick the view: `pitch` radians up, `yaw` radians (signed). Player applies and recovers it. */
  addRecoil(pitch: number, yaw: number): void;
  /** Add camera trauma 0..1 (shake = trauma^2, decays; scaled by settings.screenShake). */
  addShake(trauma: number): void;
  /** addShake with linear distance falloff from `position` out to `radius`. */
  addShakeAt(position: Vec3Like, trauma: number, radius: number): void;

  /**
   * ADS coupling. WEAPONS calls it every frame while it updates: `amount` 0..1 blend, `zoom` FOV divisor
   * at full ADS (1.35, 2.5 ...), `moveMul` speed multiplier at full ADS (0.6). Player applies FOV, speed
   * and scales look sensitivity by 1/zoom. Weapons call setAds(0, 1, 1) when they stop updating.
   */
  setAds(amount: number, zoom: number, moveMul: number): void;
  /** Current vertical FOV in degrees written to ctx.camera. */
  readonly fov: number;
  /**
   * Named external speed multipliers (product of all). 1 removes the entry. e.g. ('weapon', 0.92),
   * ('hazard', 0.5). Cleared on reset.
   */
  setSpeedMultiplier(source: string, multiplier: number): void;

  readonly dash: DashState;
  readonly overclock: OverclockState;
  /** Add Overclock charge in points (0..100 scale); ctx.mods.overclockGainMul is applied HERE. */
  addOverclockCharge(points: number): void;
  /** Start Overclock if ready (also bound to the 'overclock' action). Returns whether it started. */
  activateOverclock(): boolean;
  /** Last-stand charges left this run = max(0, ctx.mods.lastStand - charges used this run), read live. */
  readonly lastStandCharges: number;
}

// ---------------------------------------------------------------------------------------------------
// 16. Weapons (src/weapons)
// ---------------------------------------------------------------------------------------------------

/** Live state of one weapon slot. Owned by weapons; read-only for everyone else. */
export interface WeaponState {
  readonly id: WeaponId;
  readonly def: Readonly<WeaponDef>;
  readonly unlocked: boolean;
  /** Rounds in the magazine. */
  readonly mag: number;
  /** Magazine capacity with ctx.mods.magSizeMul applied. */
  readonly magSize: number;
  /** Rounds in reserve / reserve capacity. */
  readonly reserve: number;
  readonly reserveMax: number;
  readonly reloading: boolean;
  /** 0..1 while reloading, else 0. */
  readonly reloadProgress: number;
  /** 0..1 charge of charge weapons (lance), else 0. */
  readonly charge: number;
}

/**
 * Weapon logic, viewmodels (under one root named 'weapons' in ctx.viewScene), grenades, melee.
 * update(unscaledDt): reads input (fire, ads, reload, weapon1-4, weaponNext/Prev, grenade, melee),
 * fires through combat (traceShot / tracePierce / spawnProjectile / applyDamage), owns its feedback
 * (see FEEDBACK OWNERSHIP), calls player.setAds / addRecoil / addShake / addImpulse (melee lunge),
 * render.muzzleFlash. Does nothing while the player is dead.
 * Geometry of a shot: the trace starts at player.getAimRay (eye). Tracers, rail beams, muzzle fx and
 * casings start at ctx.render.viewToWorld(muzzle point of the viewmodel). Projectiles are spawned at
 * eye + forward * 0.6 with ProjectileOptions.visualOrigin = that muzzle point.
 * Player-clock presentation: muzzle*, casing*, lanceDischarge, hornetBackblast, meleeSwing, its tracers
 * and the rail beam are spawned with clock 'player'; impact sparks and decals stay on the world clock.
 * Applies ctx.mods: damageMul, fireRateMul, magSizeMul, reloadSpeedMul, critDamageMul, chainLightning,
 * explosiveCrits, grenadeCapBonus, grenadePowerMul.
 * Rules:
 *   - No ammo is consumed while player.overclock.active or ctx.debug.infiniteAmmo. Grenades ARE consumed
 *     during Overclock; they are free only with ctx.debug.infiniteAmmo.
 *   - shotsFired / shotsHit count the four guns only (not grenades, melee or perk procs). Hitscan, pellet
 *     and beam pulls are settled at fire time (hit = at least one ray dealt damage or was absorbed by a
 *     shield). Projectile pulls are settled later: weapons listens to 'hit:confirmed' and each event whose
 *     weapon is that gun credits ONE still-open pull of it (oldest first; pulls expire after 10 s).
 *   - Chain lightning: at most one proc per trigger pull per primary target; never from damage whose
 *     weapon is 'chainLightning', 'explosiveCrit', 'grenade' or 'melee'. Arcs go through
 *     combat.applyDamage (type 'chain', weapon 'chainLightning').
 *   - Explosive crits: on 'enemy:killed' with byPlayer && crit, combat.explode at the victim (weapon
 *     'explosiveCrit', faction 'player', selfDamageMul 0).
 * onModeChange(mode) — weapons MUST implement it: when mode is neither 'playing' nor 'paused', write
 *   post.adsVignette = 0, call player.setAds(0, 1, 1) and stop the charge loop.
 * reset(): only `vector` unlocked, full magazines, start reserves, 2 grenades, counters zero.
 */
export interface WeaponSystem extends System {
  readonly weapons: Readonly<Record<WeaponId, WeaponState>>;
  readonly current: WeaponState;
  /** A weapon swap animation is in progress. */
  readonly switching: boolean;
  /**
   * Unlock a weapon (full mag + start reserve), emit 'weapon:unlocked'; `equip` switches to it. Silent
   * (the crate fx + sound are the director's); no-op for an unlocked weapon apart from `equip`.
   */
  unlock(id: WeaponId, equip?: boolean): void;
  /** Start switching; false if locked or already current. */
  switchTo(id: WeaponId): boolean;
  /**
   * Add reserve ammo. `amount` is rounds, or a fraction of reserveMax when `asFraction` is true.
   * 'all' = every unlocked weapon. Returns the rounds actually added (0 = already full).
   */
  addAmmo(id: WeaponId | 'all', amount: number, asFraction?: boolean): number;
  /** Fill every magazine, every reserve and the grenades. */
  refill(): void;
  readonly grenades: number;
  readonly grenadeCap: number;
  /** Returns how many were actually added. */
  addGrenades(count: number): number;
  /** Seconds until the next melee is possible (0 = ready). */
  readonly meleeCooldown: number;
  /** Current hip/ADS spread as a half-angle in radians (UI turns it into crosshair gap). */
  readonly spread: number;
  /** 0 hip .. 1 fully aimed. With current.def.scope the UI shows the scope overlay above 0.9. */
  readonly adsAmount: number;
  /** Run counters (see the rules above). DIRECTOR reads them for accuracy. */
  readonly shotsFired: number;
  readonly shotsHit: number;
}

// ---------------------------------------------------------------------------------------------------
// 17. Combat (src/combat)
// ---------------------------------------------------------------------------------------------------

/** One hit sphere of a target, in WORLD space. The target's owner moves `center` every frame. */
export interface HitSphere {
  center: THREE.Vector3;
  radius: number;
  part: HitPart;
  /** Disabled spheres are skipped (e.g. a dropped shield). */
  enabled: boolean;
}

/**
 * Anything that can be shot. Enemies register one per live enemy (id = EnemyHandle.id), the player
 * registers one for itself, combat registers one per shootable projectile (id = projectile id).
 * The object is RETAINED by combat until unregister(id).
 */
export interface HitTarget {
  readonly id: number;
  faction: Faction;
  /** Combat skips targets that are not alive. */
  alive: boolean;
  /** Bounding-sphere centre = the point to aim at (owner keeps it current). */
  center: THREE.Vector3;
  /** Radius enclosing every hit sphere around `center` (broad phase + explosion distance). */
  boundRadius: number;
  spheres: HitSphere[];
  /** Victim-side damage resolution; returns a reusable result. Called by combat.applyDamage only. */
  takeDamage(info: DamageInfo): DamageResult;
  /** Set for enemy targets; null for the player and for projectiles. */
  enemy: EnemyHandle | null;
}

export interface TraceOptions {
  /** Faction of the shooter: targets of the SAME faction are ignored ('neutral' hits everyone). */
  faction: Faction;
  /** Extra target id to ignore (the shooter itself). Default 0. */
  ignoreId?: number;
  /** World collision mask. Default COL.PROJECTILE. Pass 0 to ignore the world. */
  worldMask?: number;
  /** Ray thickness in metres for target tests only (bullet magnetism / melee). Default 0. */
  radius?: number;
}

/** Result of traceShot (create with makeShotHit()). */
export interface ShotHit {
  /** What stopped the ray. 'none' = nothing within maxDist (`point` = origin + dir * maxDist). */
  kind: 'none' | 'world' | 'target';
  distance: number;
  point: THREE.Vector3;
  /** Surface normal (world hit) or direction from the sphere centre to the hit point (target hit). */
  normal: THREE.Vector3;
  target: HitTarget | null;
  /** Part of the sphere that was hit. Per target the NEAREST enabled sphere along the ray wins, so weak-point spheres must poke out of (or sit in front of) the body spheres to be hittable. */
  part: HitPart;
  /** Index of that sphere in target.spheres (-1 unless kind is 'target'). Copy it into DamageInfo.sphereIndex. */
  sphereIndex: number;
  /** Valid for world hits. */
  surface: SurfaceType;
  boxId: number;
}

/** Result of tracePierce (create with makePierceResult()). */
export interface PierceResult {
  /** Target hits ordered near -> far; `hits[0..count-1]` are valid. One entry per target. */
  hits: ShotHit[];
  count: number;
  /** Where the ray ended: world impact or max distance. */
  end: THREE.Vector3;
  endNormal: THREE.Vector3;
  hitWorld: boolean;
  surface: SurfaceType;
  /** Box that stopped the ray (-1 when hitWorld is false). */
  boxId: number;
}

/** Read and copied during the call; nothing is retained. */
export interface ExplosionOptions {
  position: Vec3Like;
  /** Outer radius in metres. */
  radius: number;
  /** Damage at the centre. */
  damage: number;
  /** Fraction of `damage` still dealt at the edge of the radius. Default 0.2. */
  edgeFalloff?: number;
  /**
   * Who is responsible. 'player': hurts enemies, and the player scaled by selfDamageMul.
   * 'enemy': hurts the player; with friendlyFire also other enemies. 'neutral': hurts everyone.
   */
  faction: Faction;
  /** HitTarget id of the instigator (0 = none); becomes DamageInfo.sourceId. An ENEMY owner never damages itself. */
  ownerId?: number;
  /** Target id that takes no damage from this blast (the target a rocket already hit directly). */
  excludeId?: number;
  /** Multiplier on damage dealt to the owner faction's player (hornet 0.35). Default 0.35. */
  selfDamageMul?: number;
  /** Enemy explosions that also hurt enemies (ticks -> chain reactions). Default false. */
  friendlyFire?: boolean;
  /**
   * Kills by this blast are credited to the player although faction is 'enemy' (DamageInfo.creditPlayer).
   * A tick passes `info.faction === 'player' || info.creditPlayer` of the hit that killed it, so a whole
   * chain reaction the player started scores. Default false.
   */
  creditPlayer?: boolean;
  /** Default 'explosion'. */
  type?: DamageType;
  weapon?: DamageSource | null;
  /** Impulse at the centre in m/s for mass 1 (falls off like damage). Default 6. */
  knockback?: number;
  /** Require line of sight (COL.PROJECTILE) from the centre to each victim. Default true. */
  lineOfSight?: boolean;
  /** Which fx + sound + light + shake + decal package combat plays. Default by radius ('small' < 4 m <= 'large'). */
  visual?: ExplosionVisual;
}

/** Read and copied during the call (vectors included); reuse one module-level object. */
export interface ProjectileOptions {
  kind: ProjectileKind;
  /** Where the simulation starts. */
  position: Vec3Like;
  /** Initial velocity in m/s (speed is kept constant while homing). */
  velocity: Vec3Like;
  faction: Faction;
  /** HitTarget id of the shooter (never hit by its own projectile). */
  ownerId: number;
  /**
   * Direct-hit damage. A projectile with splash that strikes a target deals `damage` to that target,
   * then explodes; the struck target is excluded from its own splash (no double dip).
   */
  damage: number;
  /** Default: PROJECTILES[kind].type. */
  type?: DamageType;
  weapon?: DamageSource | null;
  /** > 0: explode on impact / fuse with this radius. Default 0. */
  splashRadius?: number;
  /** Damage at the centre of the splash. Default = damage. */
  splashDamage?: number;
  selfDamageMul?: number;
  friendlyFire?: boolean;
  /** Copied into DamageInfo.creditPlayer of its direct hit and its blast. Default false. */
  creditPlayer?: boolean;
  /** Downward acceleration in m/s^2. Default 0 (straight). */
  gravity?: number;
  /** Restitution 0..1; > 0 = bounces off the world until the fuse ends (grenades). Default 0. */
  bounce?: number;
  /** Seconds until it explodes by itself. Default 0 (none). */
  fuse?: number;
  /** Max turn rate toward the target in rad/s. Default 0. */
  homing?: number;
  /** HitTarget id to home on (default: the player for enemy projectiles). */
  targetId?: number;
  /** Collision radius against targets. Default: PROJECTILES[kind].radius. */
  radius?: number;
  /** Seconds before it silently expires. Default 8. */
  lifetime?: number;
  knockback?: number;
  critScale?: number;
  /** Explosion package when it has splash. Default: PROJECTILES[kind].visual. */
  visual?: ExplosionVisual;
  /**
   * Which clock moves it (motion, gravity, fuse, lifetime, homing, trail): 'player' = ctx.time.playerDt —
   * full speed during Overclock; 'world' = scaled dt. Default: 'player' when faction is 'player', else
   * 'world'.
   */
  clock?: 'world' | 'player';
  /**
   * World point where the projectile should APPEAR to start (the viewmodel muzzle from
   * render.viewToWorld). Combat blends the drawn position (mesh + trail) from there onto the simulated
   * path over the first 0.15 s; the simulation itself is unaffected. Default: `position`.
   */
  visualOrigin?: Vec3Like;
  /**
   * > 0: combat predicts the ballistic impact point on the world and shows a 'mortar' telegraph of this
   * radius there for the flight time, cancelled when the projectile is gone. The shooter creates no
   * telegraph of its own. Default 0 (none).
   */
  landingTelegraph?: number;
}

/**
 * Hit volumes, damage pipeline, projectiles, explosions. Root object: 'combat'.
 * update(dt), in this order:
 *   1. advance projectiles — each on its clock (ProjectileOptions.clock), swept against the world
 *      (COL.PROJECTILE) and hostile targets; resolve impacts, bounces and fuses; remove the ones that left
 *      ctx.world.bounds. Each projectile step is wrapped in try/catch (see ERROR CONTAINMENT).
 *   2. resolve the explosion queue in FIFO order, including blasts enqueued while resolving (a chain
 *      reaction), at most 32 per update — the rest waits for the next substep.
 *   3. flush the hit feedback: per target that the PLAYER damaged since the last flush ONE damage number,
 *      ONE hit sound and ONE 'hit:confirmed' (see that event for the merge rules).
 * Projectiles: per-kind look, trail, fly loop and defaults come from data/projectiles.ts. Combat owns
 * their meshes, trails (owner = projectile id), loops, world impacts (shared impact ids), 'grenadeBounce',
 * 'bulletWhiz' and 'mortarWhistle'; it plays NO launch sound. When a projectile is removed for any reason
 * combat calls ctx.fx.cancelOwner(id) and ctx.audio.stopOwner(id). At MAX_PROJECTILES (96) live
 * projectiles the oldest one is removed silently to make room. Kinds marked `shootable` in
 * data/projectiles.ts are registered as HitTargets (faction of the projectile, one sphere, enemy = null):
 * any damage from a hostile faction destroys them with a small harmless burst.
 * reset(): remove every projectile, queued explosion and pending feedback silently; REGISTRATIONS ARE
 * KEPT (owners unregister their own targets).
 */
export interface CombatSystem extends System {
  /** Start tracking a target (retained). Registering an id twice replaces the previous entry. */
  register(target: HitTarget): void;
  unregister(id: number): void;
  /** O(1). */
  getTarget(id: number): HitTarget | undefined;

  /**
   * Nearest thing along a ray: world box or hostile target sphere. `dir` must be unit length.
   * Returns true when something was hit; `out` is always filled (kind 'none' on a miss).
   * Does NOT apply damage and plays no feedback.
   */
  traceShot(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: ShotHit): boolean;
  /**
   * Piercing ray: every hostile target crossed before the first world hit (or maxDist), near to far.
   * Returns the number of target hits.
   */
  tracePierce(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: TraceOptions, out: PierceResult): number;
  /**
   * THE damage entry point. Calls target.takeDamage(info) at once and returns the victim's reusable
   * result (dealt 0 for unknown / dead targets). When a player-faction hit damaged (or was absorbed by)
   * a hostile non-player target and !info.silent, combat also spawns one hit spark (hitEnemy* chosen by
   * result.part; not for splash) immediately and records the hit for the per-target feedback flush in
   * its next update. Hits ON the player get no feedback from combat (the player owns it).
   * Accepts the target or its id.
   */
  applyDamage(target: HitTarget | number, info: DamageInfo): DamageResult;
  /**
   * Request radial damage + the whole audiovisual package (see ExplosionOptions). ALWAYS queued: `opts`
   * is copied and the blast is resolved inside combat.update (step 2), where its fx and sound also play
   * — never inside this call, so it is safe from anywhere (HitTarget.takeDamage, EnemyBehavior.onKilled,
   * another blast) and the result never depends on who called from where.
   * Damage rule: d = max(0, |position - target.center| - target.boundRadius); targets with d > radius are
   * untouched; damage = lerp(damage, damage * edgeFalloff, d / radius); knockback falls off the same way.
   * The package: fx by `visual` with opts.radius = the damage radius, decal, sound ('explosionDistant'
   * beyond 40 m), pooled light, player.addShakeAt, rumble within 12 m, post.chromaticBoost and
   * render.screenFlash when close.
   */
  explode(opts: ExplosionOptions): void;
  /**
   * Launch a projectile; combat simulates, draws, collides and removes it. Returns its id (also the
   * `owner` id of its trail and loop, and its HitTarget id when shootable).
   */
  spawnProjectile(opts: ProjectileOptions): number;
  /** Remove one projectile; with `detonate` it explodes where it is (if it has splash). False for an unknown id. */
  removeProjectile(id: number, detonate?: boolean): boolean;
  /**
   * Remove projectiles (all, or only one faction's) without detonating them. Queued explosions are not
   * affected. Callers: the director at 'wave:clear' ('enemy'), the enemy manager when the boss dies
   * ('enemy'), reset.
   */
  clearProjectiles(faction?: Faction): void;
  readonly projectileCount: number;
  /** Collect live targets whose bounding sphere touches the query sphere into `out` (out.length is set to the count); returns the count. */
  queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number;
}

// ---------------------------------------------------------------------------------------------------
// 18. Enemies (src/enemies)
// ---------------------------------------------------------------------------------------------------

export interface EnemySpawnOptions {
  /**
   * Skip the lightning arrival (ring telegraph, bolt, flash) and appear immediately. The manager forces
   * it for 'conductor': the boss kind stages its own intro inside update() with actor.invulnerable = true.
   */
  instant?: boolean;
  /** Extra health multiplier on top of ctx.mods.enemyHealthMul. */
  hpMul?: number;
  /** Spawned by the boss: never counted toward the wave quota; scores 25 % (see DirectorSystem). */
  summoned?: boolean;
}

/** Public read-only view of one enemy in the scene. */
export interface EnemyHandle {
  /** Unique per spawn; equals its HitTarget id and the `owner` id of its sounds / beams / telegraphs. */
  readonly id: number;
  readonly type: EnemyType;
  /** Entity origin: FEET on the floor for ground units, HULL CENTRE for flyers (def.flying). */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** World-space centre of mass: aim here, measure distances from here. */
  readonly aimPoint: THREE.Vector3;
  /** Horizontal bounding radius and total height in metres. */
  readonly radius: number;
  readonly height: number;
  readonly yaw: number;
  readonly hp: number;
  readonly maxHp: number;
  /** In play with hp > 0 (also true while arriving). False from the moment hp reaches 0. */
  readonly alive: boolean;
  /** True during the arrival telegraph: not yet targetable or dangerous. */
  readonly spawning: boolean;
  /** hp reached 0 but the corpse is still in the scene (staged death): not targetable, not counted, harmless. */
  readonly dying: boolean;
  readonly zone: ZoneId | null;
  readonly isBoss: boolean;
  readonly summoned: boolean;
}

export interface BossHandle extends EnemyHandle {
  /** Display name, "THE CONDUCTOR". */
  readonly name: string;
  /** 1 .. phaseCount. Changed only through EnemySystem.setBossPhase. */
  readonly phase: number;
  readonly phaseCount: number;
  /** True during the intro, phase transitions and the staged death: every hit is absorbed. */
  readonly invulnerable: boolean;
}

/**
 * PLUG-IN CONTRACT between the enemy manager (src/enemies/index.ts) and each kind
 * (src/enemies/kinds/<type>.ts exporting `<type>Kind`, registered in src/enemies/kinds/index.ts — see
 * PARALLEL-WORK CONVENTIONS in the header). The manager owns pooling, hp arithmetic, hit-target
 * registration, the arrival sequence, events, tokens, knockback, stun, culling and removal. A kind owns
 * its meshes, hit-sphere layout, AI, attacks, animation and its own fx/audio.
 *
 * LIFE OF ONE ENEMY
 *  1. manager.spawn(): takes a pooled actor of the kind (kind.create ran once for that slot) and resets
 *     the manager-owned fields — hp = maxHp = def.hp * (boss ? mods.bossHealthMul : mods.enemyHealthMul)
 *     * (opts.hpMul ?? 1), speed = def.speed * mods.enemySpeedMul, radius / height from def, yaw facing
 *     the player, alive true, dying false, spawning = !instant, stun 0, age 0, knock 0, name = def.name,
 *     phase 1, phaseCount 1, invulnerable false — then calls behavior.onSpawn(opts), emits
 *     'enemy:spawned' (and 'boss:spawned').
 *  2. Arrival (skipped when instant): root hidden; a 'spawn' telegraph + sound 'spawnTelegraph' for
 *     ENEMY_ARRIVAL_SECONDS (0.8 s of world time); then the strike: fx.lightningBolt from the sky (with
 *     its pooled light only for 'heavy' spawns), fx 'spawnFlash', sounds 'spawnStrike' + '<type>Spawn',
 *     render.lightningFlash(<= 0.15) at most once per 0.5 s over all arrivals. Then the root is shown,
 *     spawning = false and the HitTarget is registered (id = actor.id, center = actor.aimPoint, spheres =
 *     actor.spheres). Neither update() nor animate() runs while spawning; the enemy cannot be hit.
 *  3. Every substep afterwards the manager adds to age, counts stun down, decays knock, refreshes zone,
 *     then calls behavior.update(dt) while EnemySystem.canAttack, else behavior.animate(dt). When
 *     canAttack turns false the manager calls ctx.fx.cancelOwner(id) + ctx.audio.stopOwner(id) for every
 *     actor and frees all attack tokens: the first animate() after an update() means "stand down".
 *  4. Damage arrives through the HitTarget the manager registered: ignored while spawning / dying;
 *     absorbed while actor.invulnerable; base = info.amount * (weak and not splash ? def.weakMul *
 *     info.critScale : armor ? def.armorMul : shield ? 0 : 1); hp damage = filterDamage ?
 *     filterDamage(info, base, result) : base, clamped to [0, hp]; result.healthDamage = hp damage,
 *     result.dealt = hp damage + result.shieldDamage, result.absorbed = hp damage === 0. Knockback:
 *     knock += info.dir * info.knockback / def.mass, the sum clamped to KNOCKBACK_MAX. Stun (mass <= 3
 *     only): stun = max(stun, 0.35) for type 'melee', 0.2 for 'rail'; a stunned enemy loses its token.
 *     Survived -> onDamaged + 'enemy:damaged'.
 *  5. Death (hp 0, EnemySystem.kill, killAll): alive = false, HitTarget unregistered, token freed,
 *     ctx.fx.cancelOwner(id) + ctx.audio.stopOwner(id); corpseSeconds = info.silent ? 0 :
 *     (onKilled(info) ?? 0); 'enemy:killed' is emitted. A non-silent BOSS death additionally: every other
 *     live enemy is killed as a world kill, staggered over 0.6 s; ctx.combat.clearProjectiles('enemy');
 *     then 'boss:defeated' with sequenceSeconds = corpseSeconds. With corpseSeconds > 0 the actor stays
 *     in the scene with dying = true and updateDying() is called every substep until that time has run
 *     out on ctx.time.playerDt (so slow motion staged by the kind does not stretch it).
 *  6. Despawn (corpse time over, or immediately; also reset() and killAll(true)): cancelOwner +
 *     stopOwner again, behavior.onDespawn(), root hidden, slot back to the pool.
 *
 * WHO WRITES WHAT on the actor
 *   kind    : position (through moveGround / moveFlying, or directly for ballistic moves such as a leap),
 *             velocity, yaw, aimPoint, the root transform, sphere centres and `enabled` flags — in onSpawn
 *             AND in every update / animate / updateDying — plus invulnerable, name, phaseCount.
 *   manager : hp, maxHp, alive, spawning, dying, zone, age, stun, knock, speed, phase (setBossPhase).
 *
 * The manager wraps EVERY behaviour call in try/catch: an exception is reported with
 * ctx.game.reportError('enemy:<type>', error) and that actor is removed silently; it never rethrows.
 */
export interface EnemyKind {
  readonly type: EnemyType;
  /**
   * Called once per pooled slot. Build meshes under `actor.root` (<= 8 draw calls; boss <= 40), push
   * hit spheres into `actor.spheres`, return the behaviour object bound to this actor.
   */
  create(ctx: GameContext, actor: EnemyActor): EnemyBehavior;
}

/** Mutable enemy state shared by the manager and its kind. Everyone else sees it as EnemyHandle / BossHandle. */
export interface EnemyActor extends EnemyHandle {
  readonly def: Readonly<EnemyDef>;
  /** Scene node (the manager parents it under its 'enemies' root and toggles visibility). The kind positions it from `position`/`yaw`. */
  readonly root: THREE.Group;
  /** Hit spheres in world space; the kind updates the centres every frame. */
  readonly spheres: HitSphere[];
  yaw: number;
  hp: number;
  maxHp: number;
  radius: number;
  height: number;
  alive: boolean;
  spawning: boolean;
  dying: boolean;
  /** Cruise speed in m/s for this spawn = def.speed * ctx.mods.enemySpeedMul. Kinds use THIS, never the modifier. */
  speed: number;
  /**
   * External velocity from knockback (m/s). The manager adds hits to it, clamps it and decays it;
   * moveGround / moveFlying add it to the motion. Kinds never apply it themselves.
   */
  readonly knock: THREE.Vector3;
  /** Seconds of stun left (the manager sets and counts it; a kind must not start or continue an attack while > 0). */
  stun: number;
  /** Seconds since the arrival finished. */
  age: number;
  /** Display name (def.name). Shown for the boss. */
  name: string;
  /** Boss phase state (1 / 1 for regular enemies). The boss kind sets phaseCount in onSpawn and changes phase through EnemySystem.setBossPhase only. */
  phase: number;
  phaseCount: number;
  /** While true the manager absorbs every hit (dealt 0, absorbed true). Written by the kind. */
  invulnerable: boolean;
}

export interface EnemyBehavior {
  /**
   * A fresh spawn of this pooled actor: reset every internal timer/state and pose the root, aimPoint and
   * ALL sphere centres from actor.position / actor.yaw (the target is registered from them before the
   * first update).
   */
  onSpawn(opts: Readonly<EnemySpawnOptions>): void;
  /**
   * Per-substep AI + movement + animation with scaled dt, called while EnemySystem.canAttack. canAttack
   * may turn false in the middle of a substep (another enemy just killed the player): check it right
   * before starting a telegraph and right before applying damage.
   */
  update(dt: number): void;
  /**
   * Idle animation only — no AI, no movement decisions, no attacks. Called instead of update() while
   * !EnemySystem.canAttack (ctx.debug.freezeAi, the player is dead, mode is gameover / victory). The
   * first animate() after an update() abandons the attack in progress (the manager already cancelled the
   * actor's telegraphs, beams and sounds); persistent loops and beams are re-acquired lazily when
   * update() resumes.
   */
  animate(dt: number): void;
  /**
   * Victim-side damage shaping BEFORE hp is reduced (energy shields, per-weak-point logic, phase
   * thresholds). `baseDamage` is the default hp damage (see step 4 above); return the hp damage to apply.
   * The kind may also write result.shieldDamage (damage soaked by its own shield pool), result.part
   * (remap, e.g. 'body' -> 'shield' for an arc-based frontal shield) and result.absorbed; the manager
   * then sets result.dealt = hp damage + result.shieldDamage. info.sphereIndex tells which sphere was hit.
   * The boss holds a phase by clamping: `Math.min(baseDamage, actor.hp - actor.maxHp * tuning.phase2)`.
   */
  filterDamage?(info: Readonly<DamageInfo>, baseDamage: number, result: DamageResult): number;
  /** After hp changed and the actor survived (hurt flash, hurt sound, stagger). */
  onDamaged?(info: Readonly<DamageInfo>, result: Readonly<DamageResult>): void;
  /**
   * hp reached 0 (not called for silent kills): play the death (fx, sound, combat.explode ...). Return the
   * seconds the corpse stays in the scene for a staged death (updateDying runs meanwhile), or nothing / 0
   * to be removed at once. For the boss this value becomes 'boss:defeated'.sequenceSeconds.
   */
  onKilled(info: Readonly<DamageInfo>): number | void;
  /**
   * Per-substep staging of the corpse while actor.dying: `dt` is scaled world time, `playerDt` is
   * ctx.time.playerDt — the clock the corpse timer runs on. Called in playing, gameover and victory.
   */
  updateDying?(dt: number, playerDt: number): void;
  /**
   * The slot is being freed for any reason (death, reset, killAll): drop internal state, clear any
   * time-scale or post level the kind owns. Handles started with owner: actor.id are already dead.
   */
  onDespawn(): void;
}

export interface EnemyKillOptions {
  /** No death feedback, no onKilled, no corpse, score 0, a boss dies without staging. Default false. */
  silent?: boolean;
  /** Credit the kill to the player (byPlayer true, scores). Default false = a world kill, never rewarded. */
  creditPlayer?: boolean;
}

/**
 * Enemy manager. Root object: 'enemies'. init(): register ENEMY_KINDS + placeholders, warm one actor per
 * kind (ctx.render.warm).
 * update(dt): ctx.nav.updateFlowField(player.position); arrivals; per-actor bookkeeping and behaviour
 * calls (see the plug-in contract); corpse timers; culling — an actor outside ctx.world.bounds or below
 * ctx.world.killY dies as a world kill, one with a non-finite position silently; tokens held longer than
 * 8 s are freed. The manager never moves an actor by itself: all motion goes through the kind
 * (moveGround / moveFlying). Runs in gameover / victory too (animate + updateDying only).
 * reset(): despawn everything silently, free all tokens.
 */
export interface EnemySystem extends System {
  /** Register (or replace) the factory for one type. The manager's own init() is the only caller in the game. */
  registerKind(kind: EnemyKind): void;
  /**
   * Spawn one enemy at `position` (floor point for ground units, hover point for flyers). Starts the
   * arrival sequence unless opts.instant. Returns null when MAX_ENEMIES (64) actors are in the scene:
   * the director keeps that wave entry pending and retries next frame; boss summons just skip.
   */
  spawn(type: EnemyType, position: Vec3Like, opts?: EnemySpawnOptions): EnemyHandle | null;
  /**
   * Every actor in the scene: arriving, alive and dying. Always check `alive` (and `spawning`) before
   * treating an entry as a target. Do not hold across frames.
   */
  readonly list: readonly EnemyHandle[];
  /** Number of live enemies (alive, including arriving and summoned ones; NOT dying ones). */
  readonly aliveCount: number;
  /** Live, non-summoned enemies — what the director counts for wave completion. */
  readonly waveCount: number;
  /** Live enemies of one type. */
  countOf(type: EnemyType): number;
  /** O(1) lookup of an actor in the scene (alive or dying). */
  get(id: number): EnemyHandle | undefined;
  /** Nearest live, non-arriving enemy within maxDist of `pos` (distance to aimPoint); null if none. */
  nearest(pos: Vec3Like, maxDist: number): EnemyHandle | null;
  /** Collect live, non-arriving enemies whose aimPoint is within `radius` into `out` (out.length is set to the count). */
  queryRadius(center: Vec3Like, radius: number, out: EnemyHandle[]): number;
  /**
   * Kill one live enemy through the normal death path (step 5 above) as if a lethal hit landed:
   * DamageInfo { type 'hazard', faction 'neutral', sourceId 0, weapon 'world', creditPlayer, silent }.
   * This is how a kind removes its own actor (a tick detonating by proximity, an expiring summon) and how
   * the director removes stragglers. Returns false for an unknown, dying or dead id.
   */
  kill(enemyId: number, opts?: EnemyKillOptions): boolean;
  /**
   * kill() every live enemy as a world kill (never rewarded); returns how many. With `silent` (debug,
   * cleanups) additionally every corpse is freed at once, nothing plays, and a boss dies WITHOUT its
   * staging and without 'boss:defeated'.
   */
  killAll(silent?: boolean): number;
  /** The boss while it is in the scene (alive or in its staged death), else null. */
  readonly boss: BossHandle | null;
  /**
   * Set actor.phase and emit 'boss:phase' (no-op when unchanged). Called by the BOSS KIND only; the
   * manager never derives phases from hp.
   */
  setBossPhase(enemyId: number, phase: number): void;

  // --- shared AI services for kinds ---
  /**
   * May enemies attack right now? = ctx.player.alive && ctx.game.mode === 'playing' && !ctx.debug.freezeAi.
   * Kinds check it before starting a telegraph and before applying damage.
   */
  readonly canAttack: boolean;
  /**
   * Cached line of sight from the enemy's aimPoint to ctx.player.center (COL.SIGHT), refreshed by the
   * manager at most every 0.15 s per enemy (staggered). Kinds use this instead of raycasting every frame.
   * False for unknown ids.
   */
  hasLineOfSight(enemyId: number): boolean;
  /**
   * Global attack-token budget (ctx.mods.attackTokens) so the player is never shot by everything at
   * once. A kind acquires before starting a ranged attack telegraph and releases when the attack ends.
   * `weight` defaults to ENEMIES[type].tokenCost; a cost of 0 always succeeds; asking again while holding
   * returns true. The manager frees a token by itself on death, despawn, stun, when canAttack turns
   * false, and after 8 s.
   */
  tryAcquireAttackToken(enemyId: number, weight?: number): boolean;
  releaseAttackToken(enemyId: number): void;
  /** Sum of the weights currently held (tests, debug). */
  readonly tokensInUse: number;
  /** Raw push-away vector from neighbours within `radius` of the enemy into `out` (XZ, length 0..1). moveGround / moveFlying already apply it. */
  separation(enemy: EnemyHandle, radius: number, out: THREE.Vector3): THREE.Vector3;
  /**
   * THE integrator for ground units: moves actor.position by (desiredVelocity + knock + separation) * dt,
   * constrained to walkable, step-connected nav cells (ctx.nav.isLineWalkable, sliding along the blocked
   * axis), eases y to ctx.nav.heightAt and writes actor.velocity (the velocity actually achieved).
   * `desiredVelocity` is the kind's intent in m/s (XZ; usually flow direction * actor.speed, zero to
   * stand still or while stunned). A unit can never be pushed off the grid or through a wall.
   */
  moveGround(actor: EnemyActor, desiredVelocity: Vec3Like, dt: number): void;
  /**
   * THE integrator for flyers: desiredVelocity (3D) + knock + separation, steered away from geometry
   * (ctx.collision.overlapSphere with COL.ENEMY), kept inside ctx.world.bounds and at least `minAltitude`
   * metres above ctx.nav.heightAt; writes actor.position and actor.velocity.
   */
  moveFlying(actor: EnemyActor, desiredVelocity: Vec3Like, dt: number, minAltitude: number): void;
}

// ---------------------------------------------------------------------------------------------------
// 19. Director (src/director)
// ---------------------------------------------------------------------------------------------------

export interface ComboState {
  /** 1 .. 8. */
  readonly multiplier: number;
  /** Kills in the current chain. */
  readonly count: number;
  /** Seconds before the chain breaks. */
  readonly timeLeft: number;
  /** Full window in seconds (4). */
  readonly window: number;
}

export interface RunStats {
  /** Rewardable kills (see 'enemy:killed': not world-credited, not silent). */
  kills: number;
  /** Copied from weapons.shotsFired / shotsHit. */
  shots: number;
  hits: number;
  /** hits / shots, 0..1 (0 when no shots). */
  accuracy: number;
  crits: number;
  damageDealt: number;
  damageTaken: number;
  /** Unscaled seconds played. */
  seconds: number;
  bestCombo: number;
  bestMultikill: number;
  /** Highest wave reached (1-based). */
  wave: number;
  score: number;
  /** Perks in pick order (duplicates = stacks). */
  perks: PerkId[];
  /** Final grade; '' until the run ended. */
  grade: Grade | '';
  victory: boolean;
}

export interface PickupState {
  readonly id: number;
  readonly type: PickupType;
  readonly position: THREE.Vector3;
  /** Rounds fraction / hp / shield / grenades — see PickupDef. */
  readonly amount: number;
  /** Seconds since it spawned and its total lifetime (Infinity for supply crates). */
  readonly age: number;
  readonly lifetime: number;
  /** For type 'weapon'. */
  readonly weapon: WeaponId | null;
}

export interface ObjectiveState {
  /** Short HUD line, e.g. "ELIMINATE THE STATIC", "COLLECT SUPPLY DROP". */
  readonly text: string;
  /** World marker (supply crate, gate, boss) or null. */
  readonly position: THREE.Vector3 | null;
}

/**
 * Run flow: waves, spawning, pickups, perks, score/combo, progression, supply drops. Root object:
 * 'director' (pickups, crate, beacon). Writes ctx.mods: difficulty fields in startRun, perk fields in
 * choosePerk / grantPerk. The music is NOT its job (audio derives it from events).
 *
 * WAVE FLOW. warmup -> combat. After the last wave enemy died: 'wave:clear' + ctx.combat.clearProjectiles(
 * 'enemy') -> 'cleared' for CLEARED_SECONDS -> zone unlock when due (ctx.world.unlockZone + announce) ->
 * 'supplyDrop' when WaveDef.supply is set (crate on the drop pad of WaveDef.zone nearest the player;
 * collected by walking into it, or by itself after SUPPLY_TIMEOUT_SECONDS so the run can never stall;
 * weapons.unlock + fx/sound 'weaponUnlock') -> 'perkSelect' -> 'intermission' (or 'bossIntro') -> next
 * wave. Time of day follows WaveDef.timeOfDay (render.setTimeOfDay with a blend; debugSkipToWave snaps).
 *
 * SPAWNING. Wave table (data/waves.ts) scaled by ctx.mods.enemyCountMul. Placement from
 * world.spawnPoints(zone, EnemyDef.spawnKind); when that list is empty: the other kinds of the same zone,
 * then any unlocked zone, then ctx.nav.randomPointInAnnulus(player, 12, 30). A spawn() that returns null
 * keeps its entry pending and is retried next frame. The boss spawns at bossArena.center + hoverHeight.
 *
 * KILLS ('enemy:killed', see that event). Not silent and not world-credited: stats.kills + a pickup drop
 * roll (EnemyDef.dropChance). byPlayer: score = e.score * combo multiplier (+ crit bonus), combo and
 * multikill. Summoned enemies: drops as usual, 25 % score, never part of the wave quota.
 *
 * ANTI-STALL. Mercy drop: while the phase is 'combat' or 'boss', if every unlocked weapon holds less
 * than 20 % of its capacity (mag + reserve of magSize + reserveMax) and no 'ammo' pickup is live, spawn
 * one 'ammo' pickup on a walkable point 6-12 m from the player, at most once per 12 s. Straggler
 * watchdog: in 'combat' with nothing left to spawn, when no wave enemy was damaged or killed for 40 s,
 * ctx.enemies.kill() those whose ctx.nav.flowDistance is Infinity or that are more than 80 m from the
 * player (this replaces "re-deploy stragglers" of the director assignment; nothing is relocated).
 *
 * PERK SELECT. Offer up to PERK_CHOICES perks that are below maxStacks (fewer when fewer exist; with
 * none the phase is skipped) and hard-freeze the world with ctx.time.setScale('perkSelect', 0). The
 * choice arrives through choosePerk (UI click, bot, debug — never time-guarded) or through the perk1..3
 * actions, which the director polls itself in update(0) and IGNORES until ctx.time.elapsed -
 * perkOfferedAt >= PERK_INPUT_GUARD_SECONDS (0.6 s; the same keys reload and switch weapons). Applying a
 * perk = PerkDef.apply(ctx.mods) plus the instant part: maxHealth -> player.heal(Infinity), maxShield ->
 * player.addShield(25), grenadier -> weapons.addGrenades(1); then sound 'perkAcquire', fx 'perkChosen',
 * 'perk:chosen'.
 *
 * END OF RUN. On 'player:died': the phase machine stops for good (no wave clear, supply, perk offer,
 * intermission or spawn), a pending perk offer is withdrawn (ctx.time.clearScale('perkSelect'),
 * perkOffer = null), slow motion through ctx.time.setScale('slowmo', ...) and post.saturation are the
 * director's death look; after DEATH_DELAY_SECONDS on ctx.time.playerDt it finalises stats and calls
 * game.endRun(false). On 'boss:defeated' (phase 'boss' only): phase 'done', wait sequenceSeconds on
 * ctx.time.playerDt, finalise stats, game.endRun(true).
 *
 * CLOCKS. Combo window, multikill window, pickup lifetime and all wave / phase timers run on scaled dt;
 * the two end-of-run waits on ctx.time.playerDt; everything timed inside the perk freeze compares
 * ctx.time.elapsed stamps (update(0) is called once per frame there, never summed).
 */
export interface DirectorSystem extends System {
  /** CORE ONLY, after every system was reset: apply difficulty to ctx.mods, enter 'warmup'. */
  startRun(difficulty: Difficulty): void;
  readonly difficulty: Difficulty;
  readonly difficultyDef: Readonly<DifficultyDef>;
  /** Current wave, 1-based (0 before the first wave starts). */
  readonly wave: number;
  readonly totalWaves: number;
  readonly phase: DirectorPhase;
  /** Enemies of the current wave still to kill (alive + not yet spawned). */
  readonly enemiesRemaining: number;
  /** Seconds left in warmup / intermission countdowns (0 otherwise) and the full length. */
  readonly intermissionLeft: number;
  readonly intermissionTotal: number;
  readonly score: number;
  readonly combo: ComboState;
  /** Live statistics of the run (object identity is stable for the whole session). */
  readonly stats: Readonly<RunStats>;
  /** Perks currently on offer (phase 'perkSelect'), else null. */
  readonly perkOffer: readonly PerkId[] | null;
  /** ctx.time.elapsed at the moment the current offer appeared (0 when nothing is on offer): the UI draws its input-lock bar from it. */
  readonly perkOfferedAt: number;
  /** Pick offer[index]; false when nothing is on offer or the index is invalid. Unfreezes the world. Never time-guarded. */
  choosePerk(index: number): boolean;
  /**
   * Give one stack of a perk without an offer (tests, scripted rewards): the same effects as a pick
   * ('perk:chosen' with index -1); the phase is untouched. False at maxStacks.
   */
  grantPerk(id: PerkId): boolean;
  /** Stacks owned of one perk (0 = not owned). `stats.perks` lists every pick in order. */
  perkStacks(id: PerkId): number;
  /** Live pickups including the supply crate. Do not hold across frames. */
  readonly pickups: readonly PickupState[];
  /**
   * Spawn a pickup (debug + scripted rewards). `amount` defaults to the PickupDef amount; `weapon` is
   * required for type 'weapon' (the crate's content).
   */
  spawnPickup(type: PickupType, position: Vec3Like, amount?: number, weapon?: WeaponId): void;
  readonly objective: ObjectiveState;
  /** Award score outside the kill pipeline. */
  addScore(amount: number, reason: ScoreReason, position?: Vec3Like): void;
  /**
   * Debug: kill everything silently and jump so that wave `wave` (1..totalWaves) starts after a 1 s
   * warmup, with the zones, weapons and time of day (snapped) the player would have had by then.
   */
  debugSkipToWave(wave: number): void;
}

// ---------------------------------------------------------------------------------------------------
// 20. Modifiers
// ---------------------------------------------------------------------------------------------------

/**
 * Plain mutable run modifiers. Core resets them to the defaults (in parentheses) before every run.
 * WRITERS: the director only (difficulty in startRun, perks in choosePerk via PerkDef.apply).
 * Each field names the ONE system that applies it — nobody else may, or effects double up.
 */
export interface Modifiers {
  /** (1) weapons: all player-dealt damage (guns, grenades, melee). */
  damageMul: number;
  /** (1) weapons: rate of fire / charge speed. */
  fireRateMul: number;
  /** (1) weapons: magazine capacity (rounded). */
  magSizeMul: number;
  /** (1) weapons: reload speed (time / mul). */
  reloadSpeedMul: number;
  /** (1) weapons: copied into DamageInfo.critScale. */
  critDamageMul: number;
  /** (0) weapons: chain-lightning stacks — direct hits arc to (1 + stacks) enemies within 7 m for 35 % damage. */
  chainLightning: number;
  /** (0) weapons: explosive crit kills — on 'enemy:killed' with crit, explode r = 3.5 m, 40 dmg per stack. */
  explosiveCrits: number;
  /** (0) weapons: extra grenade capacity (the director adds the grenade itself when the perk is taken). */
  grenadeCapBonus: number;
  /** (1) weapons: grenade damage + radius multiplier. */
  grenadePowerMul: number;

  /** (0) player: added to max shield (100); the director tops the shield up by the same amount when the perk is taken. */
  maxShieldBonus: number;
  /** (0) player: added to max health (100); the director heals to full when the perk is taken. */
  maxHealthBonus: number;
  /** (1) player: shield regeneration rate multiplier. */
  shieldRegenMul: number;
  /** (1) player: multiplier on the 4 s delay before shield regeneration. */
  shieldDelayMul: number;
  /** (1) player: walk / sprint / slide speed. */
  moveSpeedMul: number;
  /** (0) player: extra mid-air jumps. */
  extraJumps: number;
  /** (1) player: dash cooldown multiplier. */
  dashCooldownMul: number;
  /** (0) player: extra dash charges. */
  extraDashCharges: number;
  /** (0) player: health restored per kill. */
  lifeOnKill: number;
  /** (1) player: Overclock charge gain. */
  overclockGainMul: number;
  /** (0) player: extra Overclock seconds. */
  overclockDurationBonus: number;
  /** (0) player: last-stand charges granted per run (lethal hit leaves 1 hp + 2 s invulnerability + full shield); see PlayerSystem.lastStandCharges. */
  lastStand: number;
  /** (1) player: multiplier on damage received from the enemy faction (difficulty). */
  damageTakenMul: number;

  /** (1) director: ammo granted by pickups. */
  ammoPickupMul: number;
  /** (0) director: added to every enemy's drop chance. */
  dropChanceBonus: number;
  /** (1) director: score multiplier (difficulty). */
  scoreMul: number;
  /** (1) director: wave density (difficulty). */
  enemyCountMul: number;

  /** (1) enemies: health multiplier applied at spawn (difficulty). */
  enemyHealthMul: number;
  /** (1) enemies: health multiplier for the boss at spawn — used INSTEAD of enemyHealthMul (difficulty). */
  bossHealthMul: number;
  /** (1) enemies: movement speed multiplier (difficulty) — the manager folds it into EnemyActor.speed at spawn. */
  enemySpeedMul: number;
  /** (3) enemies: simultaneous ranged-attack token budget (difficulty). */
  attackTokens: number;
}

// ---------------------------------------------------------------------------------------------------
// 21. FX (src/fx)
// ---------------------------------------------------------------------------------------------------
// All option objects of this section are read during the call and never retained: callers in update
// paths reuse module-level objects (core/make.ts: makeFxOptions / clearFxOptions).

export interface FxSpawnOptions {
  /** Surface normal (impacts, decals); default up. */
  normal?: Vec3Like;
  /** Main emission direction (muzzles, sparks along a shot); default = normal. */
  dir?: Vec3Like;
  /** Cosmetic size multiplier; default 1. */
  scale?: number;
  /**
   * World radius in metres the effect must visually cover (the fireball equals the blast). Authored size
   * when omitted. combat.explode ALWAYS passes its damage radius.
   */
  radius?: number;
  /** 0..1 progress for charge-type stream ids (lanceCharge, riveterCharge, lancerCharge, bossCharge, bossSweepCharge); default 1. */
  charge?: number;
  /** Tint override 0xRRGGBB; default = the effect's own palette colour. */
  color?: number;
  /** Inherited velocity in m/s (effects spawned from moving things). */
  velocity?: Vec3Like;
  /** Which clock animates it: 'world' (default, scaled dt) or 'player' (ctx.time.playerDt — the player's own muzzle flashes and casings keep full speed during Overclock). */
  clock?: 'world' | 'player';
}

export interface TracerOptions {
  /** Default: player cyan for 'player', enemy orange for 'enemy'. */
  color?: number;
  /** Default 'player'. */
  faction?: Faction;
  /** Metres per second of the streak; default 320. */
  speed?: number;
  /** Streak width in metres; default 0.035. */
  width?: number;
  /** Default 'world'; weapons pass 'player' for the player's shots. */
  clock?: 'world' | 'player';
}

export interface BeamOptions {
  kind: BeamKind;
  color?: number;
  /** Core width in metres; default by kind. */
  width?: number;
  /** Seconds before it fades out by itself. 0 = persistent until handle.stop(). Default 0.12. */
  seconds?: number;
  /** Default 'world'; weapons pass 'player' for the rail beam. */
  clock?: 'world' | 'player';
  /** Entity id (enemy.id) the beam belongs to: FxSystem.cancelOwner(id) stops it. Default 0 (none). */
  owner?: number;
}

/**
 * HANDLE RULE (BeamHandle, TelegraphHandle, TrailHandle, LoopHandle): a handle is bound to ONE effect for
 * the whole session. Implementations hand out a fresh small object (or a { slot, generation } proxy) per
 * call and never reuse a handle object for another effect. Every call on a dead handle (stopped, expired,
 * cancelled by owner, invalidated by clear() / reset()) is a no-op for ever, so owners may keep stale
 * handles. When a pool is exhausted, or the system is not running, the factory returns one shared frozen
 * dead handle (active === false) and never throws. beam(), telegraph(), attachTrail() and loop() are
 * never called per frame, so one small allocation per call is fine.
 */
export interface BeamHandle {
  readonly active: boolean;
  /** Move both ends (persistent beams: tracking lasers, boss sweep). */
  set(from: Vec3Like, to: Vec3Like): void;
  /** 0..1 brightness / width factor (charge-up). */
  setIntensity(value: number): void;
  setColor(color: number): void;
  /** Fade out and release. */
  stop(): void;
}

export interface TelegraphOptions {
  kind: TelegraphKind;
  /** Centre on the ground (fx lifts it slightly to avoid z-fighting). */
  position: Vec3Like;
  /** Outer radius in metres. */
  radius: number;
  /**
   * > 0: seconds of WORLD time until the danger lands — the progress runs 0 -> 1 over this time, then the
   * marker disappears by itself. 0: persistent and owner-driven — it stays until cancel() and shows
   * whatever setRadius / setProgress say (shock rings, attacks whose timing can change).
   */
  seconds: number;
  /** Default by kind (see TelegraphKind). */
  color?: number;
  /** Entity id the marker belongs to: FxSystem.cancelOwner(id) removes it. Default 0 (none). */
  owner?: number;
}

/** See the HANDLE RULE above. */
export interface TelegraphHandle {
  readonly active: boolean;
  setPosition(position: Vec3Like): void;
  setRadius(radius: number): void;
  /** Fill progress 0..1 of a PERSISTENT telegraph (ignored by timed ones, which advance by themselves). */
  setProgress(value: number): void;
  /** Remove immediately (attacker died / attack cancelled). */
  cancel(): void;
}

/** See the HANDLE RULE above. */
export interface TrailHandle {
  readonly active: boolean;
  /** Stop emitting; the existing trail fades out by itself. */
  detach(): void;
}

export interface LightningOptions {
  /** Default: lightning white-violet. */
  color?: number;
  /** Core width in metres; default 0.25. */
  width?: number;
  /** Number of side branches; default 3. */
  branches?: number;
  /** Seconds visible; default 0.22. */
  seconds?: number;
  /** Also flash one pooled light at `to`; default true. */
  light?: boolean;
}

export interface DamageNumberOptions {
  crit?: boolean;
  /** The hit was absorbed by a shield (draws in shield colour). */
  shield?: boolean;
  kill?: boolean;
  /** HitTarget id: fx merges numbers that arrive for the same target within 0.25 s into one growing number. */
  targetId?: number;
}

/** Live counters (debug, tests, budgets). */
export interface FxStats {
  particles: number;
  decals: number;
  beams: number;
  telegraphs: number;
  trails: number;
  /** Pooled lights currently lit (0..6). */
  lights: number;
  /** Draw batches used by fx in the last frame (budget: 25). */
  batches: number;
}

/**
 * Particles, decals, tracers/beams, damage numbers, weather, the pooled light rig. Root object: 'fx'.
 * Owns the FIXED pool of 6 THREE.PointLight (created in init, never added/removed later; idle lights sit
 * at intensity 0). Budget: <= 25 draw batches in total, no allocation per spawn. Every pool is allocated
 * in init() for the caps in FX_CAPS (core/constants.ts); 'quality:changed' only changes the active caps,
 * it never allocates or disposes.
 * update(dt): world-clock effects advance with dt, effects created with clock 'player' with
 * ctx.time.playerDt. FX never reads ctx.camera on the CPU for orientation or placement (it runs before
 * the final camera of the frame is known): billboards expand in view space in the vertex shader, the
 * weather volume wraps around the built-in cameraPosition uniform. GPU buffers are written at most once
 * per rendered frame (from onBeforeRender, or when ctx.time.substep === ctx.time.substeps - 1).
 * Purely presentational: no gameplay effect, and no sounds except the ambient storm (see setWeather).
 * No public method ever throws (see ERROR CONTAINMENT in the header).
 * reduceFlashes (settings): fx halves lightFlash intensity and disables bolt strobing.
 * clear(): removes particles, decals, beams, telegraphs, trails, bolts and damage numbers, parks the
 * lights, invalidates all handles — but keeps the weather id and its particles.
 * reset(): clear(), then sync the weather from ctx.render.timeOfDay (also done in init(): never rely on
 * 'timeOfDay:changed' for the initial state).
 */
export interface FxSystem extends System {
  /**
   * Trigger an effect at a world position. Unknown / unimplemented ids must not throw.
   * BURST ids (every id NOT in FX_STREAM_IDS): one call = the complete effect, self-ending within 2.5 s.
   * STREAM ids (FX_STREAM_IDS): one call = one puff of at most 0.25 s at `position`; the owner calls
   * spawn every 0.05 s of its own clock while the state lasts — fx never sustains or follows them.
   */
  spawn(id: FxId, position: Vec3Like, opts?: FxSpawnOptions): void;
  /** Bullet streak from `from` to `to`. */
  tracer(from: Vec3Like, to: Vec3Like, opts?: TracerOptions): void;
  /** Energy beam between two points; one-shot (opts.seconds > 0) or persistent (0) through the handle. */
  beam(from: Vec3Like, to: Vec3Like, opts: BeamOptions): BeamHandle;
  /**
   * Surface mark; the oldest decals are recycled beyond render.qualityParams.maxDecals. Callers pass the
   * `boxId` of the hit (RayHit / ShotHit / PierceResult): fx ignores the call when
   * ctx.collision.boxes[boxId].decals is false and drops live decals whose box gets disabled. The impact
   * particles are spawned by the caller regardless.
   */
  decal(kind: DecalKind, position: Vec3Like, normal: Vec3Like, size?: number, boxId?: number): void;
  /** Floating damage number at a world point (no-op when settings.damageNumbers is false). Damage only — score popups are UI. */
  damageNumber(position: Vec3Like, amount: number, opts?: DamageNumberOptions): void;
  /**
   * Flash one pooled point light, fading to 0 over `seconds`; `radius` = light distance in metres.
   * `intensity` is NORMALISED: 1 = rifle muzzle flash, 2 = rocket / plasma impact, 3 = grenade, 6 = boss
   * burst (clamped to 8); fx converts to three.js units so that 1 lights a white wall 3 m away to about
   * mid-grey. When all 6 are busy the weakest is stolen.
   * `key` (a non-zero entity id): a call whose key already holds a slot REFRESHES that slot (position,
   * colour, intensity, timer) instead of taking a new one — the only way to make a moving or pulsing
   * light (rocket in flight, charging lancer, boss core). Un-keyed per-frame calls are forbidden. At most
   * 2 slots are held by keyed lights; further keys are ignored.
   */
  lightFlash(position: Vec3Like, color: number, intensity: number, radius: number, seconds: number, key?: number): void;
  /**
   * Ground danger marker (enemy arrivals, mortars, lightning strikes, stomps, shock rings). Never fails
   * below FX_CAPS.telegraphs; beyond that the oldest timed one is recycled. Gameplay-critical: never
   * thinned by quality settings.
   */
  telegraph(opts: TelegraphOptions): TelegraphHandle;
  /**
   * Jagged bolt between two points (visual + optional pooled light only). The caller owns the rest of
   * the moment: the burst at `to` ('lightningImpact', 'spawnFlash', 'bossLightningStrike', 'chainArc'),
   * the sound and render.lightningFlash.
   */
  lightningBolt(from: Vec3Like, to: Vec3Like, opts?: LightningOptions): void;
  /**
   * Ribbon/particle trail following `position` — the vector is RETAINED and read every frame until
   * detach(), so pass the entity's own live position vector. `owner`: entity id for cancelOwner (combat
   * passes the projectile id). Trails follow the clock of what they are attached to automatically: they
   * sample the retained position each update.
   */
  attachTrail(kind: TrailKind, position: THREE.Vector3, color?: number, owner?: number): TrailHandle;
  /**
   * Stop every beam, cancel every telegraph and detach every trail created with this owner id. Called by
   * the enemy manager when an actor dies, stands down or is removed, and by combat when a projectile is
   * removed. Unknown ids are a no-op.
   */
  cancelOwner(ownerId: number): void;
  /**
   * Ambient weather. FX sets it by itself from TIME_OF_DAY[ctx.render.timeOfDay].weather (init, reset,
   * 'timeOfDay:changed'); other callers only for debug. FX weather OWNS THE AMBIENT STORM: it schedules
   * strikes at TIME_OF_DAY[render.timeOfDay].lightningPerMinute * render.lighting.storm per minute; one
   * strike = an optional fx.lightningBolt 150-400 m away + ctx.render.lightningFlash(intensity, dir) +
   * ctx.audio.play(distance < 200 ? 'thunderNear' : 'thunderFar', { delay: distance / 343 }). It also
   * plays 'lightningCrack', 'staticCrackle' and 'windGust' one-shots; the continuous wind / static beds
   * are audio's. In ctx.testMode ambient strikes are off unless this method was called from outside since
   * the last reset.
   */
  setWeather(id: WeatherId, intensity?: number): void;
  readonly weather: WeatherId;
  /** Remove every transient effect now and invalidate all handles (see the interface doc). */
  clear(): void;
  readonly stats: Readonly<FxStats>;
}

// ---------------------------------------------------------------------------------------------------
// 22. Audio (src/audio)
// ---------------------------------------------------------------------------------------------------
// Option objects are read during the call and never retained (core/make.ts: makeSoundOptions).

export interface SoundOptions {
  /** Linear gain multiplier, default 1. */
  volume?: number;
  /** Playback-rate multiplier, default 1 (audio adds its own small per-shot variation). */
  pitch?: number;
  /** Seconds to wait before playing, default 0. */
  delay?: number;
  /** 0 ambient .. 3 critical (player weapon, hurt, UI). Under voice pressure the lowest is dropped. Default 1. */
  priority?: number;
  /**
   * Does the slow-motion treatment (pitch drop + low-pass, see AudioSystem) apply to this voice?
   * Default: false for play() — the player's own guns, hurt, stingers and director sounds stay crisp
   * during Overclock — and true for playAt() (the world slows down).
   */
  timeScaled?: boolean;
  /** Entity id (enemy.id, projectile id) the sound belongs to: AudioSystem.stopOwner(id) cuts it, pending delay included. Default 0 (none). */
  owner?: number;
}

export interface LoopOptions {
  /** World position for a 3D loop; omit for a 2D (head-locked) loop. */
  position?: Vec3Like;
  volume?: number;
  pitch?: number;
  /** Fade-in seconds, default 0.05. */
  fadeIn?: number;
  /** As SoundOptions.timeScaled. Default: true with a position, false without. */
  timeScaled?: boolean;
  /** 0..3, default 1: which positional loops stay audible when more than 12 want to play. */
  priority?: number;
  /** Entity id the loop belongs to (AudioSystem.stopOwner). Default 0 (none). */
  owner?: number;
}

/** See the HANDLE RULE at BeamHandle. A handle dies when stopped, on stopOwner, stopAll() and reset(). */
export interface LoopHandle {
  readonly active: boolean;
  setPosition(position: Vec3Like): void;
  /** Target gain, reached after `seconds` (default 0.05). */
  setVolume(volume: number, seconds?: number): void;
  setPitch(pitch: number): void;
  /** Fade out over `seconds` (default 0.08) and release. */
  stop(seconds?: number): void;
}

/** Live output measurements (debug, tools). */
export interface AudioMeter {
  /** 'locked' = no AudioContext yet; 'suspended' = it exists but is not running; 'running'. */
  state: 'locked' | 'suspended' | 'running';
  /** Peak and RMS of the master output over the last ~0.1 s (linear, 1 = full scale). */
  peak: number;
  rms: number;
  /** Number of update() windows since boot in which the output reached full scale. */
  clipped: number;
  /** One-shot voices and loops currently sounding. */
  voices: number;
  loops: number;
}

/**
 * 100 % synthesised WebAudio: engine, SFX library, adaptive music. Buses: sfx, ambience, ui, music.
 * LOCKING. unlock() creates the AudioContext on its first call and, on EVERY call, resumes it when its
 * state is not 'running' (`void ac.resume().catch(() => {})`). `unlocked` is true only while the context
 * exists AND is running. While it is not, play / playAt / loop are silent no-ops (loop returns the
 * shared dead handle) and NOTHING is scheduled — no backlog may burst out later. Audio suspends the
 * context while the page is hidden and resumes it when it becomes visible again. OfflineAudioContext may
 * be used at any time, also in init() (pre-rendering buffers needs no gesture).
 * update(realDt): syncs the listener from ctx.camera, applies the slow-motion treatment, drives the
 * music and the ambience beds (wind, static-rain hiss — from ctx.render.timeOfDay and
 * ctx.render.lighting.storm; synced in init() and at the end of reset(), not only on the event).
 * SLOW-MOTION TREATMENT follows s = min(ctx.time.getScale('overclock'), getScale('slowmo'),
 * getScale('bossStaging')) only — never hitstop, the perk freeze or debug: pitchMul = clamp(1 - 0.5 *
 * (1 - s), 0.7, 1); low-pass cutoff = lerp(20000, 2200, clamp((1 - s) / 0.6, 0, 1)) Hz; both approached
 * with a 0.09 s time constant. It applies to voices and loops with timeScaled only; the music gets the
 * low-pass at half depth and no pitch change; UI sounds get nothing.
 * PAUSE AND FREEZE are audio's job (gameplay systems never stop loops for them): on mode 'paused' the
 * sfx + ambience buses (one-shots, loops, pending delays) are suspended with a 60 ms fade and resumed on
 * leaving it, while UI sounds and the ducked music continue. During the perk-select hard freeze
 * (ctx.time.scale === 0 while playing) timeScaled voices fade to silence and return afterwards. Audio
 * decides "running or not" from ctx.game.mode, never from scale === 0.
 * POSITIONAL LOOPS: at most 12 are audible; audio virtualises the rest by priority then distance and
 * swaps them back in — handles stay valid throughout.
 * MUSIC is automatic: audio derives state and intensity from the events listed under FEEDBACK OWNERSHIP
 * plus ctx.enemies.aliveCount / player hp, and plays the victory / defeat stinger on 'run:end'. Gameplay
 * systems do NOT call setMusicState.
 * Volumes follow ctx.settings ('settings:changed'). No public method ever throws.
 * reset(): stopAll(), then sync the ambience from ctx.render.timeOfDay; the music follows the next mode.
 */
export interface AudioSystem extends System {
  /** See LOCKING. Core calls it from startRun and from every user gesture (pointer, key, touch). */
  unlock(): void;
  /** The AudioContext exists and is running. */
  readonly unlocked: boolean;
  /** Non-positional one-shot (UI, the player's own gun, stingers). UI sound ids go to the ui bus. */
  play(id: SoundId, opts?: SoundOptions): void;
  /** Positional one-shot (PannerNode, distance attenuation, light reverb send). */
  playAt(id: SoundId, position: Vec3Like, opts?: SoundOptions): void;
  /** Start a sustained sound; control and stop it through the handle. */
  loop(id: LoopId, opts?: LoopOptions): LoopHandle;
  /**
   * Fade out (default 0.06 s) every one-shot, pending delayed one-shot and loop that was started with
   * this owner id; their handles die. Called by the enemy manager / combat when the entity is gone.
   */
  stopOwner(ownerId: number, fadeSeconds?: number): void;
  /** Force a music state (debug / screenshots); null returns to automatic. */
  setMusicState(state: MusicState | null): void;
  readonly musicState: MusicState;
  /** Force the 0..1 combat intensity; null returns to automatic. */
  setMusicIntensity(value: number | null): void;
  readonly musicIntensity: number;
  /** Temporarily lower music by `amount` 0..1 for `seconds` (big explosions, stingers). */
  duck(amount: number, seconds: number): void;
  /** LEVEL 0..1 low-pass "muffle" on the sfx + ambience + music buses (low health, nearby blast). ONE writer: the player. */
  setMuffle(amount: number): void;
  /**
   * Stop every voice and loop on the sfx and ambience buses with a short fade; all LoopHandles die.
   * Never touches the ui bus (the click that started the run keeps ringing) or the music.
   */
  stopAll(): void;
  readonly meter: Readonly<AudioMeter>;
  /**
   * Render one sound (or 2 s of a loop) offline and report its length and level — lets tools check that
   * every id is audible and none clips. Works while locked. Resolves with zeros when rendering is
   * impossible; never rejects.
   */
  measure(id: SoundId | LoopId): Promise<{ seconds: number; peak: number; rms: number }>;
}

// ---------------------------------------------------------------------------------------------------
// 23. UI (src/ui)
// ---------------------------------------------------------------------------------------------------

/**
 * DOM HUD + menus + perk select + settings + minimap + touch controls, all inside ctx.uiRoot.
 * Never called by gameplay. update(realDt) reads ctx state every frame (also in menus and while
 * paused); events drive transient elements (hitmarkers, damage arcs, banners, callouts, score popups).
 * Button handlers call ctx.game.startRun / pause / resume / restart / toMenu, ctx.director.choosePerk,
 * ctx.settings.set. The 'pause' action is handled by CORE — the UI must not toggle pause on it
 * (see consumesPauseAction for nested panels). Pausing during perk select is allowed: the pause menu
 * covers the cards, which return on resume; wantsPointer() stays true.
 *
 * WHAT THE UI DRAWS — AND WHAT IT DOES NOT
 *   - No full-screen tint, vignette or blur for damage, low health, Overclock, dash or ADS: render.post
 *     owns those. Its only full-screen layers are the scope mask, menu scrims and the rotate-device nudge.
 *     Never use CSS backdrop-filter over the canvas.
 *   - Banners come ONLY from 'announce' (policy there). Multikill callouts come from 'multikill' as a
 *     callout line. Floating score popups at 'score:changed'.position are UI (DOM pool +
 *     render.worldToScreen); damage numbers are fx.
 *   - The fatal panel belongs to index.html + core; the boot screen is index.html's #boot element (the UI
 *     just shows its menu on the first 'game:mode' menu).
 *
 * FOCUS AND NAVIGATION. Every screen has exactly one focused control: focus the primary control when a
 * screen opens, restore the previous one when it closes. uiUp / uiDown / uiLeft / uiRight move DOM focus;
 * the UI implements key repeat itself (0.4 s, then every 0.12 s). Activation and value changes:
 * keyboard and mouse use the NATIVE behaviour of the focused element only (Enter / Space click a button,
 * arrows move a slider); the UI reacts to justPressed('uiConfirm') (-> document.activeElement.click()) and
 * to uiLeft / uiRight value steps ONLY while ctx.input.device === 'gamepad' — otherwise Enter would
 * activate twice. Every button action lives in its DOM click handler. A screen ignores confirm for 0.3 s
 * after it opens. Perk cards: focus moves with uiLeft / uiRight, confirm picks (the D-pad never picks
 * directly); the perk1..3 keys are polled by the director, not the UI.
 *
 * TIMING. Everything with a lifetime (banners, hitmarkers, damage arcs, feed entries, callouts,
 * count-ups) is timed by update(realDt), never by animationend / setTimeout. In ctx.testMode the UI adds
 * the class `sh-test` to ctx.uiRoot, under which every transition and animation duration is 0 s
 * (repeatable screenshots). Never wait for document.fonts: all layouts must hold with the fallback stacks.
 *
 * TOUCH CONTROLS are shown while ctx.input.device === 'touch' ('input:device'). They feed
 * ctx.input.setVirtualMove / setVirtualButton / addVirtualLookPixels ONLY from pointer events, release
 * exactly the buttons they hold and zero their stick whenever they hide (mode !== 'playing',
 * wantsPointer(), device change, pointercancel), and never call clearVirtual() (the bot shares the
 * channel). Each touch button carries `data-touch="<InputAction>"`, the look zone `data-touch="look"`,
 * the stick zone `data-touch="move"` (tools tap them by that attribute).
 *
 * FULLSCREEN is UI-only and optional: show the button only when document.fullscreenEnabled; call
 * document.documentElement.requestFullscreen() inside the click handler with .catch(() => {}).
 *
 * Styling: index.html defines the design tokens as CSS custom properties on :root (--sh-bg, --sh-cyan,
 * --sh-warning, --sh-danger, --sh-font-display / -ui / -mono, --sh-safe-top/right/bottom/left,
 * --sh-fast, --sh-medium ...). Use them; add further tokens on :root from the UI stylesheet instead of
 * hard-coding colours. Edge-anchored elements pad with the --sh-safe-* tokens.
 * reset(): clear transient elements. The UI must tolerate every getter of a freshly reset game.
 */
export interface UiSystem extends System {
  /**
   * Core has ALREADY shown the built-in `#fatal` panel of index.html. This hook lets the UI hide its
   * HUD/menus and stop animating. It must not throw and must not build a second panel.
   */
  showFatal(title: string, message: string): void;
  /**
   * True while a screen that needs the mouse cursor is open during 'playing' (perk select, an in-game
   * settings panel). Core releases pointer capture while true and re-requests it when it turns false.
   * Called by core every frame: keep it trivial.
   */
  wantsPointer(): boolean;
  /**
   * True while a nested screen is open that should swallow the 'pause' action itself (Esc / P / Start
   * closing a settings sub-panel instead of toggling pause). While true core does not toggle pause on
   * that action; the UI reads justPressed('pause') / justPressed('uiBack') and closes its panel.
   * Called by core only on frames where the action was pressed.
   */
  consumesPauseAction(): boolean;
  /** The screen currently shown (tests, tools). */
  readonly screen: UiScreen;
  /**
   * Debug / screenshots: force a screen regardless of the game state (settings, controls, difficulty ...);
   * null returns to automatic. Showing a screen whose data is missing must not throw.
   */
  debugShow(screen: UiScreen | null): void;
}

// ---------------------------------------------------------------------------------------------------
// 24. Data tables (src/data)
// ---------------------------------------------------------------------------------------------------
// These TYPES are frozen. The VALUES in src/data are tuned by the owning team (see DATA TABLES in the
// header); everyone else reads the tables and never copies their numbers.

export interface WeaponDef {
  id: WeaponId;
  /** "VECTOR-7". */
  name: string;
  /** "Pulse rifle". */
  kind: string;
  description: string;
  /** 1..4 (weapon1..weapon4 actions). */
  slot: number;
  /**
   * auto = hold to fire · semi = one shot per press · charge = hold fire to charge; the shot is released
   * automatically the moment the charge completes (letting go earlier cancels and keeps the round).
   */
  trigger: 'auto' | 'semi' | 'charge';
  /** hitscan = single ray · pellets = `pellets` rays · beam = piercing ray · projectile = combat.spawnProjectile. */
  delivery: 'hitscan' | 'pellets' | 'beam' | 'projectile';
  /** Rounds per minute (charge weapons: minimum cycle between shots). */
  rpm: number;
  /** Damage per ray / beam / direct projectile hit. */
  damage: number;
  pellets: number;
  magSize: number;
  /** Reserve capacity and the reserve the weapon comes with when unlocked. */
  reserveMax: number;
  reserveStart: number;
  /** Seconds for a full reload (per shell when reloadPerRound). */
  reloadSeconds: number;
  reloadPerRound: boolean;
  /** Seconds to raise the weapon after a switch. */
  equipSeconds: number;
  /** Seconds of hold to reach full charge (charge trigger). */
  chargeSeconds: number;
  /** Hip spread half-angle in radians: resting, maximum, added per shot, recovered per second. */
  spreadMin: number;
  spreadMax: number;
  spreadPerShot: number;
  spreadRecovery: number;
  /** Spread multipliers: fully aimed / moving at walk speed / airborne / crouched. */
  spreadAdsMul: number;
  spreadMoveMul: number;
  spreadAirMul: number;
  spreadCrouchMul: number;
  /** Fixed cone half-angle of the pellet pattern in radians (pellets only). */
  pelletSpread: number;
  /** Recoil per shot in radians (pitch up, random yaw amplitude) and the multiplier while aimed. */
  recoilPitch: number;
  recoilYaw: number;
  recoilAdsMul: number;
  /** Camera trauma per shot 0..1. */
  shake: number;
  /** ADS: FOV divisor, blend seconds, move speed multiplier, scope overlay. */
  adsZoom: number;
  adsSeconds: number;
  adsMoveMul: number;
  scope: boolean;
  /** Max trace distance; damage falloff start/end distance and the multiplier at/after `falloffEnd`. */
  range: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  /** Multiplier on the victim's weak-point multiplier. */
  critScale: number;
  /** Impulse in m/s given to the victim per ray. */
  knockback: number;
  /** Beam passes through every target. */
  pierce: boolean;
  /** Projectile delivery: speed m/s, splash radius, splash damage at the centre, self damage multiplier. */
  projectileSpeed: number;
  splashRadius: number;
  splashDamage: number;
  selfDamageMul: number;
  /** Player move-speed multiplier while holding it. */
  moveMul: number;
  /** 0 = owned from the start, else delivered by supply drop after this wave. */
  unlockAfterWave: number;
}

/** Suit extras that are not magazine weapons (data/weapons.ts: GRENADE, MELEE). */
export interface GrenadeDef {
  damage: number;
  radius: number;
  fuseSeconds: number;
  throwSpeed: number;
  gravity: number;
  bounce: number;
  startCount: number;
  cap: number;
  selfDamageMul: number;
  cooldownSeconds: number;
}

export interface MeleeDef {
  damage: number;
  range: number;
  /** Half-angle of the cone in radians. */
  coneAngle: number;
  cooldownSeconds: number;
  /** Forward lunge speed in m/s (weapons apply it with player.addImpulse). */
  lunge: number;
  knockback: number;
}

/**
 * Per-kind projectile defaults (data/projectiles.ts: PROJECTILES, owned by the combat team). Shooters
 * may rely on them; fields of ProjectileOptions override them per shot.
 */
export interface ProjectileDef {
  kind: ProjectileKind;
  /** Collision radius against targets in metres. */
  radius: number;
  /** DamageType of its direct hit and its blast. */
  type: DamageType;
  /** Trail combat attaches to it (null = none). */
  trail: TrailKind | null;
  /** Fly loop combat plays at it (null = silent). */
  loop: CombatLoopId | null;
  /** Blast look when it has splash. */
  visual: ExplosionVisual;
  /**
   * Hostile fire can destroy it in flight: combat registers such a projectile as a HitTarget (see
   * CombatSystem). Only the boss missiles are.
   */
  shootable: boolean;
}

export interface EnemyDef {
  type: EnemyType;
  /** "SKITTER". */
  name: string;
  role: string;
  hp: number;
  /** Cruise speed in m/s before difficulty (kinds read EnemyActor.speed, which includes ctx.mods.enemySpeedMul). */
  speed: number;
  /** Bounding radius / height in metres. */
  radius: number;
  height: number;
  flying: boolean;
  /**
   * Preferred altitude above the floor (ctx.nav.heightAt) for flyers [min, max]; [0, 0] for ground units.
   * For the conductor it is only the bob range around its anchor (see WorldSystem.bossArena).
   */
  hoverMin: number;
  hoverMax: number;
  /** Primary attack damage per hit. */
  damage: number;
  /** Preferred engagement band in metres. */
  rangeMin: number;
  rangeMax: number;
  /** Seconds between attacks. */
  attackCooldown: number;
  /** Telegraph seconds before a ranged attack lands (>= 0.35). */
  telegraphSeconds: number;
  /** Projectile speed in m/s (0 = not a projectile attacker). */
  projectileSpeed: number;
  /** Base score for a kill. */
  score: number;
  /** Overclock points granted to the player for a kill. */
  overclockCharge: number;
  /** Damage multiplier on HitPart 'weak' (x critScale) and 'armor'. */
  weakMul: number;
  armorMul: number;
  /** Chance 0..1 to drop a pickup. */
  dropChance: number;
  /** Where it may be spawned. */
  spawnKind: SpawnKind;
  /** Attack-token weight of its ranged attack = the default of tryAcquireAttackToken (0 = always granted). */
  tokenCost: number;
  /** Knockback divisor: velocity change = DamageInfo.knockback / mass (1 = light, 10 = barely moves). Stun only affects mass <= 3. */
  mass: number;
  /** 0xRRGGBB emissive accent. */
  accent: number;
  /**
   * Kind-specific tuning (leap range, blast radius, shield hp ...): see data/enemies.ts. The engineer of a
   * kind may add keys to its own row; `deathSeconds` (conductor) is the length of the staged death.
   */
  tuning: Readonly<Record<string, number>>;
}

/** `count` enemies of one type, first at `at` seconds after wave start, then one every `interval` seconds. */
export interface WaveGroupDef {
  type: EnemyType;
  count: number;
  at: number;
  interval: number;
  /** Zone to spawn in; default = WaveDef.zone. */
  zone?: ZoneId;
}

export interface WaveDef {
  /** 1-based. */
  index: number;
  /** Banner subtitle, e.g. "FIRST CONTACT". */
  name: string;
  /** Main zone of the wave. */
  zone: ZoneId;
  groups: readonly WaveGroupDef[];
  boss: boolean;
  /** Spawns are delayed while this many wave enemies are alive. */
  maxAlive: number;
  /** Score bonus for clearing it. */
  clearBonus: number;
  /** Seconds of intermission AFTER this wave (0 for the last). */
  intermissionSeconds: number;
  /** Zone unlocked after this wave is cleared. */
  unlocksZone: ZoneId | null;
  /** Weapon delivered by supply drop after this wave is cleared. */
  supply: WeaponId | null;
  /** Time of day during this wave. */
  timeOfDay: TimeOfDayId;
}

export interface PerkDef {
  id: PerkId;
  /** "OVERPRESSURE". */
  name: string;
  /** One line shown on the card; `{value}` style text is already baked in. */
  description: string;
  /** How many times it can be taken. */
  maxStacks: number;
  rarity: 'common' | 'rare' | 'epic';
  /** Icon key for the UI (it draws the glyph procedurally). */
  icon: string;
  /** Mutate the modifiers for ONE newly acquired stack. Pure: touches nothing but `mods`. */
  apply(mods: Modifiers): void;
}

export interface DifficultyDef {
  id: Difficulty;
  /** "VETERAN". */
  name: string;
  description: string;
  enemyHealthMul: number;
  /** Multiplier on damage the player receives. */
  enemyDamageMul: number;
  enemySpeedMul: number;
  /** Wave density multiplier (group counts are rounded up). */
  enemyCountMul: number;
  bossHealthMul: number;
  scoreMul: number;
  attackTokens: number;
  /** Multiplier on every enemy's drop chance. */
  dropMul: number;
}

export interface PickupDef {
  type: PickupType;
  name: string;
  /** ammo: fraction of reserveMax for every unlocked weapon · health/shield: points · grenade: count · weapon: 1. */
  amount: number;
  /** Relative weight when the director rolls a drop (0 = never dropped by enemies). */
  weight: number;
  /** Seconds before it expires (Infinity = never). */
  lifetime: number;
  /** Metres at which it starts flying to the player, and at which it is collected. */
  magnetRadius: number;
  collectRadius: number;
  /** 0xRRGGBB. */
  color: number;
}

/** Baseline look of one time of day (data/timeOfDay.ts, owned by render). Render may refine but must keep LightingState in sync. */
export interface TimeOfDayDef {
  id: TimeOfDayId;
  /** "AMBER DUSK". */
  name: string;
  /** Inclusive wave range. */
  waveFrom: number;
  waveTo: number;
  weather: WeatherId;
  /** Ambient storm lightning strikes per minute at storm = 1 (0 = none); scheduled by fx weather. */
  lightningPerMinute: number;
  /** Sun elevation above the horizon / azimuth, degrees (azimuth 0 = toward -Z, 90 = toward +X). */
  sunElevation: number;
  sunAzimuth: number;
  sunColor: number;
  sunIntensity: number;
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fogColor: number;
  fogDensity: number;
  /** 0..1 inputs for LightingState.storm / night. */
  storm: number;
  night: number;
}

// ---------------------------------------------------------------------------------------------------
// 25. Debug / test API (core/debug.ts) — window.__SH
// ---------------------------------------------------------------------------------------------------

export interface DebugError {
  /** 'window', 'promise', 'init:world', 'update:enemies', 'event:enemy:killed', 'enemy:tick', 'audio' ... */
  source: string;
  message: string;
  stack: string;
  /** ctx.time.elapsed when it happened. */
  at: number;
}

/** JSON-safe snapshot returned by __SH.state(). */
export interface DebugState {
  mode: GameMode;
  difficulty: Difficulty;
  phase: DirectorPhase;
  wave: number;
  totalWaves: number;
  score: number;
  combo: number;
  objective: string;
  /** Live enemies (EnemySystem.aliveCount), and how many actors are still arriving / are corpses. */
  enemiesAlive: number;
  enemiesSpawning: number;
  enemiesDying: number;
  enemiesRemaining: number;
  tokensInUse: number;
  pickups: number;
  projectiles: number;
  boss: { hp: number; maxHp: number; phase: number; invulnerable: boolean; dying: boolean } | null;
  perkOffer: PerkId[] | null;
  /** Stacks per owned perk. */
  perks: Partial<Record<PerkId, number>>;
  player: {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    yaw: number;
    pitch: number;
    hp: number;
    shield: number;
    alive: boolean;
    grounded: boolean;
    crouching: boolean;
    sliding: boolean;
    sprinting: boolean;
    invulnerable: boolean;
    dashCharges: number;
    overclock: number;
    overclockReady: boolean;
    overclockActive: boolean;
    lastStand: number;
  };
  weapon: {
    id: WeaponId;
    mag: number;
    reserve: number;
    reloading: boolean;
    charge: number;
    spread: number;
    ads: number;
    switching: boolean;
    unlocked: WeaponId[];
  };
  grenades: number;
  stats: RunStats;
  zones: Record<ZoneId, boolean>;
  timeOfDay: TimeOfDayId;
  weather: WeatherId;
  quality: QualityPreset;
  resolutionScale: number;
  lookMode: LookMode;
  device: InputDevice;
  uiScreen: UiScreen;
  musicState: MusicState;
  musicIntensity: number;
  audioState: AudioMeter['state'];
  voices: number;
  particles: number;
  fps: number;
  /** RenderStats of the last rendered frame. */
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  /** ctx.time.now / frame / scale. */
  simTime: number;
  frame: number;
  timeScale: number;
  errors: number;
}

export interface BotOptions {
  /** Start a run from the menu and restart after game over / victory. Default false. */
  autoStart?: boolean;
  difficulty?: Difficulty;
  /** Seconds the bot waits on the perk screen before choosing. Default 0.4. */
  perkDelay?: number;
  /** Aim turn rate limit in rad/s. Default 9. */
  turnRate?: number;
}

export interface StepOptions {
  /** Simulation step in seconds. Default 1/60. */
  dt?: number;
  /** true = render every stepped frame · false = never · n = render every n-th frame. Default false. */
  render?: boolean | number;
}

/**
 * window.__SH — automation surface used by tools/. Every method works in normal and in test mode;
 * step() is what advances the simulation in test mode (manual stepping, see GameContext.testMode).
 */
export interface DebugApi {
  /** True once boot finished and the game sits in 'menu'. */
  ready: boolean;
  /** True when a fatal error stopped the game. */
  readonly fatal: boolean;
  /** Manual stepping mode (test mode). */
  manual: boolean;
  errors: DebugError[];
  ctx: GameContext;
  state(): DebugState;
  /** startRun(difficulty ?? 'veteran'). */
  start(difficulty?: Difficulty): DebugState;
  /** Advance the game by `seconds` in fixed frames of opts.dt. */
  step(seconds: number, opts?: StepOptions): DebugState;
  /** Render one frame without advancing the simulation. */
  renderFrame(): void;
  pause(): void;
  resume(): void;
  menu(): void;
  /** Force the run to end (calls game.endRun). */
  endRun(victory: boolean): void;
  god(on: boolean): void;
  infiniteAmmo(on: boolean): void;
  freezeAi(on: boolean): void;
  /** Unlock + refill every weapon and grenades, unlock every zone. */
  giveAll(): void;
  setWave(wave: number): void;
  /** Spawn an enemy (instant arrival). Position defaults to 8 m in front of the player. Returns its id or -1. */
  spawn(type: EnemyType, x?: number, y?: number, z?: number): number;
  /** Spawn an enemy through the full lightning arrival. Returns its id or -1. */
  spawnArriving(type: EnemyType, x: number, y: number, z: number): number;
  /** Kill everything through the normal death path (ctx.enemies.killAll(false): world kills, never rewarded). Returns the count. */
  killAll(): number;
  /**
   * Damage one enemy as the player would (faction 'player', weapon 'vector', type 'bullet', at its aim
   * point) through combat.applyDamage; `part` defaults to 'body'.
   */
  damageEnemy(id: number, amount: number, part?: HitPart): { dealt: number; killed: boolean };
  /** Every actor in the scene (NaN checks). */
  enemies(): { id: number; type: EnemyType; x: number; y: number; z: number; hp: number; alive: boolean }[];
  teleport(x: number, y: number, z: number, yaw?: number, pitch?: number): void;
  look(yaw: number, pitch: number): void;
  lookAtPoint(x: number, y: number, z: number): void;
  /** Tap (or hold for `seconds` of stepped time) an input action through the virtual input. */
  press(action: InputAction, seconds?: number): void;
  /** Hold the virtual stick (strafe, advance) until changed. */
  move(x: number, y: number): void;
  /** Free camera override for screenshots (viewmodel hidden, cinematic camera off while active). */
  setCamera(position: [number, number, number], target: [number, number, number], fov?: number): void;
  releaseCamera(): void;
  setTimeOfDay(id: TimeOfDayId, seconds?: number): void;
  hideUi(on: boolean): void;
  setQuality(setting: QualitySetting): void;
  /** Damage the player through the normal pipeline (neutral faction). */
  damagePlayer(amount: number): void;
  choosePerk(index: number): boolean;
  /** ctx.director.grantPerk(id). */
  givePerk(id: PerkId): boolean;
  /** Fill the Overclock meter and activate it. Returns whether it started. */
  overclock(): boolean;
  unlockZone(zone: ZoneId): void;
  /** ctx.ui.debugShow(screen). */
  ui(screen: UiScreen | null): void;
  /** ctx.fx.spawn(id, position) — fire any effect in front of a camera. */
  fx(id: FxId, x: number, y: number, z: number): void;
  /** ctx.audio.play(id). */
  sound(id: SoundId): void;
  /**
   * Visible meshes and triangles per scene root, keyed by root name ('world', 'fx', 'enemies', ...;
   * view-scene roots as 'view:<name>') — checks the per-system budgets of the brief.
   */
  budget(): Record<string, { visibleMeshes: number; triangles: number }>;
  /** Autopilot that plays through the virtual input (see core/bot.ts). */
  bot(on: boolean, opts?: BotOptions): void;
}
