import { Platform } from 'react-native';

import type { ActivityType, ServerRun } from '@/api/schemas';
import type { ActiveSegment, TrackPoint } from '@/domain/types';
import { isUsableSample, validateRun } from '@/domain/validator';

/**
 * Save runs to Apple Health (docs/ROADMAP.md 1.6). When the runner switches it on, each run saved
 * on this phone is written to Health as a workout with its distance and route, exactly once; it is
 * removed from Health if the run is deleted, and rewritten if the run is fixed. The app only asks
 * to write workouts, never to read anything.
 */
export type HealthActivity = 'running' | 'walking' | 'hiking' | 'cycling' | 'other';

export interface HealthRunInput {
  activity: HealthActivity;
  start: Date;
  end: Date;
  distanceM: number;
  /** Distance per active stretch, so pauses aren't counted as distance time. */
  segments: { start: Date; end: Date; distanceM: number }[];
  /** Our run id, stored in the workout's metadata. */
  externalId: string;
  route: { latitude: number; longitude: number; accuracyM: number; date: Date }[];
}

export interface HealthKitPort {
  isAvailable(): boolean;
  /** Asks to write workouts and routes; true when writing workouts is allowed afterwards. */
  requestWrite(): Promise<boolean>;
  canWrite(): boolean;
  saveRun(input: HealthRunInput): Promise<string>;
  deleteWorkout(uuid: string): Promise<void>;
}

interface KvStore {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
}

/** The account journal key mapping our run ids to Health workout ids. */
export const HEALTH_WORKOUTS_KEY = 'health:workouts';

export function healthActivity(type: ActivityType | undefined): HealthActivity {
  switch (type ?? 'run') {
    case 'run':
      return 'running';
    case 'walk':
      return 'walking';
    case 'hike':
      return 'hiking';
    case 'ride':
      return 'cycling';
    default:
      return 'other';
  }
}

/** Builds the workout from a run's segments and points with the same rules the league uses. */
export function healthRunFrom(input: {
  id: string;
  activity: HealthActivity;
  segments: readonly ActiveSegment[];
  points: readonly TrackPoint[];
}): HealthRunInput | null {
  const { segments, points } = input;
  if (segments.length === 0) return null;
  const start = segments[0]!.startAt;
  const end = segments[segments.length - 1]!.endAt;
  const validation = validateRun({ startedAt: start, endedAt: end, segments: [...segments], points: [...points], receivedAt: null });
  const inSegment = (p: TrackPoint) => segments.some((s) => s.index === p.segmentIndex && p.t >= s.startAt && p.t <= s.endAt);
  return {
    activity: input.activity,
    start: new Date(start),
    end: new Date(end),
    distanceM: validation.distanceM,
    segments: validation.segments.map((s) => ({ start: new Date(s.startAt), end: new Date(s.endAt), distanceM: s.distanceM })),
    externalId: input.id,
    route: points
      .filter((p) => isUsableSample(p) && inSegment(p))
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ latitude: p.lat, longitude: p.lon, accuracyM: p.accuracyM ?? 0, date: new Date(p.t) })),
  };
}

export class AppleHealthSync {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: {
      kv: KvStore;
      port: HealthKitPort | null;
      enabled: () => boolean;
    },
  ) {}

  get available(): boolean {
    return this.deps.port?.isAvailable() ?? false;
  }

  /** Asks for permission; call only when the runner switches the setting on. */
  async requestAccess(): Promise<boolean> {
    const port = this.deps.port;
    if (!port?.isAvailable()) return false;
    return port.requestWrite().catch(() => false);
  }

  /** One change at a time, so a delete can never race the save it undoes. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async map(): Promise<Record<string, string>> {
    return (await this.deps.kv.getKv<Record<string, string>>(HEALTH_WORKOUTS_KEY))?.value ?? {};
  }

  /** Writes a run saved on this phone. Skipped when off, not allowed, or already written. */
  saveRun(runId: string, build: () => Promise<HealthRunInput | null>): Promise<'saved' | 'skipped'> {
    return this.serial(async () => {
      const port = this.deps.port;
      if (!this.deps.enabled() || !port?.isAvailable() || !port.canWrite()) return 'skipped';
      const map = await this.map();
      if (map[runId]) return 'skipped';
      const input = await build();
      if (!input || input.distanceM <= 0) return 'skipped';
      const uuid = await port.saveRun(input);
      await this.deps.kv.setKv(HEALTH_WORKOUTS_KEY, { ...(await this.map()), [runId]: uuid });
      return 'saved';
    });
  }

  /** Removes the run's workout from Health (after the run is deleted or merged away). */
  remove(runId: string): Promise<void> {
    return this.serial(async () => {
      const map = await this.map();
      const uuid = map[runId];
      if (!uuid) return;
      await this.deps.port?.deleteWorkout(uuid).catch(() => undefined);
      const { [runId]: _removed, ...rest } = map;
      await this.deps.kv.setKv(HEALTH_WORKOUTS_KEY, rest);
    });
  }

  /** After a fix: the workout is rewritten from the fixed run, if one was written before. */
  async replace(runId: string, build: () => Promise<HealthRunInput | null>): Promise<void> {
    const had = (await this.map())[runId];
    if (!had) return;
    await this.remove(runId);
    await this.saveRun(runId, build);
  }
}

/** The fixed run as a workout: the server's segments and route after the edit. */
export function healthRunFromServer(run: ServerRun, route: { segments: ActiveSegment[]; points: TrackPoint[] }, localRunId: string): HealthRunInput | null {
  return healthRunFrom({ id: localRunId, activity: healthActivity(run.activity_type), segments: route.segments, points: route.points });
}

// ---------------------------------------------------------------------------------------
// The device port (iOS only; @kingstinct/react-native-healthkit)
// ---------------------------------------------------------------------------------------
type HealthKitLibrary = typeof import('@kingstinct/react-native-healthkit');

const WRITE_TYPES = ['HKWorkoutTypeIdentifier', 'HKWorkoutRouteTypeIdentifier', 'HKQuantityTypeIdentifierDistanceWalkingRunning'] as const;

function loadLibrary(): HealthKitLibrary | null {
  if (Platform.OS !== 'ios') return null;
  try {
    // Loaded lazily: the native side exists only in builds made with the HealthKit plugin.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('@kingstinct/react-native-healthkit') as HealthKitLibrary;
    return lib.isHealthDataAvailable() ? lib : null;
  } catch {
    return null;
  }
}

let devicePort: HealthKitPort | null | undefined;

export function deviceHealthKit(): HealthKitPort | null {
  if (devicePort !== undefined) return devicePort;
  const lib = loadLibrary();
  devicePort = lib
    ? {
        isAvailable: () => true,
        canWrite: () => lib.authorizationStatusFor('HKWorkoutTypeIdentifier') === 2, // sharingAuthorized
        requestWrite: async () => {
          await lib.requestAuthorization({ toShare: WRITE_TYPES, toRead: [] });
          return lib.authorizationStatusFor('HKWorkoutTypeIdentifier') === 2;
        },
        saveRun: async (input) => {
          const activity = {
            running: lib.WorkoutActivityType.running,
            walking: lib.WorkoutActivityType.walking,
            hiking: lib.WorkoutActivityType.hiking,
            cycling: lib.WorkoutActivityType.cycling,
            other: lib.WorkoutActivityType.other,
          }[input.activity];
          const distanceType = input.activity === 'cycling' ? 'HKQuantityTypeIdentifierDistanceCycling' : 'HKQuantityTypeIdentifierDistanceWalkingRunning';
          const workout = await lib.saveWorkoutSample(
            activity,
            input.segments
              .filter((s) => s.distanceM > 0)
              .map((s) => ({ startDate: s.start, endDate: s.end, quantityType: distanceType, quantity: s.distanceM, unit: 'm' })),
            input.start,
            input.end,
            { distance: input.distanceM },
            { HKExternalUUID: input.externalId, HKIndoorWorkout: false },
          );
          if (input.route.length > 1) {
            await workout.saveWorkoutRoute(
              input.route.map((p) => ({
                latitude: p.latitude,
                longitude: p.longitude,
                altitude: 0,
                verticalAccuracy: -1,
                horizontalAccuracy: p.accuracyM,
                course: -1,
                speed: -1,
                date: p.date,
              })),
            );
          }
          return workout.uuid;
        },
        deleteWorkout: async (uuid) => {
          await lib.deleteObjects('HKWorkoutTypeIdentifier', { uuid });
        },
      }
    : null;
  return devicePort;
}
