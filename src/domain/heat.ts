import { heatSlowdown, slowRange } from './plans/paces';
import type { PaceZones } from './plans/types';

/**
 * Heat (docs/ROADMAP.md Part B point 4, Pro): on a hot, humid day the same effort runs slower.
 * The runner gives the temperature and humidity; the plan's pace ranges slow down by the
 * "temperature plus dew point" guide in `heatSlowdown`. Heart-rate ranges stay the same, since
 * heart rate already rises in the heat.
 */
export interface HeatReading {
  tempC: number;
  /** Relative humidity, 1–100 %. */
  humidity: number;
}

/** Dew point from temperature and relative humidity (the Magnus formula), in °C. */
export function dewPointC(tempC: number, humidity: number): number {
  const b = 17.62;
  const c = 243.12;
  const rh = Math.min(100, Math.max(1, humidity));
  const gamma = Math.log(rh / 100) + (b * tempC) / (c + tempC);
  return (c * gamma) / (b - gamma);
}

export interface HeatAdvice {
  dewPointC: number;
  /** How much slower to run (0.045 is 4.5 %); null when hard running isn't advised at all. */
  slowdown: number | null;
}

export function heatAdvice(reading: HeatReading): HeatAdvice {
  const dew = dewPointC(reading.tempC, reading.humidity);
  return { dewPointC: Math.round(dew * 10) / 10, slowdown: heatSlowdown(reading.tempC, dew) };
}

/** Every pace range slowed for the heat. */
export function heatZones(zones: PaceZones, slowdown: number): PaceZones {
  return Object.fromEntries(Object.entries(zones).map(([k, r]) => [k, slowRange(r, slowdown)])) as PaceZones;
}

export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const cToF = (c: number) => c * 1.8 + 32;
