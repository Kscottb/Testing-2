/**
 * Time-of-day arc tied to progress (brief section 3) with a baseline look per stage.
 */
import { TIME_OF_DAY_IDS } from '../core/constants';
import type { TimeOfDayDef, TimeOfDayId } from '../core/types';
import { waveDef } from './waves';

export const TIME_OF_DAY: Readonly<Record<TimeOfDayId, TimeOfDayDef>> = {
  dusk: {
    id: 'dusk',
    name: 'AMBER DUSK',
    waveFrom: 1,
    waveTo: 3,
    weather: 'embers',
    lightningPerMinute: 0,
    sunElevation: 14,
    sunAzimuth: 250,
    sunColor: 0xffb27a,
    sunIntensity: 3.2,
    ambientSky: 0x6f8fa6,
    ambientGround: 0x2a2420,
    ambientIntensity: 0.9,
    fogColor: 0xc98b62,
    fogDensity: 0.0032,
    storm: 0,
    night: 0.1,
  },
  twilight: {
    id: 'twilight',
    name: 'VIOLET TWILIGHT',
    waveFrom: 4,
    waveTo: 6,
    weather: 'haze',
    lightningPerMinute: 1,
    sunElevation: 5,
    sunAzimuth: 262,
    sunColor: 0xc88cff,
    sunIntensity: 2.1,
    ambientSky: 0x4a4a86,
    ambientGround: 0x1c1a2a,
    ambientIntensity: 0.8,
    fogColor: 0x5a4a8a,
    fogDensity: 0.004,
    storm: 0.25,
    night: 0.5,
  },
  stormnight: {
    id: 'stormnight',
    name: 'STORMNIGHT',
    waveFrom: 7,
    waveTo: 9,
    weather: 'staticRain',
    lightningPerMinute: 9,
    sunElevation: 32,
    sunAzimuth: 300,
    sunColor: 0x8fa6d8,
    sunIntensity: 1.1,
    ambientSky: 0x1f2f48,
    ambientGround: 0x0c1016,
    ambientIntensity: 0.7,
    fogColor: 0x16222e,
    fogDensity: 0.0058,
    storm: 1,
    night: 1,
  },
  eclipse: {
    id: 'eclipse',
    name: 'ECLIPSE',
    waveFrom: 10,
    waveTo: 10,
    weather: 'vortex',
    lightningPerMinute: 14,
    sunElevation: 48,
    sunAzimuth: 90,
    sunColor: 0xff5a8c,
    sunIntensity: 1.6,
    ambientSky: 0x4a1030,
    ambientGround: 0x120810,
    ambientIntensity: 0.75,
    fogColor: 0x2a0c20,
    fogDensity: 0.005,
    storm: 0.9,
    night: 0.9,
  },
};

export const TIME_OF_DAY_LIST: readonly TimeOfDayDef[] = TIME_OF_DAY_IDS.map((id) => TIME_OF_DAY[id]);

/** Time of day scheduled for a 1-based wave number. */
export function timeOfDayForWave(wave: number): TimeOfDayId {
  return waveDef(wave).timeOfDay;
}
