import { z } from 'zod';

import type { Journal, RunOrigin, SavedRunDraft } from '@/db/journal';
import { isValidCoordinate } from '@/domain/geo';
import type { ActiveSegment, TrackPoint } from '@/domain/types';
import { validateRun } from '@/domain/validator';
import { defaultRunTitle } from '@/features/recording/run-draft';
import { Emitter } from '@/lib/emitter';

import type { WatchLinkPort } from './watch-link';

/**
 * Runs recorded on the PaceLeague Apple Watch app (docs/ROADMAP.md 2.2). The watch sends each one
 * as a file when the phone is next in reach; it also saves the workout to Apple Health with the
 * same run id, so whichever reaches the phone first is saved and the other finds it already there.
 * Either way the run syncs through the outbox with source 'watch' and is validated like a phone run.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const watchRunSchema = z.object({
  version: z.literal(1),
  run_id: z.string().regex(UUID),
  started_at: z.number(),
  ended_at: z.number(),
  segments: z.array(z.tuple([z.number(), z.number()])).min(1).max(1000),
  points: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).max(50_000),
  distance_m: z.number().min(0).max(1_000_000),
  indoor: z.boolean(),
  avg_heart_rate: z.number().nullable().optional(),
  max_heart_rate: z.number().nullable().optional(),
  steps: z.number().nullable().optional(),
  device: z.string().nullable().optional(),
});
export type WatchRunFile = z.infer<typeof watchRunSchema>;

export function parseWatchRun(json: string): WatchRunFile | null {
  try {
    const parsed = watchRunSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    const run = parsed.data;
    return run.ended_at >= run.started_at ? run : null;
  } catch {
    return null;
  }
}

const bpm = (v: number | null | undefined) => (typeof v === 'number' && v >= 25 && v <= 250 ? Math.round(v) : null);

/** The saved run and its origin for a watch run file. */
export function watchRun(file: WatchRunFile): { draft: SavedRunDraft; points: TrackPoint[]; origin: RunOrigin } {
  const segments: ActiveSegment[] = file.segments
    .map(([startAt, endAt]) => ({ startAt: Math.round(startAt), endAt: Math.round(endAt) }))
    .filter((s) => s.endAt > s.startAt)
    .sort((a, b) => a.startAt - b.startAt)
    .map((s, index) => ({ index, ...s }));
  if (segments.length === 0) segments.push({ index: 0, startAt: Math.round(file.started_at), endAt: Math.round(file.ended_at) });
  const points: TrackPoint[] = [];
  for (const [t, lat, lon, accuracy] of [...file.points].sort((a, b) => a[0] - b[0])) {
    const segment = segments.find((s) => t >= s.startAt && t <= s.endAt);
    if (!segment || !isValidCoordinate(lat, lon)) continue;
    points.push({ seq: points.length, t: Math.round(t), lat, lon, accuracyM: accuracy >= 0 ? accuracy : null, segmentIndex: segment.index });
  }
  const startedAt = Math.min(Math.round(file.started_at), segments[0]!.startAt);
  const endedAt = Math.max(Math.round(file.ended_at), segments[segments.length - 1]!.endAt);
  const validation = validateRun({ startedAt, endedAt, segments, points, receivedAt: null });
  const routed = points.length > 1 && !file.indoor;
  const activeMs = segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0);
  return {
    draft: {
      title: file.indoor ? `${defaultRunTitle(startedAt)} treadmill` : defaultRunTitle(startedAt),
      startedAt,
      endedAt,
      activeMs,
      distanceM: routed ? validation.distanceM : file.distance_m,
      segments,
      interrupted: false,
      validation: {
        outcome: validation.outcome,
        reasons: validation.reasons,
        coverage: validation.coverage,
        distanceCm: validation.distanceCm,
        activeMs: validation.activeMs,
      },
      // The server decides; imports show "checking" rather than an estimate.
      provisionalXp: null,
    },
    points: routed ? points : [],
    origin: {
      source: 'watch',
      activityType: 'run',
      sourceApp: 'PaceLeague',
      sourceDevice: file.device ?? 'Apple Watch',
      manualEntry: false,
      externalId: file.run_id,
      claimedDistanceM: file.distance_m,
      avgHeartRate: bpm(file.avg_heart_rate),
      maxHeartRate: bpm(file.max_heart_rate),
      steps: typeof file.steps === 'number' && file.steps >= 0 ? Math.round(file.steps) : null,
      indoor: file.indoor,
    },
  };
}

/** Saves the run files the watch has sent, then lets the native side forget them. */
export class WatchRunInbox {
  private running: Promise<number> | null = null;
  /** Emits the number of runs added by each pass that added some. */
  readonly received = new Emitter<number>();

  constructor(private readonly deps: { journal: Pick<Journal, 'saveImportedRun'>; link: WatchLinkPort | null }) {}

  drain(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Drains whenever the watch sends a run; returns an unsubscribe. */
  watch(): (() => void) | null {
    return this.deps.link?.onRun(() => void this.drain()) ?? null;
  }

  private async pass(): Promise<number> {
    const link = this.deps.link;
    if (!link) return 0;
    let added = 0;
    for (const { name, json } of link.pendingRuns()) {
      const file = parseWatchRun(json);
      if (file) {
        const { draft, points, origin } = watchRun(file);
        const { created } = await this.deps.journal.saveImportedRun(file.run_id, draft, points, origin);
        if (created) added += 1;
      }
      // Saved (or unreadable, which retrying won't fix): either way the file is done with.
      link.ackRun(name);
    }
    if (added > 0) this.received.emit(added);
    return added;
  }
}
