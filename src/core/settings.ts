import { DIFFICULTIES, QUALITY_PRESETS, STORAGE_KEYS } from './constants';
import { clamp } from './math';
import type { EventBus, GameStorage, Settings, SettingsData } from './types';

export const DEFAULT_SETTINGS: Readonly<SettingsData> = {
  sensitivity: 1,
  invertY: false,
  fov: 78,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  quality: 'high',
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
    return ((QUALITY_PRESETS as readonly unknown[]).includes(value) ? value : fallback) as SettingsData[K];
  }
  if (key === 'difficulty') {
    return ((DIFFICULTIES as readonly unknown[]).includes(value) ? value : fallback) as SettingsData[K];
  }
  return fallback;
}

function assign<K extends keyof SettingsData>(data: SettingsData, key: K, value: SettingsData[K]): void {
  data[key] = value;
}

/** Persistent settings: loads once, validates every field, persists + emits on every change. */
export function createSettings(storage: GameStorage, events: EventBus): Settings {
  const data: SettingsData = { ...DEFAULT_SETTINGS };
  const stored = storage.getJson<Partial<Record<keyof SettingsData, unknown>>>(STORAGE_KEYS.SETTINGS, {});
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsData)[]) {
      if (key in stored) {
        assign(data, key, sanitize(key, stored[key], DEFAULT_SETTINGS[key]));
      }
    }
  }

  const set = <K extends keyof SettingsData>(key: K, value: SettingsData[K]): void => {
    const next = sanitize(key, value, data[key]);
    if (next === data[key]) return;
    data[key] = next;
    storage.setJson(STORAGE_KEYS.SETTINGS, data);
    events.emit('settings:changed', { key, data });
  };

  return {
    data,
    defaults: DEFAULT_SETTINGS,
    set,
    resetToDefaults(): void {
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof SettingsData)[]) {
        set(key, DEFAULT_SETTINGS[key]);
      }
    },
  };
}
