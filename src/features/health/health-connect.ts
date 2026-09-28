import { Platform } from 'react-native';

import type { HrSample, SleepSample, TrendSample } from '@/domain/training';

import type { HealthKitPort, HealthRunInput } from './apple-health';
import type { HealthDataPort } from './health-data';
import type { HealthReaderPort, HealthWorkout, ImportedActivity, RoutePoint } from './health-import';

/**
 * Health Connect on Android (docs/ROADMAP.md P.1): the Android side of Apple Health. The same
 * three jobs, behind the same ports, so the importer, the save-to-Health sync, heart-rate zones
 * and health trends work unchanged:
 * - import runs and other workouts from watches and apps (2.1),
 * - save PaceLeague runs to Health Connect (1.6),
 * - read heart rate for zones, and resting heart rate, HRV, VO2 max and sleep for trends (3.5).
 * Each asks for its permissions only when the runner switches it on.
 */

// Health Connect's numbers (androidx.health.connect.client), as the library passes them through.
export const HC_EXERCISE = {
  BIKING: 8,
  BIKING_STATIONARY: 9,
  HIGH_INTENSITY_INTERVAL_TRAINING: 36,
  HIKING: 37,
  OTHER_WORKOUT: 0,
  RUNNING: 56,
  RUNNING_TREADMILL: 57,
  STRENGTH_TRAINING: 70,
  WALKING: 79,
} as const;
const SEGMENT_PAUSE = 39;
const RECORDING_ACTIVE = 1;
const RECORDING_MANUAL = 3;
const DEVICE_PHONE = 2;
const SDK_AVAILABLE = 3;
const SLEEP_STAGE = { UNKNOWN: 0, AWAKE: 1, SLEEPING: 2, OUT_OF_BED: 3, LIGHT: 4, DEEP: 5, REM: 6 } as const;

export function hcActivity(exerciseType: number): { activity: ImportedActivity; indoor: boolean } | null {
  switch (exerciseType) {
    case HC_EXERCISE.RUNNING:
      return { activity: 'run', indoor: false };
    case HC_EXERCISE.RUNNING_TREADMILL:
      return { activity: 'run', indoor: true };
    case HC_EXERCISE.WALKING:
      return { activity: 'walk', indoor: false };
    case HC_EXERCISE.HIKING:
      return { activity: 'hike', indoor: false };
    case HC_EXERCISE.BIKING:
      return { activity: 'ride', indoor: false };
    case HC_EXERCISE.BIKING_STATIONARY:
      return { activity: 'ride', indoor: true };
    case HC_EXERCISE.STRENGTH_TRAINING:
    case HC_EXERCISE.HIGH_INTENSITY_INTERVAL_TRAINING:
      return { activity: 'other', indoor: true };
    default:
      return null;
  }
}

export function hcExerciseType(activity: HealthRunInput['activity']): number {
  return { running: HC_EXERCISE.RUNNING, walking: HC_EXERCISE.WALKING, hiking: HC_EXERCISE.HIKING, cycling: HC_EXERCISE.BIKING, other: HC_EXERCISE.OTHER_WORKOUT }[activity];
}

const ms = (iso: string) => Date.parse(iso);

/** The runner's pauses, from the session's pause segments. */
export function hcPauses(segments: readonly { startTime: string; endTime: string; segmentType: number }[] | undefined): { from: number; to: number }[] {
  return (segments ?? [])
    .filter((s) => s.segmentType === SEGMENT_PAUSE && ms(s.endTime) > ms(s.startTime))
    .map((s) => ({ from: ms(s.startTime), to: ms(s.endTime) }));
}

/** Names for the apps that most often write workouts to Health Connect; others show their package. */
const APP_NAMES: Record<string, string> = {
  'com.google.android.apps.fitness': 'Google Fit',
  'com.fitbit.FitbitMobile': 'Fitbit',
  'com.sec.android.app.shealth': 'Samsung Health',
  'com.garmin.android.apps.connectmobile': 'Garmin Connect',
  'com.strava': 'Strava',
  'com.nike.plusgps': 'Nike Run Club',
  'com.runtastic.android': 'adidas Running',
  'com.polar.polarflow': 'Polar Flow',
  'com.stt.android.suunto': 'Suunto',
};

export function hcAppName(packageName: string | null | undefined): string | null {
  if (!packageName) return null;
  return APP_NAMES[packageName] ?? packageName;
}

interface HcLocation {
  time: string;
  latitude: number;
  longitude: number;
  horizontalAccuracy?: unknown;
}

/** A route's points; Health Connect reports a missing accuracy as 0 m. */
export function hcRoute(route: { type?: unknown; route?: readonly HcLocation[] } | undefined): RoutePoint[] | null {
  if (!route || !(route.type === 'DATA' || route.type === 0)) return null;
  return (route.route ?? []).map((l) => {
    const accuracy = (l.horizontalAccuracy as { inMeters?: number } | undefined)?.inMeters;
    return { t: ms(l.time), lat: l.latitude, lon: l.longitude, accuracyM: typeof accuracy === 'number' && accuracy > 0 ? accuracy : null };
  });
}

export function hcHeartRate(records: readonly { samples?: readonly { time: string; beatsPerMinute: number }[] }[]): HrSample[] {
  return records
    .flatMap((r) => r.samples ?? [])
    .map((s) => ({ t: ms(s.time), bpm: s.beatsPerMinute }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Sleep sessions as the stretches `sleepMinutesByNight` reads (Apple's numbering): stages when the
 * session has them, otherwise the whole session as asleep. Out of bed is left out.
 */
export function hcSleep(sessions: readonly { startTime: string; endTime: string; stages?: readonly { startTime: string; endTime: string; stage: number }[] }[]): SleepSample[] {
  const value: Record<number, number | null> = {
    [SLEEP_STAGE.UNKNOWN]: 1,
    [SLEEP_STAGE.AWAKE]: 2,
    [SLEEP_STAGE.SLEEPING]: 1,
    [SLEEP_STAGE.OUT_OF_BED]: null,
    [SLEEP_STAGE.LIGHT]: 3,
    [SLEEP_STAGE.DEEP]: 4,
    [SLEEP_STAGE.REM]: 5,
  };
  return sessions.flatMap((session) =>
    session.stages?.length
      ? session.stages.flatMap((stage) => {
          const v = value[stage.stage] ?? null;
          return v === null ? [] : [{ startMs: ms(stage.startTime), endMs: ms(stage.endTime), value: v }];
        })
      : [{ startMs: ms(session.startTime), endMs: ms(session.endTime), value: 1 }],
  );
}

// ---------------------------------------------------------------------------------------
// The device side (Android only; react-native-health-connect)
// ---------------------------------------------------------------------------------------
type HcLibrary = typeof import('react-native-health-connect');
type Permission = Parameters<HcLibrary['requestPermission']>[0][number];

const IMPORT_READ: Permission[] = [
  { accessType: 'read', recordType: 'ExerciseSession' },
  { accessType: 'read', recordType: 'HeartRate' },
  { accessType: 'read', recordType: 'Distance' },
  { accessType: 'read', recordType: 'Steps' },
];
const HEART_READ: Permission[] = [{ accessType: 'read', recordType: 'HeartRate' }];
const TRENDS_READ: Permission[] = [
  { accessType: 'read', recordType: 'RestingHeartRate' },
  { accessType: 'read', recordType: 'HeartRateVariabilityRmssd' },
  { accessType: 'read', recordType: 'Vo2Max' },
  { accessType: 'read', recordType: 'SleepSession' },
  // Twelve weeks of trends reach back further than the 30 days Health Connect allows by default.
  { accessType: 'read', recordType: 'ReadHealthDataHistory' },
];
const WRITE: Permission[] = [
  { accessType: 'write', recordType: 'ExerciseSession' },
  { accessType: 'write', recordType: 'Distance' },
  { accessType: 'write', recordType: 'ExerciseRoute' },
];

let lib: HcLibrary | null = null;
let ready = false;
let granted = new Set<string>();
const key = (p: { accessType: string; recordType: string }) => `${p.accessType}:${p.recordType}`;

async function refreshGranted(): Promise<void> {
  if (!lib) return;
  granted = new Set((await lib.getGrantedPermissions().catch(() => [])).map(key));
}

/**
 * Connects to Health Connect once per launch (before the ports are used), so the ports can say
 * synchronously whether it's there. False when it isn't installed or needs an update.
 */
export async function prepareHealthConnect(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (ready) return true;
  try {
    // Loaded lazily: the native side exists only in Android builds.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('react-native-health-connect') as HcLibrary;
    if ((await loaded.getSdkStatus()) !== SDK_AVAILABLE) return false;
    if (!(await loaded.initialize())) return false;
    lib = loaded;
    ready = true;
    await refreshGranted();
  } catch {
    ready = false;
  }
  return ready;
}

async function request(permissions: Permission[]): Promise<void> {
  if (!lib) return;
  await lib.requestPermission(permissions).catch(() => []);
  await refreshGranted();
}

/** Every page of a read. */
async function readAll<T>(read: (pageToken?: string) => Promise<{ records: T[]; pageToken?: string }>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await read(token);
    out.push(...result.records);
    token = result.pageToken || undefined;
    if (!token) break;
  }
  return out;
}

const between = (fromMs: number, toMs: number) => ({ operator: 'between' as const, startTime: new Date(fromMs).toISOString(), endTime: new Date(toMs).toISOString() });

/** Saving runs to Health Connect (the Android side of 1.6). */
export function healthConnectWriter(): HealthKitPort | null {
  if (!ready || !lib) return null;
  const hc = lib;
  return {
    isAvailable: () => ready,
    canWrite: () => granted.has('write:ExerciseSession'),
    requestWrite: async () => {
      await request(WRITE);
      return granted.has('write:ExerciseSession');
    },
    saveRun: async (input) => {
      const metadata = { clientRecordId: input.externalId, recordingMethod: RECORDING_ACTIVE, device: { type: DEVICE_PHONE } };
      // Pauses aren't written as segments; the distance records below cover only the running.
      const [id] = await hc.insertRecords([
        {
          recordType: 'ExerciseSession',
          startTime: input.start.toISOString(),
          endTime: input.end.toISOString(),
          exerciseType: hcExerciseType(input.activity),
          title: 'PaceLeague run',
          ...(granted.has('write:ExerciseRoute') && input.route.length > 1
            ? {
                exerciseRoute: {
                  route: input.route.map((p) => ({
                    time: p.date.toISOString(),
                    latitude: p.latitude,
                    longitude: p.longitude,
                    horizontalAccuracy: { value: p.accuracyM, unit: 'meters' as const },
                  })),
                },
              }
            : {}),
          metadata,
        },
      ]);
      const distances = input.segments.filter((s) => s.distanceM > 0 && s.end > s.start);
      if (distances.length > 0 && granted.has('write:Distance')) {
        await hc.insertRecords(
          distances.map((s, i) => ({
            recordType: 'Distance' as const,
            startTime: s.start.toISOString(),
            endTime: s.end.toISOString(),
            distance: { value: s.distanceM, unit: 'meters' as const },
            metadata: { ...metadata, clientRecordId: `${input.externalId}:${i}` },
          })),
        );
      }
      if (!id) throw new Error('Health Connect saved nothing');
      return id;
    },
    deleteWorkout: async (id) => {
      const session = await hc.readRecord('ExerciseSession', id).catch(() => null);
      await hc.deleteRecordsByUuids('ExerciseSession', [id], []);
      // Only PaceLeague's own records can be deleted, so this removes the run's distance and nothing else.
      if (session) await hc.deleteRecordsByTimeRange('Distance', between(ms(session.startTime), ms(session.endTime))).catch(() => undefined);
    },
  };
}

/** Importing workouts from Health Connect (the Android side of 2.1). */
export function healthConnectReader(): HealthReaderPort | null {
  if (!ready || !lib) return null;
  const hc = lib;
  return {
    isAvailable: () => ready,
    requestRead: () => request(IMPORT_READ),
    workoutsSince: async (since) => {
      const sessions = await readAll((pageToken) =>
        hc.readRecords('ExerciseSession', {
          timeRangeFilter: { operator: 'after', startTime: new Date(since).toISOString() },
          ascendingOrder: true,
          pageSize: 200,
          pageToken,
        }),
      );
      const result: HealthWorkout[] = [];
      for (const s of sessions) {
        const kind = hcActivity(s.exerciseType);
        const id = s.metadata?.id;
        if (!kind || !id) continue;
        const start = ms(s.startTime);
        const end = ms(s.endTime);
        const origin = s.metadata?.dataOrigin ?? null;
        const window = { timeRangeFilter: between(start, end), ...(origin ? { dataOriginFilter: [origin] } : {}) };
        const [distance, heart, steps] = await Promise.all([
          hc.aggregateRecord({ recordType: 'Distance', ...window }).catch(() => null),
          hc.aggregateRecord({ recordType: 'HeartRate', ...window }).catch(() => null),
          kind.indoor ? hc.aggregateRecord({ recordType: 'Steps', ...window }).catch(() => null) : Promise.resolve(null),
        ]);
        const route = hcRoute(s.exerciseRoute as Parameters<typeof hcRoute>[0]);
        const device = s.metadata?.device;
        result.push({
          uuid: id,
          activity: kind.activity,
          start,
          end,
          pauses: hcPauses(s.segments),
          distanceM: distance?.DISTANCE?.inMeters ? distance.DISTANCE.inMeters : null,
          sourceName: hcAppName(origin),
          sourceBundleId: origin,
          deviceName: [device?.manufacturer, device?.model].filter(Boolean).join(' ') || null,
          manualEntry: s.metadata?.recordingMethod === RECORDING_MANUAL,
          externalUuid: s.metadata?.clientRecordId ?? null,
          avgHeartRate: heart?.MEASUREMENTS_COUNT ? Math.round(heart.BPM_AVG) : null,
          maxHeartRate: heart?.MEASUREMENTS_COUNT ? Math.round(heart.BPM_MAX) : null,
          indoor: kind.indoor,
          steps: steps?.COUNT_TOTAL ? Math.round(steps.COUNT_TOTAL) : null,
          // Routes come with the session when the runner allowed all routes; otherwise the run
          // comes in without one (Health Connect asks about routes separately).
          readRoute: async () => route ?? [],
        });
      }
      return result;
    },
  };
}

/** Heart rate for zones, and the trend readings (the Android side of 3.5). */
export function healthConnectData(): HealthDataPort | null {
  if (!ready || !lib) return null;
  const hc = lib;
  const read = <T>(fetch: (pageToken?: string) => Promise<{ records: T[]; pageToken?: string }>) => readAll(fetch);
  return {
    isAvailable: () => ready,
    requestHeartRate: () => request(HEART_READ),
    requestTrends: () => request(TRENDS_READ),
    heartRate: async (fromMs, toMs) =>
      hcHeartRate(await read((pageToken) => hc.readRecords('HeartRate', { timeRangeFilter: between(fromMs, toMs), pageSize: 1000, pageToken }))),
    trend: async (kind, fromMs, toMs): Promise<TrendSample[]> => {
      const filter = { timeRangeFilter: between(fromMs, toMs), pageSize: 1000 };
      if (kind === 'restingHr') {
        return (await read((pageToken) => hc.readRecords('RestingHeartRate', { ...filter, pageToken }))).map((r) => ({ t: ms(r.time), value: r.beatsPerMinute }));
      }
      if (kind === 'hrv') {
        return (await read((pageToken) => hc.readRecords('HeartRateVariabilityRmssd', { ...filter, pageToken }))).map((r) => ({
          t: ms(r.time),
          value: r.heartRateVariabilityMillis,
        }));
      }
      return (await read((pageToken) => hc.readRecords('Vo2Max', { ...filter, pageToken }))).map((r) => ({ t: ms(r.time), value: r.vo2MillilitersPerMinuteKilogram }));
    },
    sleep: async (fromMs, toMs) => hcSleep(await read((pageToken) => hc.readRecords('SleepSession', { timeRangeFilter: between(fromMs, toMs), pageSize: 1000, pageToken }))),
  };
}
