# Assignment: UI  (you own `src/ui/**`)

The whole interface layer: DOM + CSS over the canvas. No framework. Replace the stub in `src/ui/index.ts`; keep
the factory signature. UI never gets called by gameplay: read state from the context every frame and listen to
events. Touch only the DOM when a displayed value actually changes; animate with transform/opacity.

**Screens**
- Boot handoff → **Main menu** over the live cinematic rig: title lockup "STATIC HORIZON" (left-aligned,
  confident, not centred-everything), tagline, PLAY (→ difficulty: Recruit / Veteran / Nightmare with one-line
  descriptions), SETTINGS, CONTROLS, best score/wave. Subtle scanline/static motif tied to the fiction.
- **HUD**: crosshair with dynamic spread + hitmarkers (normal / crit / kill / shield variants); shield and
  health bars with delayed damage trail and low-health state; ammo (large magazine count, reserve, weapon name,
  reload progress, low-ammo warning, rail charge); weapon slots 1–4 (locked/unlocked/active); grenades; dash
  pips with cooldown; Overclock meter with a "READY — F" call to action and active countdown; wave number,
  enemies remaining, intermission countdown; score + combo multiplier with decay timer; announcer banners
  (WAVE 04, ZONE UNLOCKED, multikill callouts, FLAWLESS); objective line + world-anchored objective marker with
  distance; boss bar with name and phase pips; damage direction indicators; pickup/kill feed; minimap radar
  (canvas; rotates with the player; static footprints, enemy blips by type, pickups, objective, gates);
  optional FPS counter; binding prompts that switch between keyboard, gamepad and touch glyphs.
- **Perk select**: three cards (name, effect, rarity, stack count, key hint 1/2/3), choose by click/tap, keys or
  gamepad. **Pause**: resume / restart / settings / quit to menu. **Settings**: sensitivity, invert Y, FOV,
  volumes, quality, screen shake, reduce flashes, aim assist, FPS counter — applied live, fully keyboard and
  gamepad navigable with visible focus. **Game over** and **Victory**: grade letter reveal, score, wave, kills,
  accuracy, crits, best combo, time, perks taken, new-best flag; retry / menu.
- "Click to resume" prompt when mouse capture is lost; a concise hint when running in fallback look mode;
  fatal-error panel in plain language.
- **Touch controls** (shown only for touch input): left virtual stick, right-side look drag (multi-touch, fire
  button also drags look), buttons per the brief, through the virtual input API. Sized for thumbs, safe-area
  aware, semi-transparent, never overlapping vital HUD.

**Craft**
- Style per the brief (precise military-tech; cut corners, hairlines, small caps, tabular numerals). Colours
  only via CSS custom properties on `:root`. Fonts via one Google Fonts link with real fallback stacks; layout
  must hold if the web fonts never load.
- Responsive from 360 px wide phones to 4K: scale the HUD with a root size derived from the viewport; nothing
  overflows or overlaps at 1280×720, 1920×1080, 2560×1440, 844×390 (landscape phone) or 390×844 (portrait:
  show a "rotate device" nudge but stay usable).
- Motion 120–220 ms, eased; respect `prefers-reduced-motion` and the reduce-flashes setting. No emoji.
- Sandbox rules from brief §2 (no alert/confirm/prompt/window.open; storage is optional; pointer lock and
  fullscreen may be refused).
- Verify with harness screenshots of every screen and HUD state at the sizes above; look at them and iterate
  until it looks like a shipped game's UI. Add vitest coverage for pure formatting/logic helpers.
