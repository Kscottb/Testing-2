# Assignment: FX  (you own `src/fx/**`)

Every transient visual in world space: particles, tracers, beams, decals, explosions, debris, lightning bolts,
telegraphs, trails, damage numbers, weather, and the fixed pool of dynamic lights. Other systems call you
constantly; you must be fast, allocation-free in steady state, and never throw on bad input.
Replace the stub in `src/fx/index.ts`; keep the factory signature.

- **Particle core**: pooled, CPU-simulated, drawn as instanced camera-facing quads (velocity-stretched option for
  sparks/streaks) with a procedural sprite atlas (soft glow, hard spark, smoke puff, ring, shard, flare, digit
  glyphs). Per-particle colour-over-life, size-over-life, drag, gravity, rotation, ground bounce for debris.
  ≤ 4000 live particles, ≤ 25 draw calls for all FX, graceful degradation when the pool is full (drop the
  oldest low-priority particles), scale counts by quality preset.
- **Effect library**: an exhaustive `Record<FxId, …>` (the compiler must force every id to exist). Each effect
  is a layered recipe: e.g. a large explosion = white core flash + orange fireball puffs + fast sparks + slow
  smoke + ground shock ring + debris shards + scorch decal + pooled light flash. Impacts differ per surface.
  Enemy deaths differ per enemy type and scale with the enemy's size. Plasma is magenta/orange, player tech
  cyan, lightning white-violet (brief colour script). HDR colours so bloom reacts.
- **Tracers & beams**: tracers are instant stretched streaks. Beams support both one-shot (rail shot: thick core
  + spiral + fade) and **persistent handles** updated every frame (sniper tracking laser, boss sweep laser).
- **Lightning bolts**: procedurally jagged, branching, flickering for a few frames; used for enemy arrival
  strikes, chain-lightning rounds and the boss.
- **Telegraphs**: ground rings/discs that fill over their duration (spawn arrival, mortar impact, boss strikes,
  stomp radius); must sit on the ground without z-fighting on any terrace height.
- **Decals**: pooled, surface-aligned quads with polygon offset (bullet holes, scorch marks), fade out; cap ~150.
- **Trails**: attachable to moving projectiles (rocket smoke, grenade wisp, plasma glow); detach lets the trail
  finish gracefully.
- **Damage numbers**: pooled in-world billboards from a digit atlas; rise, pop and fade; crits larger and
  hazard-yellow; readable against any background (outline/shadow).
- **Weather**: drifting ember/dust motes near the camera, cloud wisps crossing the deck, streaking "static rain"
  during the storm; follows time-of-day (the documented exception to the feedback rule).
- **Light pool**: exactly 6 point lights created once at init and never added/removed; requests pick the least
  important slot; intensity decays over the requested duration.
- Everything must respect scaled world time (slow-motion slows effects), `clear()`/`reset()` must return all
  pools, and the reduce-flashes setting must tame full-screen-ish flashes.
- Verify with harness screenshots: fire every effect family in front of a free camera mid-life (step the sim a
  few frames), look at them, iterate until they read as punchy and deliberate — not confetti. Add a vitest for
  pool exhaustion / reset / NaN safety of the simulation core (no WebGL needed for that part).
