import type { EffortKey, PaceRange, PaceZones } from './types';

/** Distances of the best efforts (1.4). */
export const EFFORT_DISTANCE_M: Record<EffortKey, number> = {
  '1k': 1000,
  '1mi': 1609.344,
  '5k': 5000,
  '10k': 10000,
  half: 21097.5,
  marathon: 42195,
};

/** Riegel's formula: a time at one distance predicts a time at another. */
export function riegel(timeS: number, fromM: number, toM: number, exponent = 1.06): number {
  return timeS * Math.pow(toM / fromM, exponent);
}

/**
 * Current fitness as a 5K time: the best prediction among the runner's efforts of a mile or more
 * (a single fast kilometre says little about endurance).
 */
export function fitness5kS(best: Partial<Record<EffortKey, number>>): number | null {
  let bestS: number | null = null;
  for (const [key, timeS] of Object.entries(best) as [EffortKey, number | undefined][]) {
    if (!timeS || timeS <= 0 || key === '1k') continue;
    const predicted = riegel(timeS, EFFORT_DISTANCE_M[key], 5000);
    if (bestS === null || predicted < bestS) bestS = predicted;
  }
  return bestS === null ? null : Math.round(bestS);
}

const range = (paceS: number, fast: number, slow: number): PaceRange => ({
  fastSPerKm: Math.round(paceS * fast),
  slowSPerKm: Math.round(paceS * slow),
});

/** Training paces relative to 5K pace. Easy is deliberately wide: it should feel conversational. */
export function paceZones(fiveKS: number, racePaceSPerKm: number): PaceZones {
  const p = fiveKS / 5;
  return {
    easy: range(p, 1.22, 1.42),
    steady: range(p, 1.12, 1.2),
    tempo: range(p, 1.04, 1.09),
    interval: range(p, 0.96, 1.01),
    race: { fastSPerKm: Math.round(racePaceSPerKm * 0.99), slowSPerKm: Math.round(racePaceSPerKm * 1.01) },
  };
}

/** Heart-rate zones as fractions of maximum heart rate (Pro: training by heart rate). */
export const HR_ZONE_FRACTIONS: [number, number][] = [
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1.0],
];

export function hrZones(maxHr: number): { low: number; high: number }[] {
  return HR_ZONE_FRACTIONS.map(([low, high]) => ({ low: Math.round(maxHr * low), high: Math.round(maxHr * high) }));
}

/** Which heart-rate range each effort aims for. */
export function hrRangeForEffort(maxHr: number, effort: keyof PaceZones | 'walk'): { low: number; high: number } {
  const f: Record<keyof PaceZones | 'walk', [number, number]> = {
    walk: [0.5, 0.65],
    easy: [0.6, 0.72],
    steady: [0.72, 0.8],
    tempo: [0.8, 0.88],
    interval: [0.88, 0.95],
    race: [0.85, 0.95],
  };
  const [low, high] = f[effort];
  return { low: Math.round(maxHr * low), high: Math.round(maxHr * high) };
}

/**
 * Heat (Pro): how much slower to run for a temperature and dew point, from the widely used
 * "temperature plus dew point" guide (in °F). Null means hard running isn't advised at all.
 */
export function heatSlowdown(tempC: number, dewPointC: number): number | null {
  const sumF = tempC * 1.8 + 32 + (dewPointC * 1.8 + 32);
  const table: [number, number][] = [
    [100, 0],
    [110, 0.005],
    [120, 0.01],
    [130, 0.02],
    [140, 0.03],
    [150, 0.045],
    [160, 0.06],
    [170, 0.08],
    [180, 0.1],
  ];
  for (const [limit, slowdown] of table) if (sumF <= limit) return slowdown;
  return null;
}

export function slowRange(r: PaceRange, slowdown: number): PaceRange {
  return { fastSPerKm: Math.round(r.fastSPerKm * (1 + slowdown)), slowSPerKm: Math.round(r.slowSPerKm * (1 + slowdown)) };
}
