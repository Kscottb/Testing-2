import type { GameStorage } from './types';

/**
 * localStorage wrapper that never throws. In sandboxed frames (or private modes) where localStorage
 * is missing or throws, values live in memory for the lifetime of the page.
 */
export function createStorage(prefix = 'static-horizon:'): GameStorage {
  const memory = new Map<string, string>();
  let backend: Storage | null = null;

  try {
    const candidate = globalThis.localStorage;
    const probe = `${prefix}__probe`;
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    backend = candidate;
  } catch {
    backend = null;
  }

  const getItem = (key: string): string | null => {
    const full = prefix + key;
    if (backend) {
      try {
        return backend.getItem(full);
      } catch {
        backend = null;
      }
    }
    return memory.get(full) ?? null;
  };

  const setItem = (key: string, value: string): void => {
    const full = prefix + key;
    memory.set(full, value);
    if (backend) {
      try {
        backend.setItem(full, value);
      } catch {
        backend = null;
      }
    }
  };

  const removeItem = (key: string): void => {
    const full = prefix + key;
    memory.delete(full);
    if (backend) {
      try {
        backend.removeItem(full);
      } catch {
        backend = null;
      }
    }
  };

  return {
    get persistent(): boolean {
      return backend !== null;
    },
    getItem,
    setItem,
    removeItem,
    getJson<T>(key: string, fallback: T): T {
      const raw = getItem(key);
      if (raw === null) return fallback;
      try {
        const parsed = JSON.parse(raw) as T;
        return parsed === null || parsed === undefined ? fallback : parsed;
      } catch {
        return fallback;
      }
    },
    setJson(key: string, value: unknown): void {
      try {
        setItem(key, JSON.stringify(value));
      } catch {
        // Unserialisable value: nothing to persist.
      }
    },
  };
}
