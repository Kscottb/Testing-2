# Assignment: PLAYER

The first-person character: movement, look, camera feel, vitals, dash, Overclock. This is the thing the player
touches every millisecond — it must feel exact. Replace the stub in `src/player/index.ts`; keep the factory
`createPlayerSystem(ctx)`. Where this text and `src/core/types.ts` differ, the contract wins.

- **Movement** on the real CollisionWorld move-and-slide: acceleration/friction model (snappy ground accel,
  generous air control), sprint (needs forward input on the ground; you suppress it yourself while fire or ADS
  is held — weapons never cancel it), crouch with hitbox shrink and a headroom check before standing, **slide**
  (sprint + crouch: speed burst that decays, limited steering, slide-jump preserves momentum), jump with coyote
  time + input buffer, extra jumps from modifiers, **dash** (direction = move input or forward; charges and
  cooldown from modifiers; brief invulnerability). Two different pushes: `launch()` is for jump pads only — it
  replaces the velocity and must fly the exact arc the world solved, so the contract limits what air control
  may do to it; `addImpulse()` is for knockback, shock waves and the melee lunge. Numbers come from `PLAYER` in
  `core/constants.ts`, modifiers are read live from `ctx.mods`. Never tunnel, never stick, never NaN; clamp
  absurd velocity.
- **Look**: call `ctx.input.consumeLook` exactly once per update. It already returns radians with sensitivity,
  invert-Y and every device merged (mouse, free look, arrow keys, stick, touch, bot) — do not read devices or
  apply sensitivity yourself. You add the pitch clamp, the ADS scaling weapons hand you, and — only while
  `ctx.input.aimAssist` is true — mild look friction over targets (bullet magnetism is the weapons' half).
- **Camera feel** (all subtle, all scaled by settings where relevant): smoothed eye height through steps and
  crouch, landing dip, speed-scaled head bob (off in ADS), strafe roll, slide tilt, FOV from settings with
  sprint/dash/Overclock kicks and the ADS zoom from weapons, recoil kick with spring recovery, trauma-based
  noise shake (screen-shake setting), directional hit punch. You own `ctx.camera` while playing and paused:
  write it in `update` and again in `lateUpdate`, so recoil, shake and step smoothing added later in the
  substep are never a frame late. The aim ray carries recoil but not shake and always matches the rendered view.
- **Vitals**: you are a hit target registered with combat, and every point of damage arrives through
  `takeDamage`. Shield absorbs first, delayed shield regeneration (modifiers apply), health, last-stand perk,
  invulnerability windows (dash, last-stand grace, god mode — and everything once the boss is defeated, until
  the next reset). Difficulty scales enemy damage here and only here. You own all feedback of being hit: fx at
  the hit point, hurt and shield sounds, the damage / shield flash post impulses, shake, rumble and the
  direction event for the HUD; the low-health state drives its post level, the audio muffle and the heartbeat
  loop. On death you emit the event and may slump the camera — the slow motion, the desaturation and the
  timing of game over are the director's.
- **Overclock**: charge from kills and from damage dealt to the boss (formula in the contract), ready event,
  activation → world time scale 0.4 through your own `overclock` time-scale request for 6 s (plus perk bonus)
  while you keep running on unscaled time; post treatment, loop, start / end / denied sounds, fx. It **survives
  a pause** (audio suspends the loop; you stop nothing) and ends cleanly on death, on reset and when the run is
  left (`onModeChange` to anything but playing / paused) — writing every level you own back to its default
  exactly once.
- **Feedback you own**: footsteps by distance travelled and ground surface, jump / double jump / land (scaled
  by impact), slide loop + sparks, dash whoosh + burst + blur, hurt / shield break / recharge, heal and
  life-steal pulses, last stand.
- Player logic runs on `unscaledDt`, the unscaled-but-pausable clock; verify nothing moves while the world is
  frozen for perk select or paused.
- Vitest against the real CollisionWorld: walk into a wall and slide, climb stair-steps smoothly, jump apex
  ≈ 1.25 m, dash distance, crouch under a 1.3 m beam and refuse to stand, slide decay, a launch arc that lands
  where it was aimed, shield-then-health damage order and last stand, no NaN after 10⁴ random input steps,
  reset restores everything.

## Contract pointers

- **You implement** `PlayerSystem` (types.ts §15) with `DashState` and `OverclockState`, and you register
  yourself as a `HitTarget` (§17). Read closely: the doc block above `PlayerSystem` (what `update`,
  `lateUpdate` and `onModeChange` MUST do, the events you listen to, the Overclock formula, the sprint rule,
  the modifiers you apply, reset) and the docs of `takeDamage`, `launch`, `addImpulse`, `setAds`, `addShake`;
  `Input.consumeLook` / `aimAssist` / `rumble` (§8); `TimeState` (§6); the writers named in `PostFxParams`
  (§13); the `'player:*'` and `'overclock:*'` events, especially the direction fields of `'player:damaged'`
  (§7); the player fields of `Modifiers` (§20); `ctx.camera` and `DebugFlags.god` (§4); `moveAndSlide` /
  `MoveResult` (§10); in the header: FRAME PIPELINE (you update first, weapons right after), CLOCKS, FEEDBACK
  OWNERSHIP RULE (the player line), LEVELS / IMPULSES / HANDLES (your `onModeChange` duty).
- **Feedback you trigger**: every `PlayerFxId`, `PlayerSoundId` and `PlayerLoopId`; the post fields
  `damageFlash`, `shieldFlash`, `chromaticBoost` (heavy hits), `lowHealth`, `overclock`, `dashBlur`;
  `audio.setMuffle` (you are its only writer); camera shake; `input.rumble` on damage and hard landings; the
  `overclock` time-scale request; the `'player:*'` and `'overclock:*'` events. **Never**: weapon sounds or
  recoil of your own (weapons call `addRecoil`); hit sparks, numbers or sounds for hits on enemies (combat);
  the death slow motion and `post.saturation` (director); `render.screenFlash`; music; any HUD element (the UI
  reads your state).
- **Data tables you may tune**: none (your numbers are the `PLAYER` constants in core).
- **Files you own**: `src/player/**`.
- **Verify with**: `__SH.move(x, y)`, `__SH.press(action, seconds)`, `__SH.look(…)` / `lookAtPoint(…)`,
  `__SH.teleport(…)`, `__SH.damagePlayer(n)`, `__SH.god(on)`, `__SH.overclock()`,
  `__SH.givePerk('doubleJump' | 'dashCharge' | 'lastStand' | …)`; `__SH.state()` → `player`, `timeScale`;
  `step(seconds, { dt })` at 1/30, 1/60 and 1/144 to prove frame-rate independence; teleport onto
  `__SH.ctx.world.jumpPads[i].position` to fly a pad. `tools/smoke.mjs` covers movement, look, Overclock,
  the perk freeze and a clean restart; `__SH.bot(true)` plays you through the virtual input.
