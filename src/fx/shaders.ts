/**
 * GLSL of the FX batches. Every shader outputs LINEAR scene-referred colour (no tone mapping, no colour
 * space conversion) and sits in the scene fog: light that is ADDED fades to nothing with the fog factor
 * (mixing an additive layer toward the fog colour would add the fog a second time), covering layers mix
 * toward the fog colour like any surface.
 */

/** Fragment helpers: fog factor and the two output forms. Needs vFogDepth from the fog chunks. */
const FOG_FRAGMENT = /* glsl */ `
#include <fog_pars_fragment>
float fxFog() {
#ifdef USE_FOG
  #ifdef FOG_EXP2
    return 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    return smoothstep(fogNear, fogFar, vFogDepth);
  #endif
#else
  return 0.0;
#endif
}
// Pure light.
vec4 fxAdd(vec3 rgb) {
  return vec4(rgb * (1.0 - fxFog()), 0.0);
}
// Premultiplied cover (rgb is already multiplied by its coverage a) plus extra light on top.
vec4 fxOver(vec3 rgb, float a, vec3 glow) {
  float f = fxFog();
#ifdef USE_FOG
  rgb = mix(rgb, fogColor * a, f);
#endif
  return vec4(rgb + glow * (1.0 - f), a);
}
`;

// ---------------------------------------------------------------------------------------------------
// Particles: camera-facing, velocity-stretched or plane-aligned quads sampling the sprite atlas.
// ---------------------------------------------------------------------------------------------------

export const PARTICLE_VERTEX = /* glsl */ `
attribute vec4 aPosSize;
attribute vec4 aAxisRot;
attribute vec4 aColor;
attribute vec4 aMisc;
uniform vec2 uViewport;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vFx;
#include <fog_pars_vertex>
void main() {
  vec2 c = position.xy;
  float size = aPosSize.w;
  vec4 mvCenter = viewMatrix * vec4(aPosSize.xyz, 1.0);
  vec4 mvPosition = mvCenter;
  float mode = aMisc.y;
  float soft = 1.0;
  if (mode < 0.5) {
    // Billboard: expand in view space, rotate around the view axis.
    float s = sin(aAxisRot.w);
    float co = cos(aAxisRot.w);
    vec2 q = vec2(c.x * aMisc.w, c.y);
    vec2 r = vec2(q.x * co - q.y * s, q.x * s + q.y * co) * size;
    mvPosition.xy += r;
    // Height of this corner above the floor of the effect: the fragment fades toward the floor
    // instead of being cut by it (soft particles without a depth texture).
    float worldY = aPosSize.y + r.x * viewMatrix[1][0] + r.y * viewMatrix[1][1];
    soft = (worldY - aAxisRot.x) / max(0.1, size * 0.16);
  } else if (mode < 1.5) {
    // Streak: head at the particle, tail along the axis, facing the camera around that axis.
    vec3 p0 = mvCenter.xyz;
    vec3 p1 = p0 + (viewMatrix * vec4(aAxisRot.xyz, 0.0)).xyz;
    vec3 d = p1 - p0;
    float len = length(d);
    vec3 dn = len > 1e-5 ? d / len : vec3(1.0, 0.0, 0.0);
    vec3 pe = c.x < 0.0 ? p1 : p0;
    vec3 side = cross(dn, pe);
    float sl = length(side);
    side = sl > 1e-6 ? side / sl : vec3(0.0, 1.0, 0.0);
    // Sparks stay at least a pixel and a half wide however far away they are.
    float px = 2.0 * max(-pe.z, 0.1) / (projectionMatrix[1][1] * max(uViewport.y, 1.0));
    float hw = max(size * 0.5, px * 0.75);
    mvPosition.xyz = pe + side * (c.y * 2.0 * hw) + dn * (c.x < 0.0 ? hw : -hw);
  } else {
    // Aligned: the quad lies in the plane perpendicular to the axis (ground rings).
    vec3 n = normalize(aAxisRot.xyz);
    vec3 t = normalize(abs(n.y) < 0.99 ? cross(vec3(0.0, 1.0, 0.0), n) : cross(vec3(1.0, 0.0, 0.0), n));
    vec3 b = cross(n, t);
    float s = sin(aAxisRot.w);
    float co = cos(aAxisRot.w);
    vec2 r = vec2(c.x * co - c.y * s, c.x * s + c.y * co) * size;
    mvPosition = viewMatrix * vec4(aPosSize.xyz + t * r.x + b * r.y, 1.0);
  }
  gl_Position = projectionMatrix * mvPosition;
  float cell = aMisc.x;
  vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + c + 0.5) * 0.25;
  vColor = aColor;
  // Cloud sprites (smoke, fire, wisp) dissolve by erosion instead of fading evenly.
  float erode = (cell > 1.5 && cell < 4.5) || (cell > 10.5 && cell < 11.5) ? 1.0 : 0.0;
  // Fade out particles the camera is about to pass through (no popping, less overdraw).
  float near = smoothstep(0.0, 1.0, (-mvCenter.z - 0.12) / max(0.3, size * 0.4));
  vFx = vec4(erode, aMisc.z, near, soft);
  #include <fog_vertex>
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLight;
uniform float uLit;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vFx;
${FOG_FRAGMENT}
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  float m = t.r;
  float a = vColor.a;
  if (vFx.x > 0.5) {
    float e = (1.0 - clamp(a, 0.0, 1.0)) * 0.7;
    m = smoothstep(e, e + 0.32, t.r);
    a = min(1.0, a * 1.7);
  }
  float cov = m * a * vFx.z * smoothstep(0.0, 1.0, vFx.w);
  if (cov < 0.003) discard;
  if (uLit > 0.5) {
    vec3 lit = vColor.rgb * mix(uLight * (0.45 + 0.65 * t.g), vec3(1.0), vFx.y);
    lit += vColor.rgb * (t.b * vFx.y);
    gl_FragColor = fxOver(lit * cov, cov, vec3(0.0));
  } else {
    float lum = dot(vColor.rgb, vec3(0.3333));
    gl_FragColor = fxAdd((vColor.rgb * (1.0 + 1.2 * t.b) + vec3(t.b * lum * 0.6)) * cov);
  }
}
`;

// ---------------------------------------------------------------------------------------------------
// Streaks: one camera-facing capsule per instance (tracers, beams, glow dots).
// ---------------------------------------------------------------------------------------------------

export const STREAK_VERTEX = /* glsl */ `
attribute vec4 aFrom;
attribute vec4 aTo;
attribute vec4 aColor;
attribute vec4 aParams;
uniform vec2 uViewport;
varying vec3 vLocal;
varying vec4 vColor;
varying vec4 vInfo;
varying float vHalf;
#include <fog_pars_vertex>
void main() {
  vec2 c = position.xy;
  vec3 p0 = (viewMatrix * vec4(aFrom.xyz, 1.0)).xyz;
  vec3 p1 = (viewMatrix * vec4(aTo.xyz, 1.0)).xyz;
  vec3 d = p1 - p0;
  float len = length(d);
  bool isDot = len < 1e-4;
  vec3 dn = isDot ? vec3(0.0, 1.0, 0.0) : d / len;
  vec3 pe = c.y < 0.0 ? p0 : p1;
  float halfCore = aFrom.w * 0.5;
  float halfW = halfCore * aParams.z;
  // Keep thin lines at least a few pixels wide, with a core that stays solid.
  float px = 2.0 * max(-pe.z, 0.1) / (projectionMatrix[1][1] * max(uViewport.y, 1.0));
  float minHalf = px * aParams.w;
  float coreFrac = halfCore / max(halfW, 1e-6);
  if (halfW < minHalf) {
    coreFrac = max(coreFrac, 0.45);
    halfW = minHalf;
  }
  vec3 side = vec3(1.0, 0.0, 0.0);
  if (!isDot) {
    side = cross(dn, pe);
    float sl = length(side);
    side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
  }
  vec4 mvPosition = vec4(pe + side * (c.x * 2.0 * halfW) + dn * (c.y * 2.0 * halfW), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vLocal = vec3(c.x * 2.0, c.y < 0.0 ? -halfW : len + halfW, len);
  vHalf = halfW;
  vColor = aColor;
  vInfo = vec4(aTo.w, aParams.x, aParams.y, coreFrac);
  #include <fog_vertex>
}
`;

export const STREAK_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec3 vLocal;
varying vec4 vColor;
varying vec4 vInfo;
varying float vHalf;
${FOG_FRAGMENT}
float h1(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}
float n1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(h1(i), h1(i + 1.0), f);
}
void main() {
  float style = vInfo.x;
  float prog = vInfo.y;
  float phase = vInfo.z;
  float coreF = vInfo.w;
  float x = vLocal.x;
  float y = vLocal.y;
  float len = vLocal.z;
  float hw = max(vHalf, 1e-5);
  float dy = max(max(-y, y - len), 0.0) / hw;
  float d = length(vec2(x, dy));
  if (d >= 1.0) discard;
  float glow = pow(1.0 - d, 2.4);
  float core = 1.0 - smoothstep(coreF * 0.55, coreF * 1.3, d);
  float along = clamp(y / max(len, 1e-4), 0.0, 1.0);
  float colour = 0.0;
  float white = 0.0;
  if (style < 0.5) {
    // Tracer: bright head, fading tail.
    float tail = pow(along, 1.5);
    colour = (glow * 0.6 + core) * tail;
    white = core * tail * 0.8;
  } else if (style < 1.5) {
    // Rail: core flash that thins out while a double helix unwinds around it.
    float flash = pow(1.0 - prog, 4.0);
    float fade = pow(1.0 - prog, 1.4);
    float thin = mix(1.0, 0.35, smoothstep(0.0, 0.5, prog));
    float c2 = 1.0 - smoothstep(coreF * thin * 0.55, coreF * thin * 1.3, d);
    float amp = mix(0.16, 0.84, pow(prog, 0.55));
    float ph = y * 4.6 - phase;
    float sw = 0.055 + 0.07 * prog;
    float e1 = (x - amp * sin(ph)) / sw;
    float e2 = (x + amp * sin(ph)) / sw;
    float ends = smoothstep(0.0, 0.4, y) * (1.0 - smoothstep(len - 0.4, len, y));
    float strands = (exp(-e1 * e1) * (0.6 + 0.4 * cos(ph)) + exp(-e2 * e2) * (0.6 - 0.4 * cos(ph))) * ends;
    colour = glow * (0.9 * flash + 0.12 * fade) + c2 * (0.8 + 1.6 * flash) * fade
      + strands * 0.8 * fade * smoothstep(0.02, 0.14, prog);
    white = c2 * (2.0 * flash + 0.35 * fade);
  } else if (style < 2.5) {
    // Laser shot: a hot flash that collapses.
    float fl = 0.75 + 0.25 * n1(y * 2.5 - uTime * 40.0 + phase);
    float fade = 1.0 - prog;
    colour = (glow * 0.8 + core * 1.2) * fl * fade;
    white = core * fade * fade * 1.4;
  } else if (style < 3.5) {
    // Lock laser: thin steady line with pulses running toward the target.
    float dash = 0.7 + 0.3 * sin(y * 5.0 - uTime * 26.0 + phase);
    colour = (glow * 0.35 + core * 1.1) * dash;
    white = core * 0.25;
  } else if (style < 4.5) {
    // Sweep: thick turbulent beam.
    float tu = n1(y * 1.7 - uTime * 14.0 + phase);
    float tv = n1(y * 5.1 + uTime * 9.0 + phase * 3.0);
    float cw = coreF * (0.8 + 0.5 * tu);
    float c3 = 1.0 - smoothstep(cw * 0.5, cw * 1.25, d);
    colour = pow(1.0 - d, 1.6) * (0.7 + 0.5 * tv) * 0.9 + c3 * 1.3;
    white = c3 * (0.9 + 0.4 * tu);
  } else {
    // Glow dot.
    colour = pow(1.0 - d, 2.2) * 0.8 + core * 0.9;
    white = core * 0.7;
  }
  float lum = dot(vColor.rgb, vec3(0.3333));
  gl_FragColor = fxAdd((vColor.rgb * colour + vec3(white * (0.3 + 0.7 * lum))) * vColor.a);
}
`;

// ---------------------------------------------------------------------------------------------------
// Ribbons: one instance per polyline segment; adjoining segments share the data of their joint.
// ---------------------------------------------------------------------------------------------------

export const RIBBON_VERTEX = /* glsl */ `
attribute vec4 aA;
attribute vec4 aTA;
attribute vec4 aB;
attribute vec4 aTB;
attribute vec4 aCA;
attribute vec4 aCB;
uniform vec2 uViewport;
varying vec4 vColor;
varying vec2 vRib;
#include <fog_pars_vertex>
void main() {
  vec2 c = position.xy;
  bool far = c.y > 0.0;
  vec4 P = far ? aB : aA;
  vec4 T = far ? aTB : aTA;
  vColor = far ? aCB : aCA;
  vec3 p = (viewMatrix * vec4(P.xyz, 1.0)).xyz;
  vec3 t = (viewMatrix * vec4(T.xyz, 0.0)).xyz;
  vec3 side = cross(t, p);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
  float hw = P.w;
  float core = 0.28;
  float px = 2.0 * max(-p.z, 0.1) / (projectionMatrix[1][1] * max(uViewport.y, 1.0));
  float minHw = px * 1.6;
  if (hw > 0.0 && hw < minHw) {
    core = mix(0.28, 0.7, clamp(1.0 - hw / minHw, 0.0, 1.0));
    hw = minHw;
  }
  vec4 mvPosition = vec4(p + side * (c.x * 2.0 * hw), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vRib = vec2(c.x * 2.0, core);
  #include <fog_vertex>
}
`;

export const RIBBON_FRAGMENT = /* glsl */ `
varying vec4 vColor;
varying vec2 vRib;
${FOG_FRAGMENT}
void main() {
  float ax = abs(vRib.x);
  float glow = pow(1.0 - ax, 2.2);
  float core = 1.0 - smoothstep(vRib.y * 0.5, vRib.y * 1.3, ax);
  float lum = dot(vColor.rgb, vec3(0.3333));
  gl_FragColor = fxAdd((vColor.rgb * (glow * 0.7 + core * 1.3) + vec3(core * lum * 0.9)) * vColor.a);
}
`;

// ---------------------------------------------------------------------------------------------------
// Telegraphs: flat ground markers drawn procedurally in metres (crisp at any radius).
// ---------------------------------------------------------------------------------------------------

export const TELEGRAPH_VERTEX = /* glsl */ `
attribute vec4 aCenter;
attribute vec4 aColor;
attribute vec4 aParams;
varying vec2 vP;
varying vec4 vColor;
varying vec4 vParams;
varying float vRadius;
#include <fog_pars_vertex>
void main() {
  float ext = aCenter.w * 1.06 + 0.45;
  vP = position.xy * (2.0 * ext);
  vec4 mvPosition = viewMatrix * vec4(aCenter.xyz + vec3(vP.x, 0.0, vP.y), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vColor = aColor;
  vParams = aParams;
  vRadius = aCenter.w;
  #include <fog_vertex>
}
`;

export const TELEGRAPH_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vP;
varying vec4 vColor;
varying vec4 vParams;
varying float vRadius;
${FOG_FRAGMENT}
const float TAU = 6.2831853;
// Anti-aliased band of half width w around d = 0; aa = size of a pixel in the units of d.
float band(float d, float w, float aa) {
  return 1.0 - smoothstep(w - aa, w + aa, abs(d));
}
float soft(float d, float w) {
  float k = d / w;
  return exp(-k * k);
}
void main() {
  float kind = vParams.x;
  float prog = clamp(vParams.y, 0.0, 1.0);
  float phase = vParams.z;
  float R = max(vRadius, 0.01);
  float r = length(vP);
  float ang = atan(vP.y, vP.x);
  // Pixel footprint in metres, continuous everywhere (unlike fwidth of a wrapped angle).
  float px = max(length(dFdx(vP)), length(dFdy(vP)));
  px = max(px, 1e-4);
  float lw = max(clamp(R * 0.02, 0.03, 0.09), px * 0.9);
  float inside = 1.0 - smoothstep(R - px, R + px, r);
  float rim = band(r - R, lw, px) + soft(r - R, lw * 3.0) * 0.25;
  float edge = R * prog;
  float filled = 1.0 - smoothstep(edge - px, edge + px, r);
  float line = 0.0;
  float fill = 0.0;
  if (kind < 0.5) {
    // ring
    line = rim;
  } else if (kind < 1.5) {
    // circle: outline + a disc that fills from the centre
    line = rim + band(r - edge, lw * 0.8, px) * 0.8 * step(0.02, prog) * inside;
    fill = inside * (0.07 + 0.3 * filled);
  } else if (kind < 2.5) {
    // spawn: double ring, rotating ticks, an inner ring closing in on the centre
    float inner = R * mix(0.64, 0.16, prog);
    float turn = TAU * max(r, 1e-3);
    float seg = fract(ang / TAU * 12.0 + uTime * 0.35 + phase) - 0.5;
    float ticks = band(seg, 0.17, px * 12.0 / turn) * band(r - R * 0.85, R * 0.055, px);
    float seg2 = fract(ang / TAU * 3.0 - uTime * 0.7 + phase) - 0.5;
    float arcs = band(seg2, 0.3, px * 3.0 / turn) * band(r - inner, lw * 0.9, px);
    line = rim + ticks * 0.9 + arcs;
    fill = inside * (0.04 + 0.2 * prog * prog) + soft(r, R * 0.22) * prog * 0.45;
  } else if (kind < 3.5) {
    // strike: disc + cross-hair, blinking right before it lands
    float cross = max(band(vP.x, lw * 0.8, px), band(vP.y, lw * 0.8, px));
    cross *= step(R * 0.22, r) * inside;
    float blink = prog > 0.75 ? 0.6 + 0.4 * sin(uTime * 38.0) : 1.0;
    line = (rim + cross * 0.8 + band(r - R * 0.22, lw * 0.7, px) * 0.8) * blink;
    fill = inside * (0.06 + 0.3 * filled);
  } else if (kind < 4.5) {
    // mortar: disc + chevrons running inward
    float sector = fract(ang / TAU * 6.0 + phase) - 0.5;
    float v = r / R + abs(sector) * 0.55;
    float stripe = fract(v * 2.5 + uTime * 0.9) - 0.5;
    float chev = band(stripe, 0.11, px * 2.5 / R) * (1.0 - smoothstep(0.24, 0.3, abs(sector)));
    chev *= smoothstep(0.2 * R, 0.26 * R, r) * (1.0 - smoothstep(0.84 * R, 0.9 * R, r));
    line = rim + chev * 0.75;
    fill = inside * (0.06 + 0.3 * filled);
  } else {
    // shock: thin outline exactly at the radius, a faint wake behind it, no fill
    float w2 = max(clamp(R * 0.008, 0.025, 0.05), px * 0.9);
    float wake = inside * exp(-(R - r) / 0.45) * 0.16;
    line = band(r - R, w2, px) * 1.3 + soft(r - R, w2 * 2.5) * 0.3 + wake;
  }
  float op = vColor.a;
  vec3 glow = vColor.rgb * (line * 2.4 + fill * 0.75) * op;
  float shade = clamp(fill * 1.1 + line * 0.3, 0.0, 0.6) * op;
  if (shade < 0.002 && line + fill < 0.002) discard;
  gl_FragColor = fxOver(vec3(0.0), shade, glow);
}
`;

// ---------------------------------------------------------------------------------------------------
// Decals: surface-aligned quads with procedural marks, clipped to the face of their box.
// ---------------------------------------------------------------------------------------------------

export const DECAL_VERTEX = /* glsl */ `
attribute vec4 aPosSize;
attribute vec4 aNormalRot;
attribute vec4 aKind;
attribute vec3 aClipMin;
attribute vec3 aClipMax;
varying vec2 vUv;
varying vec4 vKind;
varying vec3 vWorld;
varying vec3 vClipMin;
varying vec3 vClipMax;
#include <fog_pars_vertex>
void main() {
  vec3 n = normalize(aNormalRot.xyz);
  vec3 t = normalize(abs(n.y) < 0.99 ? cross(vec3(0.0, 1.0, 0.0), n) : cross(vec3(1.0, 0.0, 0.0), n));
  vec3 b = cross(n, t);
  float s = sin(aNormalRot.w);
  float co = cos(aNormalRot.w);
  vec2 c = position.xy;
  vec2 r = vec2(c.x * co - c.y * s, c.x * s + c.y * co) * aPosSize.w;
  vec3 world = aPosSize.xyz + n * 0.012 + t * r.x + b * r.y;
  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vUv = c * 2.0;
  vKind = aKind;
  vWorld = world;
  vClipMin = aClipMin;
  vClipMax = aClipMax;
  #include <fog_vertex>
}
`;

export const DECAL_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uLight;
varying vec2 vUv;
varying vec4 vKind;
varying vec3 vWorld;
varying vec3 vClipMin;
varying vec3 vClipMax;
${FOG_FRAGMENT}
float dh(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float dn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(dh(i), dh(i + vec2(1.0, 0.0)), f.x), mix(dh(i + vec2(0.0, 1.0)), dh(i + vec2(1.0, 1.0)), f.x), f.y);
}
float dfbm(vec2 p) {
  return dn(p) * 0.55 + dn(p * 2.1 + 3.7) * 0.3 + dn(p * 4.3 + 9.1) * 0.15;
}
// Distance to the nearest border of a jittered cell grid (cracks, arc burns).
float cells(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(dh(i + g), dh(i + g + 17.3));
      float d = length(g + o - f);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return d2 - d1;
}
void main() {
  if (any(lessThan(vWorld, vClipMin)) || any(greaterThan(vWorld, vClipMax))) discard;
  float kind = vKind.x;
  float seed = vKind.y;
  float age = max(uTime - vKind.z, 0.0);
  float life = vKind.w;
  vec2 p = vUv;
  float r = length(p);
  if (r >= 1.0) discard;
  vec2 sp = p + seed * 37.0;
  vec2 dir = p / max(r, 1e-4);
  float dark = 0.0;
  float chip = 0.0;
  vec3 glow = vec3(0.0);
  if (kind < 0.5) {
    // bullet hole: pit, chipped rim, soot halo, a spark of heat
    float rr = r + (dn(dir * 2.0 + seed * 9.0) - 0.5) * 0.16;
    float pit = 1.0 - smoothstep(0.2, 0.3, rr);
    chip = (1.0 - smoothstep(0.34, 0.5, rr)) * (1.0 - pit) * 0.55;
    dark = max(pit * 0.96, (1.0 - smoothstep(0.3, 1.0, rr)) * 0.4);
    glow = vec3(1.0, 0.55, 0.2) * pit * 3.0 * pow(max(0.0, 1.0 - age / 0.35), 2.0);
  } else if (kind < 1.5) {
    // scorch: soot with a ragged edge and radial streaks, embers that die down
    float n = dfbm(sp * 2.6);
    float rays = 0.72 + 0.28 * dn(dir * 5.0 + seed * 3.0);
    dark = (1.0 - smoothstep(0.1, 0.98, r + (n - 0.5) * 0.55)) * rays * 0.86;
    float hot = (1.0 - smoothstep(0.0, 0.4, r)) * smoothstep(0.45, 0.8, dn(sp * 9.0));
    glow = vec3(1.0, 0.42, 0.1) * hot * 2.2 * pow(max(0.0, 1.0 - age / 1.6), 2.0);
  } else if (kind < 2.5) {
    // plasma burn: molten disc with a glowing rim
    float rr = r + (dfbm(sp * 3.5) - 0.5) * 0.3;
    dark = (1.0 - smoothstep(0.35, 0.85, rr)) * 0.88;
    float heat = pow(max(0.0, 1.0 - age / 2.6), 2.0);
    float ring = exp(-pow((rr - 0.42) / 0.12, 2.0));
    glow = (vec3(1.0, 0.3, 0.07) * ring * 3.0 + vec3(1.0, 0.8, 0.6) * (1.0 - smoothstep(0.0, 0.35, rr)) * 2.5 * heat) * heat;
  } else if (kind < 3.5) {
    // rail burn: clean hot puncture with thin radial scoring
    float score = (1.0 - smoothstep(0.0, 0.06, abs(dn(dir * 9.0 + seed) - 0.5))) * (1.0 - smoothstep(0.25, 0.95, r));
    dark = max((1.0 - smoothstep(0.12, 0.42, r)) * 0.95, score * 0.55);
    float heat = pow(max(0.0, 1.0 - age / 2.0), 2.0);
    glow = (vec3(0.25, 0.85, 1.0) * exp(-pow((r - 0.3) / 0.1, 2.0)) * 2.5 + vec3(1.0) * (1.0 - smoothstep(0.0, 0.22, r)) * 3.0 * heat) * heat;
  } else if (kind < 4.5) {
    // crack: fracture lines around a dent
    float c = cells(sp * 2.6);
    float reach = 1.0 - smoothstep(0.35, 1.0, r + (dn(sp * 3.0) - 0.5) * 0.3);
    dark = max((1.0 - smoothstep(0.0, 0.07, c)) * reach * 0.92, (1.0 - smoothstep(0.0, 0.5, r)) * 0.45);
  } else {
    // energy mark: branching arc burn that keeps glowing for a moment
    float c = cells(sp * 3.2);
    float reach = 1.0 - smoothstep(0.25, 1.0, r + (dn(sp * 2.0) - 0.5) * 0.35);
    float lines = (1.0 - smoothstep(0.0, 0.09, c)) * reach;
    dark = max(lines * 0.6, (1.0 - smoothstep(0.0, 0.6, r)) * 0.5);
    float heat = pow(max(0.0, 1.0 - age / 1.8), 2.0);
    glow = vec3(0.75, 0.8, 1.0) * (lines * 2.5 + (1.0 - smoothstep(0.0, 0.3, r)) * 2.0) * heat;
  }
  float fade = 1.0 - smoothstep(life - 4.0, life, age);
  float cover = clamp(max(dark, chip), 0.0, 1.0);
  float a = cover * fade;
  if (a < 0.004 && glow.r + glow.g + glow.b < 0.004) discard;
  vec3 base = (vec3(0.012) * dark + vec3(0.3) * uLight * chip) / max(dark + chip, 1e-4);
  gl_FragColor = fxOver(base * a, a, glow * fade);
}
`;

// ---------------------------------------------------------------------------------------------------
// Damage numbers: digit glyphs laid out in view space, with a dark outline, always on top.
// ---------------------------------------------------------------------------------------------------

export const NUMBER_VERTEX = /* glsl */ `
attribute vec4 aAnchor;
attribute vec4 aGlyph;
attribute vec4 aColor;
uniform vec4 uDigit;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 mv = viewMatrix * vec4(aAnchor.xyz, 1.0);
  float depth = max(-mv.z, 0.2);
  // Glyph height: a fixed world size up close, a fixed angular size far away.
  float h = max(uDigit.x, depth * uDigit.y) * aAnchor.w;
  vec2 q = position.xy;
  mv.xy += vec2((aGlyph.y * 0.52 + q.x * 0.75) * h, (q.y + aGlyph.w) * h);
  gl_Position = projectionMatrix * mv;
  vUv = vec2((aGlyph.x + q.x + 0.5) * uDigit.z, q.y + 0.5);
  vColor = vec4(aColor.rgb, aGlyph.z);
}
`;

export const NUMBER_FRAGMENT = /* glsl */ `
uniform sampler2D uDigits;
uniform vec4 uDigit;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float s = texture2D(uDigits, vUv).r;
  float aa = clamp(fwidth(s), 0.008, 0.12);
  float fill = smoothstep(0.5 - aa, 0.5 + aa, s);
  float outline = smoothstep(uDigit.w - aa, uDigit.w + aa, s);
  float a = outline * vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(0.008, 0.012, 0.018), vColor.rgb, fill) * a, a);
}
`;

// ---------------------------------------------------------------------------------------------------
// Weather: three layers (motes, streaks, wisps) in volumes that wrap around the camera.
// ---------------------------------------------------------------------------------------------------

export const WEATHER_VERTEX = /* glsl */ `
attribute vec3 aSeed;
attribute vec4 aRand;
uniform vec3 uVol[3];
uniform vec3 uOff[3];
uniform vec4 uCol[3];
uniform vec4 uShape[3];
uniform vec3 uStretch;
uniform float uWeatherTime;
uniform vec2 uViewport;
varying vec2 vUv;
varying vec4 vColor;
varying float vCover;
#include <fog_pars_vertex>
void main() {
  int layer = int(aRand.w + 0.5);
  vec4 shape = uShape[layer];
  vec4 col = uCol[layer];
  vColor = vec4(0.0);
  vCover = 0.0;
  vUv = vec2(0.0);
  vec4 mvPosition = vec4(0.0, 0.0, -1.0, 1.0);
  if (aRand.x >= shape.z) {
    // Thinned out by the layer density: collapse the quad off screen.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    vec3 vol = uVol[layer];
    vec2 c = position.xy;
    // The volume is anchored in the world and wraps around the camera.
    vec3 rel = mod(aSeed * vol + uOff[layer] - cameraPosition, vol) - 0.5 * vol;
    vec3 e = abs(rel) / (0.5 * vol);
    float edge = 1.0 - smoothstep(0.72, 1.0, max(e.x, max(e.y, e.z)));
    vec3 world = cameraPosition + rel;
    float px = 2.0 / (projectionMatrix[1][1] * max(uViewport.y, 1.0));
    float bright = edge;
    float cell = 0.0;
    if (layer == 0) {
      // Motes: tiny drifting glints.
      world += vec3(sin(uWeatherTime * 0.9 + aRand.y * 40.0), cos(uWeatherTime * 0.7 + aRand.y * 23.0), sin(uWeatherTime * 0.8 + aRand.y * 31.0)) * 0.14;
      mvPosition = viewMatrix * vec4(world, 1.0);
      float depth = max(-mvPosition.z, 0.05);
      float size = shape.x * (0.55 + 0.9 * aRand.z);
      float minSize = px * depth * 1.7;
      if (size < minSize) {
        bright *= (size * size) / (minSize * minSize);
        size = minSize;
      }
      bright *= 0.5 + 0.5 * sin(uWeatherTime * shape.w * (0.6 + aRand.z) + aRand.y * 60.0);
      // Motes right in front of the lens would be big blurry discs: they fade out instead.
      bright *= smoothstep(0.6, 2.4, depth);
      mvPosition.xy += c * size;
      cell = shape.y;
    } else if (layer == 1) {
      // Streaks: fast lines stretched along their motion, flickering like static.
      vec3 p0 = (viewMatrix * vec4(world, 1.0)).xyz;
      vec3 p1 = p0 + (viewMatrix * vec4(uStretch * (0.55 + 0.9 * aRand.z), 0.0)).xyz;
      vec3 d = p1 - p0;
      float len = length(d);
      vec3 dn = len > 1e-5 ? d / len : vec3(0.0, 1.0, 0.0);
      vec3 pe = c.x < 0.0 ? p1 : p0;
      vec3 side = cross(dn, pe);
      float sl = length(side);
      side = sl > 1e-6 ? side / sl : vec3(1.0, 0.0, 0.0);
      float depth = max(-pe.z, 0.05);
      float hw = max(shape.x * 0.5, px * depth * 0.9);
      mvPosition = vec4(pe + side * (c.y * 2.0 * hw), 1.0);
      float slot = floor(uWeatherTime * shape.w + aRand.y * 10.0);
      bright *= 0.35 + 0.65 * step(0.4, fract(sin(slot * 12.9898 + aRand.y * 78.233) * 43758.5453));
      bright *= smoothstep(0.2, 1.2, depth);
      cell = shape.y;
    } else {
      // Wisps: big soft sheets of cloud crossing the deck.
      mvPosition = viewMatrix * vec4(world, 1.0);
      float depth = max(-mvPosition.z, 0.05);
      float size = shape.x * (0.7 + 0.6 * aRand.z);
      float a = (aRand.y - 0.5) * 0.7;
      vec2 q = vec2(c.x * 2.1, c.y);
      mvPosition.xy += vec2(q.x * cos(a) - q.y * sin(a), q.x * sin(a) + q.y * cos(a)) * size;
      bright *= smoothstep(size * 0.35, size * 1.1, depth);
      cell = shape.y;
      vCover = col.a * bright;
    }
    gl_Position = projectionMatrix * mvPosition;
    vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + c + 0.5) * 0.25;
    vColor = vec4(col.rgb, bright);
  }
  #include <fog_vertex>
}
`;

export const WEATHER_FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
varying float vCover;
${FOG_FRAGMENT}
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (vCover > 0.0) {
    float cov = t.r * vCover;
    if (cov < 0.003) discard;
    gl_FragColor = fxOver(vColor.rgb * (0.6 + 0.5 * t.g) * cov, cov, vec3(0.0));
  } else {
    float m = t.r * vColor.a;
    if (m < 0.003) discard;
    gl_FragColor = fxOver(vec3(0.0), 0.0, vColor.rgb * m * (1.0 + t.b));
  }
}
`;
