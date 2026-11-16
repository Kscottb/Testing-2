# Assignment: WORLD

Build MERIDIAN-7: one continuous three-zone map, its materials, props, gates, hazards, jump pads, and all the
data other systems need (collision boxes, nav hints, zones, spawn points, drop pads, boss arena, minimap
footprints, cinematic camera path). Replace the stub in `src/world/index.ts`; keep the factory
`createWorldSystem(ctx)`. Where this text and `src/core/types.ts` differ, the contract wins.

## Layout (≈150 m × 90 m, x ∈ [-75, 75], z ∈ [-45, 45]; zones west → east)
- **Landing Deck** (x ≈ -75…-27). Player start near the west end beside the player's parked dropship (a big
  solid prop built from boxes/wedges), looking east (yaw −π/2 in the contract's convention). A huge painted
  landing circle with pad number "07". Cargo containers stacked into lanes and cover (1.25 m crates you can hop
  on, 2.6 m containers that block sight), a control tower with a stair-ramp up to a 3 m terrace overlooking the
  pad, fuel bowsers, light masts.
- **Refinery** (x ≈ -23…27). Dense and vertical: terraces at y = 1.5 and y = 3 joined by ramps, a sunken molten
  slag channel running north–south (hazard: damage over time, glowing hazard-amber, crossed by two solid
  bridges), large storage tanks and distillation columns, overhead pipe racks (≥ 4 m up — solid for flyers and
  shots, see Rules), two jump pads (terrace hop + channel crossing).
- **Core Spire** (x ≈ 31…75). Circular boss arena (radius ≈ 26 m), an outer raised ring (y = 1.5) with ramps at
  the four cardinal points, 6–8 pylons for cover, two jump pads. **The Conductor anchors at
  `bossArena.center + hoverHeight`** and hangs there for the whole fight; it is about 10 m across and 10 m tall
  (its row in `data/enemies.ts`), and `hoverHeight` must lie inside that row's hover band (9–13 m at
  baseline). So the spire cannot rise through that point: build it as a colossal broken core / cradle whose
  solid mass ends below the boss, crowned by render's storm vortex, and carry the tall silhouette with
  structures outside the boss volume. Keep that volume free of geometry and in plain sight from most of the
  arena floor — every weapon must be able to reach the boss. Also keep the victory camera ring clear (radius,
  height and margin in the contract).
- Zone boundaries are 4 m thick wall bands with **two energy gates each** (main 10 m wide + side 6 m) so combat
  can flow; ids and tags as the contract names them. A closed gate stops bodies and shots but can be seen
  through; its blocking volume is also its nav region and must be at least one nav cell thick. The three zone
  rectangles tile the whole map: a boundary runs through the middle of its wall band, so no gate corridor is
  zone-less.
- Perimeter: 2.5 m parapet + railings + invisible player clip to y = 40 (nobody can leave the map). Outside the
  walls: non-colliding set dressing (antenna masts, rig struts and thruster pods hanging below the deck) so the
  rig feels like a machine floating in sky, not a box.
- Rules:
  - Everything collidable is an axis-aligned box with the right block flags and surface type (the surface
    drives footsteps and impacts). Ramps = smooth visual mesh + stair-stepped collision (0.25 m steps; flag
    those boxes as not taking decals). Walkable heights are terraces only (0, 1.5, 3) — no walkable surface
    above another.
  - **Nothing visible below y = 16 m inside the perimeter is "visual only".** Wasps fly at 4–9 m and grenades
    arc there, so pipe racks, masts and tank tops block at least enemies and projectiles. Pure set dressing
    lives above 16 m or outside the walls.
  - Every corridor ≥ 3 m wide (the bulwark is 2.8 m across at its baseline radius). No dead-end pockets where
    enemies can't reach the player. Sightlines: mix long lanes (lance), mid arenas (vector) and tight corners
    (breaker). Cover every 6–10 m.

## Look
- Procedural textures (canvas → albedo, normal via Sobel of a height canvas, roughness): hull panels with seams,
  rivets and edge wear; deck plate with tread pattern; hazard stripes; grates; stencilled signage (zone names,
  pad number, arrows, warnings) on an atlas. Constant texel density via world-scaled UVs.
- Materials from the brief's colour script. Emissive strips/beacons with HDR intensity so bloom picks them up.
  Animated emissives (beacon blink, guidance chase lights, gate shader, slag flow, jump-pad chevrons) through
  shared uniforms/material properties — no per-frame allocation, no real lights, no shader recompiles after
  `init()`. Custom shaders follow the contract's rendering conventions (linear output, fog, render order).
- Gates: energy barrier shader (scrolling hex/scan pattern), enemy-red while locked; on unlock it destabilises
  and dissolves, frame lights turn cyan. `setGateOpen` / `unlockZone` toggle collision and the nav region, play
  your gate and zone-unlock fx + sound and emit the events. The "ZONE UNLOCKED" banner is the director's.
- Merge static geometry per material; InstancedMesh for containers, crates, railing posts, masts, pipes.
  Budget: ≤ 150 draw calls, ≤ 350k triangles. Large structures cast + receive shadows; tiny props don't cast.

## Systems
- The level is built once in `init()`: collision boxes (then finalize), nav hints, every list below. `reset()`
  only restores state — gates closed instantly and silently, refinery + spire locked, hazards and pads re-armed.
- Animation runs in every simulated mode (the menu shows the live rig). The gameplay rules run only while
  playing with a live player:
  - **Hazards** (slag, steam, arcs) tick their damage **through `ctx.combat.applyDamage`** as neutral world
    damage — on the player and on every live enemy inside, so nothing knocked into the slag survives there.
    Hazard areas are nav-blocked.
  - **Jump pads** launch the grounded player with `player.launch(pad.velocity)`; you solve each arc for the
    player's gravity and publish where it lands. Pads never launch enemies.
  - Touching a closed gate gives the denied feedback (rate-limited). Falling below `killY` puts the player back
    on the last safe ground with the contract's fall damage, again through combat.
- Spawn points: ≥ 12 ground, ≥ 6 air, ≥ 3 heavy per zone (the contract's floor is 6 / 3 / 2), spread out, all
  reachable, with the clearances the contract promises the director (ground 2 m, heavy 3.5 m, air = a hover
  point 4–9 m up in clear air). Drop pads in every zone: a supply crate lands on the pad of the wave's zone
  nearest the player.
- Ambient loops (gate hum, pad hum, hazard hum, steam hiss) are acquired lazily inside `update` once audio is
  unlocked — never in `init()` or `reset()`.
- Minimap data: footprints in draw order, at most 400 rectangles, each with kind, height level and gate id —
  good enough for a clean radar.
- Cinematic path: 5–8 keys (position, look target, seconds, optional fov and cut) that show off the rig for the
  main menu. You guarantee a clear 1 m tube along the exact curve render will fly — compute it with the same
  three.js curve the contract names.

## Verify
- A vitest file validating the layout against the real CollisionWorld/NavGrid: player start valid; every spawn
  point and drop pad on walkable ground with its clearance and reachable from the start with all gates open;
  zones unreachable while their gates are closed; no walkable pockets; perimeter sealed; every jump-pad arc
  clears geometry and lands on its target; the menu camera tube, the boss volume and the victory orbit ring
  are clear.
- Screenshots with the harness (free camera): one high top-down per zone and several eye-level beauty shots in
  different time-of-day settings. Look at them and iterate until composition, scale and readability are good.

## Contract pointers

- **You implement** `WorldSystem` (types.ts §12) with `ZoneInfo`, `SpawnPoint`, `DropPad`, `GateInfo`,
  `JumpPadInfo`, `HazardInfo`, `CinematicShot`, `MinimapRect` / `MinimapData`; you are also the only one who
  fills the `CollisionWorld` (`BoxDesc`, §10) and you supply `NavBuildHints` (§11). Read closely: the doc block
  above `WorldSystem` (the gameplay rules and the layout rules other systems rely on), `bossArena`,
  `CinematicShot`, `GateInfo`, `groundHeightAt`, `NavGrid.setRegionWalkable`; the `COL` flags in
  `core/constants.ts`; `PlayerSystem.launch` / `teleport` (§15); in the header: FRAME PIPELINE (you update in
  playing, gameover, victory and menu), CLOCKS (scaled `dt`), FEEDBACK OWNERSHIP RULE (the world line), LEVELS
  / IMPULSES / HANDLES (lazily acquired ambient loops), RENDERING CONVENTIONS (one root named `world`).
- **Feedback you trigger**: every `WorldFxId`, `WorldSoundId` and `WorldLoopId` (gates, zone unlock, jump
  pads, hazards, steam, beacons, fall-out respawn), and the events `'zone:unlocked'` and `'gate:state'`.
  **Never**: a banner or any `'announce'` (director); a real light (emissive + bloom only); damage that
  bypasses combat; sky, fog or time of day (render); pickups and the supply pod (director).
- **Data tables you may tune**: none.
- **Files you own**: `src/world/**`.
- **Verify with**: `__SH.setCamera(…)` / `releaseCamera()`, `__SH.teleport(…)`, `__SH.unlockZone(zone)` or
  `__SH.giveAll()`, `__SH.setTimeOfDay(…)`, `__SH.hideUi(true)`, `__SH.god(true)`; `__SH.budget().world`
  against the budget; `__SH.state().zones`; `__SH.ctx.world`, `__SH.ctx.nav.isReachable(a, b)`,
  `__SH.ctx.collision.boxes` for spot checks; `__SH.spawn('wasp' | 'bulwark' | 'conductor')` to judge sizes
  against the level; `__SH.menu()` for the camera path and `__SH.endRun(true)` for the victory orbit.
  `tools/shots.mjs` tours the three zones; `tools/campaign.mjs` lets the bot walk the whole map — a stall
  usually means an unreachable spot.
