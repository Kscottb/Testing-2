/**
 * Test support shared by the physics and nav suites: measures how many heap bytes one call of a hot
 * query costs, in a plain Node process (no --expose-gc). Nothing in the game imports this module.
 */

/** Calls to make before measuring, enough for the optimising compiler to have settled. */
export const WARM_UP_CALLS = 60000;

/**
 * A query "allocates" from this many heap bytes per call. A clean query reads as the cost of the
 * measurement itself (a fraction of a byte per call); a single boxed number per call reads as 12-16.
 */
export const ALLOC_LIMIT_BYTES = 2;

const heapUsed = (): number =>
  (globalThis as unknown as { process: { memoryUsage(): { heapUsed: number } } }).process.memoryUsage().heapUsed;

/** Median, over many short rounds, of |heap growth| / calls. */
function medianGrowth(fn: (calls: number) => unknown): number {
  const perCall: number[] = [];
  for (let round = 0; round < 41; round++) {
    const calls = 1500 + ((round * 389) % 1000);
    const before = heapUsed();
    fn(calls);
    perCall.push(Math.abs(heapUsed() - before) / calls);
  }
  perCall.sort((a, b) => a - b);
  return perCall[perCall.length >> 1] as number;
}

/**
 * Heap bytes one call of the loop body of `fn` costs. `fn(calls)` must run the query `calls` times.
 *
 * Why this is sound: between two heap readings with no collection in between, the heap grows by
 * exactly what was allocated. A round that does contain a collection reads as a large jump in either
 * direction; it is taken as an absolute value, so it can only push the verdict toward "allocates" and
 * never hide a leak, and code that allocates nothing does not trigger collections in the first place.
 * Rounds have different lengths so that a heavy allocator cannot fall into step with the collector,
 * and the median discards the occasional round disturbed by a compiler tier-up.
 *
 * A reading at or above the limit is taken again (up to three in all, the lowest counts): code that
 * really allocates per call does so every time, while a background compile that had not finished
 * when the first reading started (a busy machine) is over by the next one.
 */
export function bytesPerCall(fn: (calls: number) => unknown): number {
  let best = Infinity;
  for (let attempt = 0; attempt < 3 && best >= ALLOC_LIMIT_BYTES; attempt++) {
    const reading = medianGrowth(fn);
    if (reading < best) best = reading;
  }
  return best;
}

const leak: { value: unknown } = { value: 'tagged' };

/**
 * Positive control: stores one fractional number per call into a field the engine keeps tagged, which
 * boxes exactly one number per call - the smallest leak a query could have. A suite measures this
 * first; if it ever reads ~0 the measurement has gone blind and the other readings prove nothing.
 */
export function boxOneNumberPerCall(calls: number): unknown {
  for (let i = 0; i < calls; i++) leak.value = i + 0.5;
  return leak.value;
}
