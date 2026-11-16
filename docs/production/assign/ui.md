# Assignment: UI

The whole interface layer: DOM + CSS over the canvas, inside `ctx.uiRoot`. No framework. Replace the stub in
`src/ui/index.ts`; keep the factory `createUiSystem(ctx)`. UI never gets called by gameplay: read state from
the context every frame and listen to events. Touch the DOM only when a displayed value actually changes;
animate with transform/opacity. Where this text and `src/core/types.ts` differ, the contract wins.

**Screens**
- **Main menu** over the live cinematic rig (the boot screen is index.html's and core removes it — you simply
  show the menu when the game first reaches menu mode): title lockup "STATIC HORIZON" (left-aligned, confident,
  not centred-everything), tagline, PLAY (→ difficulty: Recruit / Veteran / Nightmare with one-line
  descriptions; start the run synchronously inside the click handler so it still counts as a user gesture),
  SETTINGS, CONTROLS (binding labels per device from the input system), best score/wave. Subtle
  scanline/static motif tied to the fiction.
- **HUD**: crosshair with dynamic spread + hitmarkers (normal / crit / kill / shield variants, one per
  hit-confirm event); scope mask for scoped weapons; shield and health bars with delayed damage trail and a
  low-health state on the bar itself; ammo (large magazine count, reserve, weapon name, reload progress,
  low-ammo warning, rail charge); weapon slots 1–4 (locked/unlocked/active); grenades; dash pips with
  cooldown; Overclock meter with a "READY — F" call to action (the label of the current binding) and active
  countdown; wave number, enemies
  remaining, intermission countdown; score + combo multiplier with decay timer; floating score popups where
  the score was earned; **banners for the director's `announce` event and for nothing else** (the newest
  replaces the current one — no queue, and no banner of your own for wave start, zone unlock or the like);
  multikill callouts as a callout line; objective line + world-anchored objective marker with distance; boss
  bar with name and phase pips; damage direction indicators; pickup/kill feed; minimap radar (canvas; rotates
  with the player; static footprints, enemy blips by type, pickups, objective, gates); optional FPS counter;
  binding prompts that switch between keyboard, gamepad and touch glyphs.
- **What you do not draw**: any full-screen tint, vignette, blur or desaturation for damage, low health,
  Overclock, dash or ADS (render's post chain owns those), and damage numbers (fx). Your only full-screen
  layers are the scope mask, menu scrims and the rotate-device nudge. No CSS `backdrop-filter` over the canvas.
- **Perk select**: one to three cards (name, effect, rarity, stack count, key hint 1/2/3), picked by click/tap
  or by focus + confirm. The 1/2/3 keys and the pad's X/Y/B are polled by the director, not by you. Cards stay
  locked for the same guard time as those keys, counted from the director's offer stamp — show the lock.
  **Pause**: resume / restart / settings / quit to menu. The pause key itself is core's: never toggle pause on
  it; a nested panel that should swallow it says so through `consumesPauseAction`. **Settings**: every field of
  the settings data — sensitivity, invert Y, FOV, the three volumes, quality (auto + four presets), dynamic
  resolution, screen shake, reduce flashes, aim assist, damage numbers, FPS counter — written live through
  `ctx.settings.set` (the owning systems apply them), fully keyboard and gamepad navigable with visible focus,
  without native drop-down lists. **Game over** and **Victory**, from the run-end event: grade letter reveal,
  score, wave, kills, accuracy, crits, best combo, time, perks taken, new-best flag; retry / menu.
- **Focus and navigation** follow the contract exactly: one focused control per screen, native Enter / Space /
  arrow behaviour for keyboard and mouse, the gamepad confirm only while the pad is the active device, your own
  key repeat, and the activation guard after a screen opens.
- When mouse capture is lost, core pauses the game: your pause screen is the "click to resume" prompt. Show a
  concise hint when running in fallback (free) look mode. **No fatal-error panel**: it lives in index.html and
  core shows it; your `showFatal` hook only hides HUD and menus and stops animating.
- **Touch controls** (shown only while touch is the active device): left virtual stick (hold sprint at full
  deflection), right-side look drag (multi-touch, fire button also drags look), buttons per the brief, through
  the virtual input API — written only from pointer events, releasing exactly what you hold whenever the
  controls hide, and never clearing the shared channel (the bot uses it too). Mark each control with the
  `data-touch` attribute the tools look for. Sized for thumbs, safe-area aware, semi-transparent, never
  overlapping vital HUD. An optional fullscreen button under the contract's rule.

**Craft**
- Style per the brief (precise military-tech; cut corners, hairlines, small caps, tabular numerals). Colours
  only via CSS custom properties on `:root`: use the `--sh-*` tokens index.html defines and add further tokens
  on `:root` rather than literal colours. The web fonts are already linked without blocking, each with a real
  fallback stack; never wait for them — every layout must hold if they never load.
- Responsive from 360 px wide phones to 4K: scale the HUD with a root size derived from the viewport; nothing
  overflows or overlaps at 1280×720, 1920×1080, 2560×1440, 844×390 (landscape phone) or 390×844 (portrait:
  show a "rotate device" nudge but stay usable).
- Motion 120–220 ms, eased; respect `prefers-reduced-motion`. Everything with a lifetime (banners, hitmarkers,
  feed entries, count-ups) is timed in `update(realDt)`, never by `setTimeout` or `animationend`; in test mode
  add the `sh-test` class, under which every duration is zero. The reduce-flashes setting is only a toggle
  here: render and fx apply it and nobody else checks it. No emoji.
- Sandbox rules from brief §2 (no alert/confirm/prompt/window.open; storage is optional; pointer lock and
  fullscreen may be refused).
- Verify with harness screenshots of every screen and HUD state at the sizes above; look at them and iterate
  until it looks like a shipped game's UI. Add vitest coverage for pure formatting/logic helpers (the tests
  run without a DOM).

## Contract pointers

- **You implement** `UiSystem` (types.ts §23) — `showFatal`, `wantsPointer`, `consumesPauseAction`, `screen`,
  `debugShow` — over the `UiScreen` list (§2). Read closely: the whole doc block above `UiSystem` (WHAT THE UI
  DRAWS — AND WHAT IT DOES NOT, FOCUS AND NAVIGATION, VALUE CONTROLS, ACTIVATION GUARD, TIMING, TOUCH CONTROLS,
  FULLSCREEN, Styling); all of `EventMap` (§7) — you are its main consumer — above all `'announce'`,
  `'hit:confirmed'`, `'player:damaged'` (how to read its angle), `'score:changed'`, `multikill`,
  `'perk:offered'`, `'run:end'` and the `'input:*'` events; the `Game` facade (§5); `Input.bindingLabel`,
  `device`, the virtual-input block and the `ui*` / `perk*` actions (§8, §2); `Settings` / `SettingsData` (§9);
  the getters you display: `PlayerSystem` (§15), `WeaponSystem` (§16), `DirectorSystem` incl. `perkOfferedAt`
  (§19), `EnemySystem.list` / `boss` (§18), `WorldSystem.minimap` / `gates` (§12),
  `RenderSystem.worldToScreen` / `quality` / `qualityIsAuto` (§13); `PERK_INPUT_GUARD_SECONDS` and
  `QUALITY_SETTINGS` in `core/constants.ts`; in the header: FRAME PIPELINE (core's pause hotkey and pointer
  policy; you update every frame, in every mode), CLOCKS (`realDt`; `ctx.time.elapsed` for guards), FEEDBACK
  OWNERSHIP RULE (the ui line), GLOBAL CONVENTIONS (sandboxed embedding).
- **Feedback you trigger**: the `UiSoundId` family only, through `ctx.audio.play` (hover, click, confirm, back,
  toggle, slider, error, pause / resume, perk offer and hover, run start, grade reveal, stat tick, new best).
  **Never**: a sound when a perk is picked (director); wave, zone, pickup or combo sounds; any `ctx.fx` call;
  a banner that no `announce` asked for; the fatal panel; pause toggling on the pause action; pointer capture
  calls (core does it from your `wantsPointer`); `clearVirtual`. You change the game only through `ctx.game.*`,
  `ctx.director.choosePerk`, `ctx.settings.set` and the virtual input.
- **Data tables you may tune**: none (you read perks, difficulties and weapons for their labels).
- **Files you own**: `src/ui/**`, plus `index.html` under the rule in brief §7.
- **Verify with**: `__SH.ui(screen)` forces any screen (`null` = automatic) and `__SH.state().uiScreen` reports
  it; `__SH.start()`, `__SH.pause()`, `__SH.setWave(n)` + `__SH.killAll()` to reach perk select,
  `__SH.givePerk(id)`, `__SH.damagePlayer(n)`, `__SH.overclock()`, `__SH.spawn('conductor')` for the boss bar,
  `__SH.endRun(true | false)` for the end screens, `__SH.hideUi(on)`; `__SH.press('uiDown' | 'uiConfirm' | …)`
  and `__SH.ctx.input.notifyDevice('gamepad' | 'touch')` for navigation and glyphs. Harness:
  `launchGame({ width, height, touch: true, reducedMotion })`; `tools/shots.mjs --size WxH` walks menu,
  difficulty, settings, controls, perk select, pause, game over, victory and a 390×844 touch layout with real
  touches on your `[data-touch]` elements. The sandboxed-frame run is an integration check; until then
  `launchGame({ test: false })` gives you the real loop, free look and real mouse / keyboard input.
