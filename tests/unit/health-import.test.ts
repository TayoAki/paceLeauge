import { Journal } from '@/db/journal';
import { buildSyntheticRun, steadyRun } from '@/domain/synthetic';
import { HEALTH_IMPORT_KEY, HealthImporter, importedRun, workoutPoints, workoutSegments, type HealthReaderPort, type HealthWorkout, type RoutePoint } from '@/features/health/health-import';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const T0 = NOW - 2 * 86_400_000;

function routeOf(start: number, distanceM: number, durationS: number): RoutePoint[] {
  return steadyRun(start, distanceM, durationS).points.map((p) => ({ t: p.t, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM }));
}

function workout(overrides: Partial<HealthWorkout> & { route?: RoutePoint[] } = {}): HealthWorkout & { released: boolean } {
  const start = overrides.start ?? T0;
  const route = overrides.route ?? routeOf(start, 5_000, 1_500);
  const w = {
    uuid: '6F1D2C3B-0000-4000-8000-00000000000A',
    activity: 'run' as const,
    start,
    end: start + 1_500_000,
    pauses: [],
    distanceM: 5_020,
    sourceName: 'Workout',
    sourceBundleId: 'com.apple.health.workout',
    deviceName: 'Apple Watch',
    manualEntry: false,
    externalUuid: null,
    avgHeartRate: 152,
    maxHeartRate: 171,
    released: false,
    readRoute: async () => route,
    ...overrides,
  };
  const result = w as HealthWorkout & { released: boolean };
  result.release = () => {
    result.released = true;
  };
  return result;
}

class FakeReader implements HealthReaderPort {
  asked: number[] = [];
  constructor(public workouts: HealthWorkout[]) {}
  isAvailable = () => true;
  requestRead = async () => undefined;
  workoutsSince = async (since: number) => {
    this.asked.push(since);
    return this.workouts.filter((w) => w.end >= since);
  };
}

class FixedClock implements Clock {
  now = () => NOW;
  monotonic = () => NOW;
}

async function setup(workouts: HealthWorkout[], enabled = true) {
  const journal = await Journal.open(new NodeSqliteDatabase(), new FixedClock());
  const port = new FakeReader(workouts);
  const importer = new HealthImporter({ journal, port, enabled: () => enabled, ownBundleId: 'com.tayoaki.paceleague', now: () => NOW });
  return { journal, port, importer };
}

describe('Apple Health import mapping', () => {
  it('turns pauses into separate active stretches and drops points recorded while paused', () => {
    const segments = workoutSegments(T0, T0 + 1_000_000, [{ from: T0 + 400_000, to: T0 + 500_000 }]);
    expect(segments).toEqual([
      { index: 0, startAt: T0, endAt: T0 + 400_000 },
      { index: 1, startAt: T0 + 500_000, endAt: T0 + 1_000_000 },
    ]);
    const points = workoutPoints(segments, routeOf(T0, 3_000, 1_000));
    expect(points.every((p) => p.t <= T0 + 400_000 || p.t >= T0 + 500_000)).toBe(true);
    expect(new Set(points.map((p) => p.segmentIndex))).toEqual(new Set([0, 1]));
    expect(points.map((p) => p.seq)).toEqual(points.map((_, i) => i));
  });

  it('marks an indoor workout with its steps, so the server can judge it by heart rate and steps', () => {
    const treadmill = importedRun(workout({ indoor: true, steps: 5_100, distanceM: 6_000 }), []);
    expect(treadmill.origin).toMatchObject({ source: 'health_import', indoor: true, steps: 5_100, claimedDistanceM: 6_000, avgHeartRate: 152 });
    expect(treadmill.draft.title).toMatch(/indoor run$/);
    expect(treadmill.draft.distanceM).toBe(6_000);
    // An outdoor workout is never marked indoor, and a workout with a route is judged by the route.
    expect(importedRun(workout(), routeOf(T0, 5_000, 1_500)).origin.indoor).toBe(false);
    expect(importedRun(workout({ indoor: true }), routeOf(T0, 5_000, 1_500)).origin.indoor).toBe(false);
  });

  it('measures a routed workout from its route and a routeless one from Health’s distance', () => {
    const routed = importedRun(workout(), routeOf(T0, 5_000, 1_500));
    expect(routed.draft.distanceM).toBeCloseTo(5_000, -1);
    expect(routed.origin).toMatchObject({ source: 'health_import', externalId: '6F1D2C3B-0000-4000-8000-00000000000A', sourceDevice: 'Apple Watch', avgHeartRate: 152 });
    const bare = importedRun(workout({ route: [] }), []);
    expect(bare.points).toEqual([]);
    expect(bare.draft.distanceM).toBe(5_020);
    expect(importedRun(workout({ activity: 'walk' }), []).draft.title).toMatch(/ walk$/);
  });
});

describe('Apple Health importer', () => {
  it('saves each new workout once as a run waiting to sync, and releases each workout', async () => {
    const w = workout();
    const { journal, importer, port } = await setup([w]);
    expect(await importer.importNew()).toBe(1);
    expect(await importer.importNew()).toBe(0);
    expect(w.released).toBe(true);
    const saved = await journal.getSavedRun(w.uuid.toLowerCase());
    expect(saved).toMatchObject({ syncState: 'pending', origin: { source: 'health_import' } });
    expect((await journal.openOutbox()).map((o) => o.kind)).toEqual(['upload_run']);
    // The first pass looked back 30 days; the second starts a day before the newest workout.
    expect(port.asked[0]).toBe(NOW - 30 * 86_400_000);
    expect(port.asked[1]).toBe(w.end - 86_400_000);
    expect((await journal.getKv(HEALTH_IMPORT_KEY))?.value).toMatchObject({ newestEndMs: w.end });
  });

  it('never imports PaceLeague’s own workouts back, and does nothing while switched off', async () => {
    const ours = workout({ uuid: '6F1D2C3B-0000-4000-8000-00000000000B', sourceBundleId: 'com.tayoaki.paceleague' });
    const { importer } = await setup([ours]);
    expect(await importer.importNew()).toBe(0);
    // A workout whose external id is a run already on this phone (saved without a bundle id).
    const runId = '0b0b0b0b-0000-4000-8000-000000000001';
    const exported = workout({ uuid: '6F1D2C3B-0000-4000-8000-00000000000C', sourceBundleId: null, externalUuid: runId.toUpperCase() });
    const again = await setup([exported]);
    await again.journal.saveImportedRun(runId, importedRun(workout(), []).draft, [], { source: 'indoor' });
    expect(await again.importer.importNew()).toBe(0);
    const off = await setup([workout()], false);
    expect(await off.importer.importNew()).toBe(0);
  });

  it('imports other apps’ workouts even when they carry an external id', async () => {
    const strava = workout({ uuid: '6F1D2C3B-0000-4000-8000-00000000000E', sourceBundleId: 'com.strava.stravaride', externalUuid: 'strava-123' });
    const { importer, journal } = await setup([strava]);
    expect(await importer.importNew()).toBe(1);
    expect((await journal.getSavedRun(strava.uuid.toLowerCase()))?.origin).toMatchObject({ source: 'health_import' });
  });

  it('imports the PaceLeague watch app’s workouts under the watch’s run id, as watch runs', async () => {
    const runId = '1c1c1c1c-0000-4000-8000-000000000002';
    const fromWatch = workout({
      uuid: '6F1D2C3B-0000-4000-8000-00000000000F',
      sourceBundleId: 'com.tayoaki.paceleague.watchkitapp',
      sourceName: 'PaceLeague',
      externalUuid: runId.toUpperCase(),
    });
    const { importer, journal } = await setup([fromWatch]);
    expect(await importer.importNew()).toBe(1);
    expect(await journal.getSavedRun(fromWatch.uuid.toLowerCase())).toBeNull();
    expect((await journal.getSavedRun(runId))?.origin).toMatchObject({ source: 'watch', sourceDevice: 'Apple Watch' });
    // The watch's file transfer got there first: nothing more to do.
    const second = await setup([fromWatch]);
    await second.journal.saveImportedRun(runId, importedRun(fromWatch, []).draft, [], { source: 'watch' });
    expect(await second.importer.importNew()).toBe(0);
  });

  it('runs one pass at a time', async () => {
    const { importer } = await setup([workout(), workout({ uuid: '6F1D2C3B-0000-4000-8000-00000000000D', start: T0 + 86_400_000 })]);
    const [a, b] = await Promise.all([importer.importNew(), importer.importNew()]);
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('skips a workout that ends in the future (a clock problem)', async () => {
    const { importer } = await setup([workout({ start: NOW + 60_000 })]);
    expect(await importer.importNew()).toBe(0);
  });
});

describe('walk import', () => {
  it('keeps the activity type', () => {
    const walk = importedRun(workout({ activity: 'walk' }), buildSyntheticRun({ startAt: T0, legs: [{ kind: 'run', durationS: 600, speedMps: 1.4 }] }).points);
    expect(walk.origin.activityType).toBe('walk');
  });
});
