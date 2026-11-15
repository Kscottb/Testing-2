import type { QualityParams, QualityPreset } from '../core/types';

/** Baseline parameters per quality preset ("high" targets 60 fps at 1080p on integrated graphics). */
export const QUALITY: Readonly<Record<QualityPreset, QualityParams>> = {
  low: {
    preset: 'low',
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    bloom: false,
    filmEffects: false,
    particleScale: 0.5,
    maxDecals: 48,
    weatherScale: 0.4,
  },
  medium: {
    preset: 'medium',
    maxPixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    filmEffects: false,
    particleScale: 0.75,
    maxDecals: 96,
    weatherScale: 0.7,
  },
  high: {
    preset: 'high',
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    filmEffects: true,
    particleScale: 1,
    maxDecals: 160,
    weatherScale: 1,
  },
  ultra: {
    preset: 'ultra',
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    bloom: true,
    filmEffects: true,
    particleScale: 1.4,
    maxDecals: 256,
    weatherScale: 1.3,
  },
};
