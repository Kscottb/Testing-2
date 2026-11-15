import type { Rng } from './types';

/** Seeded PRNG (mulberry32). Deterministic for a given seed across browsers. */
export function createRng(seed = 0x5eed1234): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range(min: number, max: number): number {
      return min + (max - min) * next();
    },
    int(min: number, max: number): number {
      return Math.floor(min + (max - min + 1) * next());
    },
    chance(p: number): boolean {
      return next() < p;
    },
    sign(): number {
      return next() < 0.5 ? -1 : 1;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty array');
      return items[Math.floor(next() * items.length)] as T;
    },
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = items[i] as T;
        items[i] = items[j] as T;
        items[j] = tmp;
      }
      return items;
    },
    seed(value: number): void {
      state = value >>> 0;
    },
  };
}
