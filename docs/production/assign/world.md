# Assignment: WORLD  (you own `src/world/**`)

Build MERIDIAN-7: one continuous three-zone map, its materials, props, gates, hazards, jump pads, and all the
data other systems need (collision boxes, nav hints, spawn points, drop pads, minimap footprints, cinematic
camera path). Replace the stub in `src/world/index.ts`; keep the factory name/signature.

## Layout (≈150 m × 90 m, x ∈ [-75, 75], z ∈ [-45, 45]; zones west → east)
- **Landing Deck** (x ≈ -75…-27). Player start near the west end beside the player's parked dropship (a big
  solid prop built from boxes/wedges), looking east. A huge painted landing circle with pad number "07". Cargo
  containers stacked into lanes and cover (1.25 m crates you can hop on, 2.6 m containers that block sight), a
  control tower with a stair-ramp up to a 3 m terrace overlooking the pad, fuel bowsers, light masts.
- **Refinery** (x ≈ -23…27). Dense and vertical: terraces at y = 1.5 and y = 3 joined by ramps, a sunken molten
  slag channel running north–south (hazard: damage over time, glowing hazard-amber, crossed by two solid
  bridges), large storage tanks and distillation columns, overhead pipe racks (visual only, ≥ 4 m up), two
  jump pads (terrace hop + channel crossing).
- **Core Spire** (x ≈ 31…75). Circular boss arena (radius ≈ 26 m) around a colossal central spire (radius ≈ 4 m,
  emissive core, rising far into the sky), an outer raised ring (y = 1.5) with ramps at the four cardinal
  points, 6–8 pylons for cover, two jump pads. Leave the air above 8–16 m clear: the boss flies there.
- Zone boundaries are 4 m thick wall bands with **two energy gates each** (main 10 m wide + side 6 m) so combat
  can flow. Gates are solid + sight-blocking-false energy barriers when closed.
- Perimeter: 2.5 m parapet + railings + invisible clip to y = 40 (nobody can leave the map). Outside the walls:
  non-colliding set dressing (antenna masts, rig struts and thruster pods hanging below the deck) so the rig
  feels like a machine floating in sky, not a box.
- Rules: everything collidable is an axis-aligned box. Ramps = smooth visual mesh + stair-stepped collision
  (0.25 m steps). Walkable heights are terraces only (0, 1.5, 3) — no walkable surface above another. Every
  corridor ≥ 3 m wide (heavy enemies are 2.4 m wide). No dead-end pockets where enemies can't reach the player.
  Sightlines: mix long lanes (lance), mid arenas (vector) and tight corners (breaker). Cover every 6–10 m.

## Look
- Procedural textures (canvas → albedo, normal via Sobel of a height canvas, roughness): hull panels with seams,
  rivets and edge wear; deck plate with tread pattern; hazard stripes; grates; stencilled signage (zone names,
  pad number, arrows, warnings) on an atlas. Constant texel density via world-scaled UVs.
- Materials from the brief's colour script. Emissive strips/beacons with HDR intensity so bloom picks them up.
  Animated emissives (beacon blink, guidance chase lights, gate shader, slag flow, jump-pad chevrons) through
  shared uniforms/material properties — no per-frame allocation, no real lights.
- Gates: energy barrier shader (scrolling hex/scan pattern), enemy-red while locked; on unlock it destabilises
  and dissolves, frame lights turn cyan. Toggle collision + nav region and emit the documented events.
- Merge static geometry per material; InstancedMesh for containers, crates, railing posts, masts, pipes.
  Budget: ≤ 150 draw calls, ≤ 350k triangles. Large structures cast + receive shadows; tiny props don't cast.

## Systems
- Register all collision boxes and nav hints at init (the level is built once; `reset()` only restores gates,
  zone locks, animated state). Hazard damage and jump-pad launches go through the player interface.
- Spawn points: ≥ 12 ground, ≥ 6 air, ≥ 3 heavy per zone, spread out, never inside geometry, all reachable.
- Minimap data: footprints good enough for a clean radar.
- Cinematic path: 5–8 waypoints (position + look target) that show off the rig for the main menu.

## Verify
- A vitest file validating the layout against the real CollisionWorld/NavGrid: player start valid; every spawn
  point and drop pad is on walkable ground and reachable from the start with all gates open; zones unreachable
  while their gate is closed; no walkable pockets; perimeter sealed.
- Screenshots with the harness (free camera): one high top-down per zone and several eye-level beauty shots in
  different time-of-day settings. Look at them and iterate until composition, scale and readability are good.
