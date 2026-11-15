/**
 * STATIC HORIZON — THE CODE CONTRACT.
 *
 * This file is types only (no runtime code). Import with `import type { ... } from '../core/types'`.
 * Runtime companions living next to it:
 *   - core/constants.ts  id lists, collision flag bits, pipeline constants
 *   - core/make.ts       allocation helpers for the plain-data structs below (DamageInfo, RayHit, ...)
 *   - core/math.ts       damp / clamp / angle helpers, yawPitchToDir, safe normalise
 *   - core/palette.ts    the colour script
 *   - data/*.ts          tuning tables typed by the *Def interfaces at the end of this file
 *
 * GLOBAL CONVENTIONS
 *   - Units: metres, seconds, radians. Y is up. Right-handed (three.js). Player yaw 0 looks down -Z,
 *     positive yaw turns LEFT (counter-clockwise seen from above), positive pitch looks UP.
 *     forward(yaw,pitch) = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)).
 *   - Colours passed as numbers are 0xRRGGBB (sRGB hex), exactly like `new THREE.Color(hex)`.
 *   - Vectors passed INTO a method are never retained by the callee unless the doc says "retained".
 *     Results are written into caller-provided "out" objects so hot paths never allocate.
 *   - Vector3 properties exposed by a system (e.g. `player.position`) are LIVE and READ-ONLY for everyone
 *     except the owning system: read them, copy them, never write them, never keep them across a reset.
 *   - Event payloads and returned result structs may be reused by the emitter/callee: copy what you keep.
 *   - Ids: `ctx.nextId()` hands out unique positive integers. 0 always means "none / the world".
 *   - Factories `createXSystem(ctx)` must only store `ctx`. Other systems are not constructed yet at that
 *     point; touch them from `init()` onwards.
 *
 * FRAME PIPELINE (implemented in core/game.ts — the single source of truth for ordering)
 *
 *   frame(realDt):                                   realDt is clamped to [0, 0.1]
 *     input.poll(realDt)
 *     core hotkeys: `pause` action toggles playing <-> paused (unless ui.consumesPauseAction())
 *     pointer policy (see Input.requestCapture)
 *     substeps = playing/menu/gameover/victory ? min(3, ceil(realDt / (1/30))) : 1
 *     for each substep (stepDt = realDt / substeps, so stepDt <= 1/30):
 *        time.advance(stepDt)                        fills dt / unscaledDt / scale / now / frame
 *        mode === 'playing' and NOT hard-frozen (time.scale > 0):
 *            player.update(unscaledDt)   -> weapons.update(unscaledDt)
 *            enemies.update(dt)          -> combat.update(dt) -> world.update(dt)
 *            director.update(dt)         -> fx.update(dt)
 *            then lateUpdate in the same order for systems that define it
 *        mode === 'playing' and hard-frozen (time.scale === 0, e.g. perk select):
 *            director.update(0) only                  (it reads perk1..3 and waits for choosePerk)
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
 *           -> combat -> player -> weapons -> enemies -> director -> ui
 *   reset : same order as init. Called once right after boot, before every run and when returning to
 *           the menu. Core resets ctx.time and ctx.mods BEFORE the systems.
 *
 * CLOCKS (see TimeState)
 *   - player, weapons            : ctx.time.unscaledDt  (full speed during Overclock / slow motion)
 *   - enemies, combat, world,
 *     director, fx               : ctx.time.dt          (scaled world time)
 *   - render, audio, ui          : ctx.time.realDt      (never stops, also while paused / in menus)
 *
 * FEEDBACK OWNERSHIP RULE (who triggers FX + audio — exactly one owner per moment, nothing double-fires)
 *   The gameplay system that owns a moment calls ctx.fx / ctx.audio / ctx.render.post explicitly:
 *   - weapons : muzzle flash, fire/reload/dry/switch sounds, tracers and beams of player shots, casings,
 *               WORLD-surface impacts of player hitscan (fx + sound + decal), recoil, melee swing,
 *               chain-lightning arcs, explosive-crit blasts (through combat.explode).
 *   - combat  : everything about a HIT ON A TARGET by the player (hit spark by HitPart, damage number,
 *               hit-confirm sound, `hit:confirmed` event); every explosion (combat.explode owns flash,
 *               particles, decal, sound, light, shake); projectile visuals, trails, fly loops and
 *               projectile impacts on the world.
 *   - enemies : spawn arrival (telegraph ring, bolt, sound), idle motifs, attack telegraphs and attack
 *               sounds/fx, hurt flash + hurt sound of the victim, death fx + sound, boss staging.
 *   - player  : footsteps, jump/land/slide/dash, hurt + shield sounds, Overclock treatment, low-health
 *               state, camera shake, ctx.render.post writes for damage/low health/overclock/dash.
 *   - director: wave stingers, `announce` banners, pickups, supply drops, perk sounds, score sounds.
 *   - world   : gates, jump pads, hazards, fall-out respawn.
 *   - ui      : its own interface sounds (ctx.audio.play('uiClick') ...).
 *   FX and AUDIO never subscribe to gameplay events to spawn effects or sounds. The ONLY events they
 *   (and RENDER) may react to are:
 *     'game:mode', 'run:start', 'run:end', 'settings:changed', 'quality:changed', 'view:resize',
 *     'timeOfDay:changed' (fx: weather, audio: wind/ambience),
 *     'wave:start', 'wave:clear', 'director:phase', 'boss:spawned', 'boss:phase', 'boss:defeated'
 *       (audio only: adaptive MUSIC state/intensity — never one-shot sounds).
 *   UI is the opposite: gameplay never calls UI. UI reads ctx state every frame and listens to events.
 *
 * RENDERING CONVENTIONS (so independently built meshes look like one game)
 *   - Colour: hex numbers are sRGB (three.js colour management on). Use core/palette.ts; the five accent
 *     colours carry gameplay meaning and must not be used for anything else.
 *   - Lighting: NO system adds lights except render (sun + hemisphere in ctx.scene, a small rig in
 *     ctx.viewScene) and fx (its fixed pool of 6 point lights). Light count never changes at runtime.
 *   - Glow: the frame is rendered in HDR and render applies bloom above a linear luminance of ~1.0, then
 *     filmic tone mapping. To make something glow give it `emissive` + `emissiveIntensity` of 2..8 (or an
 *     additive MeshBasicMaterial with a colour multiplied above 1). Lit surfaces stay below 1 and never
 *     bloom. Do not set `toneMapped = false`.
 *   - Materials: shared MeshStandardMaterial instances for lit surfaces (no MeshPhysicalMaterial);
 *     additive particles use depthWrite:false. Render sets scene.environment for both scenes.
 *   - Shadows: render owns the one shadow-casting sun. World geometry: castShadow + receiveShadow.
 *     Enemies: castShadow. Projectiles, fx, pickups and everything in ctx.viewScene: no shadows.
 *   - Fog/background/sky belong to render. Keep `material.fog` at its default (true) for world-space
 *     meshes so they sit in the atmosphere.
 *   - Everything a system adds to a scene is removed again in its dispose(); transient objects are
 *     pooled and hidden, never created per frame.
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
export type ProjectileKind =
  | 'rocket'
  | 'grenade'
  | 'plasmaBolt'
  | 'lightBolt'
  | 'mortar'
  | 'bossBolt'
  | 'bossMissile'
  | 'shard';
/** What dealt damage. Player sources are the four weapons plus the suit extras. */
export type DamageSource =
  | WeaponId
  | 'grenade'
  | 'melee'
  | 'chainLightning'
  | 'explosiveCrit'
  | 'enemy'
  | 'world';
export type TimeScaleSource = 'overclock' | 'hitstop' | 'slowmo' | 'perkSelect' | 'cinematic' | 'debug';
export type ScoreReason = 'kill' | 'crit' | 'multikill' | 'waveClear' | 'flawless' | 'boss' | 'pickup' | 'bonus';
export type AnnounceStyle = 'wave' | 'clear' | 'info' | 'warning' | 'reward' | 'zone' | 'boss';
export type ExplosionVisual = 'none' | 'small' | 'large' | 'plasma' | 'shock' | 'boss';
export type DecalKind = 'bulletHole' | 'scorch' | 'plasmaBurn' | 'railBurn' | 'crack' | 'energyMark';
export type TrailKind = 'rocket' | 'grenade' | 'plasma' | 'bolt' | 'mortar' | 'missile' | 'bossBolt' | 'supply' | 'dash';
export type BeamKind = 'rail' | 'laser' | 'lockLaser' | 'sweep' | 'chain' | 'tether';
export type TelegraphKind = 'ring' | 'circle' | 'spawn' | 'strike' | 'mortar' | 'shock';

/**
 * Logical input actions. One physical key may drive several actions (e.g. Digit1 = weapon1 + perk1);
 * the consumer decides by context. Default bindings (core/input.ts):
 *   moveForward/Back/Left/Right  W S A D           (prefer Input.moveX/moveY which merge all devices)
 *   lookLeft/Right/Up/Down       arrow keys        (already folded into Input.consumeLook)
 *   fire LMB/RT · ads RMB/LT · reload R/X · jump Space/A · sprint Shift/L3 · crouch C/B · dash Q/LB
 *   overclock F/D-pad up · melee V/R3 · grenade G/RB · weapon1..4 Digit1..4 · weaponNext wheel down, Y
 *   weaponPrev wheel up · pause Esc, P, Start (handled by core only) · perk1..3 Digit1..3, pad X/Y/B,
 *   D-pad left/up/right · ui* arrows / D-pad / left stick, Enter / A, Backspace / B.
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

/**
 * Every one-shot visual effect. FxSystem.spawn must accept ALL of them (an unimplemented id may fall
 * back to a generic burst but must never throw). Naming: <owner or subject><Moment>.
 */
export type FxId =
  // --- player weapons (world-space; viewmodel-attached flashes are weapons-internal meshes) ---
  | 'muzzleVector'
  | 'muzzleBreaker'
  | 'muzzleLance'
  | 'muzzleHornet'
  | 'casingVector'
  | 'casingBreaker'
  | 'lanceCharge'
  | 'lanceDischarge'
  | 'hornetBackblast'
  | 'grenadeBounce'
  | 'meleeSwing'
  | 'meleeHit'
  // --- impacts on world geometry, by surface (opts.normal = surface normal) ---
  | 'impactMetal'
  | 'impactPlating'
  | 'impactGrate'
  | 'impactGlass'
  | 'impactEnergy'
  // --- impacts on world geometry, by damage flavour (added on top of / instead of the surface one) ---
  | 'impactPellet'
  | 'impactRail'
  | 'impactPlasma'
  | 'impactBolt'
  | 'impactLaser'
  // --- hits on targets (spawned by combat) ---
  | 'hitEnemy'
  | 'hitEnemyWeak'
  | 'hitEnemyArmor'
  | 'hitEnemyShield'
  | 'hitPlayer'
  | 'hitPlayerShield'
  // --- explosions (spawned by combat.explode only) ---
  | 'explosionSmall'
  | 'explosionLarge'
  | 'explosionPlasma'
  | 'explosionShock'
  | 'explosionBoss'
  | 'shockwaveRing'
  // --- player ---
  | 'footDust'
  | 'jumpDust'
  | 'landDust'
  | 'doubleJump'
  | 'slideSparks'
  | 'dashBurst'
  | 'shieldBreak'
  | 'shieldRecharge'
  | 'healPulse'
  | 'overclockStart'
  | 'overclockEnd'
  | 'lastStand'
  // --- enemies: generic ---
  | 'spawnFlash'
  | 'enemySmoke'
  | 'enemySparks'
  | 'deathSkitter'
  | 'deathRiveter'
  | 'deathWasp'
  | 'deathTick'
  | 'deathLancer'
  | 'deathBulwark'
  | 'deathConductor'
  // --- enemies: attacks ---
  | 'skitterLeap'
  | 'skitterBite'
  | 'riveterCharge'
  | 'riveterMuzzle'
  | 'waspMuzzle'
  | 'tickArm'
  | 'lancerCharge'
  | 'lancerMuzzle'
  | 'lancerRelocate'
  | 'bulwarkMortarMuzzle'
  | 'bulwarkStomp'
  | 'bulwarkShieldBreak'
  | 'bulwarkShieldRestore'
  // --- boss ---
  | 'bossSpawn'
  | 'bossCharge'
  | 'bossVolleyMuzzle'
  | 'bossSweepCharge'
  | 'bossSweepHit'
  | 'bossLightningStrike'
  | 'bossMissileLaunch'
  | 'bossShockRing'
  | 'bossSummon'
  | 'bossPhaseShift'
  | 'bossWeakPointBreak'
  | 'bossDeathBurst'
  | 'bossDeathFinal'
  // --- pickups + supply drops ---
  | 'pickupSpawn'
  | 'pickupAmmo'
  | 'pickupHealth'
  | 'pickupShield'
  | 'pickupGrenade'
  | 'pickupExpire'
  | 'supplyTrail'
  | 'supplyLand'
  | 'supplyOpen'
  | 'weaponUnlock'
  // --- world ---
  | 'gateOpen'
  | 'gateClose'
  | 'gateDenied'
  | 'zoneUnlock'
  | 'jumpPad'
  | 'steamVent'
  | 'sparkShower'
  | 'hazardArc'
  | 'respawn'
  // --- perks / misc ---
  | 'perkChosen'
  | 'chainArc'
  | 'lifeSteal'
  | 'lightningImpact'
  | 'waveClear';

/**
 * Every one-shot sound. AudioSystem.play / playAt must accept ALL of them (an unimplemented id may
 * fall back to a generic blip but must never throw).
 */
export type SoundId =
  // --- ui (played by the UI system) ---
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
  | 'uiPerkSelect'
  | 'uiCountdown'
  | 'uiCountdownGo'
  // --- weapons ---
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
  | 'lanceCharge'
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
  | 'grenadeBounce'
  | 'meleeSwing'
  | 'meleeHit'
  | 'meleeHitWorld'
  // --- hit confirmation (played by combat, 2D) ---
  | 'hitConfirm'
  | 'hitCrit'
  | 'hitKill'
  | 'hitShield'
  | 'hitArmor'
  // --- impacts ---
  | 'impactMetal'
  | 'impactPlating'
  | 'impactGrate'
  | 'impactGlass'
  | 'impactEnergy'
  | 'impactPlasma'
  | 'ricochet'
  | 'bulletWhiz'
  // --- explosions (played by combat.explode) ---
  | 'explosionSmall'
  | 'explosionLarge'
  | 'explosionPlasma'
  | 'explosionShock'
  | 'explosionBoss'
  | 'explosionDistant'
  // --- player ---
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
  | 'heartbeat'
  | 'death'
  | 'lastStand'
  | 'fallRespawn'
  | 'overclockReady'
  | 'overclockStart'
  | 'overclockEnd'
  | 'overclockDenied'
  // --- enemies: arrival ---
  | 'spawnTelegraph'
  | 'spawnStrike'
  // --- enemies: per type (spawn / idle motif / telegraph / attack / hurt / death) ---
  | 'skitterSpawn'
  | 'skitterIdle'
  | 'skitterStep'
  | 'skitterTelegraph'
  | 'skitterAttack'
  | 'skitterHurt'
  | 'skitterDeath'
  | 'riveterSpawn'
  | 'riveterIdle'
  | 'riveterTelegraph'
  | 'riveterAttack'
  | 'riveterHurt'
  | 'riveterDeath'
  | 'waspSpawn'
  | 'waspIdle'
  | 'waspTelegraph'
  | 'waspAttack'
  | 'waspHurt'
  | 'waspDeath'
  | 'tickSpawn'
  | 'tickIdle'
  | 'tickBeep'
  | 'tickTelegraph'
  | 'tickAttack'
  | 'tickHurt'
  | 'tickDeath'
  | 'lancerSpawn'
  | 'lancerIdle'
  | 'lancerTelegraph'
  | 'lancerLock'
  | 'lancerAttack'
  | 'lancerRelocate'
  | 'lancerHurt'
  | 'lancerDeath'
  | 'bulwarkSpawn'
  | 'bulwarkIdle'
  | 'bulwarkStep'
  | 'bulwarkTelegraph'
  | 'bulwarkAttack'
  | 'bulwarkStomp'
  | 'bulwarkShieldBreak'
  | 'bulwarkShieldRestore'
  | 'bulwarkHurt'
  | 'bulwarkDeath'
  // --- boss ---
  | 'conductorSpawn'
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
  | 'conductorDeathFinal'
  // --- projectiles (played by combat) ---
  | 'boltFire'
  | 'mortarLaunch'
  | 'mortarWhistle'
  | 'missileLaunch'
  // --- pickups + supply (played by director) ---
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
  // --- world ---
  | 'gateOpen'
  | 'gateClose'
  | 'gateDenied'
  | 'zoneUnlock'
  | 'jumpPad'
  | 'steamVent'
  | 'hazardZap'
  | 'beaconPing'
  // --- director ---
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
  | 'scoreTick'
  | 'perkAcquire'
  | 'chainZap'
  | 'lifeSteal'
  | 'objective'
  | 'gameOver'
  | 'victory'
  | 'newBest'
  // --- weather (played by fx weather, which owns ambient lightning) ---
  | 'thunderNear'
  | 'thunderFar'
  | 'lightningCrack'
  | 'staticCrackle'
  | 'windGust';

/** Sustained sounds started with AudioSystem.loop and controlled through the returned LoopHandle. */
export type LoopId =
  | 'lanceChargeLoop'
  | 'overclockLoop'
  | 'heartbeatLoop'
  | 'slideLoop'
  | 'rocketLoop'
  | 'missileLoop'
  | 'mortarLoop'
  | 'riveterHover'
  | 'waspBuzz'
  | 'tickRoll'
  | 'lancerLaser'
  | 'bulwarkServo'
  | 'bulwarkShieldHum'
  | 'conductorCore'
  | 'conductorSweep'
  | 'gateHum'
  | 'pickupHum'
  | 'supplyBeacon'
  | 'jumpPadHum'
  | 'hazardHum'
  | 'steamHiss';

// ---------------------------------------------------------------------------------------------------
// 3. System lifecycle
// ---------------------------------------------------------------------------------------------------

/**
 * Lifecycle implemented by world, render, fx, audio, combat, player, weapons, enemies, director, ui.
 * Core wraps every call in a try/catch: an exception is recorded in `window.__SH.errors` (which fails
 * every automated check) and the frame carries on; a call that throws 3 times in a row (or 30 times in
 * total, or at all during init) raises the fatal panel and stops the loop.
 */
export interface System {
  /**
   * One-time setup: build meshes/materials/DOM, add objects to ctx.scene, subscribe to events.
   * All ctx.* systems exist here. May be async (awaited sequentially in lifecycle order).
   * Never start audio, request pointer lock or read localStorage directly from here.
   */
  init(): void | Promise<void>;
  /**
   * Restore the pristine pre-run state: no enemies, projectiles, pickups, timers, tweens, handles or
   * loops left over; gates closed; vitals full. Must be idempotent and safe to call any number of times.
   */
  reset(): void;
  /** Called per substep according to the frame pipeline above; `dt` is this system's clock (see CLOCKS). */
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
  /** ENEMIES: skip AI decisions, movement and attacks (idle animation only) while true. */
  freezeAi: boolean;
  /** Core applies a free camera before rendering. RENDER must skip the viewmodel layer while true. */
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
   * aspect. The view camera sits at the origin looking down -Z and never moves; weapons animate the model
   * in view space (x right, y up, -z forward).
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
  /** Gameplay RNG, reseeded by core at every run start (fixed seed in test mode). Cosmetics may use Math.random. */
  readonly rng: Rng;
  readonly time: TimeState;
  /** Run modifiers (perks + difficulty). Reset by core before every run. */
  readonly mods: Modifiers;
  readonly game: Game;
  readonly debug: DebugFlags;
  /** True when the page was opened with `?test=1`: manual stepping, fixed seed, no auto-pause on blur. */
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
   * Start a fresh run from any mode except boot: reset time + mods + every system, director.startRun,
   * mode -> 'playing', emit 'run:start', unlock audio and request pointer capture. Call it synchronously
   * from the click/keydown handler so the browser still considers it a user gesture.
   */
  startRun(difficulty: Difficulty): void;
  /** startRun with the current difficulty. */
  restart(): void;
  /** playing -> paused (no-op otherwise). Releases the pointer. */
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
  /** Record an error in window.__SH.errors; `fatal` also shows the fatal panel and stops the loop. */
  reportError(source: string, error: unknown, fatal?: boolean): void;
}

// ---------------------------------------------------------------------------------------------------
// 6. Time
// ---------------------------------------------------------------------------------------------------

/**
 * Clocks. Core calls advance() once per substep; everything else only reads, or files time-scale
 * requests. The effective world scale is the MINIMUM of all active requests (1 when none).
 *
 *   mode                          dt                 unscaledDt          realDt
 *   playing                       stepDt * scale     stepDt (0 if scale 0)   frame delta
 *   menu / gameover / victory     stepDt * scale     0                   frame delta
 *   paused / boot                 0                  0                   frame delta
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
  /** Wall-clock delta of the current frame, clamped to 0.1. Never 0 while the loop runs. */
  readonly realDt: number;
  /** Wall-clock seconds since boot, monotonic, never reset. Use for UI / shader animation phases. */
  readonly elapsed: number;
  /** Effective world time scale of the current substep (0..1). */
  readonly scale: number;
  /** Substep counter since boot. */
  readonly frame: number;
  /** Unscaled seconds actually played this run (sum of unscaledDt). */
  readonly runTime: number;
  /**
   * File or replace the request of `source`. `scale` is clamped to [0,1]. With `seconds` the request
   * expires by itself after that much REAL time (the countdown stops while the game is paused);
   * without it stays until clearScale(source).
   * Owners: 'overclock' player · 'hitstop' anyone via hitstop() · 'slowmo' director/boss staging ·
   * 'perkSelect' director · 'cinematic' render · 'debug' window.__SH. Reset clears every request.
   */
  setScale(source: TimeScaleSource, scale: number, seconds?: number): void;
  clearScale(source: TimeScaleSource): void;
  /** Current request of one source (1 when none). */
  getScale(source: TimeScaleSource): number;
  /** Impact freeze: world scale 0.05 for `seconds` of real time (clamped to 0.25, longest request wins). */
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
  /** E: core. Boot progress for the loading screen (fraction 0..1). */
  'boot:progress': { label: string; fraction: number };
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
   * E: enemies. hp reached 0 (for the boss: start of the staged death). `score` is the base value from
   * EnemyDef (the director applies combo/difficulty) — 0 for silent kills (info.silent), which listeners
   * must not reward. `weapon` is info.weapon. `position` is the aim point. `byPlayer` = info.faction 'player'.
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
   * source (0,0 when unknown). `angle` = that direction relative to the view: 0 ahead, +PI/2 left,
   * -PI/2 right, PI behind (UI damage indicators rotate by it).
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
  /** E: player. */
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
  'weapon:unlocked': { weapon: WeaponId };
  /** E: weapons. Trigger pulled with an empty magazine and no reserve. */
  'weapon:empty': { weapon: WeaponId };
  'weapon:grenade': { left: number };
  'weapon:melee': { hit: boolean };

  /**
   * E: combat (inside applyDamage) when the PLAYER damaged an enemy target: drives the hitmarker.
   * `shield` = the hit was absorbed by an energy shield. `point` is the world impact point.
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
  /** E: director. Three (or fewer) perk choices are on offer; world is hard-frozen until choosePerk. */
  'perk:offered': { choices: readonly PerkId[] };
  'perk:chosen': { perk: PerkId; index: number; stacks: number };
  /** E: director. `position` is where the score was earned (null for non-spatial bonuses). */
  'score:changed': { score: number; delta: number; reason: ScoreReason; position: THREE.Vector3 | null };
  /** E: director. Combo count or multiplier changed (multiplier 1 + count 0 = combo ended). */
  'combo:changed': { multiplier: number; count: number; timeLeft: number };
  /** E: director. 2+ kills inside the multi-kill window. `label` e.g. "DOUBLE KILL". */
  multikill: { count: number; label: string; bonus: number };
  /**
   * E: director (only). Big banner text. UI shows a banner for every 'announce' and for nothing else:
   * wave start / wave clear / zone unlocked / supply drop / boss intro banners all arrive through here.
   */
  announce: { text: string; sub: string; style: AnnounceStyle; seconds: number };

  /** E: world (inside unlockZone). */
  'zone:unlocked': { zone: ZoneId; name: string };
  /** E: world (inside setGateOpen), only when the state actually changes. */
  'gate:state': { gateId: string; open: boolean; from: ZoneId; to: ZoneId };

  /** E: director. Crate inbound to `position` (a drop pad). */
  'supply:incoming': { weapon: WeaponId; position: THREE.Vector3 };
  'supply:landed': { weapon: WeaponId; position: THREE.Vector3 };
  /** E: director. Crate opened (walked into, or auto-collected on timeout); weapon is now unlocked. */
  'supply:collected': { weapon: WeaponId };

  /** E: enemies. */
  'boss:spawned': { boss: BossHandle };
  'boss:phase': { boss: BossHandle; phase: number; prev: number };
  /**
   * E: enemies, at the START of the staged death (same frame as the boss 'enemy:killed'); never for
   * silent kills. The director waits `sequenceSeconds` (unscaled seconds of staging) before calling
   * game.endRun(true), and only reacts while its phase is 'boss'.
   */
  'boss:defeated': { boss: BossHandle; position: THREE.Vector3; sequenceSeconds: number };

  /** E: player. */
  'overclock:ready': Record<string, never>;
  'overclock:start': { seconds: number };
  'overclock:end': Record<string, never>;

  /** E: render (inside setTimeOfDay). FX switches weather and audio switches ambience on this. */
  'timeOfDay:changed': { id: TimeOfDayId; prev: TimeOfDayId; seconds: number };
  /** E: core/settings.ts after a value changed and was persisted. */
  'settings:changed': { key: keyof SettingsData; data: Readonly<SettingsData> };
  /** E: core/input.ts. */
  'input:device': { device: InputDevice; prev: InputDevice };
  'input:lookMode': { mode: LookMode; prev: LookMode };
  /**
   * E: core/input.ts. Pointer lock was gained or lost, or gameplay input was interrupted.
   * `intentional` is false when the browser or the user took control away while gameplay owned the
   * pointer (Esc out of pointer lock, alt-tab, window blur, hidden tab): core auto-pauses on that.
   * Never emitted with intentional = false in test mode.
   */
  'input:capture': { captured: boolean; intentional: boolean };
  /** E: render. Preset or effective parameters changed (also by the dynamic quality governor). */
  'quality:changed': { preset: QualityPreset; params: Readonly<QualityParams> };
  /** E: core, after render.resize ran. CSS pixels of the canvas. */
  'view:resize': { width: number; height: number };
}

export type EventName = keyof EventMap;
export type EventHandler<K extends EventName> = (payload: EventMap[K]) => void;

/**
 * Synchronous typed pub/sub. Handlers run in subscription order during emit(). A throwing handler is
 * caught and reported (it never breaks the emitter or the other handlers). Subscribing/unsubscribing
 * from inside a handler is safe. Subscribe in init(), never in update().
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
  /** Analog amount 0..1 (triggers); 1 or 0 for digital sources. */
  value(action: InputAction): number;

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
   * "Gameplay wants the mouse": try pointer lock; if it is rejected or unavailable (sandboxed frame,
   * cooldown after Esc) fall back to `free` look silently and retry on the next click on the canvas.
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
  /** Device that produced the most recent input. */
  readonly device: InputDevice;
  /** settings.aimAssist && device !== 'keyboardMouse'. PLAYER adds look friction, WEAPONS add bullet magnetism. */
  readonly aimAssist: boolean;

  // --- virtual input (touch UI, bot, tests) ------------------------------------------------------
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
  /** Release every virtual button, zero the virtual stick. */
  clearVirtual(): void;

  // --- prompts ---------------------------------------------------------------------------------
  /** Short label of the binding for the CURRENT device: 'R', 'LMB', 'SPACE', 'RT', 'X'; '' if unbound. */
  bindingLabel(action: InputAction): string;
  /** Gamepad rumble, 0..1 strength; silently ignored when unsupported. */
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
  /** Applied by RENDER (it listens to 'settings:changed'). */
  quality: QualityPreset;
  /** RENDER may lower the internal resolution to hold the frame rate. */
  dynamicResolution: boolean;
  /** Camera shake multiplier 0 .. 1.5 (default 1). Applied by PLAYER inside addShake. */
  screenShake: number;
  /** Applied by RENDER: caps post.flash / lightning / white-outs. Writers never check it themselves. */
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

/** Persistent user settings. set() clamps, persists and emits 'settings:changed'. */
export interface Settings {
  /** Live values. Read freely every frame. */
  readonly data: Readonly<SettingsData>;
  readonly defaults: Readonly<SettingsData>;
  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void;
  /** Restore every default (emits one 'settings:changed' per changed key). */
  resetToDefaults(): void;
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
  /** Random element; throws on an empty array. */
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
  /** Free-form label for lookups, e.g. 'gate:deck-refinery'. Default ''. */
  tag?: string;
}

export interface CollisionBox extends Readonly<Aabb> {
  /** Index into CollisionWorld.boxes; stable for the lifetime of the world. */
  readonly id: number;
  readonly flags: number;
  readonly surface: SurfaceType;
  readonly tag: string;
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
 */
export interface CollisionWorld {
  /** Add a static box; returns its id. Only world.init() adds boxes. */
  addBox(desc: BoxDesc): number;
  /** Call once after the last addBox: computes bounds and any acceleration structure. */
  finalize(): void;
  /** Remove everything (dispose / rebuild). */
  clear(): void;
  /** Toggle a box (gates). Bumps `version`. */
  setEnabled(id: number, enabled: boolean): void;
  /** Toggle every box with this exact tag; returns how many matched. */
  setEnabledByTag(tag: string, enabled: boolean): number;
  /** All boxes including disabled ones (minimap, debug). Never mutate. */
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
  /** Collect the ids of all overlapping boxes into `out` (cleared first); returns the count. */
  overlapBoxAll(box: Aabb, mask: number, out: number[]): number;
  /** True when a sphere overlaps any matching box. */
  overlapSphere(center: Vec3Like, radius: number, mask: number): boolean;
  /**
   * Highest box top that is <= maxY among matching boxes whose footprint contains (x, z).
   * Returns -Infinity when there is no floor below.
   */
  groundHeight(x: number, z: number, maxY: number, mask: number): number;
}

// ---------------------------------------------------------------------------------------------------
// 11. Navigation (src/nav) — 2.5D grid
// ---------------------------------------------------------------------------------------------------

/** Provided by world.navHints(); consumed by NavGrid.build. */
export interface NavBuildHints {
  /** Grid extent (XZ used; cells start at minX/minZ). */
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
  /** Regions blocked right after the build (the closed gates). Later toggled with setRegionWalkable. */
  closedRegions: readonly Aabb[];
  /** Flood-fill seeds: only cells connected to a seed are walkable (keeps roofs and crate tops out). */
  seeds: readonly Vec3Like[];
  /** Max height difference between neighbouring cells that still connects them (0.75). */
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
 * One walkable height per cell. Flyers ignore it (they raycast).
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
  /** Floor height of the cell at (x, z); `fallback` (default 0) when not walkable / outside. */
  heightAt(x: number, z: number, fallback?: number): number;
  /** Zone label of the cell, or null. */
  zoneAt(x: number, z: number): ZoneId | null;
  /** Nearest walkable cell centre within `maxRadius` metres into `out`; false if none. */
  nearestWalkable(pos: Vec3Like, maxRadius: number, out: THREE.Vector3): boolean;
  /** Block or unblock every cell whose centre lies inside `region` (XZ). WORLD calls it for gates. */
  setRegionWalkable(region: Aabb, walkable: boolean): void;
  /** True when a path exists between the two positions (same connected region). */
  isReachable(a: Vec3Like, b: Vec3Like): boolean;

  /**
   * Shared flow field toward one target (the player). ENEMIES calls this once per frame (or every few
   * frames); it only recomputes when the target cell or `version` changed. Returns true if recomputed.
   */
  updateFlowField(target: Vec3Like): boolean;
  /**
   * Unit XZ direction (y = 0) that walks toward the flow target from `pos` into `out`.
   * False (out = 0) when `pos` cannot reach the target. Inside the target cell it points straight at it.
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
  /** Centre of the pad on the floor. */
  readonly position: THREE.Vector3;
  readonly zone: ZoneId;
}

export interface GateInfo {
  /** e.g. 'deck-refinery', 'refinery-spire'. */
  readonly id: string;
  readonly from: ZoneId;
  readonly to: ZoneId;
  readonly open: boolean;
  /** Centre of the doorway on the floor. */
  readonly position: THREE.Vector3;
  /**
   * The blocking volume, also the nav region toggled with it: it must be at least one nav cell (1 m)
   * thick and span the whole doorway so that a closed gate really disconnects the grid.
   */
  readonly aabb: Readonly<Aabb>;
  /** Tag of its collision box(es): 'gate:<id>'. */
  readonly tag: string;
}

export interface JumpPadInfo {
  readonly position: THREE.Vector3;
  /** Launch velocity given to the player. */
  readonly velocity: THREE.Vector3;
  readonly zone: ZoneId;
}

/** One key of the slow menu camera path (render interpolates and loops through them). */
export interface CinematicShot {
  readonly position: THREE.Vector3;
  readonly target: THREE.Vector3;
  /** Seconds to travel to the next shot. */
  readonly seconds: number;
}

/** Top-down footprint rectangle for the minimap (world XZ metres). */
export interface MinimapRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly kind: 'floor' | 'wall' | 'cover' | 'gate' | 'pad' | 'hazard';
  readonly zone: ZoneId | null;
  /** Set for kind 'gate': look the live state up in world.gates. */
  readonly gateId: string | null;
}

export interface MinimapData {
  readonly bounds: Readonly<Aabb>;
  readonly rects: readonly MinimapRect[];
}

/**
 * The level. init() builds all meshes into ctx.scene, fills ctx.collision (then finalize()), and
 * prepares the data below. update() animates gates/beacons and runs jump pads, hazards and the
 * fall-out rule (player below `killY` -> teleported to the last safe ground with 'fall' damage).
 * reset() closes every gate, locks refinery + spire, and re-arms hazards.
 */
export interface WorldSystem extends System {
  /** Playable volume (enemies and projectiles outside it may be culled). */
  readonly bounds: Readonly<Aabb>;
  readonly zones: readonly ZoneInfo[];
  zone(id: ZoneId): ZoneInfo;
  /** Where a run starts (deck). */
  readonly playerStart: { readonly position: THREE.Vector3; readonly yaw: number };
  /** Spawn points filtered by zone and/or kind. Returned arrays are cached: do not mutate. */
  spawnPoints(zone?: ZoneId, kind?: SpawnKind): readonly SpawnPoint[];
  readonly dropPads: readonly DropPad[];
  readonly gates: readonly GateInfo[];
  readonly jumpPads: readonly JumpPadInfo[];
  /**
   * Open/close a gate: animation, fx + sound, collision box toggle, nav region toggle and
   * 'gate:state'. Idempotent.
   */
  setGateOpen(id: string, open: boolean): void;
  /** Mark a zone unlocked, open every gate leading into it, emit 'zone:unlocked'. DIRECTOR calls it. */
  unlockZone(zone: ZoneId): void;
  /** Zone containing (x, z), or null outside all zones. */
  zoneAt(x: number, z: number): ZoneId | null;
  /** Floor height under (x, z) searching down from `fromY` (default: top of the world); -Infinity if none. */
  groundHeightAt(x: number, z: number, fromY?: number): number;
  /** Boss arena on the Core Spire: the boss hovers `hoverHeight` above `center`. */
  readonly bossArena: {
    readonly center: THREE.Vector3;
    readonly radius: number;
    readonly hoverHeight: number;
  };
  /** Menu camera path (at least 2 shots). */
  readonly cinematicPath: readonly CinematicShot[];
  readonly minimap: MinimapData;
  /** Height below which the player is considered fallen off the rig. */
  readonly killY: number;
  /** Nav build input. Core calls it once, right after init(). */
  navHints(): NavBuildHints;
}

// ---------------------------------------------------------------------------------------------------
// 13. Render (src/render)
// ---------------------------------------------------------------------------------------------------

/**
 * Reactive post-processing inputs. Plain mutable numbers written by gameplay, read by render.
 * IMPULSES decay by themselves inside render.update (writers use `x = Math.max(x, v)`).
 * LEVELS are states: the owner writes them every frame; render.reset() restores the defaults.
 */
export interface PostFxParams {
  /** IMPULSE 0..1 — red damage vignette. Writer: player. */
  damageFlash: number;
  /** IMPULSE 0..1 — full-screen colour flash using `flashColor` (explosions, lightning, boss white-out). */
  flash: number;
  /** 0xRRGGBB used by `flash`. */
  flashColor: number;
  /** IMPULSE 0..1 — extra chromatic aberration (explosions, heavy hits). */
  chromaticBoost: number;
  /** LEVEL 0..1 — low-health desaturation + pulse. Writer: player. */
  lowHealth: number;
  /** LEVEL 0..1 — Overclock treatment. Writer: player. */
  overclock: number;
  /** LEVEL 0..1 — radial dash blur / speed lines. Writer: player. */
  dashBlur: number;
  /** LEVEL 0..1 — ADS vignette. Writer: weapons. */
  adsVignette: number;
  /** LEVEL multiplier (1 = graded default). Writer: director (death cam) / boss staging. */
  saturation: number;
  /** LEVEL multiplier (1 = default). Writer: boss staging (white-out). */
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
  /** Multiplier on particle counts (FX reads it). */
  particleScale: number;
  /** Max live decals (FX reads it). */
  maxDecals: number;
  /** Multiplier on weather particle density (FX reads it). */
  weatherScale: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
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
 * init(): create the WebGLRenderer on ctx.canvas, lights for BOTH scenes, sky, post chain; precompile.
 * update(realDt): time-of-day blending, impulse decay, dynamic resolution, cinematic camera when it
 * owns the camera (menu / gameover / victory). Reacts to 'settings:changed' (quality, dynamicResolution,
 * reduceFlashes) and 'game:mode' by itself.
 */
export interface RenderSystem extends System {
  readonly renderer: THREE.WebGLRenderer;
  /**
   * Draw one frame: world scene with ctx.camera, then (only while mode is playing/paused, the player
   * is alive and !ctx.debug.freeCamera) ctx.viewScene with ctx.viewCamera on a cleared depth buffer,
   * then post. Core calls it; nobody else does.
   */
  render(): void;
  /** Match the canvas client size (or the given CSS size): renderer, composer, both camera aspects. */
  resize(width?: number, height?: number): void;
  /** Canvas size in CSS pixels. */
  readonly width: number;
  readonly height: number;

  readonly quality: QualityPreset;
  /** Apply a preset immediately and emit 'quality:changed'. (settings.set('quality') ends up here.) */
  setQuality(preset: QualityPreset): void;
  readonly qualityParams: Readonly<QualityParams>;
  /** Current dynamic resolution factor, 0.5 .. 1. */
  readonly resolutionScale: number;

  /** Mutable reactive post inputs (see PostFxParams). */
  readonly post: PostFxParams;

  /** Blend to another time of day over `seconds` (default 0 = snap); emits 'timeOfDay:changed'. DIRECTOR calls it. */
  setTimeOfDay(id: TimeOfDayId, seconds?: number): void;
  /** The target time of day. */
  readonly timeOfDay: TimeOfDayId;
  readonly lighting: LightingState;
  /**
   * Sky + scene lighting flash (storm lightning, spawn strikes). intensity 0..1; `direction` = unit
   * vector from the scene toward the bolt (optional). Respects settings.reduceFlashes.
   */
  lightningFlash(intensity: number, direction?: Vec3Like): void;
  /** Briefly light the first-person weapon (render owns a muzzle light in the view scene). WEAPONS calls it. */
  muzzleFlash(color: number, intensity: number): void;

  /** Project a world position to canvas CSS pixels with the camera of the last/current frame. Returns out.visible. */
  worldToScreen(world: Vec3Like, out: ScreenPoint): boolean;
  /** Stats of the last rendered frame. */
  readonly stats: Readonly<RenderStats>;
}

// ---------------------------------------------------------------------------------------------------
// 14. Damage structs
// ---------------------------------------------------------------------------------------------------

/**
 * One instance of damage travelling through combat.applyDamage -> HitTarget.takeDamage.
 * Create with makeDamageInfo() and keep it as module-level scratch; victims never retain it.
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
  /** What dealt it (null when not meaningful). */
  weapon: DamageSource | null;
  /** Part that was struck. Set by combat traces from the hit sphere; 'body' for splash. */
  part: HitPart;
  /** Scales the victim's weak-point multiplier (weapon def critScale * ctx.mods.critDamageMul). */
  critScale: number;
  /** World-space impact point. */
  point: THREE.Vector3;
  /** Unit direction the damage travels (attacker -> victim). Zero vector when unknown. */
  dir: THREE.Vector3;
  /** Impulse in m/s along `dir` (victims scale it by their own mass). */
  knockback: number;
  /** Radial damage (explosion / shock): no weak-point crits. */
  splash: boolean;
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
  /** Fully stopped by an energy shield / invulnerability. */
  absorbed: boolean;
  /** Part that took it (the victim may remap). */
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
 * init(): registers itself with combat as a HitTarget (faction 'player', id = targetId).
 * update(unscaledDt): consume look, move with ctx.collision.moveAndSlide(COL.PLAYER), vitals regen,
 * dash, Overclock; then write ctx.camera (position, rotation, fov) + updateMatrixWorld.
 * Subscribes to 'enemy:killed' (byPlayer) for Overclock charge (EnemyDef.overclockCharge, x1.5 for
 * crits, scaled up with the director's combo multiplier) and the lifeOnKill perk.
 * Sprint rule: sprinting needs forward input on the ground and is suppressed by the player itself while
 * the 'fire' or 'ads' action is held — weapons never have to cancel a sprint.
 * Applies ctx.mods: maxShieldBonus, maxHealthBonus, shieldRegenMul, shieldDelayMul, moveSpeedMul,
 * extraJumps, dashCooldownMul, extraDashCharges, lifeOnKill, overclockGainMul, overclockDurationBonus,
 * lastStand, damageTakenMul. Perks arrive mid-run: read the modifiers live, never cache them.
 * reset(): teleport to world.playerStart, full vitals (with ctx.mods), zero Overclock, clear every
 * time-scale / post-fx level it owns.
 */
export interface PlayerSystem extends System {
  /** Feet centre. */
  readonly position: THREE.Vector3;
  /** Camera position without shake (feet + eye height). */
  readonly eye: THREE.Vector3;
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
   * Apply damage: i-frames/god -> absorbed; enemy-faction damage is multiplied by
   * ctx.mods.damageTakenMul; shield first, then health; last stand; info.knockback pushes the player
   * along info.dir; emits 'player:damaged' / 'player:shieldBroken' / 'player:died'; owns hurt
   * feedback. Usually reached via combat.applyDamage(player.targetId, info).
   */
  takeDamage(info: DamageInfo): DamageResult;
  /** Restore health (clamped); returns the amount actually restored. Emits 'player:healed'. */
  heal(amount: number): number;
  /** Restore shield (clamped); returns the amount actually restored. */
  addShield(amount: number): number;
  /** Replace the velocity (jump pads) or, with `additive`, add to it (knockback). Leaves the ground. */
  launch(velocity: Vec3Like, additive?: boolean): void;
  /** Move the feet to `position`, zero the velocity, optionally set the view. */
  teleport(position: Vec3Like, yaw?: number, pitch?: number): void;
  /** Set the view angles (pitch clamped to +-89 degrees). */
  setLook(yaw: number, pitch: number): void;
  /** Eye position and unit aim direction (recoil in, shake out) into the out vectors. */
  getAimRay(origin: THREE.Vector3, dir: THREE.Vector3): void;
  /** Kick the view: `pitch` radians up, `yaw` radians (signed). Player applies and recovers it. */
  addRecoil(pitch: number, yaw: number): void;
  /** Add camera trauma 0..1 (shake = trauma^2, decays; scaled by settings.screenShake). */
  addShake(trauma: number): void;
  /** addShake with linear distance falloff from `position` out to `radius`. */
  addShakeAt(position: Vec3Like, trauma: number, radius: number): void;

  /**
   * ADS coupling. WEAPONS calls it every frame: `amount` 0..1 blend, `zoom` FOV divisor at full ADS
   * (1.35, 2.5 ...), `moveMul` speed multiplier at full ADS (0.6). Player applies FOV, speed and scales
   * look sensitivity by 1/zoom.
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
  /** Last-stand charges left this run (from ctx.mods.lastStand). */
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
 * Weapon logic, viewmodels (in ctx.viewScene), grenades, melee.
 * update(unscaledDt): reads input (fire, ads, reload, weapon1-4, weaponNext/Prev, grenade, melee),
 * fires through combat (traceShot / tracePierce / spawnProjectile / applyDamage), owns its feedback
 * (see FEEDBACK OWNERSHIP), calls player.setAds / addRecoil / addShake, render.muzzleFlash.
 * Applies ctx.mods: damageMul, fireRateMul, magSizeMul, reloadSpeedMul, critDamageMul, chainLightning,
 * explosiveCrits, grenadeCapBonus. No ammo is consumed while player.overclock.active or
 * ctx.debug.infiniteAmmo. Does nothing while the player is dead.
 * reset(): only `vector` unlocked, full magazines, start reserves, 2 grenades, counters zero.
 */
export interface WeaponSystem extends System {
  readonly weapons: Readonly<Record<WeaponId, WeaponState>>;
  readonly current: WeaponState;
  /** A weapon swap animation is in progress. */
  readonly switching: boolean;
  /** Unlock a weapon (full mag + start reserve), emit 'weapon:unlocked'; `equip` switches to it. */
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
  /** Run counters: trigger pulls / pulls that damaged at least one enemy. DIRECTOR reads them for accuracy. */
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
 * registers one for itself. The object is RETAINED by combat until unregister(id).
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
  /** Set for enemy targets. */
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
}

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
  /** Default 'explosion'. */
  type?: DamageType;
  weapon?: DamageSource | null;
  /** Impulse at the centre in m/s (falls off like damage). Default 6. */
  knockback?: number;
  /** Require line of sight (COL.PROJECTILE) from the centre to each victim. Default true. */
  lineOfSight?: boolean;
  /** Which fx + sound + light + shake + decal package combat plays. Default by radius ('small' < 4 m <= 'large'). */
  visual?: ExplosionVisual;
}

export interface ProjectileOptions {
  kind: ProjectileKind;
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
  /** Default by kind ('plasma' for bolts, 'explosion' for rockets/grenades/mortars). */
  type?: DamageType;
  weapon?: DamageSource | null;
  /** > 0: explode on impact / fuse with this radius. Default 0. */
  splashRadius?: number;
  /** Damage at the centre of the splash. Default = damage. */
  splashDamage?: number;
  selfDamageMul?: number;
  friendlyFire?: boolean;
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
  /** Collision radius against targets. Default by kind. */
  radius?: number;
  /** Seconds before it silently expires. Default 8. */
  lifetime?: number;
  knockback?: number;
  critScale?: number;
  /** Explosion package when it has splash. Default by kind. */
  visual?: ExplosionVisual;
}

/**
 * Hit volumes, damage pipeline, projectiles, explosions.
 * update(dt): advance projectiles (swept against world with COL.PROJECTILE and against targets),
 * resolve impacts and fuses, run queued explosions. reset(): remove every projectile and queued
 * explosion; REGISTRATIONS ARE KEPT (owners unregister their own targets).
 */
export interface CombatSystem extends System {
  /** Start tracking a target (retained). Registering an id twice replaces the previous entry. */
  register(target: HitTarget): void;
  unregister(id: number): void;
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
   * THE damage entry point. Calls target.takeDamage(info), then — when a player-faction hit damaged
   * an enemy target and !info.silent — plays the target-hit feedback and emits 'hit:confirmed'.
   * Accepts the target or its id. Returns the victim's reusable result (dealt 0 for unknown/dead targets).
   */
  applyDamage(target: HitTarget | number, info: DamageInfo): DamageResult;
  /**
   * Radial damage + the whole audiovisual package (see ExplosionOptions). Safe to call from anywhere,
   * including HitTarget.takeDamage / EnemyBehavior.onKilled: a blast requested while a damage call or
   * another explosion is in flight is queued and resolved at the start of the next combat.update, so
   * damage callbacks never nest. `opts` is copied; nothing is retained.
   */
  explode(opts: ExplosionOptions): void;
  /** Launch a projectile; combat simulates, draws, collides and removes it. Returns its id. */
  spawnProjectile(opts: ProjectileOptions): number;
  /** Remove projectiles (all, or only one faction's) without detonating them. */
  clearProjectiles(faction?: Faction): void;
  readonly projectileCount: number;
  /** Collect live targets whose bounding sphere touches the query sphere into `out` (cleared first); returns the count. */
  queryRadius(center: Vec3Like, radius: number, faction: Faction | 'any', out: HitTarget[]): number;
}

// ---------------------------------------------------------------------------------------------------
// 18. Enemies (src/enemies)
// ---------------------------------------------------------------------------------------------------

export interface EnemySpawnOptions {
  /** Skip the lightning arrival (ring telegraph ~0.8 s, bolt, flash) and appear immediately. */
  instant?: boolean;
  /** Extra health multiplier on top of ctx.mods.enemyHealthMul. */
  hpMul?: number;
  /** Initial facing. Default: toward the player. */
  yaw?: number;
  /** Spawned by the boss: tagged so the director does not count it toward the wave quota. */
  summoned?: boolean;
}

/** Public read-only view of one live enemy. */
export interface EnemyHandle {
  /** Unique per spawn; equals its HitTarget id. */
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
  readonly alive: boolean;
  /** True during the arrival telegraph: not yet targetable or dangerous. */
  readonly spawning: boolean;
  readonly zone: ZoneId | null;
  readonly isBoss: boolean;
  readonly summoned: boolean;
}

export interface BossHandle extends EnemyHandle {
  /** Display name, "THE CONDUCTOR". */
  readonly name: string;
  /** 1, 2 or 3. */
  readonly phase: number;
  readonly phaseCount: number;
  /** True during phase transitions and the staged death. */
  readonly invulnerable: boolean;
}

/**
 * PLUG-IN CONTRACT between the enemy manager (src/enemies/index.ts) and each kind
 * (src/enemies/kinds/<type>.ts). The manager owns pooling, hp arithmetic, hit-target registration,
 * the arrival sequence, events, knockback decay and removal. A kind owns its meshes, hit-sphere
 * layout, AI, movement, attacks, animation and its own fx/audio.
 *
 * Life of one enemy: manager.spawn() -> behavior.onSpawn(opts) -> arrival (spawning = true; the
 * HitTarget is not registered yet, so it cannot be shot or hit by blasts) -> manager registers the
 * HitTarget (id = actor.id, center = actor.aimPoint, spheres = actor.spheres) -> behavior.update(dt)
 * every substep -> damage arrives through the manager (filterDamage -> hp -> onDamaged) -> at 0 hp:
 * onKilled(info) (skipped when info.silent) -> 'enemy:killed' -> onDespawn() -> slot returns to the pool.
 */
export interface EnemyKind {
  readonly type: EnemyType;
  /**
   * Called once per pooled slot. Build meshes under `actor.root`, push hit spheres into
   * `actor.spheres`, return the behaviour object bound to this actor.
   */
  create(ctx: GameContext, actor: EnemyActor): EnemyBehavior;
}

/** Mutable enemy state shared by the manager and its kind. Everyone else sees it as EnemyHandle. */
export interface EnemyActor extends EnemyHandle {
  readonly def: Readonly<EnemyDef>;
  /** Scene node (manager adds/removes it and toggles visibility). The kind positions it from `position`/`yaw`. */
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
  /** Decaying external velocity from knockback (manager decays it; the kind adds it to its motion). */
  readonly knock: THREE.Vector3;
  /** Seconds of stun left (manager counts down; the kind must not act while > 0). */
  stun: number;
  /** Seconds since the arrival finished. */
  age: number;
}

export interface EnemyBehavior {
  /** A fresh spawn of this pooled actor: reset every internal timer/state, pose the model. */
  onSpawn(opts: Readonly<EnemySpawnOptions>): void;
  /**
   * Per-substep AI + movement + animation with scaled dt. Not called while `spawning`, nor while
   * ctx.debug.freezeAi (then `animate` is called instead when defined).
   */
  update(dt: number): void;
  /** Idle animation only (used while AI is frozen). */
  animate?(dt: number): void;
  /**
   * Victim-side damage shaping BEFORE hp is reduced: return the final hp damage for this hit
   * (energy shields, invulnerable phases). Default when undefined:
   * amount * (weak ? def.weakMul * info.critScale : armor ? def.armorMul : 1), 0 for 'shield'.
   */
  filterDamage?(info: Readonly<DamageInfo>, baseDamage: number): number;
  /** After hp changed and the actor survived (hurt flash, stagger). */
  onDamaged?(info: Readonly<DamageInfo>, result: Readonly<DamageResult>): void;
  /** hp reached 0: play the death (fx, sound, explosion). The manager emits events and frees the slot afterwards. */
  onKilled(info: Readonly<DamageInfo>): void;
  /** The slot is being freed for any reason (death, reset, killAll): cancel telegraphs, stop loops, release tokens. */
  onDespawn(): void;
}

/**
 * Enemy manager. update(dt): ctx.nav.updateFlowField(player), arrivals, behaviours, separation,
 * removal of the dead. Applies ctx.mods.enemyHealthMul (hp) and ctx.mods.enemySpeedMul at spawn.
 * Enemies never attack while !ctx.player.alive. reset(): despawn everything, release all tokens.
 */
export interface EnemySystem extends System {
  /** Register the factory for one type (call from src/enemies/index.ts init, one file per kind). */
  registerKind(kind: EnemyKind): void;
  /**
   * Spawn one enemy at `position` (floor point for ground units, hover point for flyers). Starts the
   * arrival sequence unless opts.instant. Returns null when the hard cap (64 live) is reached.
   */
  spawn(type: EnemyType, position: Vec3Like, opts?: EnemySpawnOptions): EnemyHandle | null;
  /**
   * Live enemies, including those still arriving. An enemy that died earlier in the same frame may
   * still be listed until the next enemies.update — always check `alive`. Do not hold across frames.
   */
  readonly list: readonly EnemyHandle[];
  /** Number of live enemies (alive, including arriving ones, including summoned ones). */
  readonly aliveCount: number;
  /** Live, non-summoned enemies — what the director counts for wave completion. */
  readonly waveCount: number;
  countOf(type: EnemyType): number;
  get(id: number): EnemyHandle | undefined;
  /** Nearest live, non-arriving enemy within maxDist of `pos` (distance to aimPoint); null if none. */
  nearest(pos: Vec3Like, maxDist: number): EnemyHandle | null;
  /** Collect live, non-arriving enemies whose aimPoint is within `radius` into `out` (cleared first). */
  queryRadius(center: Vec3Like, radius: number, out: EnemyHandle[]): number;
  /**
   * Kill every live enemy and free its slot immediately. Kills are credited to the world
   * (DamageInfo.faction 'neutral', weapon 'world'), so they never score. 'enemy:killed' is emitted for
   * each. With `silent` (debug, cleanups) DamageInfo.silent is true: no death fx/audio, the event
   * carries score 0, and a boss dies WITHOUT its staging and without 'boss:defeated'.
   * Returns how many were killed.
   */
  killAll(silent?: boolean): number;
  /** The boss while it is alive (or in its staged death), else null. */
  readonly boss: BossHandle | null;

  // --- shared AI services for kinds ---
  /**
   * Global attack-token budget (ctx.mods.attackTokens) so the player is never shot by everything at
   * once. A kind acquires before starting a ranged attack telegraph and releases when the attack ends.
   */
  tryAcquireAttackToken(enemyId: number, weight?: number): boolean;
  releaseAttackToken(enemyId: number): void;
  /** Push-away vector from neighbours within `radius` of the enemy into `out` (XZ, length 0..1). */
  separation(enemy: EnemyHandle, radius: number, out: THREE.Vector3): THREE.Vector3;
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
 * Run flow: waves, spawning, pickups, perks, score/combo, progression, supply drops.
 * Owns: wave table playback (data/waves.ts scaled by difficulty), spawn placement (world.spawnPoints,
 * validated with ctx.nav), drops on 'enemy:killed', zone unlocks (world.unlockZone), time of day
 * (render.setTimeOfDay per WaveDef.timeOfDay), supply drops (weapons.unlock on collect — a crate that is
 * not collected within 20 s is auto-collected so the run can never stall), perk offers (hard-freeze via
 * time.setScale('perkSelect', 0) — the choice arrives through choosePerk from the UI, from the
 * perk1..3 actions which the director polls itself, or from the bot), run end (player death:
 * endRun(false) after ~1.5 s; boss defeated: endRun(true) after the staging).
 * Writes ctx.mods: difficulty fields in startRun, perk fields in choosePerk.
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
  /** Pick offer[index]; false when nothing is on offer or the index is invalid. Unfreezes the world. */
  choosePerk(index: number): boolean;
  /** Stacks owned of one perk (0 = not owned). `stats.perks` lists every pick in order. */
  perkStacks(id: PerkId): number;
  /** Live pickups including the supply crate. Do not hold across frames. */
  readonly pickups: readonly PickupState[];
  /** Spawn a pickup (debug + scripted rewards). `amount` defaults to the PickupDef amount. */
  spawnPickup(type: PickupType, position: Vec3Like, amount?: number): void;
  readonly objective: ObjectiveState;
  /** Award score outside the kill pipeline. */
  addScore(amount: number, reason: ScoreReason, position?: Vec3Like): void;
  /**
   * Debug: kill everything silently and jump so that wave `wave` (1..totalWaves) starts after a 1 s
   * warmup, with the zones, weapons and time of day the player would have had by then.
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
  /** (0) weapons: extra grenade capacity. */
  grenadeCapBonus: number;
  /** (1) weapons: grenade damage + radius multiplier. */
  grenadePowerMul: number;

  /** (0) player: added to max shield (100). */
  maxShieldBonus: number;
  /** (0) player: added to max health (100). */
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
  /** (0) player: last-stand charges granted per run (lethal hit leaves 1 hp + 2 s invulnerability + full shield). */
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
  /** (1) enemies: movement speed multiplier (difficulty). */
  enemySpeedMul: number;
  /** (3) enemies: simultaneous ranged-attack token budget (difficulty). */
  attackTokens: number;
}

// ---------------------------------------------------------------------------------------------------
// 21. FX (src/fx)
// ---------------------------------------------------------------------------------------------------

export interface FxSpawnOptions {
  /** Surface normal (impacts, decals); default up. */
  normal?: Vec3Like;
  /** Main emission direction (muzzles, sparks along a shot); default = normal. */
  dir?: Vec3Like;
  /** Size multiplier; default 1. */
  scale?: number;
  /** Tint override 0xRRGGBB; default = the effect's own palette colour. */
  color?: number;
  /** Inherited velocity in m/s (effects spawned from moving things). */
  velocity?: Vec3Like;
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
}

export interface BeamOptions {
  kind: BeamKind;
  color?: number;
  /** Core width in metres; default by kind. */
  width?: number;
  /** Seconds before it fades out by itself. 0 = persistent until handle.stop(). Default 0.12. */
  seconds?: number;
}

/** Dead handles (stopped, expired, or invalidated by fx.clear()) ignore every call. */
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
  /** Seconds until the danger lands: the fill grows from 0 to the full radius over this time, then the marker disappears. */
  seconds: number;
  /** Default: hazard yellow. */
  color?: number;
}

export interface TelegraphHandle {
  readonly active: boolean;
  setPosition(position: Vec3Like): void;
  setRadius(radius: number): void;
  /** Remove immediately (attacker died / attack cancelled). */
  cancel(): void;
}

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
}

/**
 * Particles, decals, tracers/beams, damage numbers, weather, the pooled light rig.
 * Owns the FIXED pool of 6 THREE.PointLight in ctx.scene (created in init, never added/removed later;
 * idle lights sit at intensity 0). Budget: <= 25 draw batches in total, no allocation per spawn.
 * update(dt) uses scaled world time. Purely presentational: no gameplay effect, no sounds except the
 * ambient storm (see setWeather). clear() kills every transient effect and invalidates all handles.
 * See FEEDBACK OWNERSHIP at the top: fx never spawns anything from gameplay events.
 */
export interface FxSystem extends System {
  /** One-shot effect at a world position. Unknown/unimplemented ids must not throw. */
  spawn(id: FxId, position: Vec3Like, opts?: FxSpawnOptions): void;
  /** Bullet streak from `from` to `to`. */
  tracer(from: Vec3Like, to: Vec3Like, opts?: TracerOptions): void;
  /** Energy beam between two points; one-shot (opts.seconds > 0) or persistent (0) through the handle. */
  beam(from: Vec3Like, to: Vec3Like, opts: BeamOptions): BeamHandle;
  /** Surface mark; oldest decals are recycled beyond render.qualityParams.maxDecals. */
  decal(kind: DecalKind, position: Vec3Like, normal: Vec3Like, size?: number): void;
  /** Floating damage number at a world point (no-op when settings.damageNumbers is false). */
  damageNumber(position: Vec3Like, amount: number, opts?: DamageNumberOptions): void;
  /**
   * Flash one pooled point light: `intensity` in candela-ish three.js units at t=0 fading to 0 over
   * `seconds`, `radius` = light distance in metres. When all 6 are busy the weakest is stolen.
   */
  lightFlash(position: Vec3Like, color: number, intensity: number, radius: number, seconds: number): void;
  /** Ground danger marker (enemy arrivals, mortars, lightning strikes, shock rings). */
  telegraph(opts: TelegraphOptions): TelegraphHandle;
  /** Jagged bolt between two points (visual + optional pooled light only: the caller plays the sound and render.lightningFlash). */
  lightningBolt(from: Vec3Like, to: Vec3Like, opts?: LightningOptions): void;
  /**
   * Ribbon/particle trail following `position` — the vector is RETAINED and read every frame until
   * detach(), so pass the projectile's own live position vector.
   */
  attachTrail(kind: TrailKind, position: THREE.Vector3, color?: number): TrailHandle;
  /**
   * Ambient weather. FX calls this itself on 'timeOfDay:changed' (per data/timeOfDay.ts); others only
   * for debug. Storm weathers own ambient lightning: fx picks the moments, draws distant bolts, calls
   * ctx.render.lightningFlash and plays 'thunderFar' / 'thunderNear'.
   */
  setWeather(id: WeatherId, intensity?: number): void;
  readonly weather: WeatherId;
  /** Remove every transient effect now and invalidate all handles (reset calls it). */
  clear(): void;
  /** Live particle count (debug HUD / tests). */
  readonly particleCount: number;
}

// ---------------------------------------------------------------------------------------------------
// 22. Audio (src/audio)
// ---------------------------------------------------------------------------------------------------

export interface SoundOptions {
  /** Linear gain multiplier, default 1. */
  volume?: number;
  /** Playback-rate multiplier, default 1 (audio adds its own small per-shot variation). */
  pitch?: number;
  /** Seconds to wait before playing, default 0. */
  delay?: number;
  /** 0 ambient .. 3 critical (player weapon, hurt, UI). Under voice pressure the lowest is dropped. Default 1. */
  priority?: number;
}

export interface LoopOptions {
  /** World position for a 3D loop; omit for a 2D (head-locked) loop. */
  position?: Vec3Like;
  volume?: number;
  pitch?: number;
  /** Fade-in seconds, default 0.05. */
  fadeIn?: number;
}

/** Dead handles (stopped or invalidated by stopAll()/reset()) ignore every call. */
export interface LoopHandle {
  readonly active: boolean;
  setPosition(position: Vec3Like): void;
  /** Target gain, reached after `seconds` (default 0.05). */
  setVolume(volume: number, seconds?: number): void;
  setPitch(pitch: number): void;
  /** Fade out over `seconds` (default 0.08) and release. */
  stop(seconds?: number): void;
}

/**
 * 100 % synthesised WebAudio: engine, SFX library, adaptive music.
 * Nothing may create or resume an AudioContext before unlock(). Before unlock every call is a silent
 * no-op (loop() returns a dead handle) — callers never need to check.
 * update(realDt): syncs the listener from ctx.camera, follows ctx.time.scale with a global SFX
 * pitch/low-pass (Overclock / slow motion; music and UI sounds are exempt), drives music layers.
 * Volumes follow ctx.settings ('settings:changed'). MUSIC is automatic: audio derives state and
 * intensity from the events listed under FEEDBACK OWNERSHIP plus ctx.enemies.aliveCount / player hp —
 * gameplay systems do NOT call setMusicState.
 * reset(): stopAll(), music follows the next mode/phase.
 */
export interface AudioSystem extends System {
  /** Create/resume the AudioContext. Core calls it from startRun and from the first pointer/key gesture. Idempotent. */
  unlock(): void;
  readonly unlocked: boolean;
  /** Non-positional one-shot (UI, the player's own gun, stingers). */
  play(id: SoundId, opts?: SoundOptions): void;
  /** Positional one-shot (PannerNode, distance attenuation, light reverb send). */
  playAt(id: SoundId, position: Vec3Like, opts?: SoundOptions): void;
  /** Start a sustained sound; control and stop it through the handle. */
  loop(id: LoopId, opts?: LoopOptions): LoopHandle;
  /** Force a music state (debug / screenshots); null returns to automatic. */
  setMusicState(state: MusicState | null): void;
  readonly musicState: MusicState;
  /** Force the 0..1 combat intensity; null returns to automatic. */
  setMusicIntensity(value: number | null): void;
  readonly musicIntensity: number;
  /** Temporarily lower music by `amount` 0..1 for `seconds` (big explosions, stingers). */
  duck(amount: number, seconds: number): void;
  /** LEVEL 0..1 low-pass "muffle" on the SFX + music buses (low health, nearby blast). Owner: player, written every frame. */
  setMuffle(amount: number): void;
  /** Stop every one-shot and loop (not the music) with a short fade; all LoopHandles die. */
  stopAll(): void;
  /** Voices currently sounding (debug HUD / tests). */
  readonly voiceCount: number;
}

// ---------------------------------------------------------------------------------------------------
// 23. UI (src/ui)
// ---------------------------------------------------------------------------------------------------

/**
 * DOM HUD + menus + perk select + settings + minimap + touch controls, all inside ctx.uiRoot.
 * Never called by gameplay. update(realDt) reads ctx state every frame (also in menus and while
 * paused); events drive transient elements (hitmarkers, damage arcs, banners, callouts).
 * Button handlers call ctx.game.startRun / pause / resume / restart / toMenu, ctx.director.choosePerk,
 * ctx.settings.set. The 'pause' action is handled by CORE — the UI must not toggle pause on it
 * (see consumesPauseAction for nested panels).
 * Touch controls feed ctx.input.setVirtualMove / setVirtualButton / addVirtualLookPixels and are shown
 * while ctx.input.device === 'touch' ('input:device').
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
}

// ---------------------------------------------------------------------------------------------------
// 24. Data tables (src/data)
// ---------------------------------------------------------------------------------------------------

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
  /** Forward lunge speed in m/s. */
  lunge: number;
  knockback: number;
}

export interface EnemyDef {
  type: EnemyType;
  /** "SKITTER". */
  name: string;
  role: string;
  hp: number;
  /** Cruise speed in m/s. */
  speed: number;
  /** Bounding radius / height in metres. */
  radius: number;
  height: number;
  flying: boolean;
  /** Preferred altitude above the floor for flyers [min, max]; [0, 0] for ground units. */
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
  /** Attack-token weight of its ranged attack (0 = melee only). */
  tokenCost: number;
  /** Knockback divisor (1 = light, 10 = barely moves). */
  mass: number;
  /** 0xRRGGBB emissive accent. */
  accent: number;
  /** Kind-specific tuning (leap range, blast radius, shield hp ...): see data/enemies.ts. */
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

/** Baseline look of one time of day (data/timeOfDay.ts). Render may refine but must keep LightingState in sync. */
export interface TimeOfDayDef {
  id: TimeOfDayId;
  /** "AMBER DUSK". */
  name: string;
  /** Inclusive wave range. */
  waveFrom: number;
  waveTo: number;
  weather: WeatherId;
  /** Ambient storm lightning strikes per minute (0 = none). */
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
  /** 'window', 'promise', 'init:world', 'update:enemies', 'event:enemy:killed' ... */
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
  enemiesAlive: number;
  enemiesRemaining: number;
  pickups: number;
  projectiles: number;
  boss: { hp: number; maxHp: number; phase: number } | null;
  perkOffer: PerkId[] | null;
  player: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    hp: number;
    shield: number;
    alive: boolean;
    grounded: boolean;
    overclock: number;
    overclockActive: boolean;
  };
  weapon: { id: WeaponId; mag: number; reserve: number; reloading: boolean; unlocked: WeaponId[] };
  grenades: number;
  stats: RunStats;
  zones: Record<ZoneId, boolean>;
  timeOfDay: TimeOfDayId;
  quality: QualityPreset;
  lookMode: LookMode;
  device: InputDevice;
  fps: number;
  drawCalls: number;
  triangles: number;
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
 * step() is what advances the simulation when the page was opened with ?test=1 (manual mode).
 */
export interface DebugApi {
  /** True once boot finished and the game sits in 'menu'. */
  ready: boolean;
  /** True when a fatal error stopped the game. */
  readonly fatal: boolean;
  /** Manual stepping mode (?test=1). */
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
  /** Kill everything through the normal death path (ctx.enemies.killAll(false): credited to the world, no score). Returns the count. */
  killAll(): number;
  /** Positions of live enemies (NaN checks). */
  enemies(): { id: number; type: EnemyType; x: number; y: number; z: number; hp: number }[];
  teleport(x: number, y: number, z: number, yaw?: number, pitch?: number): void;
  look(yaw: number, pitch: number): void;
  lookAtPoint(x: number, y: number, z: number): void;
  /** Tap (or hold for `seconds` of stepped time) an input action through the virtual input. */
  press(action: InputAction, seconds?: number): void;
  /** Hold the virtual stick (strafe, advance) until changed. */
  move(x: number, y: number): void;
  /** Free camera override for screenshots (viewmodel hidden while active). */
  setCamera(position: [number, number, number], target: [number, number, number], fov?: number): void;
  releaseCamera(): void;
  setTimeOfDay(id: TimeOfDayId, seconds?: number): void;
  hideUi(on: boolean): void;
  setQuality(preset: QualityPreset): void;
  /** Damage the player through the normal pipeline (neutral faction). */
  damagePlayer(amount: number): void;
  choosePerk(index: number): boolean;
  unlockZone(zone: ZoneId): void;
  /** Autopilot that plays through the virtual input (see core/bot.ts). */
  bot(on: boolean, opts?: BotOptions): void;
}
