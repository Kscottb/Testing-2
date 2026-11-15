# Assignment: RENDER  (you own `src/render/**`)

Own everything between the scene graph and the pixels: renderer setup, sky, sun/shadows, time-of-day, storm,
post-processing, quality + dynamic resolution, the first-person view-scene composite, and the cinematic cameras
used when the player is not in control. Replace the stub in `src/render/index.ts`; keep the factory signature.

- **Renderer**: WebGL2, HalfFloat HDR pipeline, sRGB output, filmic tone mapping (ACES or AgX — pick by eye),
  soft shadows from the single sun (2048 map on High, texel-snapped shadow frustum that follows the player so
  shadows never shimmer), device pixel ratio capped (2 desktop, 1.5 phones). Handle resize (ResizeObserver),
  context loss/restore, and a zero-size canvas without throwing.
- **Sky** (custom shader dome): we are inside a gas giant's upper atmosphere. Gradient atmosphere, sun disc
  with glow, a bright **planetary ring arc** spanning the sky, 2 small moons, hash stars at night, layered
  animated FBM cloud banks around the horizon, a soft **cloud sea** far below the rig (seen past the deck edge),
  lightning glowing inside distant clouds, and for *eclipse* a red-magenta storm vortex above the Core Spire.
  Keep it cheap (< 1 ms at 1080p on an iGPU): low octave counts, or render the sky to a small cube target that
  updates one face per frame. Scene fog matched to the horizon colour.
- **Image-based lighting**: PMREM environment from the sky so metal reads as metal; regenerate only when
  time-of-day changes (time-sliced, never per frame).
- **Time-of-day**: keyframes for dusk / twilight / stormnight / eclipse (sun direction, colour, intensity,
  hemisphere colours, fog, exposure, bloom, grade, star/ring visibility, storm amount) with smooth multi-second
  transitions. Publish the lighting state the contract exposes so FX/viewmodel can match.
- **Storm**: random lightning during stormnight/eclipse — a few frames of white-violet key-light flicker plus sky
  flash, and thunder through the audio system after a distance delay. Honour the reduce-flashes setting.
- **View scene**: light the first-person weapon layer consistently with the world (own small light rig + same
  environment) and composite it after the world with cleared depth, before bloom.
- **Post chain**: world → view scene → bloom → one combined final pass (vignette, radial chromatic aberration,
  film grain, colour grade, damage flash/vignette, low-health pulse + desaturation, Overclock treatment — cool
  tint, contrast, edge streaks —, dash radial blur, full-screen flash colour, all driven by the PostFx params
  in the contract) → tone map/output → AA (FXAA or SMAA). Low preset: no composer, but the view scene must
  still render on top.
- **Quality**: low / medium / high / ultra presets (shadow size, bloom, AA, resolution scale, sky cost).
  Sensible automatic default from the device. Dynamic resolution with hysteresis to hold frame rate. Report
  render stats per the contract.
- **Cinematic cameras**: main-menu flythrough along the world's camera path (slow, smooth spline, subtle
  handheld drift); game-over pull-back from where the player fell; victory orbit of the Spire. In `playing`
  the player system owns the camera — never fight it.
- Verify with harness screenshots at each time-of-day, each quality preset, with and without post; look at them
  and iterate until the sky and lighting are genuinely striking. Check there is no banding, no blown-out white,
  and that enemies' red and the player's cyan accents stay readable in every time-of-day.
