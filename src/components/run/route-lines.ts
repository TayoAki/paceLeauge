import { RECORDER_V1 } from '@/domain/config';
import type { TrackPoint } from '@/domain/types';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Splits a route into drawable lines at pause boundaries and GPS gaps, so a map never
 * draws a connecting line (or implies distance) the recorder did not observe.
 */
export function routeLines(points: readonly Pick<TrackPoint, 't' | 'lat' | 'lon' | 'segmentIndex' | 'accuracyM'>[]): LatLng[][] {
  const lines: LatLng[][] = [];
  let current: LatLng[] = [];
  let previous: (typeof points)[number] | null = null;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  for (const p of sorted) {
    if (p.accuracyM === null || p.accuracyM > RECORDER_V1.maxHorizontalAccuracyM) continue;
    const breakLine = previous !== null && (p.segmentIndex !== previous.segmentIndex || p.t - previous.t > RECORDER_V1.gapThresholdMs);
    if (breakLine && current.length > 0) {
      lines.push(current);
      current = [];
    }
    current.push({ latitude: p.lat, longitude: p.lon });
    previous = p;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
