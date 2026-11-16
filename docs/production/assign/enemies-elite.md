# Assignment: ENEMIES — three elite kinds

The manager and three kinds (skitter, tick, riveter) were just written by another engineer. Read all of
`src/enemies/` and the plug-in contract in `src/core/types.ts` first. Add wasp, lancer and bulwark as three new
kind files and register them. If you hit a manager bug, repair it — keep its structure and the contract's
behaviour. Where this text and the contract differ, the contract wins.

- **wasp** — flying harasser, the only regular flyer. It moves through the manager's `moveFlying`, which
  already steers around geometry and keeps it inside the map and above the floor; add look-ahead of your own
  only where a strafing run needs it. Holds its table altitude band, circle-strafes, then commits to diving
  strafing runs firing a stream of light bolts (combat projectiles) along its path; banks into turns;
  wing/rotor flicker. Its death is staged: it spins down trailing smoke and bursts on ground contact —
  cosmetic only (your death effect; no blast, no damage).
- **lancer** — tripod sniper. Finds firing positions inside its range band with line of sight (nav random point
  + LOS), walks there with a three-leg gait, plants, takes an attack token, then charges: a **persistent thin
  tracking laser** (a lock-laser beam handle owned by the actor) follows the player with slight lag, then locks
  (stops tracking, changes colour, rising whine) and fires a hitscan beam that only hurts if the player is
  still on the locked line and not behind cover. Telegraph and lock times come from its row (1.6 s in all, the
  last 0.3 s locked). The beam shot, its mark on the world and its sounds are yours; the damage goes through
  combat. Relocates after its shots per perch or when rushed. Weak point: the glowing lens.
- **bulwark** — heavy assault frame (size from its row), slow with a slow turn rate so the player can flank.
  Frontal energy shield: hits inside its front arc are soaked by a shield pool that regenerates after a delay
  (pool, delay, rate and arc in its row). Use shield hit spheres or an arc remap in your damage filter — either
  way report the hit as a shield hit, so combat plays the right spark and sound. Breaking the shield staggers
  the bulwark for ≈ 2.5 s (big fx + sound); that stagger is your own state, because the manager's stun never
  touches anything this heavy. Ranged: volleys of lobbed mortars — combat projectiles with a landing telegraph:
  combat draws the ground marker at the predicted impact and plays the whistle, you add neither. Close: a
  telegraphed stomp shock ring (jump to avoid) whose ring marker you drive so that it is the damage front.
  Rear reactor vents are the weak point (multiplier in its row). Enrages below 30 % health. Heavy servo audio,
  weighty walk with camera-shake footfalls nearby (through the player's shake API).
- **Accent**: read it from the table row. The baseline rows of lancer and bulwark still carry the regular
  enemy orange, while the colour script reserves magenta for elites — decide it in your rows, never in code.
- Same rules as the framework: a telegraph for every attack, an attack token around every ranged attack,
  damage only through combat and unscaled (difficulty is applied elsewhere), **≤ 8 draw calls for every kind,
  the bulwark included**, launch and muzzle sounds are yours (combat plays none), positional sounds and loops
  carry the actor as owner — except death sounds, which must outlive it. New numbers (mortars per volley,
  wind-ups, stagger, enrage threshold) go into your rows' `tuning`, not into code.
- Vitest: lancer lock/fire timing and cover check, bulwark shield arc + regen + break stagger and the damage
  filter's result, mortar lead prediction, wasp altitude control and its staged death, token use, reset.
- Screenshots via the harness of each new kind (front, three-quarter, mid-telegraph). Look at them and iterate;
  the screenshot tool freezes the AI, so `onSpawn` + `animate` alone must give a complete pose. Then review the
  three earlier kinds with fresh eyes and fix anything broken or ugly in their code (their table rows are not
  yours: report tuning problems instead of editing them).

## Contract pointers

- **You implement** three `EnemyKind` objects with their `EnemyBehavior`, against `EnemyActor` and the
  services of `EnemySystem` (types.ts §18). Read closely: the PLUG-IN CONTRACT block above `EnemyKind` (LIFE OF
  ONE ENEMY, WHO WRITES WHAT); every member doc of `EnemyBehavior` — `filterDamage` for the shield, `onKilled`
  (WORLD KILLS, NO OWNER) and `updateDying` for the wasp; `moveFlying`, `moveGround`, the token calls,
  `hasLineOfSight`, `canAttack`; `HitSphere` and `ProjectileOptions` (gravity, `landingTelegraph`) in §17;
  `HitPart`, `BeamKind`, `TelegraphKind` and the owner comment at `EnemyKindSoundId` (§2); the beam and
  telegraph handles (§21); `EnemyDef` (§24); `NavGrid.randomPointInAnnulus` / `heightAt` (§11);
  `CollisionWorld.lineOfSight` (§10); `PlayerSystem.center` / `addShakeAt` (§15); in the header: PARALLEL-WORK
  CONVENTIONS (the enemies layout), CLOCKS, FEEDBACK OWNERSHIP RULE (enemies against combat), LEVELS /
  IMPULSES / HANDLES, RENDERING CONVENTIONS (shield mesh render order, enemies cast shadows, glow by emissive —
  no lights).
- **Feedback you trigger**: the `EnemyKind*` ids named after your kinds — fx `deathWasp`, `waspMuzzle`,
  `deathLancer`, `lancerCharge`, `lancerMuzzle`, `lancerRelocate`, `deathBulwark`, `bulwarkMortarMuzzle`,
  `bulwarkStomp`, `bulwarkShieldBreak`, `bulwarkShieldRestore` and the `enemySmoke` / `enemySparks` streams;
  the `wasp*`, `lancer*`, `bulwark*` sounds; the loops `waspBuzz`, `lancerLaser`, `bulwarkServo`,
  `bulwarkShieldHum`; the lancer's `lockLaser` and `laser` beams with shared impact ids where the shot meets
  the world; the stomp telegraph; footfall shake. **Never**: `<type>Spawn` sounds or arrival effects (manager);
  the mortar's ground marker, whistle, trail and blast (combat); hit sparks, damage numbers or hit sounds on
  your own actor (combat — you only add the hurt flash and hurt sound); any bus event; `render.screenFlash` /
  `lightningFlash`; a write to `actor.stun`; ids of other kinds.
- **Data tables you may tune**: `src/data/enemies.ts` — only the rows `wasp`, `lancer`, `bulwark` (values; you
  may add keys to their `tuning`).
- **Files you own**: you create `src/enemies/kinds/wasp.ts`, `kinds/lancer.ts` and `kinds/bulwark.ts`,
  exporting `waspKind`, `lancerKind`, `bulwarkKind`, and add one import line + one array entry each to
  `ENEMY_KINDS` in `src/enemies/kinds/index.ts` — the only registration point (never call `registerKind`
  yourself). Tests and helper modules for your kinds go under `src/enemies/` (not `boss/`). The manager
  `src/enemies/index.ts` remains the first engineer's design: bug repairs only. Leave
  `kinds/placeholder.ts` in place — the boss still needs it.
- **Verify with**: `__SH.spawn(type, x, y, z)` and `__SH.spawnArriving(…)`; `__SH.freezeAi(on)`;
  `__SH.damageEnemy(id, amount, 'body' | 'weak' | 'shield')`; `__SH.enemies()`; `__SH.state()` → `tokensInUse`,
  `enemiesDying`; `__SH.setCamera(…)`; `__SH.setWave(4 | 5 | 6)` for the waves that introduce your kinds;
  `__SH.god(true)` + `__SH.bot(true)` for a fight; `__SH.budget().enemies`. `tools/shots.mjs` lines every type
  up; `tools/campaign.mjs` is the soak.
