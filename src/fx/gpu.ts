/**
 * GPU plumbing shared by every FX batch: one instanced quad mesh per batch, one interleaved instance
 * buffer per mesh, written at most once per rendered frame. A batch with zero instances issues no draw
 * call, so every mesh stays visible (and is fully uploaded by the first frame — nothing hitches later).
 */
import * as THREE from 'three';

/** Uniform objects shared by reference between the FX materials. */
export interface SharedUniforms {
  /** Seconds of world time since the last clear(). */
  uTime: { value: number };
  /** Canvas size in CSS pixels (minimum-width clamps of thin streaks). */
  uViewport: { value: THREE.Vector2 };
  /** Approximate scene light on a matte surface (smoke, dust, debris, decal chips). */
  uLight: { value: THREE.Vector3 };
}

/** Unit quad in the XY plane, corners at +-0.5, shared by every batch. */
export function makeQuad(): { position: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const position = new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3);
  const index = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);
  return { position, index };
}

export class InstancedBatch {
  readonly mesh: THREE.Mesh;
  /** Instance data, `stride` floats per instance. */
  readonly data: Float32Array;
  readonly capacity: number;
  /** Instances committed last. */
  count = 0;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  /** The one upload range of this batch, reused every frame (three clears the list after each upload). */
  private readonly range = { start: 0, count: 0 };

  /**
   * @param layout attribute name + item size, in buffer order (the sizes must add up to `stride`)
   */
  constructor(
    name: string,
    capacity: number,
    readonly stride: number,
    layout: readonly (readonly [string, number])[],
    material: THREE.Material,
    renderOrder: number,
    quad: { position: THREE.BufferAttribute; index: THREE.BufferAttribute },
  ) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * stride);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', quad.position);
    this.geometry.setIndex(quad.index);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, stride, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    let offset = 0;
    for (const [attribute, size] of layout) {
      this.geometry.setAttribute(attribute, new THREE.InterleavedBufferAttribute(this.buffer, size, offset));
      offset += size;
    }
    this.geometry.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = renderOrder;
  }

  /** Draw the first `count` instances of `data` from the next frame on (uploads only that part). */
  commit(count: number): void {
    const n = count < 0 ? 0 : count > this.capacity ? this.capacity : count;
    this.count = n;
    this.geometry.instanceCount = n;
    if (n > 0) {
      const ranges = this.buffer.updateRanges;
      if (ranges.length !== 1 || ranges[0] !== this.range) {
        ranges.length = 0;
        ranges.push(this.range);
      }
      this.range.count = n * this.stride;
      this.buffer.needsUpdate = true;
    }
  }

  /** Stop drawing without touching the buffer (clear()). */
  hide(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

export interface FxMaterialOptions {
  name: string;
  vertex: string;
  fragment: string;
  uniforms: Record<string, THREE.IUniform>;
  /** 'add' = pure additive light; 'over' = premultiplied alpha (rgb + dst * (1 - a)). */
  blend: 'add' | 'over';
  depthTest?: boolean;
  /** Decals and telegraphs: pull toward the camera so they never z-fight with their surface. */
  polygonOffset?: boolean;
  fog?: boolean;
}

/**
 * ShaderMaterial following the rendering conventions: linear HDR output, no tone mapping, fog aware,
 * depthWrite off. The destination alpha is never touched.
 */
export function fxMaterial(options: FxMaterialOptions): THREE.ShaderMaterial {
  const fog = options.fog ?? true;
  const uniforms: Record<string, THREE.IUniform> = fog
    ? { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...options.uniforms }
    : { ...options.uniforms };
  const material = new THREE.ShaderMaterial({
    name: options.name,
    vertexShader: options.vertex,
    fragmentShader: options.fragment,
    uniforms,
    fog,
    transparent: true,
    depthWrite: false,
    depthTest: options.depthTest ?? true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: options.blend === 'add' ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  if (options.polygonOffset) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
  }
  return material;
}
