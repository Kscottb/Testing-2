# Assignment: COMBAT

The shared rules of violence: hit targets, traces, damage routing, projectiles, explosions and the hit-confirm
feedback. Every weapon and every enemy goes through you, so correctness and determinism matter more than
anything. Replace the stub in `src/combat/index.ts`; keep the factory `createCombatSystem(ctx)`. Where this text
and `src/core/types.ts` differ, the contract wins.

- **Targets & traces**: registry of hit targets (retained until their owner unregisters them) with world-space
  spheres per part; ray vs spheres + ray vs world (CollisionWorld) → nearest hit with part, sphere index and
  normal — per target the nearest enabled sphere along the ray wins; piercing trace (all targets in order until
  the world stops it; each target at most once); radius queries; faction filtering; optional ray thickness for
  targets only. A trace applies no damage and plays nothing. No allocation per trace.
- **Damage routing**: `applyDamage` is the one entry point, but you apply **no multiplier of your own**. The
  attacker has already put its factors into `info.amount`; the victim's own `takeDamage` applies weak points,
  armour, shields and difficulty and returns the result you hand back. Unknown and dead targets deal 0. You
  never emit damaged / killed events — the victim's owner does.
- **Hit-confirm feedback is yours**, for player hits on hostile targets only: one hit spark per damaging ray at
  once, picked by the result's part (none for splash, none for silent damage); and, flushed once per target per
  substep from `update`, one merged damage number, one hit sound (kill > crit > shield > armour > plain) and one
  `'hit:confirmed'`. A nine-pellet blast on one enemy is one number, one sound, one event. Hits on the player
  get nothing from you.
- **Projectiles**: pooled up to the contract's cap (the oldest makes room, silently); look, trail, fly loop and
  defaults per kind from `data/projectiles.ts` for everything `ProjectileKind` lists (glowing plasma / light
  bolts as instanced meshes, rocket with exhaust trail, bouncing grenade, arcing mortar, homing missiles with a
  turn rate, boss bolts). Continuous collision per step (segment vs world and hostile targets), bounce with
  restitution and friction, fuses, lifetime caps, direct hit vs splash (the struck target is excluded from its
  own splash), removal outside the world bounds. **Each projectile runs on its own clock**: the player's on
  `ctx.time.playerDt` (full speed during Overclock), all others on scaled dt. Draw it from `visualOrigin`,
  blending onto the simulated path. A mortar's ground telegraph is yours (predicted impact; the shooter draws
  none). Kinds marked `shootable` (the boss missiles) are hit targets and die to any hostile damage with a small
  harmless burst. Trails, fly loops, bounces, whiz-by, the mortar whistle and impacts on the world are yours;
  the launch sound is the shooter's — you play none. A projectile whose step throws is reported and removed;
  never rethrow.
- **Explosions**: `explode` never resolves inside the call. Always queue, then resolve in `update` in FIFO
  order — including blasts enqueued while resolving (tick chains) — up to the contract's cap per update; no
  artificial delay, no recursion. Falloff measured to the target's bounding sphere, knockback falling off the
  same way, line of sight as a hard requirement (nothing behind solid cover is hurt) unless the caller switches
  it off; self-damage multiplier, friendly fire, excluded target and player credit exactly as the options say.
  You own the whole audiovisual package of every blast: the fx recipe for its `visual` sized to the damage
  radius, the scorch decal, the sound (distant variant far away), a pooled light flash, distance-scaled camera
  shake through the player, rumble, and when it is close chromatic boost, screen flash and hit-stop. (Recipe,
  decal and light are three fx calls of yours — an fx recipe never contains a decal or a light.)
- **Order inside `update`** is fixed: projectiles → explosion queue → hit-feedback flush.
- **Reset** removes every projectile, queued blast and pending feedback silently. Registrations are **kept**:
  owners unregister their own targets.
- Vitest (no WebGL): ray/sphere maths, nearest-hit and nearest-sphere ordering, piercing order and uniqueness,
  `applyDamage` routing (no multipliers, dead targets), the per-target feedback merge, falloff + LOS in
  explosions, the explosion queue (FIFO, chain inside one update, the cap), projectile CCD (no tunnelling
  through a 0.2 m wall at 60 m/s with dt 1/30), player-clock vs world-clock projectiles under a time scale,
  bounce energy loss, homing convergence, shoot-down, pool exhaustion, reset.

## Contract pointers

- **You implement** `CombatSystem` (types.ts §17) with `HitTarget`, `HitSphere`, `TraceOptions`, `ShotHit`,
  `PierceResult`, `ExplosionOptions`, `ProjectileOptions`. Read closely: the doc block above `CombatSystem`
  (update order, projectile ownership, reset) and every method doc; `DamageInfo` / `DamageResult` (§14);
  `'hit:confirmed'` in `EventMap` (§7); `ProjectileDef` (§24); the `CombatFxId`, `CombatSoundId`,
  `CombatLoopId`, `SharedFxId` and `SharedSoundId` comments (§2); in the header: FRAME PIPELINE (you also run
  in gameover / victory), CLOCKS, FEEDBACK OWNERSHIP RULE, LEVELS / IMPULSES / HANDLES (which of your sounds
  carry `owner: <projectile id>`; `cancelOwner` + `stopOwner` on every removal), ERROR CONTAINMENT, RENDERING
  CONVENTIONS (one root named `combat`, no shadows, `RENDER_ORDER`, warm one mesh per kind in `init()`).
- **Feedback you trigger**: every `CombatFxId`, `CombatSoundId` and `CombatLoopId`; shared impact fx + sounds +
  decals for projectile impacts on the world; `fx.damageNumber`; projectile trails; the `mortar` landing
  telegraph; for blasts `fx.lightFlash`, `player.addShakeAt`, `input.rumble`, `time.hitstop`, and near the
  player `render.screenFlash` + `post.chromaticBoost`. **Never**: a launch or muzzle sound / fx (weapons, enemy
  kinds); world impacts of the player's hitscan, rail and melee (weapons); anything about a hit on the player
  (player); hurt and death fx / sounds of enemies (their kinds); `'enemy:*'` events; `render.lightningFlash`.
- **Data tables you may tune**: `src/data/projectiles.ts` (values only).
- **Files you own**: `src/combat/**`.
- **Verify with**: `__SH.spawn(type)` + `__SH.freezeAi(true)`, `__SH.damageEnemy(id, amount, part)`,
  `__SH.ctx.combat.explode({…})` / `.spawnProjectile({…})` / `.traceShot(…)`, `__SH.state()` → `projectiles`,
  `stats.damageDealt`; `__SH.overclock()` to compare the two projectile clocks; `__SH.budget().combat`.
  `tools/smoke.mjs` checks the flushed hit feedback and the end-of-run cases around the boss;
  `tools/campaign.mjs --god 1` is the soak for NaN and contained errors.
