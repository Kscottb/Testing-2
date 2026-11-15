# Assignment: ENEMIES — core + first three kinds  (you own `src/enemies/**` for this stage)

Build the enemy framework and the three rank-and-file machines. Two more engineers follow you in the same
directory (three more kinds, then the boss), so leave a clean, documented extension point: one file per kind
under `src/enemies/kinds/`, registered through the kind registry in the contract. Replace the stub in
`src/enemies/index.ts`; keep the factory signature.

- **Manager**: pooled instances per kind; `spawn` runs the **lightning-strike arrival** (ground telegraph ring
  ≈ 0.8 s → bolt from the sky → machine scales/flashes in; harmless and untargetable until it lands); live
  list and queries per the contract; hit-target registration with combat; flow-field refresh toward the
  player on a sensible cadence; separation via a spatial hash; **attack tokens** (global budget by difficulty,
  per-kind cost, fair rotation); stuck/out-of-bounds/NaN detection with recovery; death handling (events with
  everything score/pickups need, per-kind death FX + audio, corpse removal); clean `reset`/`killAll`.
- **Base class + helpers**: ground locomotion along the flow field with steering smoothing and terrace height
  following, hover and flight helpers for later kinds, knockback impulses with damping, stagger, facing with
  turn-rate limits, hit flash on the emissive accent, line-of-sight and lead-target helpers, a tiny state
  machine helper, optional small health bars over damaged elites. Time-scaled by world dt.
- **Kinds** (procedural meshes ≤ 8 draw calls each, dark gunmetal + one hot orange-red emissive accent, each
  silhouette unmistakable at 30 m, each with spawn/idle/telegraph/attack/hurt/death audio from the SoundId list):
  - **skitter** — low wedge body on four scythe legs with a procedural gait; packs approach from different
    angles to surround; crouch telegraph ≈ 0.35 s then a ballistic leap; bite on contact; recoil after a miss.
  - **tick** — armoured rolling sphere with spikes; rolls by distance travelled; core pulse and beeps accelerate
    with proximity; detonates near the player through `combat.explode` (hurts other enemies → chains); also
    explodes when killed (short fuse so chains ripple).
  - **riveter** — hovering triangular gun platform with twin barrels and a single large eye (weak point);
    bobs on a thruster glow; holds a range band, strafes with direction changes, retreats if rushed; fires
    3-round plasma bursts after an eye-flare + chirp telegraph, leading the target with distance-scaled error.
- Fairness: no attack without a telegraph, no damage through walls, no instant hits from off-screen without an
  audio cue. Enemy → player damage goes through the documented pipeline only.
- Vitest (fake context where needed): token budget fairness, state-machine transitions for each kind, leap
  ballistics, tick chain timing, separation maths, stuck recovery, pool reuse and reset.
- Screenshots via the harness: each kind standing in front of a free camera (front, three-quarter, in a pack),
  mid-telegraph and mid-attack. Look at them; iterate on silhouette, proportions and glow until they look
  designed. Also run a short bot fight on your dev port to confirm nothing throws.
