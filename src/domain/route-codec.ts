import { UPLOAD_RULES } from './config';
import type { ActiveSegment, EpochMs, TrackPoint } from './types';

/**
 * Wire format for route chunks: [seq, t, lat, lon, accuracy, segmentIndex].
 * Coordinates are normalized to 7 decimals (~1 cm) and accuracy to 0.1 m *at capture*, so
 * the device's provisional validation and the server's authoritative validation read
 * exactly the same numbers.
 */
export type CompactPoint = [seq: number, t: EpochMs, lat: number, lon: number, accuracyM: number | null, segmentIndex: number];

export function normalizeCoordinate(x: number): number {
  return Math.round(x * 1e7) / 1e7;
}

export function normalizeAccuracy(accuracy: number | null | undefined): number | null {
  if (accuracy === null || accuracy === undefined || !Number.isFinite(accuracy) || accuracy < 0) return null;
  return Math.round(accuracy * 10) / 10;
}

export function toCompact(p: TrackPoint): CompactPoint {
  return [p.seq, p.t, p.lat, p.lon, p.accuracyM, p.segmentIndex];
}

export function fromCompact(c: CompactPoint): TrackPoint {
  return { seq: c[0], t: c[1], lat: c[2], lon: c[3], accuracyM: c[4], segmentIndex: c[5] };
}

export function encodeChunk(points: readonly TrackPoint[]): string {
  return JSON.stringify(points.map(toCompact));
}

export function chunk<T>(items: readonly T[], size: number = UPLOAD_RULES.maxPointsPerChunk): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);
}

/** GPX 1.1 export of one run: one track segment per active segment. */
export function toGpx(run: { title: string; startedAt: EpochMs }, segments: readonly ActiveSegment[], points: readonly TrackPoint[]): string {
  const bySegment = new Map<number, TrackPoint[]>();
  for (const p of [...points].sort((a, b) => a.t - b.t || a.seq - b.seq)) {
    const list = bySegment.get(p.segmentIndex) ?? [];
    list.push(p);
    bySegment.set(p.segmentIndex, list);
  }
  const trksegs = segments
    .map((s) => {
      const pts = (bySegment.get(s.index) ?? [])
        .map((p) => `      <trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
        .join('\n');
      return `    <trkseg>\n${pts}\n    </trkseg>`;
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="PaceLeague" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><time>${new Date(run.startedAt).toISOString()}</time></metadata>`,
    '  <trk>',
    `    <name>${escapeXml(run.title)}</name>`,
    trksegs,
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}
