# Assignment: BOSS — THE CONDUCTOR  (you own `src/enemies/**` for this stage)

The framework and six kinds exist. Read all of `src/enemies/` first, then add the boss as
`src/enemies/kinds/conductor.ts` (+ helper files under `src/enemies/boss/` if needed) and register it. This is
the climax of the game: make it a set piece.

- **Form**: a colossal floating storm-core machine (≈ 9 m across): a rotating armoured ring of segmented plates
  around a blinding core, three **capacitor nodes** orbiting it (weak points, crit damage), dangling conductor
  spines crackling with white-violet lightning, magenta accents. ≤ 40 draw calls. Hovers 8–14 m up, drifting
  around the Core Spire inside the arena; always trackable, never out of reach of every weapon.
- **Intro**: the director spawns it when the player enters the arena. Descend from the storm with lightning
  strikes, a roar, camera shake and the documented boss-spawned event (UI shows the bar and name). Invulnerable
  until the intro ends.
- **Phase 1 (100–66 %)**: aimed bolt volleys in readable patterns; a slow rotating **sweep laser** at ground
  level (persistent FX beam handle; jump over or slide under; never undodgeable — rotation speed bounded);
  summons skitter packs through the normal arrival effect.
- **Phase 2 (66–33 %)**: adds telegraphed **lightning strikes** (ground circles that fill, then a bolt) seeded
  around and ahead of the player, and **homing missile salvos** (slow turn rate; shoot-downable if the contract
  supports it); summons wasps.
- **Phase 3 (< 33 %)**: enraged — faster cadence, sweep laser + strikes overlap, **expanding shock rings** along
  the ground (jump), summons ticks. Never more than the player can read: stagger attacks, keep telegraphs ≥ 0.6 s.
- **Transitions**: brief invulnerability, shockwave that pushes the player back, colour/audio shift, the
  documented phase event. Attack scheduler with cooldowns and a global "busy" budget so patterns never stack
  unfairly; difficulty scales cadence and health, not telegraph time.
- **Death**: 3 s staged chain of explosions across the body, slow motion through the layered time scale, core
  white-out through the post flash param, falling wreck, then the boss-defeated event (the director ends the run).
  Kill all remaining adds.
- Vitest: phase thresholds and transition lockouts, attack scheduler fairness (no two heavy attacks inside the
  minimum gap), sweep laser hit test geometry (jump/slide dodge windows exist), strike seeding stays inside the
  arena, summon caps, death sequence emits each event exactly once, reset mid-fight is clean.
- Screenshots via the harness: wide shot of the boss over the Spire, each phase's attacks mid-telegraph, the
  death sequence. Look at them and iterate until it reads as a boss. Run a god-mode bot fight on your dev port
  to the kill and confirm nothing throws and victory is reached.
