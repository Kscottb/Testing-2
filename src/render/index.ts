// STUB: replaced by the render team
import * as THREE from 'three';
import { QUALITY } from '../data/quality';
import { TIME_OF_DAY } from '../data/timeOfDay';
import { damp } from '../core/math';
import type { GameContext, LightingState, PostFxParams, QualityPreset, QualitySetting, RenderStats, RenderSystem, ScreenPoint, TimeOfDayId, Vec3Like } from '../core/types';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const POST_DEFAULTS: PostFxParams = { damageFlash: 0, shieldFlash: 0, flash: 0, flashColor: 0xffffff, chromaticBoost: 0, lowHealth: 0, overclock: 0, dashBlur: 0, adsVignette: 0, saturation: 1, exposure: 1 };

/** Gray-box renderer: forward pass for the world, cleared depth, then the first-person layer. No post. */
export function createRenderSystem(ctx: GameContext): RenderSystem {
  let renderer!: THREE.WebGLRenderer;
  let quality: QualityPreset = 'high';
  let qualityIsAuto = true;
  let timeOfDay: TimeOfDayId = 'dusk';
  let width = 1;
  let height = 1;
  let orbit = 0;
  const post: PostFxParams = { ...POST_DEFAULTS };
  const stats: RenderStats = { drawCalls: 0, shadowCalls: 0, postCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0, pixelRatio: 1, renderMs: 0 };
  const lighting: Mutable<LightingState> = { sunDirection: new THREE.Vector3(0.4, 0.6, 0.5).normalize(), sunColor: new THREE.Color(), sunIntensity: 3, ambientColor: new THREE.Color(), ambientIntensity: 1, fogColor: new THREE.Color(), fogDensity: 0.003, storm: 0, night: 0, flash: 0 };
  // One root per scene, named after the system.
  const root = new THREE.Group();
  const viewRoot = new THREE.Group();
  root.name = viewRoot.name = 'render';
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
  const viewSun = new THREE.DirectionalLight(0xffffff, 2.5);
  const viewHemi = new THREE.HemisphereLight(0xffffff, 0x333333, 1.2);
  const projected = new THREE.Vector3();
  const background = new THREE.Color();

  /** 'auto' -> a preset from the device (see RenderSystem QUALITY). */
  const resolveAuto = (): QualityPreset => {
    if (matchMedia('(pointer: coarse)').matches) return Math.min(screen.width, screen.height) < 800 ? 'low' : 'medium';
    const gl = renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    return /SwiftShader|llvmpipe|Intel|Iris|UHD|Mali|Adreno|PowerVR/i.test(gpu) ? 'medium' : 'high';
  };

  const applyTimeOfDay = (): void => {
    const def = TIME_OF_DAY[timeOfDay];
    lighting.sunColor.setHex(def.sunColor);
    lighting.sunIntensity = def.sunIntensity;
    lighting.ambientColor.setHex(def.ambientSky);
    lighting.ambientIntensity = def.ambientIntensity;
    lighting.fogColor.setHex(def.fogColor);
    lighting.fogDensity = def.fogDensity;
    lighting.storm = def.storm;
    lighting.night = def.night;
    const el = (def.sunElevation * Math.PI) / 180;
    const az = (def.sunAzimuth * Math.PI) / 180;
    lighting.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    sun.color.copy(lighting.sunColor);
    sun.intensity = def.sunIntensity;
    sun.position.copy(lighting.sunDirection).multiplyScalar(100);
    hemi.color.setHex(def.ambientSky);
    hemi.groundColor.setHex(def.ambientGround);
    hemi.intensity = def.ambientIntensity * 2;
    background.setHex(def.fogColor).multiplyScalar(0.5);
  };

  const system: RenderSystem = {
    get renderer() {
      return renderer;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get quality() {
      return quality;
    },
    get qualityIsAuto() {
      return qualityIsAuto;
    },
    get qualityParams() {
      return QUALITY[quality];
    },
    resolutionScale: 1,
    post,
    get timeOfDay() {
      return timeOfDay;
    },
    lighting,
    stats,
    init(): void {
      renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.autoClear = false;
      renderer.info.autoReset = false;
      ctx.scene.background = background;
      root.add(sun, hemi);
      ctx.scene.add(root);
      viewSun.position.set(0.5, 1, 0.8);
      viewRoot.add(viewSun, viewHemi);
      ctx.viewScene.add(viewRoot);
      ctx.events.on('settings:changed', (e) => {
        if (e.key === 'quality') system.setQuality(e.data.quality);
      });
      applyTimeOfDay();
      system.setQuality(ctx.settings.data.quality);
    },
    reset(): void {
      Object.assign(post, POST_DEFAULTS);
      lighting.flash = 0;
      system.setTimeOfDay('dusk', 0);
    },
    update(realDt: number): void {
      post.damageFlash = damp(post.damageFlash, 0, 3, realDt);
      post.shieldFlash = damp(post.shieldFlash, 0, 3, realDt);
      post.flash = damp(post.flash, 0, 2.5, realDt);
      post.chromaticBoost = damp(post.chromaticBoost, 0, 3, realDt);
      lighting.flash = damp(lighting.flash, 0, 6, realDt);
      const mode = ctx.game.mode;
      // Cinematic ownership (never while the debug free camera is active): slow orbit around the first
      // cinematic target (or the player's body).
      if ((mode === 'menu' || mode === 'gameover' || mode === 'victory') && !ctx.debug.freeCamera) {
        orbit += realDt * 0.08;
        const target = mode === 'menu' ? (ctx.world.cinematicPath[0]?.target ?? ctx.scene.position) : ctx.player.position;
        ctx.camera.position.set(target.x + Math.cos(orbit) * 26, target.y + 12, target.z + Math.sin(orbit) * 26);
        ctx.camera.lookAt(target);
        ctx.camera.updateMatrixWorld();
      }
    },
    render(): void {
      const t0 = performance.now();
      renderer.info.reset();
      renderer.clear();
      renderer.render(ctx.scene, ctx.camera);
      const mode = ctx.game.mode;
      if ((mode === 'playing' || mode === 'paused') && ctx.player.alive && !ctx.debug.freeCamera) {
        renderer.clearDepth();
        renderer.render(ctx.viewScene, ctx.viewCamera);
      }
      stats.drawCalls = renderer.info.render.calls;
      stats.triangles = renderer.info.render.triangles;
      stats.geometries = renderer.info.memory.geometries;
      stats.textures = renderer.info.memory.textures;
      stats.programs = renderer.info.programs?.length ?? 0;
      stats.pixelRatio = renderer.getPixelRatio();
      stats.renderMs = performance.now() - t0;
    },
    resize(w?: number, h?: number): void {
      width = Math.max(1, Math.floor(w ?? ctx.canvas.clientWidth));
      height = Math.max(1, Math.floor(h ?? ctx.canvas.clientHeight));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[quality].maxPixelRatio));
      renderer.setSize(width, height, false);
      for (const camera of [ctx.camera, ctx.viewCamera]) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    },
    setQuality(setting: QualitySetting): void {
      qualityIsAuto = setting === 'auto';
      quality = setting === 'auto' ? resolveAuto() : setting;
      system.resize();
      ctx.events.emit('quality:changed', { preset: quality, params: QUALITY[quality] });
    },
    screenFlash(color: number, intensity: number): void {
      // Strongest wins: a weak blast never recolours a strong lightning flash.
      if (intensity > post.flash) {
        post.flash = Math.min(1, intensity);
        post.flashColor = color;
      }
    },
    setTimeOfDay(id: TimeOfDayId, seconds = 0): void {
      const prev = timeOfDay;
      timeOfDay = id;
      applyTimeOfDay();
      if (prev !== id) ctx.events.emit('timeOfDay:changed', { id, prev, seconds });
    },
    lightningFlash(intensity: number): void {
      lighting.flash = Math.max(lighting.flash, Math.min(1, intensity));
    },
    muzzleFlash(): void {},
    worldToScreen(world: Vec3Like, out: ScreenPoint): boolean {
      projected.set(world.x, world.y, world.z).applyMatrix4(ctx.camera.matrixWorldInverse);
      out.depth = -projected.z;
      projected.applyMatrix4(ctx.camera.projectionMatrix);
      out.x = (projected.x * 0.5 + 0.5) * width;
      out.y = (-projected.y * 0.5 + 0.5) * height;
      out.visible = out.depth > 0 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
      return out.visible;
    },
    viewToWorld(viewPoint: Vec3Like, out: THREE.Vector3): THREE.Vector3 {
      const k = Math.tan((ctx.camera.fov * Math.PI) / 360) / Math.tan((ctx.viewCamera.fov * Math.PI) / 360);
      return out.set(viewPoint.x * k, viewPoint.y * k, viewPoint.z).applyMatrix4(ctx.camera.matrixWorld);
    },
    warm(object: THREE.Object3D, layer: 'world' | 'view' = 'world'): void {
      try {
        // compile() also visits hidden and detached objects and uses the target scene's lights / fog.
        if (layer === 'view') renderer.compile(object, ctx.viewCamera, ctx.viewScene);
        else renderer.compile(object, ctx.camera, ctx.scene);
      } catch {
        // Warming is an optimisation: it must never fail a boot.
      }
    },
    dispose(): void {
      ctx.scene.remove(root);
      ctx.viewScene.remove(viewRoot);
      renderer.dispose();
    },
  };
  return system;
}
