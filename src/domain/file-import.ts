import { Decoder, Stream } from '@garmin/fitsdk';

import type { EpochMs } from './types';

/**
 * GPX, TCX and FIT files (docs/ROADMAP.md 2.4), parsed on the phone into one shape. A file can be
 * edited, so the server keeps file imports as history; parsing here only has to be faithful, not
 * trusted. Files carry no GPS accuracy, so points get a nominal one for measuring distance.
 */
export type FileActivity = 'run' | 'walk' | 'hike' | 'ride' | 'other';

export interface FilePoint {
  t: EpochMs;
  lat: number;
  lon: number;
  accuracyM: number | null;
}

export interface ParsedActivity {
  format: 'gpx' | 'tcx' | 'fit';
  activity: FileActivity;
  start: EpochMs;
  end: EpochMs;
  points: FilePoint[];
  /** Stretches between track segments or timer stops, when the file records them. */
  pauses: { from: EpochMs; to: EpochMs }[];
  /** Distance the file itself reports, if any. */
  distanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  /** The app or device that wrote the file. */
  creator: string | null;
  name: string | null;
}

export class FileImportError extends Error {
  constructor(readonly reason: 'unknown_format' | 'no_points' | 'unreadable') {
    super(reason);
    this.name = 'FileImportError';
  }
}

/** Points in files carry no accuracy: treat them as a good fix (5 m) for measuring distance. */
export const NOMINAL_FILE_ACCURACY_M = 5;

export function activityFromName(text: string | null | undefined): FileActivity {
  const t = (text ?? '').toLowerCase();
  if (/run|jog|treadmill/.test(t)) return 'run';
  if (/walk/.test(t)) return 'walk';
  if (/hik|trek/.test(t)) return 'hike';
  if (/rid|bik|cycl/.test(t)) return 'ride';
  return t ? 'other' : 'run';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(xml: string, tag: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return match ? decodeEntities(match[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : null;
}

function attr(tagSource: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tagSource);
  const value = match ? (match[1] ?? match[2] ?? null) : null;
  return value === null ? null : decodeEntities(value);
}

function heartStats(rates: number[]): { avg: number | null; max: number | null } {
  const valid = rates.filter((r) => Number.isFinite(r) && r >= 25 && r <= 250);
  if (valid.length === 0) return { avg: null, max: null };
  return { avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length), max: Math.max(...valid) };
}

function finish(parsed: Omit<ParsedActivity, 'start' | 'end'>): ParsedActivity {
  const points = parsed.points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (points.length === 0) throw new FileImportError('no_points');
  return { ...parsed, points, start: points[0]!.t, end: points[points.length - 1]!.t };
}

export function parseGpx(xml: string): ParsedActivity {
  if (!/<gpx\b/i.test(xml)) throw new FileImportError('unknown_format');
  const creator = attr(/<gpx\b[^>]*>/i.exec(xml)?.[0] ?? '', 'creator');
  const trk = /<trk\b[\s\S]*?<\/trk>/i.exec(xml)?.[0] ?? xml;
  const points: FilePoint[] = [];
  const pauses: { from: number; to: number }[] = [];
  const rates: number[] = [];
  let previousSegmentEnd: number | null = null;
  for (const seg of trk.match(/<trkseg\b[\s\S]*?<\/trkseg>/gi) ?? []) {
    let first: number | null = null;
    let last: number | null = null;
    for (const pt of seg.match(/<trkpt\b[\s\S]*?(?:\/>|<\/trkpt>)/gi) ?? []) {
      const open = /<trkpt\b[^>]*>/i.exec(pt)?.[0] ?? pt;
      const lat = Number(attr(open, 'lat'));
      const lon = Number(attr(open, 'lon'));
      const time = tagText(pt, 'time');
      const t = time ? Date.parse(time) : NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) continue;
      points.push({ t, lat, lon, accuracyM: NOMINAL_FILE_ACCURACY_M });
      const hr = tagText(pt, 'hr');
      if (hr) rates.push(Number(hr));
      first ??= t;
      last = t;
    }
    if (first !== null && previousSegmentEnd !== null && first > previousSegmentEnd) pauses.push({ from: previousSegmentEnd, to: first });
    if (last !== null) previousSegmentEnd = last;
  }
  const heart = heartStats(rates);
  return finish({
    format: 'gpx',
    activity: activityFromName(tagText(trk, 'type')),
    points,
    pauses,
    distanceM: null,
    avgHeartRate: heart.avg,
    maxHeartRate: heart.max,
    creator,
    name: tagText(trk, 'name'),
  });
}

export function parseTcx(xml: string): ParsedActivity {
  if (!/<TrainingCenterDatabase\b/i.test(xml)) throw new FileImportError('unknown_format');
  const activity = /<Activity\b[^>]*>/i.exec(xml)?.[0] ?? '';
  const points: FilePoint[] = [];
  const pauses: { from: number; to: number }[] = [];
  const rates: number[] = [];
  let distanceM = 0;
  let hasDistance = false;
  let previousLapEnd: number | null = null;
  for (const lap of xml.match(/<Lap\b[\s\S]*?<\/Lap>/gi) ?? []) {
    const lapDistance = Number(tagText(lap.replace(/<Track\b[\s\S]*<\/Track>/i, ''), 'DistanceMeters'));
    if (Number.isFinite(lapDistance) && lapDistance > 0) {
      distanceM += lapDistance;
      hasDistance = true;
    }
    let first: number | null = null;
    let last: number | null = null;
    for (const tp of lap.match(/<Trackpoint\b[\s\S]*?<\/Trackpoint>/gi) ?? []) {
      const time = tagText(tp, 'Time');
      const t = time ? Date.parse(time) : NaN;
      const lat = Number(tagText(tp, 'LatitudeDegrees'));
      const lon = Number(tagText(tp, 'LongitudeDegrees'));
      const hr = tagText(/<HeartRateBpm\b[\s\S]*?<\/HeartRateBpm>/i.exec(tp)?.[0] ?? '', 'Value');
      if (hr) rates.push(Number(hr));
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || tagText(tp, 'LatitudeDegrees') === null) continue;
      points.push({ t, lat, lon, accuracyM: NOMINAL_FILE_ACCURACY_M });
      first ??= t;
      last = t;
    }
    if (first !== null && previousLapEnd !== null && first - previousLapEnd > 15_000) pauses.push({ from: previousLapEnd, to: first });
    if (last !== null) previousLapEnd = last;
  }
  const heart = heartStats(rates);
  return finish({
    format: 'tcx',
    activity: activityFromName(attr(activity, 'Sport')),
    points,
    pauses,
    distanceM: hasDistance ? distanceM : null,
    avgHeartRate: heart.avg,
    maxHeartRate: heart.max,
    creator: tagText(/<Creator\b[\s\S]*?<\/Creator>/i.exec(xml)?.[0] ?? '', 'Name'),
    name: null,
  });
}

const SEMICIRCLES_TO_DEGREES = 180 / 2 ** 31;

interface FitRecord {
  timestamp?: Date;
  positionLat?: number;
  positionLong?: number;
  heartRate?: number;
}

export function parseFit(bytes: Uint8Array): ParsedActivity {
  const stream = Stream.fromByteArray(bytes);
  if (!Decoder.isFIT(stream)) throw new FileImportError('unknown_format');
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read();
  if (errors.length > 0 && !messages?.recordMesgs?.length) throw new FileImportError('unreadable');
  const records = (messages.recordMesgs ?? []) as FitRecord[];
  const session = (messages.sessionMesgs ?? [])[0] as
    | { sport?: string; totalDistance?: number; avgHeartRate?: number; maxHeartRate?: number }
    | undefined;
  const points: FilePoint[] = [];
  for (const r of records) {
    if (!r.timestamp || r.positionLat === undefined || r.positionLong === undefined) continue;
    points.push({
      t: r.timestamp.getTime(),
      lat: r.positionLat * SEMICIRCLES_TO_DEGREES,
      lon: r.positionLong * SEMICIRCLES_TO_DEGREES,
      accuracyM: NOMINAL_FILE_ACCURACY_M,
    });
  }
  // Timer stops and starts mark the pauses.
  const pauses: { from: number; to: number }[] = [];
  let stoppedAt: number | null = null;
  for (const e of (messages.eventMesgs ?? []) as { timestamp?: Date; event?: string; eventType?: string }[]) {
    if (e.event !== 'timer' || !e.timestamp) continue;
    if ((e.eventType === 'stop' || e.eventType === 'stopAll') && stoppedAt === null) stoppedAt = e.timestamp.getTime();
    if (e.eventType === 'start' && stoppedAt !== null) {
      pauses.push({ from: stoppedAt, to: e.timestamp.getTime() });
      stoppedAt = null;
    }
  }
  const heart = heartStats(records.map((r) => r.heartRate ?? NaN));
  const fileId = (messages.fileIdMesgs ?? [])[0] as { manufacturer?: string; garminProduct?: string; product?: string | number } | undefined;
  return finish({
    format: 'fit',
    activity: activityFromName(session?.sport),
    points,
    pauses,
    distanceM: session?.totalDistance ?? null,
    avgHeartRate: session?.avgHeartRate ?? heart.avg,
    maxHeartRate: session?.maxHeartRate ?? heart.max,
    creator: fileId ? [fileId.manufacturer, fileId.garminProduct ?? fileId.product].filter(Boolean).join(' ') || null : null,
    name: null,
  });
}

/** Detects the format from the name and content, and parses it. */
export function parseActivityFile(name: string, bytes: Uint8Array): ParsedActivity {
  const lower = name.toLowerCase();
  if (lower.endsWith('.fit')) return parseFit(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (lower.endsWith('.gpx') || /<gpx\b/i.test(text)) return parseGpx(text);
  if (lower.endsWith('.tcx') || /<TrainingCenterDatabase\b/i.test(text)) return parseTcx(text);
  // Some apps export FIT without the extension.
  try {
    return parseFit(bytes);
  } catch {
    throw new FileImportError('unknown_format');
  }
}
