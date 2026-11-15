/**
 * Fixed-growth object pool with an "active" list, for projectiles / particles / enemies / DOM nodes.
 * acquire() never allocates once the pool is warm; release() is O(1) (swap-remove).
 */
export class Pool<T> {
  /** Active items occupy `items[0..count-1]`. Iterate backwards when releasing during iteration. */
  readonly items: T[] = [];
  count = 0;
  private readonly free: T[] = [];
  private readonly index = new Map<T, number>();

  /**
   * @param create builds a brand-new item (called lazily, or `prewarm` times up front)
   * @param max    hard cap of simultaneously active items (acquire returns null beyond it)
   */
  constructor(
    private readonly create: () => T,
    private readonly max = Infinity,
    prewarm = 0,
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(create());
  }

  /** Take an item (recycled or new); null when `max` items are already active. */
  acquire(): T | null {
    if (this.count >= this.max) return null;
    const item = this.free.pop() ?? this.create();
    this.index.set(item, this.count);
    this.items[this.count++] = item;
    return item;
  }

  /** Return an active item to the pool. Returns false if it was not active. */
  release(item: T): boolean {
    const i = this.index.get(item);
    if (i === undefined) return false;
    const last = this.items[--this.count] as T;
    this.items[i] = last;
    this.index.set(last, i);
    this.index.delete(item);
    this.items.length = this.count;
    this.free.push(item);
    return true;
  }

  /** Release everything, calling `each` on every item that was active. */
  releaseAll(each?: (item: T) => void): void {
    for (let i = this.count - 1; i >= 0; i--) {
      const item = this.items[i] as T;
      if (each) each(item);
      this.free.push(item);
    }
    this.items.length = 0;
    this.index.clear();
    this.count = 0;
  }

  /** Visit every item ever created (active and free) — use for dispose. */
  forEachCreated(each: (item: T) => void): void {
    for (let i = 0; i < this.count; i++) each(this.items[i] as T);
    for (const item of this.free) each(item);
  }
}
