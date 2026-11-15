# Assignment: WEAPONS  (you own `src/weapons/**`)

Four guns, grenades and melee: the logic and the first-person presentation. Gunfeel is the product. Replace the
stub in `src/weapons/index.ts`; keep the factory signature. Tuning starts from `src/data` (you may refine the
weapon table values if the contract gives you ownership of it; otherwise keep local multipliers).

- **Logic**: fire modes (auto / pump / charge-and-release / projectile), fire-rate timing that is exact at any
  frame rate (accumulate, allow multiple shots per frame), spread model (base + per-shot bloom + movement/air
  penalties − crouch/ADS bonuses, recovering over time; this drives the crosshair), per-weapon recoil pattern
  (vertical climb + horizontal drift, reduced in ADS, sent to the player's recoil API), damage falloff, pellets,
  piercing rail via the combat piercing trace, rockets and grenades via combat projectiles, magazines + reserve,
  reloads (rifle: mag swap; scattergun: shell-by-shell, interruptible by firing; rail: cell swap; launcher:
  slow), auto-reload on empty, reload cancel on switch, switch with lower/raise timing, 120 ms input buffering
  for fire/reload/switch, dry-fire click, rising pitch on the last rounds of a magazine, all perk modifiers,
  Overclock rules (no ammo use), shot/hit accounting and every documented event.
- **Hit feedback** (you own the shot moment): tracers from the muzzle, per-surface impact FX + decals on world
  hits, sparks on enemies, shield ripple on shields, the documented hit-confirm events, knockback on big hits.
- **Viewmodels** in the view scene: four distinct, chunky, readable guns built from primitives (bevelled boxes,
  cylinders, lathe/extrude) plus simple armoured gauntlet hands. ≤ 12 draw calls each: merge static parts, keep
  moving parts separate (bolt, magazine, pump, charge coils, missile rack). A small emissive **diegetic ammo
  readout** on each gun (canvas texture redrawn only when the count changes). Muzzle flash meshes (randomised
  per shot, ~50 ms) and the view-layer muzzle light the contract provides. Brass/cell ejection as pooled meshes.
- **Animation**, all procedural and spring-driven so it never looks canned: look sway and lag, movement bob,
  jump/land offsets, sprint carry pose, slide pose, ADS pose with sights aligned to screen centre (rail: scoped
  zoom), recoil kick + recovery, pump/bolt cycling, charge shake and glow for the rail, small keyframed reload
  sequences (mag out → mag in → charge), lower/raise on switch, melee strike, grenade toss, idle breathing.
  Animation clocks use the player's (unscaled) time so Overclock keeps handling crisp.
- **Grenades** (arc throw, bounce, fuse) and **melee** (cone check, lunge, hit-stop on connect, FX/audio).
- Vitest for the pure logic: fire-rate exactness across dt, spread/recoil evolution, falloff, ammo/reload state
  machine (including interrupts and reset), modifiers.
- Screenshots via the harness of every gun: idle, ADS, mid-fire (flash visible), mid-reload, plus melee and
  grenade frames. Look at them; iterate until each gun has a strong silhouette and sits well in frame at 16:9
  and on a narrow phone-landscape viewport.
