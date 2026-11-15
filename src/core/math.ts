/**
 * Small allocation-free math helpers shared by every system.
 */
import type { Aabb, Vec3Like } from './types';

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPS = 1e-6;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Where `v` sits between a and b (0..1, clamped). Returns 0 when a === b. */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

/** Map v from [inMin, inMax] to [outMin, outMax], clamped. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, invLerp(inMin, inMax, v));
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = invLerp(edge0, edge1, v);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing toward `target`.
 * `lambda` is the sharpness in 1/s (10 = snappy, 2 = lazy). Safe for dt = 0.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a <= 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference `to - from`, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/** Turn `current` toward `target` by at most `maxDelta` radians. */
export function approachAngle(current: number, target: number, maxDelta: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Unit view direction for yaw/pitch (yaw 0 = -Z, +yaw = left, +pitch = up). Returns `out`. */
export function yawPitchToDir<T extends Vec3Like>(yaw: number, pitch: number, out: T): T {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Yaw that looks along the horizontal direction (dx, dz). Returns 0 for a zero vector. */
export function dirToYaw(dx: number, dz: number): number {
  if (dx * dx + dz * dz < EPS * EPS) return 0;
  return Math.atan2(-dx, -dz);
}

/** Pitch of a direction (need not be normalised). Returns 0 for a zero vector. */
export function dirToPitch(dx: number, dy: number, dz: number): number {
  const h = Math.sqrt(dx * dx + dz * dz);
  if (h < EPS && Math.abs(dy) < EPS) return 0;
  return Math.atan2(dy, h);
}

/**
 * Normalise in place. A zero / non-finite vector becomes the fallback (default +Y) instead of NaN.
 * Returns the ORIGINAL length (0 when the fallback was used).
 */
export function safeNormalize(v: Vec3Like, fx = 0, fy = 1, fz = 0): number {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!(len > EPS) || !Number.isFinite(len)) {
    v.x = fx;
    v.y = fy;
    v.z = fz;
    return 0;
  }
  const inv = 1 / len;
  v.x *= inv;
  v.y *= inv;
  v.z *= inv;
  return len;
}

/** Normalise the XZ part in place and zero Y. Zero vector -> (0,0,0). Returns the original XZ length. */
export function safeNormalizeXZ(v: Vec3Like): number {
  const len = Math.sqrt(v.x * v.x + v.z * v.z);
  v.y = 0;
  if (!(len > EPS) || !Number.isFinite(len)) {
    v.x = 0;
    v.z = 0;
    return 0;
  }
  v.x /= len;
  v.z /= len;
  return len;
}

export function distSq(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function dist(a: Vec3Like, b: Vec3Like): number {
  return Math.sqrt(distSq(a, b));
}

export function distSqXZ(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function distXZ(a: Vec3Like, b: Vec3Like): number {
  return Math.sqrt(distSqXZ(a, b));
}

export function isFiniteVec3(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Replace a non-finite number by a fallback. */
export function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export function aabbContainsXZ(box: Aabb, x: number, z: number): boolean {
  return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
}

export function aabbContains(box: Aabb, p: Vec3Like): boolean {
  return (
    p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY && p.z >= box.minZ && p.z <= box.maxZ
  );
}

export function aabbOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
  );
}

/** Linear damage falloff multiplier: 1 up to `start`, `min` from `end` on. */
export function falloff(distance: number, start: number, end: number, min: number): number {
  if (distance <= start || end <= start) return 1;
  if (distance >= end) return min;
  return lerp(1, min, (distance - start) / (end - start));
}

/** Jump launch speed that reaches `apex` metres under `gravity`. */
export function jumpSpeed(apex: number, gravity: number): number {
  return Math.sqrt(2 * gravity * apex);
}
