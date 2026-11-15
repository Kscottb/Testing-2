# Assignment: ENEMIES — three elite kinds  (you own `src/enemies/**` for this stage)

The framework and three kinds (skitter, tick, riveter) were just written by another engineer. Read all of
`src/enemies/` first. Add three kinds as new files under `src/enemies/kinds/` and register them; fix any
framework bug you hit (you own the directory now) but keep its structure.

- **wasp** — flying harasser. Holds an altitude band (4–9 m), circle-strafes, then commits to diving strafing
  runs firing a stream of light bolts along its path; banks into turns; avoids obstacles with a few raycasts;
  wing/rotor flicker; on death it spins down trailing smoke and explodes on ground contact (small, cosmetic).
- **lancer** — tripod sniper. Finds firing positions 25–45 m out with line of sight (nav random point + LOS),
  walks there with a three-leg gait, plants, then charges: a **persistent thin tracking laser** (FX beam handle)
  follows the player with slight lag for ≈ 1.3 s, locks (stops tracking, turns white, rising whine) for 0.3 s,
  then fires a hitscan beam that only hurts if the player is still on the locked line and not behind cover.
  Relocates after 1–2 shots or when rushed. Weak point: the glowing lens. Magenta elite accent.
- **bulwark** — heavy assault frame, ≈ 2.4 m wide, slow with a slow turn rate so the player can flank. Frontal
  energy shield: shield-part hit volumes cover its front arc and absorb damage into a 250-point shield that
  regenerates after 5 s without hits; breaking it staggers the bulwark for ≈ 2.5 s (big FX + sound). Ranged:
  volleys of three lobbed mortars with ground telegraphs at predicted impact points. Close: a 0.6 s telegraphed
  stomp shock ring (jump to avoid). Rear reactor vents are a ×2.5 weak point. Enrages below 30 % health.
  Magenta elite accent, heavy servo audio, weighty walk with camera-shake footfalls nearby.
- Same rules as the framework: telegraphs for everything, attack tokens, damage only through the documented
  pipeline, ≤ 8 draw calls per regular enemy (bulwark may use up to 12), all audio/FX ids from the contract.
- Vitest: lancer lock/fire timing and cover check, bulwark shield arc + regen + break stagger, mortar lead
  prediction, wasp altitude control and obstacle avoidance decisions, reset.
- Screenshots via the harness of each new kind (front, three-quarter, mid-telegraph). Look at them and iterate.
  Then review the three earlier kinds with fresh eyes and fix anything broken or ugly you notice.
