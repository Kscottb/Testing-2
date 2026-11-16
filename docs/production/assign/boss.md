# Assignment: BOSS — THE CONDUCTOR

The manager and six kinds exist. Read all of `src/enemies/` and the plug-in contract in `src/core/types.ts`
first, then add the boss as one more kind — `src/enemies/kinds/conductor.ts`, with helper files under
`src/enemies/boss/` — and register it. This is the climax of the game: make it a set piece. Where this text and
the contract differ, the contract wins.

- **Form**: a colossal floating storm-core machine (size from its table row: about 10 m across): a rotating
  armoured ring of segmented plates around a blinding core, orbiting **capacitor nodes** (weak points, crit
  damage; their count is in the row), dangling conductor spines crackling with white-violet lightning, magenta
  accents. ≤ 40 draw calls and no lights of its own (emissive glow plus the fx light pool). It is **anchored**:
  the director spawns it at the arena anchor the world defines (arena centre + hover height; a debug spawn
  anchors where it was spawned) and it bobs and sways around that point inside its hover band — it does not
  roam the arena. Always trackable, never out of reach of every weapon.
- **Intro**: the director spawns it after its own timed boss-intro phase. The manager spawns the boss instantly
  (no ring-and-bolt arrival), emits the boss-spawned event (the UI shows bar and name) and plays the spawn roar.
  Your part is the staging inside `update`: descend from the storm onto the anchor with lightning strikes,
  camera shake and your own effects, invulnerable until it ends. `onSpawn` alone must already pose the complete
  machine — the AI may be frozen.
- **Phase 1 (100–66 %)**: aimed bolt volleys in readable patterns; a slow rotating **sweep laser** at ground
  level (a persistent sweep beam handle; jump over or slide under — heights in the row; never undodgeable —
  rotation speed bounded); summons skitter packs: ordinary spawn calls flagged as summoned — the manager gives
  them the normal arrival, and a full scene simply skips them.
- **Phase 2 (66–33 %)**: adds telegraphed **lightning strikes** (ground markers that fill, then a bolt) seeded
  around and ahead of the player, and **homing missile salvos** (slow turn rate; combat makes them
  shoot-downable); summons wasps.
- **Phase 3 (< 33 %)**: enraged — faster cadence, sweep laser + strikes overlap, **expanding shock rings** along
  the ground (jump; the ring marker you drive is the damage front), summons ticks. Never more than the player
  can read: stagger attacks, keep telegraphs ≥ 0.6 s.
- **Phases are yours to drive** — the manager never derives them from health. Hold a threshold by clamping the
  damage in your filter, go invulnerable for the shift, and change phase only through `setBossPhase`: it emits
  the phase event, you emit nothing yourself. A shift = brief invulnerability, a shockwave that pushes the
  player back, a colour shift and your phase sound; the music follows the event on its own. Attack scheduler
  with cooldowns and a global "busy" budget so patterns never stack unfairly. Difficulty already scales your
  health (the manager, at spawn) and your damage (the player, on receipt) — do neither yourself. If cadence
  should vary with difficulty, derive it from the run's difficulty with numbers in your row; telegraph times
  never shrink.
- **Death**: `onKilled` starts the staged death and returns its length (the death seconds of your row). In that
  same instant the manager has cleared enemy projectiles, announced the defeat — the director ends the run
  exactly that many seconds later and the player can no longer be hurt — and begun killing the remaining adds.
  None of that is yours. Yours is the show in `updateDying`: a chain of explosions across the body, slow motion
  through your `bossStaging` time-scale request, a core white-out (screen flash plus the exposure post level,
  put back when done), the falling wreck. Death sounds carry no owner. A silent kill gets no staging at all.
- **Clean exit**: `onDespawn` clears every level you own (time scale, exposure) whatever state the fight was in
  — a reset mid-fight, a silent kill, an error.
- Vitest: phase thresholds held by the filter and transition lockouts, `setBossPhase` called exactly once per
  shift, attack scheduler fairness (no two heavy attacks inside the minimum gap), sweep laser hit-test geometry
  (jump/slide dodge windows exist), strike seeding stays inside the arena, summon caps, `onKilled` returns the
  staged length and deals nothing on a world kill, reset mid-fight is clean.
- Screenshots via the harness: wide shot of the boss over the Spire, each phase's attacks mid-telegraph, the
  death sequence. Look at them and iterate until it reads as a boss. Run a god-mode bot fight on your dev port
  to the kill and confirm nothing throws and victory is reached.

## Contract pointers

- **You implement** one `EnemyKind` — `conductorKind` — with its `EnemyBehavior`; its actor is also the
  `BossHandle` the UI reads (name, phase, phase count, invulnerable). Read closely: the PLUG-IN CONTRACT block
  above `EnemyKind` (step 1: what the manager resets at spawn; step 5: the order of a boss death; WHO WRITES
  WHAT); every member doc of `EnemyBehavior` (`filterDamage` with its phase-clamp example, `onKilled`,
  `updateDying`, `onDespawn`); `EnemySystem.setBossPhase`, `spawn` with `summoned`, `moveFlying`;
  `EnemySpawnOptions.instant`; `WorldSystem.bossArena` (§12); the `'boss:*'` events (§7); END OF RUN and the
  boss watchdog at `DirectorSystem` (§19); `PlayerSystem.takeDamage`, `addImpulse`, `addShake` (§15);
  `RenderSystem.screenFlash` / `lightningFlash` and `PostFxParams.exposure` (§13); `TimeScaleSource` and
  `TimeState.hitstop` (§2, §6); `ProjectileOptions` (homing) in §17; `TelegraphKind`, `BeamKind` and the
  conductor ids in `EnemyKindFxId` / `EnemyKindSoundId` / `EnemyKindLoopId` (§2); keyed `fx.lightFlash` (§21);
  `EnemyDef` (§24) and the conductor's `tuning` keys in `data/enemies.ts`; in the header: PARALLEL-WORK
  CONVENTIONS (the enemies layout), CLOCKS (the corpse timer runs on `playerDt`), FEEDBACK OWNERSHIP RULE,
  LEVELS / IMPULSES / HANDLES, ERROR CONTAINMENT (a boss removed after an error ends the fight through the
  director's watchdog).
- **Feedback you trigger**: every `boss*` fx and `deathConductor`; every `conductor*` sound except
  `conductorSpawn`; the loops `conductorCore` and `conductorSweep`; the `sweep` beam and the `strike` / `shock`
  telegraphs; `fx.lightningBolt` + `render.lightningFlash` for your strikes; `render.screenFlash` and
  `post.exposure` for the white-outs (you are the only writer of exposure); the `bossStaging` time-scale
  request and `time.hitstop` on phase breaks; `player.addShake` / `addImpulse`; blasts through
  `combat.explode`. **Never**: `conductorSpawn` or any bus event (the manager emits spawned, phase and
  defeated); killing adds or clearing projectiles on death (manager); ending the run (director); the
  `bossIntro` sound and banner (director); the boss bar (UI); the music (audio); the sky vortex (render); a
  real light.
- **Data tables you may tune**: `src/data/enemies.ts` — only the `conductor` row (values; you may add keys to
  its `tuning`). Keep the world's arena hover height inside the row's hover band. The projectile defaults of
  the boss bolt and missile are combat's.
- **Files you own**: you create `src/enemies/kinds/conductor.ts` exporting `conductorKind`, helper files under
  `src/enemies/boss/**`, and your tests; you add one import line + one array entry to `ENEMY_KINDS` in
  `src/enemies/kinds/index.ts` — the only registration point (never call `registerKind` yourself). The manager
  `src/enemies/index.ts` remains the first engineer's design: bug repairs only. Leave `kinds/placeholder.ts`
  and the manager's fallback alone.
- **Verify with**: `__SH.setWave(10)` (the director brings the boss after its intro) or
  `__SH.spawn('conductor')` (anchors where spawned); `__SH.state()` → `boss` (hp, phase, invulnerable, dying),
  `timeScale`; `__SH.damageEnemy(id, amount, 'body' | 'weak')` to walk through the thresholds;
  `__SH.ctx.enemies.kill(id)` (a world kill: staged death, no damage) and `kill(id, { silent: true })` (no
  staging — the watchdog must still end the fight); `__SH.freezeAi(on)`, `__SH.god(true)`, `__SH.giveAll()`,
  `__SH.bot(true)`, `__SH.setCamera(…)`. `tools/smoke.mjs` runs the three end-of-run cases around the boss;
  `tools/campaign.mjs --god 1` must end in victory; `tools/shots.mjs` takes the boss portrait and the victory
  screen.
