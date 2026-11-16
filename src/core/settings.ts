import { DIFFICULTIES, QUALITY_SETTINGS, STORAGE_KEYS } from './constants';
import { clamp } from './math';
import type { EventBus, GameStorage, Settings, SettingsData } from './types';

export const DEFAULT_SETTINGS: Readonly<SettingsData> = {
  sensitivity: 1,
  invertY: false,
  fov: 78,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  quality: 'auto',
  dynamicResolution: true,
  screenShake: 1,
  reduceFlashes: false,
  showFps: false,
  aimAssist: true,
  damageNumbers: true,
  difficulty: 'veteran',
};

/** Numeric ranges enforced by set(). */
export const SETTING_RANGES: Readonly<Partial<Record<keyof SettingsData, readonly [number, number]>>> = {
  sensitivity: [0.2, 3],
  fov: [60, 100],
  masterVolume: [0, 1],
  musicVolume: [0, 1],
  sfxVolume: [0, 1],
  screenShake: [0, 1.5],
};

/** Storage writes are delayed by this much after the last change (a slider drag fires 60 changes a second). */
const PERSIST_DELAY_MS = 300;

/** Coerce an untrusted value to a valid one for `key`, or return the fallback. */
function sanitize<K extends keyof SettingsData>(key: K, value: unknown, fallback: SettingsData[K]): SettingsData[K] {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const range = SETTING_RANGES[key];
    return (range ? clamp(value, range[0], range[1]) : value) as SettingsData[K];
  }
  if (typeof def === 'boolean') {
    return (typeof value === 'boolean' ? value : fallback) as SettingsData[K];
  }
  if (key === 'quality') {
    return ((QUALITY_SETTINGS as readonly unknown[]).includes(value) ? value : fallback) as SettingsData[K];
  }
  if (key === 'difficulty') {
    return ((DIFFICULTIES as readonly unknown[]).includes(value) ? value : fallback) as SettingsData[K];
  }
  return fallback;
}

function assign<K extends keyof SettingsData>(data: SettingsData, key: K, value: SettingsData[K]): void {
  data[key] = value;
}

/** The OS-level "reduce motion" preference (false where it cannot be read). */
function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Persistent settings: loads once, validates every field, emits on every change and persists on a
 * trailing timer (flushed when the page is hidden or closed).
 * `testMode` (GameContext.testMode): nothing follows the operating system — every setting that was not
 * stored starts from DEFAULT_SETTINGS, so automated runs see the same (full-flash) game on every machine.
 */
export function createSettings(storage: GameStorage, events: EventBus, testMode = false): Settings {
  const data: SettingsData = { ...DEFAULT_SETTINGS };
  const stored = storage.getJson<Partial<Record<keyof SettingsData, unknown>>>(STORAGE_KEYS.SETTINGS, {});
  const has = (key: keyof SettingsData): boolean => stored !== null && typeof stored === 'object' && key in stored;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsData)[]) {
    if (has(key)) assign(data, key, sanitize(key, stored[key], DEFAULT_SETTINGS[key]));
  }
  // Nothing stored yet: follow the operating system's reduced-motion preference (never in test mode:
  // the harness asks for reduced motion to calm the CSS, which must not also mute every flash).
  if (!has('reduceFlashes')) data.reduceFlashes = !testMode && prefersReducedMotion();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    storage.setJson(STORAGE_KEYS.SETTINGS, data);
  };

  const schedule = (): void => {
    dirty = true;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, PERSIST_DELAY_MS);
  };

  const set = <K extends keyof SettingsData>(key: K, value: SettingsData[K]): void => {
    const next = sanitize(key, value, data[key]);
    if (next === data[key]) return;
    data[key] = next;
    schedule();
    events.emit('settings:changed', { key, data });
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flush();
    });
    window.addEventListener('pagehide', flush);
  }

  return {
    data,
    defaults: DEFAULT_SETTINGS,
    set,
    resetToDefaults(): void {
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsData)[]) {
        set(key, DEFAULT_SETTINGS[key]);
      }
    },
    flush,
  };
}
