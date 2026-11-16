# Assignment: WEAPONS

Four guns, grenades and melee: the logic and the first-person presentation. Gunfeel is the product. Replace the
stub in `src/weapons/index.ts`; keep the factory `createWeaponSystem(ctx)`. All tuning lives in
`src/data/weapons.ts`, which is yours to refine — no local multipliers, no copies of its numbers. Where this
text and `src/core/types.ts` differ, the contract wins.

- **Logic**: triggers auto / semi / charge and deliveries hitscan / pellets / piercing beam / projectile, as
  the weapon table says. The LANCE fires by itself the moment its charge completes; letting go earlier cancels
  and keeps the round (there is no hold-and-release). Fire-rate timing that is exact at any frame rate
  (accumulate, allow multiple shots per frame), spread model (base + per-shot bloom + movement/air penalties −
  crouch/ADS bonuses, recovering over time; exposed as the half-angle that drives the crosshair), per-weapon
  recoil pattern (vertical climb + horizontal drift, reduced in ADS, sent to the player's recoil API), damage
  falloff, pellets, piercing rail via the combat piercing trace, rockets and grenades via combat projectiles
  (simulated from the eye, drawn from the muzzle), magazines + reserve, reloads (rifle: mag swap; scattergun:
  shell-by-shell, interruptible by firing; rail: cell swap; launcher: slow), auto-reload on empty, reload
  cancel on switch, switch with lower/raise timing, 120 ms input buffering for fire/reload/switch, dry-fire
  click, rising pitch on the last rounds of a magazine, all perk modifiers (read live), Overclock rules (no
  ammo use — grenades are still consumed), shot/hit accounting as the contract defines it and every documented
  event. You put every attacker-side factor (weapon damage, damage perks, falloff, charge) into the damage you
  hand to combat; the victim applies the rest. Bullet magnetism only while `ctx.input.aimAssist` is true. The
  held weapon's move-speed multiplier reaches the player through its named speed-multiplier API (source
  `'weapon'`).
- **The shot moment — your half and combat's half.** Yours: muzzle flash, fire sound, tracer or rail beam from
  the muzzle, casing, recoil, shake, rumble, and what a player ray or melee strike does to **world** geometry
  (per-surface impact fx + sound + decal). Combat's: everything about a hit on an **enemy** — spark, shield
  ripple, damage number, hit sound, the hit-confirm event — is played when you call `applyDamage`; add none of
  your own. Knockback is simply the impulse you put into the damage. The perk procs are yours to trigger:
  chain-lightning arcs, and explosive-crit blasts through `combat.explode`.
- **Viewmodels** in the view scene: four distinct, chunky, readable guns built from primitives (bevelled boxes,
  cylinders, lathe/extrude) plus simple armoured gauntlet hands. ≤ 12 draw calls each: merge static parts, keep
  moving parts separate (bolt, magazine, pump, charge coils, missile rack). A small emissive **diegetic ammo
  readout** on each gun (canvas texture redrawn only when the count changes). Muzzle flash meshes on the model
  (randomised per shot, ~50 ms) plus `render.muzzleFlash` for the view-layer light — you add no light of your
  own. Ejected casings are the world-space casing effects, placed through `render.viewToWorld` like the tracer
  start — no casing meshes of your own. ADS is a pose in view space: the view camera never moves and nobody
  writes its FOV; the zoom is applied by the player from what you pass to `setAds` each frame, and the scope
  overlay is the UI's.
- **Animation**, all procedural and spring-driven so it never looks canned: look sway and lag, movement bob,
  jump/land offsets, sprint carry pose, slide pose, ADS pose with sights aligned to screen centre, recoil kick
  + recovery, pump/bolt cycling, charge shake and glow for the rail, small keyframed reload sequences (mag out
  → mag in → charge), lower/raise on switch, melee strike, grenade toss, idle breathing. You run on the
  player's unscaled clock, and the effects of the player's own hands are spawned on the `'player'` clock, so
  Overclock keeps handling crisp.
- **Grenades** (arc throw; bounce, fuse and blast are combat's) and **melee** (cone check, lunge through the
  player's impulse API, hit-stop on connect, fx/audio).
- **Leaving the run**: on `onModeChange` to anything but playing / paused, put back the levels you own (ADS
  vignette, ADS coupling) and stop the charge loop. Do nothing while the player is dead. `unlock()` is silent —
  the crate's fanfare is the director's.
- Vitest for the pure logic: fire-rate exactness across dt, spread/recoil evolution, falloff, the charge
  trigger (auto-release, cancel), ammo/reload state machine (including interrupts and reset), shot/hit
  accounting, modifiers.
- Screenshots via the harness of every gun: idle, ADS, mid-fire (flash visible), mid-reload, plus melee and
  grenade frames. Look at them; iterate until each gun has a strong silhouette and sits well in frame at 16:9
  and on a narrow phone-landscape viewport.

## Contract pointers

- **You implement** `WeaponSystem` (types.ts §16) with `WeaponState`. Read closely: the doc block above
  `WeaponSystem` (geometry of a shot, player-clock presentation, the rules for ammo, accounting, chain
  lightning and explosive crits, `onModeChange`, reset); `WeaponDef`, `GrenadeDef`, `MeleeDef` (§24); the
  combat calls you make and their option structs (§17) and `DamageInfo` (§14); `PlayerSystem.getAimRay`,
  `addRecoil`, `setAds`, `addImpulse`, `setSpeedMultiplier` (§15); `RenderSystem.viewToWorld`, `muzzleFlash`,
  `warm` (§13) and the view-scene docs of `GameContext` (§4); the `'weapon:*'` events (§7); the weapons fields
  of `Modifiers` (§20); `TimeState.hitstop` (§6); `Input.aimAssist` / `rumble` (§8); the `WeaponsFxId`,
  `WeaponsSoundId`, `WeaponsLoopId`, shared impact ids and the `BeamKind` note on chain lightning (§2); in the
  header: FRAME PIPELINE, CLOCKS (`unscaledDt`), FEEDBACK OWNERSHIP RULE (the weapons line against the combat
  line), LEVELS / IMPULSES / HANDLES, RENDERING CONVENTIONS (one root named `weapons` in the view scene,
  materials never shared between the scenes, no shadows, warm the viewmodels with layer `'view'`).
- **Feedback you trigger**: every `WeaponsFxId`, `WeaponsSoundId` and `WeaponsLoopId`; `fx.tracer` and the
  `rail` beam; shared impact fx + sounds + `fx.decal` for player rays and melee on world geometry;
  `fx.lightningBolt` + `chainArc` + `chainZap` for chain lightning; `render.muzzleFlash` (and `fx.lightFlash`
  at the muzzle if the world should light up); `player.addRecoil` / `addShake`; `input.rumble` per shot;
  `time.hitstop` on a melee connect and a rail kill; `post.adsVignette` (you are its only writer); the
  `'weapon:*'` events. **Never**: `hitEnemy*` sparks, damage numbers, hit sounds or `'hit:confirmed'` (combat);
  explosion fx or sounds (they come with `combat.explode`); projectile trails, fly loops, bounces and impacts
  (combat); the `weaponUnlock` fx / sound (director); a real light; a write to `ctx.viewCamera`.
- **Data tables you may tune**: `src/data/weapons.ts` (`WEAPONS`, `GRENADE`, `MELEE` — values only). Projectile
  defaults in `data/projectiles.ts` are combat's.
- **Files you own**: `src/weapons/**`.
- **Verify with**: `__SH.giveAll()`, `__SH.infiniteAmmo(true)`, `__SH.press('fire' | 'ads' | 'reload' | 'melee' |
  'grenade' | 'weapon1'…, seconds)`, `__SH.ctx.weapons.switchTo(id)`; `__SH.spawn(type)` + `__SH.freezeAi(true)`
  + `__SH.lookAtPoint(…)` for a target; `__SH.state()` → `weapon` (mag, reserve, charge, spread, ads,
  switching), `stats.shots` / `hits`; `__SH.overclock()`; `__SH.givePerk('chainLightning' | 'explosiveCrits' |
  …)`; `__SH.budget()['view:weapons']` for the draw-call budget; `step(seconds, { dt })` at several dt for
  fire-rate exactness. `tools/shots.mjs` photographs each viewmodel (`--size 844x390` for phone landscape).
