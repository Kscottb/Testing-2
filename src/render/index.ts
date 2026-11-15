// STUB: replaced by the render team
import * as THREE from 'three';
import { QUALITY } from '../data/quality';
import { TIME_OF_DAY } from '../data/timeOfDay';
import { damp } from '../core/math';
import type { GameContext, LightingState, PostFxParams, QualityPreset, RenderStats, RenderSystem, ScreenPoint, TimeOfDayId, Vec3Like } from '../core/types';

/** Gray-box renderer: forward pass for the world, cleared depth, then the first-person layer. No post. */
export function createRenderSystem(ctx: GameContext): RenderSystem {
  let renderer!: THREE.WebGLRenderer;
  let quality: QualityPreset = ctx.settings.data.quality;
  let timeOfDay: TimeOfDayId = 'dusk';
  let width = 1;
  let height = 1;
  let orbit = 0;
  const post: PostFxParams = { damageFlash: 0, flash: 0, flashColor: 0xffffff, chromaticBoost: 0, lowHealth: 0, overclock: 0, dashBlur: 0, adsVignette: 0, saturation: 1, exposure: 1 };
  const stats: RenderStats = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, pixelRatio: 1, renderMs: 0 };
  const lighting = { sunDirection: new THREE.Vector3(0.4, 0.6, 0.5).normalize(), sunColor: new THREE.Color(), sunIntensity: 3, ambientColor: new THREE.Color(), ambientIntensity: 1, fogColor: new THREE.Color(), fogDensity: 0.003, storm: 0, night: 0 };
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
  const viewSun = new THREE.DirectionalLight(0xffffff, 2.5);
  const viewHemi = new THREE.HemisphereLight(0xffffff, 0x333333, 1.2);
  const projected = new THREE.Vector3();
  const background = new THREE.Color();

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
    get qualityParams() {
      return QUALITY[quality];
    },
    resolutionScale: 1,
    post,
    get timeOfDay() {
      return timeOfDay;
    },
    lighting: lighting as LightingState,
    stats,
    init(): void {
      renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.autoClear = false;
      renderer.info.autoReset = false;
      ctx.scene.background = background;
      ctx.scene.add(sun, hemi);
      viewSun.position.set(0.5, 1, 0.8);
      ctx.viewScene.add(viewSun, viewHemi);
      ctx.events.on('settings:changed', (e) => {
        if (e.key === 'quality') system.setQuality(e.data.quality);
      });
      applyTimeOfDay();
      system.resize();
    },
    reset(): void {
      Object.assign(post, { damageFlash: 0, flash: 0, chromaticBoost: 0, lowHealth: 0, overclock: 0, dashBlur: 0, adsVignette: 0, saturation: 1, exposure: 1 });
      system.setTimeOfDay('dusk', 0);
    },
    update(realDt: number): void {
      post.damageFlash = damp(post.damageFlash, 0, 3, realDt);
      post.flash = damp(post.flash, 0, 2.5, realDt);
      post.chromaticBoost = damp(post.chromaticBoost, 0, 3, realDt);
      const mode = ctx.game.mode;
      if (mode === 'menu' || mode === 'gameover' || mode === 'victory') {
        // Cinematic ownership: slow orbit around the first cinematic target (or the player's body).
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
    setQuality(preset: QualityPreset): void {
      quality = preset;
      system.resize();
      ctx.events.emit('quality:changed', { preset, params: QUALITY[preset] });
    },
    setTimeOfDay(id: TimeOfDayId, seconds = 0): void {
      const prev = timeOfDay;
      timeOfDay = id;
      applyTimeOfDay();
      if (prev !== id) ctx.events.emit('timeOfDay:changed', { id, prev, seconds });
    },
    lightningFlash(): void {},
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
    dispose(): void {
      ctx.scene.remove(sun, hemi);
      ctx.viewScene.remove(viewSun, viewHemi);
      renderer.dispose();
    },
  };
  return system;
}
