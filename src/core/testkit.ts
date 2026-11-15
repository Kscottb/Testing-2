/**
 * Test support for core's own unit tests: a minimal stand-in for the browser globals core touches
 * (window, document, navigator, a canvas) so input.ts and game.ts run in the node test environment.
 * Nothing in the game imports this file.
 */

type Listener = (event: never) => void;

/** An event target that records its listeners and lets a test dispatch plain objects to them. */
export class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Call every listener of `type` with `event` (missing fields are the test's business). */
  dispatch(type: string, event: object = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) (listener as (e: object) => void)(event);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export interface FakePadState {
  mapping: string;
  axes: number[];
  /** Indices of the buttons that are down. */
  pressed: Set<number>;
}

export interface FakeDom {
  window: FakeTarget & { name: string; devicePixelRatio: number };
  document: FakeTarget & { pointerLockElement: unknown; hidden: boolean; exitPointerLock(): void; getElementById(id: string): null };
  canvas: FakeTarget & {
    style: Record<string, string>;
    clientWidth: number;
    clientHeight: number;
    /** Calls made to requestPointerLock (the options of each). */
    lockRequests: unknown[];
    /** What the next requestPointerLock call returns (default: a promise that never settles). */
    lockResult: () => unknown;
    requestPointerLock(options?: unknown): unknown;
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  };
  navigator: { userActivation: { isActive: boolean }; getGamepads(): unknown[] };
  /** The pad returned by navigator.getGamepads() (null = none connected). */
  pad: FakePadState | null;
  /** The clock behind performance.now(), in milliseconds. */
  now: number;
  /** Put the originals back. */
  restore(): void;
}

/** Install the fakes on globalThis. Call restore() when the test is done. */
export function installFakeDom(): FakeDom {
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  };

  const dom = { pad: null, now: 1000 } as FakeDom;
  dom.window = Object.assign(new FakeTarget(), { name: '', devicePixelRatio: 1 });
  dom.document = Object.assign(new FakeTarget(), {
    pointerLockElement: null as unknown,
    hidden: false,
    exitPointerLock(): void {
      dom.document.pointerLockElement = null;
    },
    getElementById: (): null => null,
  });
  dom.canvas = Object.assign(new FakeTarget(), {
    style: {} as Record<string, string>,
    clientWidth: 1280,
    clientHeight: 720,
    lockRequests: [] as unknown[],
    lockResult: (): unknown => new Promise<void>(() => undefined),
    requestPointerLock(options?: unknown): unknown {
      dom.canvas.lockRequests.push(options);
      return dom.canvas.lockResult();
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  });
  dom.navigator = {
    userActivation: { isActive: false },
    getGamepads(): unknown[] {
      const pad = dom.pad;
      if (!pad) return [null];
      const buttons = [];
      for (let i = 0; i < 17; i++) buttons.push({ pressed: pad.pressed.has(i), value: pad.pressed.has(i) ? 1 : 0 });
      return [{ connected: true, mapping: pad.mapping, axes: pad.axes, buttons }];
    },
  };

  define('window', dom.window);
  define('document', dom.document);
  define('navigator', dom.navigator);
  const realNow = performance.now.bind(performance);
  performance.now = () => dom.now;

  dom.restore = (): void => {
    performance.now = realNow;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(g, key, descriptor);
      else delete g[key];
    }
  };
  return dom;
}
