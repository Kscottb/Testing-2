# Assignment: DIRECTOR

The game master: waves, spawning, pacing, pickups, perks, score, progression, objectives, win/lose. Replace the
stub in `src/director/index.ts`; keep the factory `createDirectorSystem(ctx)`. The wave, perk, pickup and
difficulty tables are yours: tune them into a 15–22 minute campaign with a real difficulty curve. Where this
text and `src/core/types.ts` differ, the contract wins.

- **Wave flow** (the phase machine of the contract): warmup → combat → cleared → zone unlock when due → supply
  drop when a weapon is due → perk select → intermission countdown → next wave. Every banner in the game is one
  of your `announce` events (wave start, clear, FLAWLESS, zone unlocked, supply drop, boss intro); the UI shows
  the newest one and nothing else, so pace them. Perk select hard-freezes the world through your `perkSelect`
  time-scale request; pointer capture is core's business, not yours. There is no way to skip an intermission.
  Wave 10 = boss: after the last intermission a timed boss intro (banner, sound, objective marker on the Core
  Spire), then the Conductor is spawned at the arena anchor wherever the player stands; victory follows the
  boss's staged death by exactly the seconds its defeat event carries.
- **Spawning**: timed groups from the wave table scaled by the difficulty density, the wave's cap on
  simultaneously alive enemies (queue the rest; a refused spawn is retried next frame). Points come from the
  group's zone and the enemy's spawn kind, with the contract's fallback order when a list is empty; among them
  choose well: 16–45 m from the player, prefer out of sight, spread packs across nearby points. Each wave
  introduces or recombines enemy types so it teaches: 1 skitters → 2 +riveters → 3 +ticks → 4 wasps → 5 lancers
  → 6 first bulwark → 7–9 mixed elites with denser packs.
- **Anti-stall** — a run can never soft-lock. Three watchdogs, all specified in the contract: the mercy ammo
  drop; the straggler watchdog (unreachable or far-away leftovers are *killed* as world kills after a quiet
  spell — nothing is re-deployed or relocated); the boss watchdog (a boss that vanished without being defeated
  still ends the fight). Plus the supply crate that opens by itself after its timeout.
- **Progression**: unlock zones after waves 3 and 6 by calling the world (it opens the gates with its own fx
  and sound; you add the banner and the objective). Drive time-of-day from the wave table through render
  (blend; snap on a debug skip). Weapon unlocks after waves 1/4/6 arrive by **supply drop**: a pod streaks down
  onto the drop pad of the wave's zone nearest the player, a beacon marks it, and it is collected by walking
  into it (or by the timeout): `weapons.unlock` plus your unlock fx and sound.
- **Perks**: offer up to three distinct perks below their max stacks, weighted by rarity (fewer when fewer
  exist; none → skip the phase). A pick = the perk's `apply` on `ctx.mods` plus the instant part the contract
  lists (max health heals to full, max shield tops the shield up, grenadier hands over a grenade), then your
  acquire sound, fx and event. The perk keys double as weapon keys: you poll them yourself during the freeze
  and ignore them for the guard time after the offer appeared; `choosePerk` itself is never time-guarded. All
  perks from the brief must really work end-to-end — coordinate only through the documented modifier fields.
- **Pickups**: a drop roll per rewardable kill from the enemy's drop chance (plus perk bonus and the difficulty
  drop multiplier), type by pickup weight, with pity logic on top (health when the player is hurt and unlucky,
  ammo when reserves are low). Bobbing glowing pickup meshes, instanced per type, in the colours of the pickup
  table; magnetise, collect through the player / weapons interfaces, expiry with blink; fx + sound + events.
- **Score**: base × combo, multikill callouts, crit-kill bonus, wave-clear and flawless bonuses, run stats,
  grade. Which kills are rewarded (never world-credited or silent ones; summoned enemies at a quarter) is
  spelled out at `'enemy:killed'`; the combo / multikill numbers are the `SCORING` constants in core. Finalise
  the run stats **before** you call `endRun` — core stores the best score and wave; you persist nothing.
- **Difficulty**: `startRun` (called by core only) writes the difficulty row into `ctx.mods`. You are the only
  writer of `ctx.mods`; every other system only applies its own fields. Gentle ramp inside each run through
  the wave table.
- **End of run**: whichever of player death and boss defeat arrives first decides the run; the phase goes to
  `done` and the machine stops for good. On death: withdraw a pending perk offer, a short slow motion through
  your `slowmo` request plus the saturation post level (both yours alone), then game over after the death
  delay. You are the only caller of `endRun`. Everything resets cleanly for a new run.
- **Not yours**: the music. Audio derives its state and intensity from your events by itself — never drive it.
- **Clocks**: wave, phase, combo, multikill and pickup timers run on scaled dt; the two end-of-run waits on
  `ctx.time.playerDt`; anything timed during the perk freeze compares `ctx.time.elapsed` stamps (your update
  receives dt 0 there, once per frame).
- Vitest with fake/minimal context: wave runner timing and alive-cap queueing, spawn-point scoring and the
  fallback order, the three watchdogs, perk offer rules, the key guard and modifier application, reward rules
  per kill kind, combo/multikill/score maths, grade thresholds, pickup pity logic, both end-of-run orders, full
  flow from wave 1 to victory with a simulated "kill everything" loop, reset.

## Contract pointers

- **You implement** `DirectorSystem` (types.ts §19) with `ComboState`, `RunStats`, `PickupState`,
  `ObjectiveState`. Read closely: the whole doc block above `DirectorSystem` (WAVE FLOW, SPAWNING, KILLS,
  ANTI-STALL, PERK SELECT, END OF RUN, CLOCKS); `DirectorPhase` (§2); `Game.startRun` / `endRun` (§5); your
  events in `EventMap`, above all the `'announce'` banner policy, the reward rules at `'enemy:killed'`,
  `'boss:defeated'` and `'player:died'` (§7); `Modifiers` (§20); `WaveDef`, `PerkDef`, `PickupDef`,
  `DifficultyDef` (§24); the calls you make into `EnemySystem` (§18), `WorldSystem` (§12),
  `RenderSystem.setTimeOfDay` and `PostFxParams.saturation` (§13), `WeaponSystem` (§16), `PlayerSystem.heal` /
  `addShield` (§15), `TimeState.setScale` (§6); `SCORING` and `PERK_INPUT_GUARD_SECONDS` in
  `core/constants.ts`; in the header: FRAME PIPELINE (your `update(0)` during the freeze), CLOCKS, FEEDBACK
  OWNERSHIP RULE (the director line), LEVELS / IMPULSES / HANDLES (the lazily acquired beacon loop), RENDERING
  CONVENTIONS (one root named `director`; warm pickups and crate in `init()`).
- **Feedback you trigger**: every `DirectorFxId`, `DirectorSoundId` and `DirectorLoopId` (wave stingers,
  countdown ticks, objective, pickups, supply drop, weapon unlock, perk pick, combo and multikill), the `supply`
  trail, every `'announce'` banner, `post.saturation`, the `perkSelect` and `slowmo` time-scale requests and
  your events. **Never**: music state or intensity, or an end-of-run stinger (audio); gate and zone-unlock fx /
  sound (world plays them inside `unlockZone`); the arrival effects of a spawn (enemy manager); interface
  sounds (the UI plays the perk-offer sound, you play the pick); storing records (core); pointer capture;
  moving an enemy.
- **Data tables you may tune**: `src/data/waves.ts` (with the timing constants in that file), `perks.ts`,
  `pickups.ts`, `difficulty.ts` — values only. Not yours: `enemies.ts` (drop chance, score and token cost per
  enemy belong to the enemy engineers) and the `SCORING` constants.
- **Files you own**: `src/director/**`.
- **Verify with**: `__SH.setWave(n)`; `__SH.killAll()` clears a wave with world kills (no rewards), while
  `__SH.damageEnemy(id, 9999)` is a rewarded kill; `__SH.choosePerk(i)`, `__SH.givePerk(id)`,
  `__SH.ctx.director.spawnPickup(…)`, `__SH.damagePlayer(1e5)` for the death path; `__SH.state()` → `phase`,
  `wave`, `enemiesRemaining`, `perkOffer`, `perks`, `pickups`, `score`, `combo`, `stats`, `timeScale`.
  `tools/smoke.mjs` walks the wave flow, the perk lock and freeze, restarts and all three end-of-run cases (it
  teleports to `objective.position` to reach the crate — keep that marker accurate). `tools/campaign.mjs
  --god 1` must reach victory and fails after 120 s without progress; run it with `--god 0` for balance.
