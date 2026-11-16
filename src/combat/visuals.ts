/**
 * Projectile meshes. Solid ordnance (rocket, grenade, mortar shell, boss missile) is one InstancedMesh per
 * kind on one shared lit material; everything that glows — plasma and light bolts, boss bolts, engine
 * flares, seeker heads, the grenade's fuse light — is an instance of ONE additive soft-volume mesh.
 * At most five draw calls for any number of projectiles, and none while nothing flies.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_PROJECTILES, RENDER_ORDER } from '../core/constants';
import { TAU } from '../core/math';
import { PALETTE } from '../core/palette';
import { RESTING } from './projectiles';
import type { Projectile } from './projectiles';

export interface ProjectileVisuals {
  /** Parent of every projectile mesh (added to the combat root). */
  readonly group: THREE.Group;
  /** Write the instance buffers from the live projectiles (dead entries are skipped). */
  sync(live: readonly Projectile[]): void;
  /** Draw nothing until the next sync. */
  hide(): void;
  dispose(): void;
}

/** Kinds that have a solid body. The others are pure energy. */
type SolidKind = 'rocket' | 'grenade' | 'mortar' | 'bossMissile';
const SOLID_KINDS: readonly SolidKind[] = ['rocket', 'grenade', 'mortar', 'bossMissile'];
/** Every projectile lights at most two glow volumes. */
const GLOWS_PER_PROJECTILE = 2;
const GLOW_CAPACITY = MAX_PROJECTILES * GLOWS_PER_PROJECTILE;

const GLOW_VERTEX = /* glsl */ `
attribute float aCore;
varying vec3 vObj;
varying vec3 vEye;
varying vec3 vGlow;
varying float vCore;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  mat4 toView = modelViewMatrix * instanceMatrix;
  vec4 mvPosition = toView * vec4(position, 1.0);
  vObj = position;
  // The eye in the space of the unit sphere: the glow is evaluated there, so any stretch stays a soft volume.
  vEye = (inverse(toView) * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vGlow = instanceColor;
  vCore = aCore;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const GLOW_FRAGMENT = /* glsl */ `
varying vec3 vObj;
varying vec3 vEye;
varying vec3 vGlow;
varying float vCore;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  // Half the chord the view ray cuts through the unit sphere: 0 at the silhouette, 1 through the centre.
  vec3 ray = normalize(vObj - vEye);
  float along = dot(-vEye, ray);
  float miss2 = dot(vEye, vEye) - along * along;
  float h2 = max(0.0, 1.0 - miss2);
  // Soft body that is dark at the rim, and a small white-hot heart.
  float halo = h2 * h2;
  float core = halo * halo * halo * halo * vCore;
  float peak = max(vGlow.r, max(vGlow.g, vGlow.b));
  vec3 hot = mix(vGlow, vec3(peak), 0.55) * 1.3;
  // Linear scene-referred colour; render tone-maps once in its final pass.
  gl_FragColor = vec4(vGlow + hot * core, halo);
  #include <fog_fragment>
}
`;

/** Bake a colour into every vertex of a primitive (after an optional transform). */
function tinted(geometry: THREE.BufferGeometry, hex: number, transform?: THREE.Matrix4): THREE.BufferGeometry {
  if (transform) geometry.applyMatrix4(transform);
  geometry.deleteAttribute('uv');
  const color = new THREE.Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const at = (x: number, y: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, y, z);

/** `count` fins around the Y axis at `radius`, each `thick` x `length` (along Y) x `span` (outward). */
function fins(
  count: number,
  radius: number,
  y: number,
  thick: number,
  length: number,
  span: number,
  hex: number,
): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const turn = new THREE.Matrix4().makeRotationY((i / count) * TAU);
    parts.push(tinted(new THREE.BoxGeometry(thick, length, span), hex, turn.multiply(at(0, y, radius))));
  }
  return parts;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error('combat: projectile geometry could not be merged');
  return geometry;
}

// All bodies point along +Y (their flight direction).

/** HORNET micro-missile: off-white nose, graphite body, cyan collar, four fins. */
function rocketGeometry(): THREE.BufferGeometry {
  return merged([
    tinted(new THREE.CylinderGeometry(0.062, 0.062, 0.36, 10), PALETTE.weaponGraphite),
    tinted(new THREE.ConeGeometry(0.062, 0.18, 10), PALETTE.weaponShell, at(0, 0.27, 0)),
    tinted(new THREE.CylinderGeometry(0.071, 0.071, 0.035, 10), PALETTE.player, at(0, 0.13, 0)),
    tinted(new THREE.CylinderGeometry(0.062, 0.044, 0.07, 10), PALETTE.hullDark, at(0, -0.215, 0)),
    ...fins(4, 0.092, -0.15, 0.012, 0.14, 0.08, PALETTE.weaponShell),
  ]);
}

/** Frag grenade: a chunky canister with a pale band and a fuse cap. */
function grenadeGeometry(): THREE.BufferGeometry {
  return merged([
    tinted(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 10), PALETTE.weaponGraphite),
    tinted(new THREE.CylinderGeometry(0.048, 0.075, 0.035, 10), PALETTE.hullDark, at(0, 0.0775, 0)),
    tinted(new THREE.CylinderGeometry(0.075, 0.048, 0.035, 10), PALETTE.hullDark, at(0, -0.0775, 0)),
    tinted(new THREE.CylinderGeometry(0.081, 0.081, 0.032, 10), PALETTE.weaponShell),
    tinted(new THREE.CylinderGeometry(0.028, 0.028, 0.04, 8), PALETTE.weaponShell, at(0, 0.115, 0)),
  ]);
}

/** Bulwark mortar shell: a heavy gunmetal teardrop with a collar and tail fins. */
function mortarGeometry(): THREE.BufferGeometry {
  return merged([
    tinted(new THREE.SphereGeometry(0.19, 10, 5, 0, TAU, 0, Math.PI / 2), PALETTE.gunmetal, at(0, 0.12, 0)),
    tinted(new THREE.CylinderGeometry(0.19, 0.19, 0.24, 10), PALETTE.gunmetalLight),
    tinted(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 10), PALETTE.hullDark, at(0, 0.04, 0)),
    tinted(new THREE.CylinderGeometry(0.19, 0.07, 0.26, 10), PALETTE.gunmetalLight, at(0, -0.25, 0)),
    ...fins(4, 0.125, -0.33, 0.016, 0.17, 0.14, PALETTE.gunmetal),
  ]);
}

/** Conductor missile: long dark body, seeker dome, swept fins. */
function missileGeometry(): THREE.BufferGeometry {
  return merged([
    tinted(new THREE.CylinderGeometry(0.11, 0.11, 0.62, 10), PALETTE.gunmetalLight),
    tinted(new THREE.SphereGeometry(0.11, 10, 5, 0, TAU, 0, Math.PI / 2), PALETTE.hullDark, at(0, 0.31, 0)),
    tinted(new THREE.CylinderGeometry(0.125, 0.125, 0.05, 10), PALETTE.gunmetal, at(0, 0.12, 0)),
    tinted(new THREE.CylinderGeometry(0.11, 0.14, 0.1, 10), PALETTE.gunmetal, at(0, -0.36, 0)),
    ...fins(3, 0.17, -0.27, 0.016, 0.24, 0.17, PALETTE.gunmetal),
  ]);
}

const BODY_GEOMETRY: Readonly<Record<SolidKind, () => THREE.BufferGeometry>> = {
  rocket: rocketGeometry,
  grenade: grenadeGeometry,
  mortar: mortarGeometry,
  bossMissile: missileGeometry,
};

/** One glow volume of a projectile, in metres along its heading. */
interface GlowSpec {
  /** Centre this far BEHIND the drawn position (negative = ahead). */
  back: number;
  /** Radius across the heading and half-length along it. */
  radial: number;
  half: number;
  /** Brightness of the accent colour (above 1 blooms). */
  gain: number;
  /** 0..1: how white-hot the centre burns. */
  core: number;
}

// Engines burn in a streak behind the tail; collars and seekers are thin discs hugging the body, so the
// accent reads without drowning the silhouette; bolts are a hot head dragging a tail.
const ROCKET_FLAME: GlowSpec = { back: 0.45, radial: 0.09, half: 0.3, gain: 1.7, core: 1 };
const ROCKET_NOZZLE: GlowSpec = { back: 0.26, radial: 0.19, half: 0.09, gain: 1.5, core: 0.8 };
const GRENADE_BAND: GlowSpec = { back: 0, radial: 0.118, half: 0.032, gain: 2.2, core: 0.7 };
const GRENADE_HALO: GlowSpec = { back: 0, radial: 0.25, half: 0.25, gain: 0.6, core: 0 };
const MORTAR_COLLAR: GlowSpec = { back: -0.04, radial: 0.34, half: 0.07, gain: 2.3, core: 0.5 };
const MORTAR_TAIL: GlowSpec = { back: 0.5, radial: 0.1, half: 0.2, gain: 1.4, core: 0.8 };
const MISSILE_SEEKER: GlowSpec = { back: -0.37, radial: 0.2, half: 0.14, gain: 2.1, core: 0.6 };
const MISSILE_FLAME: GlowSpec = { back: 0.72, radial: 0.11, half: 0.34, gain: 1.7, core: 1 };
const PLASMA_TAIL: GlowSpec = { back: 0.75, radial: 0.17, half: 0.9, gain: 1.2, core: 0.3 };
const PLASMA_HEAD: GlowSpec = { back: 0, radial: 0.36, half: 0.42, gain: 1.6, core: 0.7 };
const LIGHT_STREAK: GlowSpec = { back: 0.55, radial: 0.1, half: 0.72, gain: 1.5, core: 0.4 };
const LIGHT_HEAD: GlowSpec = { back: 0, radial: 0.2, half: 0.24, gain: 1.6, core: 0.8 };
const BOSS_ORB: GlowSpec = { back: 0, radial: 0.6, half: 0.6, gain: 1.3, core: 0.2 };
const BOSS_CORE: GlowSpec = { back: 0.3, radial: 0.27, half: 0.75, gain: 1.8, core: 1 };

/**
 * Work registers of sync(). The per-projectile helpers take their numbers from here instead of
 * parameters: a fractional argument of a call that is not inlined would be boxed, every frame.
 * [0..8] the orientation basis (columns X, Y = heading, Z) · ROLL angle · GAIN and SWELL multipliers.
 */
const ROLL = 9;
const GAIN = 10;
const SWELL = 11;

export function createProjectileVisuals(): ProjectileVisuals {
  const group = new THREE.Group();
  group.name = 'projectiles';

  const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
  bodyMaterial.name = 'combat-ordnance';
  const bodies = {} as Record<SolidKind, THREE.InstancedMesh>;
  for (const kind of SOLID_KINDS) {
    const mesh = new THREE.InstancedMesh(BODY_GEOMETRY[kind](), bodyMaterial, MAX_PROJECTILES);
    mesh.name = `projectile:${kind}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Instances are anywhere in the world: the mesh origin says nothing about them.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = RENDER_ORDER.OPAQUE;
    mesh.count = 0;
    mesh.visible = false;
    bodies[kind] = mesh;
    group.add(mesh);
  }

  // A unit sphere, slightly oversized so its facets enclose the true sphere the shader evaluates;
  // positions only, welded and indexed (the vertex shader inverts a matrix: fewer vertices, less work).
  const faceted = new THREE.IcosahedronGeometry(1.06, 2);
  faceted.deleteAttribute('uv');
  faceted.deleteAttribute('normal');
  const glowGeometry = mergeVertices(faceted);
  faceted.dispose();
  const glowCore = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAPACITY), 1);
  glowCore.setUsage(THREE.DynamicDrawUsage);
  glowGeometry.setAttribute('aCore', glowCore);
  const glowMaterial = new THREE.ShaderMaterial({
    name: 'combat-glow',
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.InstancedMesh(glowGeometry, glowMaterial, GLOW_CAPACITY);
  glow.name = 'projectile:glow';
  glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const glowColor = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAPACITY * 3), 3);
  glowColor.setUsage(THREE.DynamicDrawUsage);
  glow.instanceColor = glowColor;
  glow.frustumCulled = false;
  glow.castShadow = false;
  glow.receiveShadow = false;
  glow.renderOrder = RENDER_ORDER.FX_ADDITIVE;
  glow.count = 0;
  glow.visible = false;
  group.add(glow);

  /** Accent hex -> linear colour (hex colours reach an attribute only through THREE.Color). */
  const palette = new Map<number, THREE.Color>();
  for (const hex of [PALETTE.player, PALETTE.enemy, PALETTE.elite]) palette.set(hex, new THREE.Color(hex));
  const linear = (hex: number): THREE.Color => {
    let color = palette.get(hex);
    if (!color) {
      color = new THREE.Color(hex);
      palette.set(hex, color);
    }
    return color;
  };

  const w = new Float64Array(12);
  const glowMatrices = glow.instanceMatrix.array;
  const glowColors = glowColor.array;
  const glowCores = glowCore.array;
  const bodyCount: Record<SolidKind, number> = { rocket: 0, grenade: 0, mortar: 0, bossMissile: 0 };
  let glowCount = 0;

  /** Basis whose Y column is the heading, rolled about it by w[ROLL]. */
  const aim = (dir: THREE.Vector3): void => {
    const yx = dir.x;
    const yy = dir.y;
    const yz = dir.z;
    // Any vector off the heading gives a side axis: world up, or world X when flying straight up or down.
    let xx: number;
    let xy: number;
    let xz: number;
    if (Math.abs(yy) < 0.99) {
      xx = yz;
      xy = 0;
      xz = -yx;
    } else {
      xx = 0;
      xy = -yz;
      xz = yy;
    }
    const len = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= len;
    xy /= len;
    xz /= len;
    // Z = X x Y completes the right-handed frame.
    const zx = xy * yz - xz * yy;
    const zy = xz * yx - xx * yz;
    const zz = xx * yy - xy * yx;
    const roll = w[ROLL] as number;
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    w[0] = xx * c + zx * s;
    w[1] = xy * c + zy * s;
    w[2] = xz * c + zz * s;
    w[3] = yx;
    w[4] = yy;
    w[5] = yz;
    w[6] = zx * c - xx * s;
    w[7] = zy * c - xy * s;
    w[8] = zz * c - xz * s;
  };

  /** Basis of a rotation by w[ROLL] about a unit axis (a tumbling shell). */
  const tumble = (axis: THREE.Vector3): void => {
    const angle = w[ROLL] as number;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const k = 1 - c;
    const x = axis.x;
    const y = axis.y;
    const z = axis.z;
    w[0] = c + x * x * k;
    w[1] = y * x * k + z * s;
    w[2] = z * x * k - y * s;
    w[3] = x * y * k - z * s;
    w[4] = c + y * y * k;
    w[5] = z * y * k + x * s;
    w[6] = x * z * k + y * s;
    w[7] = y * z * k - x * s;
    w[8] = c + z * z * k;
  };

  /** One body instance of `kind` at the drawn position, oriented by the basis in `w`. */
  const putBody = (kind: SolidKind, p: Projectile): void => {
    const out = bodies[kind].instanceMatrix.array;
    const o = bodyCount[kind]++ * 16;
    const at = p.drawPos;
    out[o] = w[0] as number;
    out[o + 1] = w[1] as number;
    out[o + 2] = w[2] as number;
    out[o + 3] = 0;
    out[o + 4] = w[3] as number;
    out[o + 5] = w[4] as number;
    out[o + 6] = w[5] as number;
    out[o + 7] = 0;
    out[o + 8] = w[6] as number;
    out[o + 9] = w[7] as number;
    out[o + 10] = w[8] as number;
    out[o + 11] = 0;
    out[o + 12] = at.x;
    out[o + 13] = at.y;
    out[o + 14] = at.z;
    out[o + 15] = 1;
  };

  /**
   * One glow volume of `p`: the spec's ellipsoid along the heading in `w`, its size times w[SWELL], in
   * the accent colour times the spec's gain times w[GAIN].
   */
  const putGlow = (p: Projectile, spec: GlowSpec): void => {
    if (glowCount >= GLOW_CAPACITY) return;
    const i = glowCount++;
    const o = i * 16;
    const swell = w[SWELL] as number;
    const radial = spec.radial * swell;
    const half = spec.half * swell;
    const at = p.drawPos;
    const dir = p.dir;
    glowMatrices[o] = (w[0] as number) * radial;
    glowMatrices[o + 1] = (w[1] as number) * radial;
    glowMatrices[o + 2] = (w[2] as number) * radial;
    glowMatrices[o + 3] = 0;
    glowMatrices[o + 4] = (w[3] as number) * half;
    glowMatrices[o + 5] = (w[4] as number) * half;
    glowMatrices[o + 6] = (w[5] as number) * half;
    glowMatrices[o + 7] = 0;
    glowMatrices[o + 8] = (w[6] as number) * radial;
    glowMatrices[o + 9] = (w[7] as number) * radial;
    glowMatrices[o + 10] = (w[8] as number) * radial;
    glowMatrices[o + 11] = 0;
    glowMatrices[o + 12] = at.x - dir.x * spec.back;
    glowMatrices[o + 13] = at.y - dir.y * spec.back;
    glowMatrices[o + 14] = at.z - dir.z * spec.back;
    glowMatrices[o + 15] = 1;
    const color = linear(p.accent);
    const gain = spec.gain * (w[GAIN] as number);
    glowColors[i * 3] = color.r * gain;
    glowColors[i * 3 + 1] = color.g * gain;
    glowColors[i * 3 + 2] = color.b * gain;
    glowCores[i] = spec.core;
  };

  const commit = (): void => {
    for (const kind of SOLID_KINDS) {
      const mesh = bodies[kind];
      const n = bodyCount[kind];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    glow.count = glowCount;
    glow.visible = glowCount > 0;
    if (glowCount > 0) {
      glow.instanceMatrix.needsUpdate = true;
      glowColor.needsUpdate = true;
      glowCore.needsUpdate = true;
    }
  };

  return {
    group,

    sync(live: readonly Projectile[]): void {
      bodyCount.rocket = bodyCount.grenade = bodyCount.mortar = bodyCount.bossMissile = 0;
      glowCount = 0;
      for (let n = 0; n < live.length; n++) {
        const p = live[n] as Projectile;
        if (!p.alive) continue;
        // Engines and plasma never burn perfectly steady.
        const flicker = 0.88 + 0.12 * Math.sin(p.age * 43 + p.seed * 40);
        w[SWELL] = 1;
        w[GAIN] = flicker;
        switch (p.kind) {
          case 'rocket':
            w[ROLL] = p.age * 9 + p.seed * TAU;
            aim(p.dir);
            putBody('rocket', p);
            putGlow(p, ROCKET_FLAME);
            putGlow(p, ROCKET_NOZZLE);
            break;
          case 'grenade': {
            w[ROLL] = p.travelled * 3.2 + p.seed * TAU;
            tumble(p.spinAxis);
            putBody('grenade', p);
            // The fuse light blinks faster and faster as the fuse runs down.
            const run = p.fuse > 0 ? p.age / p.fuse : 0;
            const wave = 0.5 + 0.5 * Math.cos(TAU * p.age * (2 + 3.5 * run));
            w[GAIN] = 0.15 + 0.85 * wave * wave * wave;
            putGlow(p, GRENADE_BAND);
            putGlow(p, GRENADE_HALO);
            break;
          }
          case 'mortar': {
            w[ROLL] = 0;
            aim(p.dir);
            putBody('mortar', p);
            // The collar pulses harder once the shell is on its way down.
            const falling = p.vel.y < 0 && p.state !== RESTING ? 1 : 0;
            w[GAIN] = (0.7 + falling * 0.3) * (0.75 + 0.25 * Math.sin(p.age * (falling ? 30 : 12)));
            putGlow(p, MORTAR_COLLAR);
            w[GAIN] = flicker;
            putGlow(p, MORTAR_TAIL);
            break;
          }
          case 'bossMissile':
            w[ROLL] = p.age * 5 + p.seed * TAU;
            aim(p.dir);
            putBody('bossMissile', p);
            // A hard seeker blink: this one can be shot.
            w[GAIN] = 0.6 + 0.4 * Math.sin(p.age * 38);
            putGlow(p, MISSILE_SEEKER);
            w[GAIN] = flicker;
            putGlow(p, MISSILE_FLAME);
            break;
          case 'plasmaBolt':
            w[ROLL] = 0;
            aim(p.dir);
            putGlow(p, PLASMA_TAIL);
            putGlow(p, PLASMA_HEAD);
            break;
          case 'lightBolt':
            w[ROLL] = 0;
            aim(p.dir);
            putGlow(p, LIGHT_STREAK);
            putGlow(p, LIGHT_HEAD);
            break;
          case 'bossBolt':
            w[ROLL] = 0;
            aim(p.dir);
            w[GAIN] = 1;
            w[SWELL] = 1 + 0.08 * Math.sin(p.age * 21 + p.seed * TAU);
            putGlow(p, BOSS_ORB);
            w[GAIN] = flicker;
            w[SWELL] = 1;
            putGlow(p, BOSS_CORE);
            break;
        }
      }
      commit();
    },

    hide(): void {
      bodyCount.rocket = bodyCount.grenade = bodyCount.mortar = bodyCount.bossMissile = 0;
      glowCount = 0;
      commit();
    },

    dispose(): void {
      for (const kind of SOLID_KINDS) {
        bodies[kind].geometry.dispose();
        bodies[kind].dispose();
      }
      glowGeometry.dispose();
      glow.dispose();
      bodyMaterial.dispose();
      glowMaterial.dispose();
      group.clear();
    },
  };
}
