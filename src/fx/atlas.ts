/**
 * Procedural textures of the FX system, computed as plain bytes (no canvas, no WebGL):
 *   - the 4 x 4 sprite atlas: R = coverage, G = shading / detail, B = hot core;
 *   - the digit strip of the damage numbers as a distance field (crisp fill + outline at any size).
 */
import { SPR } from './consts';

export const ATLAS_GRID = 4;
export const ATLAS_CELL = 256;
export const ATLAS_SIZE = ATLAS_GRID * ATLAS_CELL;

export const DIGIT_CELL_W = 96;
export const DIGIT_CELL_H = 128;
export const DIGIT_ATLAS_W = 1024;
export const DIGIT_ATLAS_H = 128;
/** Distance-field value at the stroke edge and at the outer edge of the outline. */
export const DIGIT_FILL_EDGE = 0.5;
export const DIGIT_OUTLINE_EDGE = 0.2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smooth(e0: number, e1: number, v: number): number {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Integer lattice hash -> [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, seed + o * 17) * amp;
    norm += amp;
    x = x * 2.03 + 11.7;
    y = y * 2.03 - 4.3;
    amp *= 0.5;
  }
  return sum / norm;
}

function ridged(x: number, y: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    const n = 1 - Math.abs(valueNoise(x, y, seed + o * 31) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    x = x * 2.1 + 3.1;
    y = y * 2.1 + 7.9;
    amp *= 0.5;
  }
  return sum / norm;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0;
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/** Density of a noisy cloud puff at (u, v) in [-1, 1]. */
function cloud(u: number, v: number, seed: number, lump: number, freq: number): number {
  const r = Math.sqrt(u * u + v * v);
  const edge = r + (fbm(u * freq + 5, v * freq + 9, seed) - 0.5) * lump;
  const body = 1 - smooth(0.45, 0.96, edge);
  const detail = 0.5 + 0.85 * fbm(u * freq * 2.3 + 1, v * freq * 2.3 + 2, seed + 7);
  return clamp01(body * detail) * smooth(0.96, 0.8, r);
}

/** Jagged arcs of the ZAP sprite: [x0, y0, x1, y1] segments, built once. */
function zapSegments(): number[] {
  const segs: number[] = [];
  const arcs = [0.35, 2.5, 4.4];
  for (let a = 0; a < arcs.length; a++) {
    let angle = arcs[a] as number;
    let x = Math.cos(angle) * 0.06;
    let y = Math.sin(angle) * 0.06;
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      angle += (hash2(a * 13 + i, 7, 99) - 0.5) * 1.5;
      const len = 0.11 + hash2(a * 5 + i, 3, 42) * 0.07;
      const nx = x + Math.cos(angle) * len;
      const ny = y + Math.sin(angle) * len;
      segs.push(x, y, nx, ny);
      // One short fork per arc.
      if (i === 2) {
        const fa = angle + (a % 2 === 0 ? 0.9 : -0.9);
        segs.push(nx, ny, nx + Math.cos(fa) * 0.16, ny + Math.sin(fa) * 0.16);
      }
      x = nx;
      y = ny;
      // Pull the arc back toward its own direction so it reaches the rim.
      angle = angle * 0.6 + (arcs[a] as number) * 0.4;
    }
  }
  return segs;
}

type Rgb = [number, number, number];
const out: Rgb = [0, 0, 0];

/** One texel of sprite `cell` at (u, v) in [-1, 1] (v up). Writes R, G, B in 0..1 into `out`. */
function sprite(cell: number, u: number, v: number, zap: number[]): Rgb {
  const r = Math.sqrt(u * u + v * v);
  let R = 0;
  let G = 1;
  let B = 0;
  switch (cell) {
    case SPR.GLOW: {
      const e = (x: number): number => Math.exp(-5 * x * x);
      R = Math.max(0, (e(r) - e(0.95)) / (1 - e(0.95)));
      B = Math.exp(-26 * r * r);
      break;
    }
    case SPR.SPARK: {
      // Teardrop streak: head at +u, tail fading toward -u.
      const along = smooth(-0.95, 0.55, u) * smooth(0.97, 0.78, u);
      const w = 0.07 + 0.11 * smooth(-1, 0.8, u);
      R = along * Math.exp(-((v / w) * (v / w)));
      B = along * along * Math.exp(-((v / (w * 0.45)) * (v / (w * 0.45))));
      break;
    }
    case SPR.SMOKE_A:
    case SPR.SMOKE_B: {
      const seed = cell === SPR.SMOKE_A ? 3 : 41;
      const d = cloud(u, v, seed, 0.55, 2.1);
      // Fake lighting from the upper left: brighter where the density drops toward the light.
      const lit = cloud(u - 0.07, v + 0.09, seed, 0.55, 2.1);
      R = d;
      G = clamp01(0.68 + (d - lit) * 1.3);
      B = clamp01((d - 0.55) * 2.2);
      B *= B;
      break;
    }
    case SPR.FIRE: {
      const edge = r + (fbm(u * 2.4 + 3, v * 2.4 + 8, 71) - 0.5) * 0.7;
      const body = 1 - smooth(0.4, 0.97, edge);
      const d = clamp01(body * (0.5 + 1.0 * ridged(u * 3.2, v * 3.2, 77))) * smooth(0.97, 0.82, r);
      R = d;
      G = clamp01(0.4 + d * 0.8);
      B = clamp01((d - 0.5) * 2);
      B *= B;
      break;
    }
    case SPR.RING: {
      const rr = r / 0.92;
      const crest = Math.exp(-(((rr - 0.93) / 0.024) * ((rr - 0.93) / 0.024)));
      const wake = rr < 0.93 ? 0.2 * Math.pow(smooth(0.5, 0.93, rr), 3) : 0;
      R = clamp01(crest + wake) * smooth(1.0, 0.985, rr);
      B = Math.exp(-(((rr - 0.93) / 0.012) * ((rr - 0.93) / 0.012)));
      break;
    }
    case SPR.SHARD: {
      // Convex quad given by inward half-planes; the smallest signed distance is the edge distance.
      const pts = [-0.72, -0.48, 0.78, -0.22, 0.34, 0.74, -0.34, 0.42];
      let sd = 1;
      for (let i = 0; i < 4; i++) {
        const ax = pts[i * 2] as number;
        const ay = pts[i * 2 + 1] as number;
        const bx = pts[((i + 1) % 4) * 2] as number;
        const by = pts[((i + 1) % 4) * 2 + 1] as number;
        const ex = bx - ax;
        const ey = by - ay;
        const len = Math.sqrt(ex * ex + ey * ey);
        sd = Math.min(sd, ((u - ax) * -ey + (v - ay) * ex) / len);
      }
      R = smooth(0, 0.035, sd);
      // Two facets split along a diagonal, plus a bright rim.
      const facet = smooth(-0.04, 0.04, u * 0.5 - v * 0.85 + 0.05);
      G = clamp01(0.35 + 0.5 * facet + 0.15 * (v + 1) * 0.5);
      B = R * (1 - smooth(0.02, 0.09, sd)) * 0.6;
      break;
    }
    case SPR.FLARE: {
      const h = Math.exp(-((v / 0.03) * (v / 0.03))) * Math.pow(Math.max(0, 1 - Math.abs(u) / 0.95), 1.6);
      const w = Math.exp(-((u / 0.03) * (u / 0.03))) * Math.pow(Math.max(0, 1 - Math.abs(v) / 0.95), 1.6) * 0.8;
      const d1 = (u + v) * 0.7071;
      const d2 = (u - v) * 0.7071;
      const x1 = Math.exp(-((d2 / 0.022) * (d2 / 0.022))) * Math.pow(Math.max(0, 1 - Math.abs(d1) / 0.55), 2) * 0.45;
      const x2 = Math.exp(-((d1 / 0.022) * (d1 / 0.022))) * Math.pow(Math.max(0, 1 - Math.abs(d2) / 0.55), 2) * 0.45;
      const core = Math.exp(-28 * r * r);
      R = clamp01(Math.max(h, w, x1, x2) + core);
      B = Math.exp(-70 * r * r);
      break;
    }
    case SPR.BURST: {
      const a = Math.atan2(v, u);
      const n =
        0.5 +
        0.2 * Math.cos(a * 3 + 0.7) +
        0.14 * Math.cos(a * 5 + 2.1) +
        0.1 * Math.cos(a * 8 + 4.0) +
        0.06 * Math.cos(a * 13 + 1.3);
      const spike = 0.26 + 0.66 * Math.pow(clamp01(n), 1.6);
      R = smooth(spike, spike * 0.3, r) * (0.6 + 0.4 * (1 - r)) * smooth(0.95, 0.85, r);
      B = smooth(0.42, 0.02, r);
      break;
    }
    case SPR.DOT: {
      R = smooth(0.66, 0.5, r);
      G = clamp01(1 - r);
      B = smooth(0.5, 0.15, r);
      break;
    }
    case SPR.ZAP: {
      let d = 9;
      for (let i = 0; i < zap.length; i += 4) {
        const s = segDist(u, v, zap[i] as number, zap[i + 1] as number, zap[i + 2] as number, zap[i + 3] as number);
        if (s < d) d = s;
      }
      const tip = 1 - smooth(0.72, 0.94, r);
      R = clamp01(Math.exp(-((d / 0.028) * (d / 0.028))) + 0.32 * Math.exp(-((d / 0.085) * (d / 0.085)))) * tip;
      B = Math.exp(-((d / 0.016) * (d / 0.016))) * tip;
      break;
    }
    case SPR.WISP: {
      const e = Math.sqrt(u * u + v * v) + (fbm(u * 1.5 + 2, v * 1.5 + 6, 113) - 0.5) * 0.75;
      const body = 1 - smooth(0.1, 0.92, e);
      const d = clamp01(body * (0.4 + 0.75 * fbm(u * 3.1, v * 3.1, 127))) * smooth(0.96, 0.7, r);
      const lit = clamp01(
        (1 - smooth(0.1, 0.92, Math.sqrt((u - 0.08) * (u - 0.08) + (v + 0.1) * (v + 0.1)))) *
          (0.4 + 0.75 * fbm((u - 0.08) * 3.1, (v + 0.1) * 3.1, 127)),
      );
      R = d;
      G = clamp01(0.65 + (d - lit) * 1.6);
      break;
    }
    case SPR.HALO: {
      const rr = r / 0.94;
      R = Math.exp(-(((rr - 0.72) / 0.16) * ((rr - 0.72) / 0.16))) * smooth(1.0, 0.9, rr);
      B = Math.exp(-(((rr - 0.72) / 0.045) * ((rr - 0.72) / 0.045))) * smooth(1.0, 0.9, rr);
      break;
    }
    case SPR.HEX: {
      const au = Math.abs(u);
      const av = Math.abs(v);
      const h = Math.max(au * 0.866 + av * 0.5, av);
      const line = Math.exp(-(((h - 0.76) / 0.05) * ((h - 0.76) / 0.05)));
      R = clamp01(line + (h < 0.76 ? 0.16 : 0));
      B = Math.exp(-(((h - 0.76) / 0.02) * ((h - 0.76) / 0.02)));
      break;
    }
    case SPR.PLUS: {
      const au = Math.abs(u);
      const av = Math.abs(v);
      const sd = Math.min(Math.max(au - 0.7, av - 0.2), Math.max(au - 0.2, av - 0.7));
      const glow = sd > 0 ? 0.4 * Math.exp(-(sd * sd) / 0.012) : 0;
      R = clamp01(smooth(0.03, -0.03, sd) + glow) * smooth(0.96, 0.86, Math.max(au, av));
      B = smooth(0, -0.12, sd);
      break;
    }
    case SPR.CASING: {
      const dx = Math.max(Math.abs(u) - 0.52, 0);
      const sd = Math.sqrt(dx * dx + v * v) - 0.34;
      R = smooth(0.03, -0.03, sd);
      const band = 1 - Math.min(1, Math.abs(v - 0.1) / 0.34);
      G = clamp01(0.3 + 0.7 * band * band - (u > 0.55 ? 0.25 : 0));
      B = R * Math.pow(band, 6) * 0.5;
      break;
    }
    default:
      R = 0;
  }
  out[0] = clamp01(R);
  out[1] = clamp01(G);
  out[2] = clamp01(B);
  return out;
}

/** RGBA8 pixels of the sprite atlas (ATLAS_SIZE squared, row 0 = bottom). */
export function buildSpriteAtlas(): Uint8Array {
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const zap = zapSegments();
  for (let cell = 0; cell < ATLAS_GRID * ATLAS_GRID; cell++) {
    const cx = (cell % ATLAS_GRID) * ATLAS_CELL;
    const cy = Math.floor(cell / ATLAS_GRID) * ATLAS_CELL;
    for (let y = 0; y < ATLAS_CELL; y++) {
      const v = ((y + 0.5) / ATLAS_CELL) * 2 - 1;
      for (let x = 0; x < ATLAS_CELL; x++) {
        const u = ((x + 0.5) / ATLAS_CELL) * 2 - 1;
        const px = sprite(cell, u, v, zap);
        const o = ((cy + y) * ATLAS_SIZE + cx + x) * 4;
        data[o] = Math.round(px[0] * 255);
        data[o + 1] = Math.round(px[1] * 255);
        data[o + 2] = Math.round(px[2] * 255);
        data[o + 3] = 255;
      }
    }
  }
  return data;
}

/**
 * Stroke paths of the digits on a 2 x 4 grid (y up): chamfered monoline numerals that match the HUD.
 * Each digit is a list of polylines; each polyline a flat list of x, y pairs.
 */
const DIGIT_STROKES: readonly (readonly number[][])[] = [
  [[0.3, 0, 1.7, 0, 2, 0.3, 2, 3.7, 1.7, 4, 0.3, 4, 0, 3.7, 0, 0.3, 0.3, 0]],
  [
    [0.35, 3.2, 1.15, 4, 1.15, 0],
    [0.35, 0, 1.9, 0],
  ],
  [[0, 3.55, 0.4, 4, 1.7, 4, 2, 3.7, 2, 2.45, 0, 0.55, 0, 0, 2, 0]],
  [
    [0, 4, 1.7, 4, 2, 3.7, 2, 2.4, 1.7, 2.1, 0.7, 2.1],
    [1.7, 2.1, 2, 1.8, 2, 0.3, 1.7, 0, 0, 0],
  ],
  [[1.55, 0, 1.55, 4, 0, 1.3, 2, 1.3]],
  [[2, 4, 0, 4, 0, 2.25, 1.7, 2.25, 2, 1.95, 2, 0.3, 1.7, 0, 0, 0]],
  [[1.85, 4, 0.3, 4, 0, 3.7, 0, 0.3, 0.3, 0, 1.7, 0, 2, 0.3, 2, 1.95, 1.7, 2.25, 0, 2.25]],
  [[0, 4, 2, 4, 2, 3.6, 0.75, 0]],
  [
    [0.3, 2.1, 0, 2.4, 0, 3.7, 0.3, 4, 1.7, 4, 2, 3.7, 2, 2.4, 1.7, 2.1, 0.3, 2.1],
    [0.3, 2.1, 0, 1.8, 0, 0.3, 0.3, 0, 1.7, 0, 2, 0.3, 2, 1.8, 1.7, 2.1],
  ],
  [[0.15, 0, 1.7, 0, 2, 0.3, 2, 3.7, 1.7, 4, 0.3, 4, 0, 3.7, 0, 2.05, 0.3, 1.75, 2, 1.75]],
];

/** Pixels per grid unit, stroke half width and encoded distance range of the digit field (pixels). */
const DIGIT_UNIT = 22;
const DIGIT_STROKE = 6.2;
const DIGIT_RANGE = 22;

/** RGBA8 pixels of the digit strip: R = distance field (0.5 at the stroke edge), row 0 = bottom. */
export function buildDigitAtlas(): Uint8Array {
  const data = new Uint8Array(DIGIT_ATLAS_W * DIGIT_ATLAS_H * 4);
  const ox = (DIGIT_CELL_W - 2 * DIGIT_UNIT) / 2;
  const oy = (DIGIT_CELL_H - 4 * DIGIT_UNIT) / 2;
  for (let digit = 0; digit < 10; digit++) {
    const strokes = DIGIT_STROKES[digit] as readonly number[][];
    for (let y = 0; y < DIGIT_CELL_H; y++) {
      for (let x = 0; x < DIGIT_CELL_W; x++) {
        const gx = (x + 0.5 - ox) / DIGIT_UNIT;
        const gy = (y + 0.5 - oy) / DIGIT_UNIT;
        let d = 99;
        for (const line of strokes) {
          for (let i = 0; i + 3 < line.length; i += 2) {
            const s = segDist(gx, gy, line[i] as number, line[i + 1] as number, line[i + 2] as number, line[i + 3] as number);
            if (s < d) d = s;
          }
        }
        const sd = d * DIGIT_UNIT - DIGIT_STROKE;
        const value = clamp01(0.5 - sd / (2 * DIGIT_RANGE));
        const o = (y * DIGIT_ATLAS_W + digit * DIGIT_CELL_W + x) * 4;
        const byte = Math.round(value * 255);
        data[o] = byte;
        data[o + 1] = byte;
        data[o + 2] = byte;
        data[o + 3] = 255;
      }
    }
  }
  return data;
}
