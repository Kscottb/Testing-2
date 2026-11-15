# Assignment: COMBAT  (you own `src/combat/**`)

The shared rules of violence: hit volumes, traces, the damage pipeline, projectiles, explosions. Every weapon
and every enemy goes through you, so correctness and determinism matter more than anything. Replace the stub in
`src/combat/index.ts`; keep the factory signature.

- **Targets & traces**: registry of hit targets with world-space spheres per part; ray vs spheres + ray vs world
  (CollisionWorld) → nearest hit with part and normal; piercing trace (all targets in order until the world
  stops it; each target at most once); radius queries; faction filtering. No allocation per trace.
- **Damage pipeline**: one place where multipliers are applied in the documented order (part/crit multiplier,
  player damage modifiers, difficulty scaling, shields), producing the DamageResult and exactly one set of
  events per hit (damaged / killed / hit-confirm) — never double-emit, never damage dead targets, never apply a
  kill twice in one frame (shotgun pellets, piercing, explosions overlapping).
- **Projectiles**: pooled; per-kind tuning and visuals (glowing plasma/light bolts as instanced meshes, rocket
  with exhaust trail, bouncing grenade, arcing mortar shell with a ground telegraph at the predicted impact,
  homing missiles with a turn rate, boss orbs — whatever ProjectileKind lists). Continuous collision per step
  (segment trace vs world and opposing targets and the player), bounce with restitution/friction and bounce
  sounds, fuses, lifetime caps, direct-hit vs splash, optional shoot-down of enemy missiles by player fire if
  the contract supports projectile hit targets. World-time scaled.
- **Explosions**: radial falloff, line-of-sight attenuation behind solid cover, self-damage multiplier, enemy
  explosions hurting other enemies (tick chain reactions resolve over several frames — queue them with a short
  delay — never recursion in one frame), knockback on player and enemies, and you own the explosion's FX, audio
  and distance-scaled camera shake.
- Reset returns every pool and clears the registry of dead entries; nothing leaks between runs.
- Vitest (no WebGL): ray/sphere maths, nearest-hit ordering, piercing order and uniqueness, damage ordering and
  single-kill guarantee, falloff + LOS in explosions, chain-reaction queue, projectile CCD (no tunnelling through
  a 0.2 m wall at 60 m/s with dt 1/30), bounce energy loss, homing convergence, pool exhaustion, reset.
