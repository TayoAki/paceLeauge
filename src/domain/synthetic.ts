import { destinationPoint, haversineM, type LatLon } from './geo';
import { normalizeAccuracy, normalizeCoordinate } from './route-codec';
import type { ActiveSegment, EpochMs, TrackPoint } from './types';

/**
 * Deterministic synthetic routes for logic tests and the development location simulator.
 * Synthetic data exercises validation and scoring rules only; it is never evidence of GPS
 * quality on a real device (see docs/DEVICE_TEST_PROTOCOL.md).
 */

export interface RunLeg {
  kind: 'run';
  durationS: number;
  speedMps: number;
  bearingDeg?: number;
  sampleIntervalS?: number;
  accuracyM?: number;
  /** Offsets (seconds from leg start, [from, to)) during which no samples are delivered. */
  dropouts?: [number, number][];
}

export interface PauseLeg {
  kind: 'pause';
  durationS: number;
  /** Distance travelled while paused (never recorded). */
  movedM?: number;
  bearingDeg?: number;
}

export type Leg = RunLeg | PauseLeg;

export interface SyntheticRun {
  startedAt: EpochMs;
  endedAt: EpochMs;
  segments: ActiveSegment[];
  points: TrackPoint[];
  /** Straight-line ground truth of the active legs, before coordinate normalization. */
  truthDistanceM: number;
}

export const CHICAGO_LAKEFRONT: LatLon = { lat: 41.8781136, lon: -87.6297982 };

export function buildSyntheticRun(options: { startAt: EpochMs; origin?: LatLon; legs: Leg[] }): SyntheticRun {
  let position = options.origin ?? CHICAGO_LAKEFRONT;
  let clock = options.startAt;
  let seq = 0;
  let truthDistanceM = 0;
  const segments: ActiveSegment[] = [];
  const points: TrackPoint[] = [];

  for (const leg of options.legs) {
    if (leg.kind === 'pause') {
      if (leg.movedM) position = destinationPoint(position, leg.bearingDeg ?? 90, leg.movedM);
      clock += leg.durationS * 1000;
      continue;
    }
    const index = segments.length;
    const interval = leg.sampleIntervalS ?? 1;
    const bearing = leg.bearingDeg ?? 90;
    const legStart = clock;
    const samples = Math.floor(leg.durationS / interval);
    for (let k = 0; k <= samples; k += 1) {
      const offsetS = k * interval;
      const dropped = leg.dropouts?.some(([from, to]) => offsetS >= from && offsetS < to);
      if (dropped) continue;
      const at = destinationPoint(position, bearing, leg.speedMps * offsetS);
      points.push({
        seq: seq++,
        segmentIndex: index,
        t: legStart + Math.round(offsetS * 1000),
        lat: normalizeCoordinate(at.lat),
        lon: normalizeCoordinate(at.lon),
        accuracyM: normalizeAccuracy(leg.accuracyM ?? 5),
      });
    }
    const legDistance = leg.speedMps * leg.durationS;
    truthDistanceM += legDistance;
    position = destinationPoint(position, bearing, legDistance);
    clock = legStart + leg.durationS * 1000;
    segments.push({ index, startAt: legStart, endAt: clock });
  }

  return {
    startedAt: options.startAt,
    endedAt: segments[segments.length - 1]?.endAt ?? options.startAt,
    segments,
    points,
    truthDistanceM,
  };
}

/** A steady single-segment run covering `distanceM` in `durationS`. */
export function steadyRun(startAt: EpochMs, distanceM: number, durationS: number, overrides: Partial<RunLeg> = {}): SyntheticRun {
  return buildSyntheticRun({
    startAt,
    legs: [{ kind: 'run', durationS, speedMps: distanceM / durationS, ...overrides }],
  });
}

/** A run through `waypoints` at a steady speed, one fix a second, in one stretch. */
export function routeRun(startAt: EpochMs, waypoints: readonly LatLon[], speedMps: number): SyntheticRun {
  const points: TrackPoint[] = [];
  let t = startAt;
  let truthDistanceM = 0;
  const push = (p: LatLon) =>
    points.push({ seq: points.length, segmentIndex: 0, t, lat: normalizeCoordinate(p.lat), lon: normalizeCoordinate(p.lon), accuracyM: normalizeAccuracy(5) });
  if (waypoints[0]) push(waypoints[0]);
  for (let k = 1; k < waypoints.length; k++) {
    const [a, b] = [waypoints[k - 1]!, waypoints[k]!];
    const length = haversineM(a, b);
    const steps = Math.max(1, Math.round(length / speedMps));
    for (let s = 1; s <= steps; s++) {
      t += 1000;
      push({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps });
    }
    truthDistanceM += length;
  }
  return { startedAt: startAt, endedAt: t, segments: [{ index: 0, startAt, endAt: t }], points, truthDistanceM };
}
