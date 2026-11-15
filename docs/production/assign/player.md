# Assignment: PLAYER  (you own `src/player/**`)

The first-person character: movement, look, camera feel, vitals, dash, Overclock. This is the thing the player
touches every millisecond — it must feel exact. Replace the stub in `src/player/index.ts`; keep the signature.

- **Movement** on the real CollisionWorld move-and-slide: acceleration/friction model (snappy ground accel,
  generous air control), sprint (forward-ish only, cancels on ADS/fire per taste), crouch with hitbox shrink and
  a headroom check before standing, **slide** (sprint + crouch: speed burst that decays, limited steering,
  slide-jump preserves momentum), jump with coyote time + input buffer, extra jumps from modifiers, **dash**
  (direction = move input or forward; charges/cooldown from modifiers; brief invulnerability), `launch()` for
  jump pads and knockback, numbers from the brief. Never tunnel, never stick, never NaN; clamp absurd velocity.
- **Look**: raw mouse deltas → radians with the sensitivity setting, invert-Y, pitch clamp; arrow-key and
  gamepad look as smooth rates with a response curve; free-look fallback modes behave sensibly. Mild aim assist
  (rotation slowdown over targets + slight pull) only for gamepad/touch when the setting allows.
- **Camera feel** (all subtle, all scaled by settings where relevant): smoothed eye height through steps and
  crouch, landing dip, speed-scaled head bob (off in ADS), strafe roll, slide tilt, FOV from settings with
  sprint/dash/Overclock kicks and the ADS zoom from weapons, recoil kick with spring recovery, trauma-based
  noise shake (screen-shake setting), directional hit punch. The aim ray always matches the rendered view.
- **Vitals**: shield absorbs first, delayed shield regeneration (modifiers apply), health, last-stand perk,
  invulnerability windows, damage → post-FX flash, direction event for the HUD, hurt sounds; low-health state
  drives the post param and heartbeat loop; death → documented event/sequence (short slow-motion, camera slump).
- **Overclock**: charge from the documented sources, ready event, activation → world time scale 0.4 through the
  layered time-scale API for 6 s while the player runs on unscaled time, post treatment, loop + start/end
  sounds, FX; ends cleanly on death, pause, reset.
- **Feedback you own**: footsteps by distance travelled, jump/land (scaled by impact), slide loop, dash whoosh +
  trail FX, hurt/shield break/recharge.
- Player logic runs on the unscaled-but-pausable clock defined by the contract; verify nothing moves while the
  world is frozen for perk select or paused.
- Vitest against the real CollisionWorld: walk into a wall and slide, climb stair-steps smoothly, jump apex
  ≈ 1.25 m, dash distance, crouch under a 1.3 m beam and refuse to stand, slide decay, launch arcs, no NaN after
  10⁴ random input steps, reset restores everything.
