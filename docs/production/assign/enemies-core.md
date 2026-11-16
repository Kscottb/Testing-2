# Assignment: ENEMIES — manager + first three kinds

Build the enemy manager and the three rank-and-file machines. Two more engineers follow you in the same
directory, one after the other (three more kinds, then the boss). The plug-in contract between manager and
kinds is fixed by `src/core/types.ts`: implement it to the letter — including everything the boss will need —
because the people after you build against the contract, not against your habits. Replace the stub in
`src/enemies/index.ts`; keep the factory `createEnemySystem(ctx)`. Where this text and the contract differ, the
contract wins.

- **Manager**: pooled actors per kind and the whole life cycle of the plug-in contract. Spawn; the
  **lightning-strike arrival** (ground ring ≈ 0.8 s → bolt from the sky → the machine appears with a flash;
  hidden, harmless and untargetable until then; for an air spawn the ring sits on the floor under the hover
  point; the boss always spawns instantly); hit-target registration with combat; hp arithmetic (weak / armour /
  shield multipliers, the kind's damage filter, knockback by mass, stun); death, corpse time, despawn; and the
  events with everything score and pickups need. Services for the kinds: the two integrators (`moveGround` on
  the nav grid, `moveFlying`), separation via a spatial hash, cached line of sight, **attack tokens** (budget
  from difficulty, per-kind cost, fair rotation, automatic release), `canAttack`, flow-field refresh toward the
  player. Culling instead of "recovery": an actor outside the world bounds or below the kill height dies as a
  world kill, one with a non-finite position is removed silently — you never move an actor yourself. Boss
  services: the boss handle, `setBossPhase`, and the boss-death order (clear enemy projectiles, the defeat
  event, staggered clean-up kills). Every behaviour call is wrapped: a kind that throws is reported and that
  one actor removed, never the frame. When enemies must stand down (player dead, AI frozen, run over) you
  cancel their effects and tokens and call `animate` instead of `update`. Clean `reset` / `kill` / `killAll`.
- **Registration**: `init()` registers every entry of `ENEMY_KINDS` and the placeholder for each type that is
  still missing, so all ten waves — boss included — stay playable at every stage of the three hand-overs.
- **Shared helpers for kinds** (plain modules; a kind reaches the manager only through its actor, the
  behaviour interface and the `EnemySystem` services): flow following with steering smoothing, facing with
  turn-rate limits (flow directions can turn sharply at corners), hover bob, hit flash on the emissive accent,
  lead-target maths (aim at the player's centre, not the eye), a tiny state machine, a stream-effect ticker.
  Knockback, stun and floor-height following live in the manager's integrators — kinds never apply them.
  Everything on scaled world dt; corpse timers on `ctx.time.playerDt`.
- **Kinds** (procedural meshes ≤ 8 draw calls each, dark gunmetal + the emissive accent of their table row,
  each silhouette unmistakable at 30 m, each with idle / telegraph / attack / hurt / death audio; the spawn
  sound belongs to the manager's arrival):
  - **skitter** — low wedge body on four scythe legs with a procedural gait; packs approach from different
    angles to surround; crouch telegraph ≈ 0.35 s then a ballistic leap; bite on contact; recoil after a miss.
  - **tick** — armoured rolling sphere with spikes; rolls by distance travelled; core pulse and beeps accelerate
    with proximity. Near the player it arms and detonates through `combat.explode` (hurts other enemies →
    chains): explode first, then remove itself with `ctx.enemies.kill`. Shot dead it explodes too — at once,
    from `onKilled`, handing the player's credit on so a chain he started scores (no delayed blast from a
    corpse: a dying actor is harmless by contract). A world kill (hazard, cull, clean-up) plays the death but
    deals no damage. The blast's look, sound and chain resolution are combat's.
  - **riveter** — hovering triangular gun platform with twin barrels and a single large eye (weak point); bobs
    on a thruster glow at its table hover height, but it is **not a flyer**: it paths on the nav grid through
    `moveGround`. Holds a range band, strafes with direction changes, retreats if rushed; takes an attack
    token, then fires 3-round plasma bursts (combat projectiles; muzzle sound and flash are yours) after an
    eye-flare + chirp telegraph, leading the target with distance-scaled error.
- Fairness: no attack without a telegraph, no damage through walls, no instant hits from off-screen without an
  audio cue. All damage to the player goes through `combat.applyDamage` on the player's target id, unscaled:
  difficulty is applied by the player (damage), by the manager at spawn (health, speed) and through the token
  budget — a kind never reads a difficulty multiplier.
- Vitest (fake context where needed): the life cycle (arrival → alive → dying → despawn, each event once), hp
  arithmetic and the damage filter, token budget fairness and automatic release, error containment, culling,
  the boss-death order with a fake boss kind, state-machine transitions for each kind, leap ballistics, tick
  credit and the world-kill rule, separation maths, pool reuse and reset.
- Screenshots via the harness: each kind standing in front of a free camera (front, three-quarter, in a pack),
  mid-telegraph and mid-attack. Look at them; iterate on silhouette, proportions and glow until they look
  designed. The screenshot tool photographs kinds with the AI frozen, so `onSpawn` + `animate` alone must give
  a complete pose. Also run a short bot fight on your dev port to confirm nothing throws.

## Contract pointers

- **You implement** `EnemySystem` (types.ts §18) — the manager — and `EnemyKind` / `EnemyBehavior` for skitter,
  tick and riveter against `EnemyActor`. Read closely: the PLUG-IN CONTRACT block above `EnemyKind` (LIFE OF
  ONE ENEMY steps 1–6, WHO WRITES WHAT) and every member doc of `EnemyBehavior` and `EnemySystem`;
  `EnemySpawnOptions`, `EnemyHandle`, `BossHandle`, `EnemyKillOptions`; the `'enemy:*'` and `'boss:*'` events
  with their reward fields (§7); `HitTarget`, `applyDamage`, `ExplosionOptions`, `ProjectileOptions` (§17);
  `DamageInfo` / `DamageResult` (§14); the flow and height queries of `NavGrid` (§11); `PlayerSystem.center` /
  `targetId` (§15); `EnemyDef` (§24); the enemy fields of `Modifiers` (§20); `DebugFlags.freezeAi` (§4); the
  owner comments of `EnemyManagerFxId` / `EnemyManagerSoundId` and `EnemyKindFxId` / `EnemyKindSoundId` /
  `EnemyKindLoopId` (§2 — which sounds carry `owner` and which must not); in the header: PARALLEL-WORK
  CONVENTIONS (the enemies layout), FRAME PIPELINE (you also update in gameover / victory), CLOCKS, FEEDBACK
  OWNERSHIP RULE (the enemies line), LEVELS / IMPULSES / HANDLES, ERROR CONTAINMENT, RENDERING CONVENTIONS (one
  root named `enemies`, enemies cast shadows, warm one actor per kind).
- **Feedback you trigger** — as the manager: the arrival (`spawn` telegraph, `fx.lightningBolt`, `spawnFlash`,
  `spawnTelegraph`, `spawnStrike`, `<type>Spawn` for all seven types, a weak rate-limited
  `render.lightningFlash`) and the `'enemy:*'` / `'boss:*'` events. In your kinds: the `EnemyKind*` ids named
  after that kind plus the `enemySmoke` / `enemySparks` streams, their telegraphs and loops with
  `owner: actor.id`. **Never**: hit sparks, damage numbers or hit-confirm sounds on enemies (combat); explosion
  fx / sounds, projectile trails, fly loops and landing telegraphs (combat); the feedback of a hit on the
  player (player); `render.screenFlash`; score, pickups, banners (director); and from inside a kind: any bus
  event, a `<type>Spawn` sound, another kind's ids.
- **Data tables you may tune**: `src/data/enemies.ts` — only the rows `skitter`, `tick`, `riveter` (values; you
  may add keys to their `tuning`).
- **Files you own**: `src/enemies/index.ts` (the manager: yours — the two engineers after you may repair a bug
  in it, never restructure it); `src/enemies/kinds/skitter.ts`, `kinds/tick.ts`, `kinds/riveter.ts`, each
  exporting `skitterKind` / `tickKind` / `riveterKind`; `src/enemies/kinds/index.ts`, whose `ENEMY_KINDS` array
  is the only place a kind is registered (one import line + one array entry per kind — you add your three);
  `src/enemies/kinds/placeholder.ts` (keep `placeholderKind(type)` working); your helper modules and tests
  elsewhere under `src/enemies/`, except `src/enemies/boss/`, which is reserved for the conductor's helpers.
- **Verify with**: `__SH.spawn(type, x, y, z)` (instant) and `__SH.spawnArriving(type, x, y, z)` (full
  arrival); `__SH.freezeAi(on)`; `__SH.enemies()`; `__SH.damageEnemy(id, amount, part)`; `__SH.killAll()` and
  `__SH.ctx.enemies.kill(id, { silent })`; `__SH.state()` → `enemiesAlive` / `enemiesSpawning` /
  `enemiesDying`, `tokensInUse`, `boss`; `__SH.setCamera(…)`; `__SH.god(true)` + `__SH.bot(true)` for a fight;
  `__SH.setWave(10)` to exercise your boss services with the placeholder boss; `__SH.budget().enemies`.
  `tools/smoke.mjs` checks the arrival, direct damage and the end-of-run cases around the boss;
  `tools/shots.mjs` lines every type up; `tools/campaign.mjs` is the soak.
