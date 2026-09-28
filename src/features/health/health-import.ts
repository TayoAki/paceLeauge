import { Platform } from 'react-native';

import type { Journal, RunOrigin, SavedRunDraft } from '@/db/journal';
import { isValidCoordinate } from '@/domain/geo';
import { normalizeAccuracy, normalizeCoordinate } from '@/domain/route-codec';
import type { ActiveSegment, EpochMs, TrackPoint } from '@/domain/types';
import { validateRun } from '@/domain/validator';
import { defaultRunTitle } from '@/features/recording/run-draft';
import { Emitter } from '@/lib/emitter';

/**
 * Apple Health import (docs/ROADMAP.md 2.1 and Part A). Runs from the Apple Watch Workout app, or any
 * app that saves workouts to Health, come into PaceLeague. Each workout becomes a saved run on this
 * phone and syncs through the same outbox as a recorded run, so it gets the same retries and sync
 * states. The workout's Health id is its run id, so importing twice is harmless; the server keeps
 * one copy when a phone recording and an import cover the same time.
 */
export type ImportedActivity = 'run' | 'walk' | 'hike' | 'ride' | 'other';

export interface RoutePoint {
  t: EpochMs;
  lat: number;
  lon: number;
  accuracyM: number | null;
}

export interface HealthWorkout {
  /** Apple Health's id for the workout (a UUID). */
  uuid: string;
  activity: ImportedActivity;
  start: EpochMs;
  end: EpochMs;
  /** Paused stretches, from the workout's pause and resume events. */
  pauses: { from: EpochMs; to: EpochMs }[];
  distanceM: number | null;
  sourceName: string | null;
  sourceBundleId: string | null;
  deviceName: string | null;
  manualEntry: boolean;
  /** Set on workouts PaceLeague wrote itself (1.6): our own run id. */
  externalUuid: string | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  /** An indoor workout (a treadmill): no route, judged by heart rate and steps. */
  indoor?: boolean;
  /** Steps during the workout, when Health has them. */
  steps?: number | null;
  readRoute(): Promise<RoutePoint[]>;
  /** Frees the native object (the library holds routes in memory until released). */
  release?(): void;
}

export interface HealthReaderPort {
  isAvailable(): boolean;
  /** Asks to read workouts, routes and heart rate. Health never says whether reading was allowed. */
  requestRead(): Promise<void>;
  workoutsSince(since: EpochMs): Promise<HealthWorkout[]>;
  /** Wakes the app when Health gets a new workout; returns an unsubscribe. */
  watchNewWorkouts?(onChange: () => void): () => void;
}

interface KvStore {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
}

export const HEALTH_IMPORT_KEY = 'health:import';
/** First connection looks back this far (the roadmap's "last 30 days"). */
export const BACKFILL_DAYS = 30;
/** Later passes look back a day before the newest workout, in case Health delivered late. */
const OVERLAP_MS = 24 * 3_600_000;

export interface ImportState {
  /** End of the newest workout imported so far. */
  newestEndMs: number | null;
  lastRunAtMs: number | null;
  lastImported: number;
}

/** Active stretches of a workout: its span minus the paused stretches. */
export function workoutSegments(start: EpochMs, end: EpochMs, pauses: readonly { from: EpochMs; to: EpochMs }[]): ActiveSegment[] {
  const cuts = [...pauses]
    .map((p) => ({ from: Math.max(start, p.from), to: Math.min(end, p.to) }))
    .filter((p) => p.to > p.from)
    .sort((a, b) => a.from - b.from);
  const segments: ActiveSegment[] = [];
  let cursor = start;
  for (const c of cuts) {
    if (c.from > cursor) segments.push({ index: segments.length, startAt: cursor, endAt: c.from });
    cursor = Math.max(cursor, c.to);
  }
  if (end > cursor) segments.push({ index: segments.length, startAt: cursor, endAt: end });
  return segments.length > 0 ? segments : [{ index: 0, startAt: start, endAt: Math.max(start, end) }];
}

/** Route points inside the active stretches, numbered and assigned to their stretch. */
export function workoutPoints(segments: readonly ActiveSegment[], route: readonly RoutePoint[]): TrackPoint[] {
  const points: TrackPoint[] = [];
  let lastT = -Infinity;
  for (const p of [...route].sort((a, b) => a.t - b.t)) {
    if (p.t <= lastT) continue;
    const segment = segments.find((s) => p.t >= s.startAt && p.t <= s.endAt);
    if (!segment) continue;
    if (!isValidCoordinate(p.lat, p.lon)) continue;
    lastT = p.t;
    points.push({
      seq: points.length,
      segmentIndex: segment.index,
      t: p.t,
      lat: normalizeCoordinate(p.lat),
      lon: normalizeCoordinate(p.lon),
      accuracyM: normalizeAccuracy(p.accuracyM),
    });
  }
  return points;
}

const ACTIVITY_WORD: Record<ImportedActivity, string> = { run: 'run', walk: 'walk', hike: 'hike', ride: 'ride', other: 'workout' };

/** The saved run and its origin for one Health workout. */
export function importedRun(workout: HealthWorkout, route: readonly RoutePoint[]): { draft: SavedRunDraft; points: TrackPoint[]; origin: RunOrigin } {
  const segments = workoutSegments(workout.start, workout.end, workout.pauses);
  const points = workoutPoints(segments, route);
  const validation = validateRun({ startedAt: workout.start, endedAt: workout.end, segments, points, receivedAt: null });
  const hasRoute = points.length > 1;
  const title =
    workout.activity === 'run' && workout.indoor
      ? `${defaultRunTitle(workout.start)} indoor run`
      : workout.activity === 'run'
        ? defaultRunTitle(workout.start)
        : `${defaultRunTitle(workout.start)} ${ACTIVITY_WORD[workout.activity]}`;
  return {
    draft: {
      title,
      startedAt: workout.start,
      endedAt: workout.end,
      activeMs: segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0),
      distanceM: hasRoute ? validation.distanceM : (workout.distanceM ?? 0),
      segments,
      interrupted: false,
      validation: {
        outcome: validation.outcome,
        reasons: validation.reasons,
        coverage: validation.coverage,
        distanceCm: validation.distanceCm,
        activeMs: validation.activeMs,
      },
      provisionalXp: null,
    },
    points,
    origin: {
      source: 'health_import',
      activityType: workout.activity,
      sourceApp: workout.sourceName,
      sourceDevice: workout.deviceName,
      manualEntry: workout.manualEntry,
      externalId: workout.uuid,
      claimedDistanceM: workout.distanceM,
      avgHeartRate: workout.avgHeartRate,
      maxHeartRate: workout.maxHeartRate,
      steps: workout.steps ?? null,
      indoor: workout.indoor === true && !hasRoute,
    },
  };
}

export class HealthImporter {
  private running: Promise<number> | null = null;
  /** Emits the number of runs added by each pass that added some. */
  readonly imported = new Emitter<number>();

  constructor(
    private readonly deps: {
      journal: Pick<Journal, 'getSavedRun' | 'saveImportedRun'> & KvStore;
      port: HealthReaderPort | null;
      enabled: () => boolean;
      /** This app's bundle id: workouts PaceLeague wrote itself are never imported back. */
      ownBundleId: string | null;
      now?: () => number;
    },
  ) {}

  get available(): boolean {
    return this.deps.port?.isAvailable() ?? false;
  }

  async state(): Promise<ImportState> {
    return (await this.deps.journal.getKv<ImportState>(HEALTH_IMPORT_KEY))?.value ?? { newestEndMs: null, lastRunAtMs: null, lastImported: 0 };
  }

  /** Calls `onChange` whenever Health gets a new workout (including in the background). */
  watch(onChange: () => void): (() => void) | null {
    return this.deps.port?.watchNewWorkouts?.(onChange) ?? null;
  }

  /** Asks Health for read access (when the runner switches import on). */
  async connect(): Promise<void> {
    await this.deps.port?.requestRead();
  }

  /**
   * Imports new workouts. The first pass looks back `BACKFILL_DAYS`; later ones start just before the
   * newest workout already imported. One pass at a time; returns how many runs were added.
   */
  importNew(options: { sinceMs?: number } = {}): Promise<number> {
    if (this.running) return this.running;
    this.running = this.pass(options.sinceMs).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(sinceOverride?: number): Promise<number> {
    const { port, journal } = this.deps;
    if (!port?.isAvailable() || !this.deps.enabled()) return 0;
    const now = this.deps.now?.() ?? Date.now();
    const state = await this.state();
    const since = sinceOverride ?? (state.newestEndMs !== null ? state.newestEndMs - OVERLAP_MS : now - BACKFILL_DAYS * 86_400_000);
    const workouts = await port.workoutsSince(since);
    let imported = 0;
    let newest = state.newestEndMs;
    for (const workout of workouts) {
      try {
        if (workout.end > now) continue;
        newest = Math.max(newest ?? 0, workout.end);
        const ours = (this.deps.ownBundleId && workout.sourceBundleId === this.deps.ownBundleId) || workout.externalUuid !== null;
        if (ours) continue;
        const runId = workout.uuid.toLowerCase();
        if (await journal.getSavedRun(runId)) continue;
        const route = await workout.readRoute().catch(() => []);
        const { draft, points, origin } = importedRun(workout, route);
        const { created } = await journal.saveImportedRun(runId, draft, points, origin);
        if (created) imported += 1;
      } finally {
        workout.release?.();
      }
    }
    await journal.setKv(HEALTH_IMPORT_KEY, { newestEndMs: newest, lastRunAtMs: now, lastImported: imported } satisfies ImportState);
    if (imported > 0) this.imported.emit(imported);
    return imported;
  }
}

// ---------------------------------------------------------------------------------------
// The device port (iOS only; @kingstinct/react-native-healthkit)
// ---------------------------------------------------------------------------------------
type HealthKitLibrary = typeof import('@kingstinct/react-native-healthkit');

const READ_TYPES = [
  'HKWorkoutTypeIdentifier',
  'HKWorkoutRouteTypeIdentifier',
  'HKQuantityTypeIdentifierHeartRate',
  'HKQuantityTypeIdentifierDistanceWalkingRunning',
  'HKQuantityTypeIdentifierDistanceCycling',
  // Steps let an indoor run from the watch earn capped league credit (docs/ROADMAP.md 2.5).
  'HKQuantityTypeIdentifierStepCount',
] as const;

function metres(quantity: { unit: string; quantity: number } | undefined): number | null {
  if (!quantity) return null;
  const factor: Record<string, number> = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048, yd: 0.9144 };
  const f = factor[quantity.unit];
  return f ? quantity.quantity * f : null;
}

type WorkoutProxy = Awaited<ReturnType<HealthKitLibrary['queryWorkoutSamples']>>[number];

/** Steps during a workout: the workout's own statistic, else the steps Health links to it. */
async function workoutSteps(lib: HealthKitLibrary, w: WorkoutProxy): Promise<number | null> {
  const own = await w.getStatistic('HKQuantityTypeIdentifierStepCount', 'count').catch(() => undefined);
  const fromWorkout = own?.sumQuantity?.quantity;
  if (typeof fromWorkout === 'number' && fromWorkout > 0) return Math.round(fromWorkout);
  const linked = await lib
    .queryStatisticsForQuantity('HKQuantityTypeIdentifierStepCount', ['cumulativeSum'], { filter: { workout: w }, unit: 'count' })
    .catch(() => undefined);
  const sum = linked?.sumQuantity?.quantity;
  return typeof sum === 'number' && sum > 0 ? Math.round(sum) : null;
}

let readerPort: HealthReaderPort | null | undefined;

export function deviceHealthReader(): HealthReaderPort | null {
  if (readerPort !== undefined) return readerPort;
  readerPort = null;
  if (Platform.OS !== 'ios') return readerPort;
  let lib: HealthKitLibrary;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('@kingstinct/react-native-healthkit') as HealthKitLibrary;
    if (!lib.isHealthDataAvailable()) return readerPort;
  } catch {
    return readerPort;
  }
  const T = lib.WorkoutActivityType;
  const activityOf = (type: number): ImportedActivity | null => {
    if (type === T.running) return 'run';
    if (type === T.walking) return 'walk';
    if (type === T.hiking) return 'hike';
    if (type === T.cycling) return 'ride';
    if (type === T.traditionalStrengthTraining || type === T.functionalStrengthTraining || type === T.highIntensityIntervalTraining) return 'other';
    return null;
  };
  readerPort = {
    isAvailable: () => true,
    requestRead: async () => {
      await lib.requestAuthorization({ toRead: READ_TYPES, toShare: [] });
    },
    workoutsSince: async (since) => {
      const workouts = await lib.queryWorkoutSamples({ limit: 200, ascending: true, filter: { date: { startDate: new Date(since) } } });
      const result: HealthWorkout[] = [];
      for (const w of workouts) {
        const activity = activityOf(w.workoutActivityType);
        if (!activity) continue;
        const events = w.events ?? [];
        const pauses: { from: number; to: number }[] = [];
        let pausedAt: number | null = null;
        for (const e of [...events].sort((a, b) => a.startDate.getTime() - b.startDate.getTime())) {
          if ((e.type === lib.WorkoutEventType.pause || e.type === lib.WorkoutEventType.motionPaused) && pausedAt === null) pausedAt = e.startDate.getTime();
          if ((e.type === lib.WorkoutEventType.resume || e.type === lib.WorkoutEventType.motionResumed) && pausedAt !== null) {
            pauses.push({ from: pausedAt, to: e.startDate.getTime() });
            pausedAt = null;
          }
        }
        const metadata = (w.metadata ?? {}) as Record<string, unknown>;
        const heart = await w.getStatistic('HKQuantityTypeIdentifierHeartRate', 'count/min').catch(() => undefined);
        const indoor = metadata.HKIndoorWorkout === true || metadata.HKIndoorWorkout === 1;
        // Steps matter only indoors, where they stand in for the route.
        const steps = indoor ? await workoutSteps(lib, w) : null;
        result.push({
          uuid: w.uuid,
          activity,
          start: w.startDate.getTime(),
          end: w.endDate.getTime(),
          pauses,
          distanceM: metres(w.totalDistance),
          sourceName: w.sourceRevision?.source?.name ?? null,
          sourceBundleId: w.sourceRevision?.source?.bundleIdentifier ?? null,
          deviceName: w.device?.name ?? w.device?.model ?? null,
          manualEntry: metadata.HKWasUserEntered === true || metadata.HKWasUserEntered === 1,
          externalUuid: typeof metadata.HKExternalUUID === 'string' ? metadata.HKExternalUUID : null,
          avgHeartRate: heart?.averageQuantity ? Math.round(heart.averageQuantity.quantity) : null,
          maxHeartRate: heart?.maximumQuantity ? Math.round(heart.maximumQuantity.quantity) : null,
          indoor,
          steps,
          readRoute: async () => {
            const routes = await w.getWorkoutRoutes();
            return routes.flatMap((r) =>
              r.locations.map((l) => ({ t: l.date.getTime(), lat: l.latitude, lon: l.longitude, accuracyM: l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : null })),
            );
          },
          release: () => {
            (w as unknown as { dispose?: () => void }).dispose?.();
          },
        });
      }
      return result;
    },
    watchNewWorkouts: (onChange) => {
      void lib.enableBackgroundDelivery('HKWorkoutTypeIdentifier', 1 /* immediate */).catch(() => false);
      const subscription = lib.subscribeToChanges('HKWorkoutTypeIdentifier', () => onChange());
      return () => void subscription.remove();
    },
  };
  return readerPort;
}
