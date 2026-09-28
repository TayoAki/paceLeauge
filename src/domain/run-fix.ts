import { haversineM } from './geo';
import type { ActiveSegment, EpochMs, TrackPoint } from './types';
import { validateRun, type RunValidation } from './validator';

/**
 * "Fix a run" (docs/ROADMAP.md 1.5), on the phone: the same trim and cut rules as the server's
 * public.edit_run, so the screen can show what a fix does before it is saved, and a finder for
 * stretches recorded while the runner stood still. The server re-validates and re-scores every
 * edit itself; nothing here is trusted.
 */
export interface RunEdit {
  /** Keep from here (defaults to the run's start). */
  keepFromMs?: EpochMs;
  /** Keep until here (defaults to the run's end). */
  keepToMs?: EpochMs;
  /** Ranges to cut out, inside the kept window. */
  cutRanges?: { fromMs: EpochMs; toMs: EpochMs }[];
}

/** The server refuses a fix that keeps less than a minute. */
export const MIN_KEPT_MS = 60_000;
export const MAX_CUT_RANGES = 20;

export interface EditedRun {
  segments: ActiveSegment[];
  points: TrackPoint[];
}

/**
 * Each segment clipped to the kept window, minus every cut range; each remaining piece becomes a
 * segment of its own and keeps only its own points. Null when the edit is invalid or keeps nothing
 * (the server would refuse it with invalid_input).
 */
export function applyEdit(segments: readonly ActiveSegment[], points: readonly TrackPoint[], edit: RunEdit): EditedRun | null {
  if (segments.length === 0) return null;
  const started = segments[0]!.startAt;
  const ended = segments[segments.length - 1]!.endAt;
  const from = edit.keepFromMs ?? started;
  const to = edit.keepToMs ?? ended;
  const cuts = edit.cutRanges ?? [];
  if (from < started || to > ended || to - from < MIN_KEPT_MS) return null;
  if (cuts.length > MAX_CUT_RANGES || cuts.some((c) => c.fromMs >= c.toMs || c.fromMs < from || c.toMs > to)) return null;

  const pieces: { old: number; from: number; to: number; index: number }[] = [];
  for (const seg of segments) {
    const lo = Math.max(seg.startAt, from);
    const hi = Math.min(seg.endAt, to);
    if (lo >= hi) continue;
    let work: [number, number][] = [[lo, hi]];
    for (const cut of cuts) {
      const next: [number, number][] = [];
      for (const [a, b] of work) {
        if (cut.toMs <= a || cut.fromMs >= b) {
          next.push([a, b]);
          continue;
        }
        if (cut.fromMs > a) next.push([a, cut.fromMs]);
        if (cut.toMs < b) next.push([cut.toMs, b]);
      }
      work = next;
    }
    for (const [a, b] of work.sort((x, y) => x[0] - y[0])) pieces.push({ old: seg.index, from: a, to: b, index: pieces.length });
  }
  if (pieces.length === 0) return null;

  const kept: TrackPoint[] = [];
  for (const p of points) {
    for (const piece of pieces) {
      if (p.segmentIndex === piece.old && p.t >= piece.from && p.t <= piece.to) kept.push({ ...p, segmentIndex: piece.index });
    }
  }
  kept.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return { segments: pieces.map((p) => ({ index: p.index, startAt: p.from, endAt: p.to })), points: kept };
}

/** Validates an edited run the way the server will (without the upload-time checks). */
export function previewEdit(segments: readonly ActiveSegment[], points: readonly TrackPoint[], edit: RunEdit): RunValidation | null {
  const edited = applyEdit(segments, points, edit);
  if (!edited) return null;
  return validateRun({
    startedAt: edited.segments[0]!.startAt,
    endedAt: edited.segments[edited.segments.length - 1]!.endAt,
    segments: edited.segments,
    points: edited.points,
    receivedAt: null,
  });
}

export interface StopSection {
  fromMs: EpochMs;
  toMs: EpochMs;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Stretches inside a segment where every fix stayed within `radiusM` of where the runner stopped,
 * for at least `minMs`: a traffic light, a chat, a phone left running on a bench. Accurate fixes
 * only. The ends are then pulled in to fixes within `tightM` of the stop's median position, so
 * cutting a stop removes the standing time and not the running just before or after it.
 */
export function findStops(
  segments: readonly ActiveSegment[],
  points: readonly TrackPoint[],
  options: { minMs?: number; radiusM?: number; tightM?: number; maxAccuracyM?: number } = {},
): StopSection[] {
  const minMs = options.minMs ?? 60_000;
  const radiusM = options.radiusM ?? 20;
  const tightM = options.tightM ?? 8;
  const maxAccuracyM = options.maxAccuracyM ?? 30;
  const stops: StopSection[] = [];
  for (const seg of segments) {
    const pts = points
      .filter((p) => p.segmentIndex === seg.index && p.t >= seg.startAt && p.t <= seg.endAt && p.accuracyM !== null && p.accuracyM <= maxAccuracyM)
      .sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < pts.length) {
      const anchor = pts[i]!;
      let j = i;
      while (j + 1 < pts.length && haversineM(anchor, pts[j + 1]!) <= radiusM) j += 1;
      if (pts[j]!.t - anchor.t < minMs) {
        i += 1;
        continue;
      }
      const window = pts.slice(i, j + 1);
      const centre = { lat: median(window.map((p) => p.lat)), lon: median(window.map((p) => p.lon)) };
      const still = window.filter((p) => haversineM(p, centre) <= tightM);
      const first = still[0];
      const last = still[still.length - 1];
      if (first && last && last.t - first.t >= minMs) stops.push({ fromMs: first.t, toMs: last.t });
      i = j + 1;
    }
  }
  return stops;
}
