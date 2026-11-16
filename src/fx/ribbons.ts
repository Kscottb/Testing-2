/**
 * Ribbon writer: turns polylines into the segment instances of the ribbon batch. Adjoining segments
 * repeat the position, tangent, width and colour of their shared joint, so a polyline renders as one
 * continuous camera-facing strip. Used by lightning bolts and trails.
 */
import { RIBBON_STRIDE } from './consts';

/** Longest polyline (points) a single start()..end() may hold. */
export const RIBBON_MAX_POINTS = 48;
const POINT_STRIDE = 8;

export class RibbonWriter {
  /** Segments written since reset(). */
  count = 0;
  private readonly capacity: number;
  private readonly points = new Float32Array(RIBBON_MAX_POINTS * POINT_STRIDE);
  private n = 0;
  private tx = 0;
  private ty = 1;
  private tz = 0;

  constructor(private readonly out: Float32Array) {
    this.capacity = Math.floor(out.length / RIBBON_STRIDE);
  }

  reset(): void {
    this.count = 0;
  }

  /** Begin a polyline. */
  start(): void {
    this.n = 0;
  }

  /** Add a point: position, half width in metres, linear HDR colour and opacity. */
  point(x: number, y: number, z: number, halfWidth: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= RIBBON_MAX_POINTS) return;
    const o = this.n++ * POINT_STRIDE;
    const p = this.points;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
    p[o + 3] = halfWidth;
    p[o + 4] = r;
    p[o + 5] = g;
    p[o + 6] = b;
    p[o + 7] = a;
  }

  /** Finish the polyline: emits one segment per pair of consecutive points. */
  end(): void {
    const n = this.n;
    if (n < 2) return;
    const p = this.points;
    const out = this.out;
    for (let i = 0; i < n - 1; i++) {
      if (this.count >= this.capacity) return;
      const o = this.count * RIBBON_STRIDE;
      const a = i * POINT_STRIDE;
      const b = a + POINT_STRIDE;
      this.tangent(i);
      out[o] = p[a] as number;
      out[o + 1] = p[a + 1] as number;
      out[o + 2] = p[a + 2] as number;
      out[o + 3] = p[a + 3] as number;
      out[o + 4] = this.tx;
      out[o + 5] = this.ty;
      out[o + 6] = this.tz;
      out[o + 7] = 0;
      this.tangent(i + 1);
      out[o + 8] = p[b] as number;
      out[o + 9] = p[b + 1] as number;
      out[o + 10] = p[b + 2] as number;
      out[o + 11] = p[b + 3] as number;
      out[o + 12] = this.tx;
      out[o + 13] = this.ty;
      out[o + 14] = this.tz;
      out[o + 15] = 0;
      out[o + 16] = p[a + 4] as number;
      out[o + 17] = p[a + 5] as number;
      out[o + 18] = p[a + 6] as number;
      out[o + 19] = p[a + 7] as number;
      out[o + 20] = p[b + 4] as number;
      out[o + 21] = p[b + 5] as number;
      out[o + 22] = p[b + 6] as number;
      out[o + 23] = p[b + 7] as number;
      this.count++;
    }
  }

  /** Unit tangent at point i (direction from its previous to its next neighbour). */
  private tangent(i: number): void {
    const p = this.points;
    const a = (i > 0 ? i - 1 : 0) * POINT_STRIDE;
    const b = (i < this.n - 1 ? i + 1 : i) * POINT_STRIDE;
    const x = (p[b] as number) - (p[a] as number);
    const y = (p[b + 1] as number) - (p[a + 1] as number);
    const z = (p[b + 2] as number) - (p[a + 2] as number);
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-6) {
      this.tx = x / len;
      this.ty = y / len;
      this.tz = z / len;
    }
    // A zero-length neighbourhood keeps the previous tangent.
  }
}
