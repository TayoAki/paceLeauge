import { createHash, randomUUID } from 'node:crypto';

import { createPaceApi } from '@/api/pace-api';
import { Journal, type RawSample } from '@/db/journal';
import { steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { importActivityFile } from '@/features/files/file-import';
import { HealthImporter, type HealthReaderPort, type HealthWorkout } from '@/features/health/health-import';
import { IndoorRunService } from '@/features/indoor/indoor-run';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { serverRunOf, SyncEngine } from '@/features/sync/sync-engine';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';
import { sqlTransport } from '../support/sql-transport';
import { TestDb, type TestUser } from './helpers/db';
import { inCurrentWeek } from './helpers/runs';

/**
 * Apple Health import end to end (docs/ROADMAP.md 2.1): the importer saves workouts to the journal,
 * the real sync engine uploads them through the real client to the real SQL, and the server judges
 * them by their source.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

class ManualClock implements Clock {
  constructor(public wall: number) {}
  now = () => this.wall;
  monotonic = () => this.wall;
}

const idleDriver: LocationDriver = { supportsBackground: true, start: async () => undefined, stop: async () => undefined, isRunning: async () => true };

function watchWorkout(uuid: string, start: number, distanceM: number, durationS: number, withRoute = true): HealthWorkout {
  const route = withRoute ? steadyRun(start, distanceM, durationS).points.map((p) => ({ t: p.t, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM })) : [];
  return {
    uuid,
    activity: 'run',
    start,
    end: start + durationS * 1000,
    pauses: [],
    distanceM,
    sourceName: withRoute ? 'Workout' : 'Garmin Connect',
    sourceBundleId: withRoute ? 'com.apple.health.workout' : 'com.garmin.connect.mobile',
    deviceName: withRoute ? 'Apple Watch' : 'Forerunner 265',
    manualEntry: false,
    externalUuid: null,
    avgHeartRate: 150,
    maxHeartRate: 170,
    readRoute: async () => route,
  };
}

async function device(user: TestUser, workouts: HealthWorkout[]) {
  const clock = new ManualClock(Date.now());
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const api = createPaceApi(sqlTransport(db, user));
  const engine = new SyncEngine({ journal, api, sha256, clock, random: () => 0.5, environment: 'test' });
  const reader: HealthReaderPort = { isAvailable: () => true, requestRead: async () => undefined, workoutsSince: async () => workouts };
  const importer = new HealthImporter({ journal, port: reader, enabled: () => true, ownBundleId: 'com.tayoaki.paceleague', now: () => clock.wall });
  const recorder = new RecorderService({ journal, location: idleDriver, clock, newRunId: randomUUID });
  return { clock, journal, api, engine, importer, recorder };
}

describe('Apple Health import through sync', () => {
  it('scores an Apple Watch run like a phone run and keeps a Garmin workout as history', async () => {
    const runner = await db.createRunner('Import Ivy');
    const watch = watchWorkout('A1B2C3D4-0000-4000-8000-000000000001', inCurrentWeek(0), 5_240, 1_888);
    const garmin = watchWorkout('A1B2C3D4-0000-4000-8000-000000000002', inCurrentWeek(1), 8_000, 2_700, false);
    const d = await device(runner, [watch, garmin]);
    expect(await d.importer.importNew()).toBe(2);
    const status = await d.engine.run();
    expect(status).toMatchObject({ pending: 0, needsAttention: 0 });

    const imported = serverRunOf((await d.journal.getSavedRun(watch.uuid.toLowerCase()))!);
    expect(imported).toMatchObject({ status: 'accepted', source: 'health_import', source_device: 'Apple Watch', avg_heart_rate: 150, xp_award: { total_xp: 77 } });
    const history = serverRunOf((await d.journal.getSavedRun(garmin.uuid.toLowerCase()))!);
    expect(history).toMatchObject({ status: 'personal_only', reason_codes: ['no_route'], source_app: 'Garmin Connect', distance_m: 8000 });
    expect((await d.api.getMe()).lifetime_xp).toBe(77);
  });

  it('counts a run once when the phone recorded it and Health brings in the watch copy', async () => {
    const runner = await db.createRunner('Both Devices');
    const start = inCurrentWeek(2);
    const d = await device(runner, []);
    // The phone recorded the run (with the signal dropping out for a minute every five) …
    const phonePoints = steadyRun(start, 6_000, 2_000).points.filter((_, i) => i % 300 < 200 || i % 300 >= 260);
    d.clock.wall = start;
    await d.recorder.start();
    for (let i = 0; i < phonePoints.length; i += 25) {
      const slice = phonePoints.slice(i, i + 25);
      d.clock.wall = (slice[slice.length - 1] as TrackPoint).t;
      await d.recorder.ingest(slice.map((p): RawSample => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM })));
    }
    d.clock.wall = start + 2_000_000;
    await d.recorder.pause();
    const phone = await d.recorder.finish();
    d.clock.wall = Date.now();
    await d.engine.run();
    const phoneXp = (await d.api.getMe()).lifetime_xp;
    expect(phoneXp).toBeGreaterThan(0);

    // … and the watch's cleaner copy arrives from Health afterwards.
    const watch = watchWorkout('A1B2C3D4-0000-4000-8000-000000000003', start + 15_000, 6_050, 2_000);
    const d2 = { ...d, importer: new HealthImporter({ journal: d.journal, port: { isAvailable: () => true, requestRead: async () => undefined, workoutsSince: async () => [watch] }, enabled: () => true, ownBundleId: null, now: () => d.clock.wall }) };
    expect(await d2.importer.importNew()).toBe(1);
    await d.engine.run();

    const kept = serverRunOf((await d.journal.getSavedRun(watch.uuid.toLowerCase()))!);
    expect(kept?.status).toBe('accepted');
    const page = await d.api.listMyRuns(null, 20);
    expect(page.runs.map((r) => r.id)).toEqual([kept!.id]);
    const phoneServer = await d.api.getMyRun(serverRunOf((await d.journal.getSavedRun(phone.runId))!)!.id);
    expect(phoneServer).toMatchObject({ status: 'duplicate', duplicate_of: kept!.id });
    expect((await d.api.getMe()).lifetime_xp).toBe(kept!.xp_award!.total_xp);
  });
});

describe('file import through sync', () => {
  it('keeps a GPX file as history, once however often it is imported', async () => {
    const runner = await db.createRunner('File Finn');
    const d = await device(runner, []);
    const start = inCurrentWeek(3);
    const pts = steadyRun(start, 7_000, 2_400).points.filter((_, i) => i % 5 === 0);
    const gpx = `<gpx creator="Old Watch"><trk><name>Tempo</name><type>running</type><trkseg>${pts
      .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time></trkpt>`)
      .join('')}</trkseg></trk></gpx>`;
    const bytes = new TextEncoder().encode(gpx);
    const first = await importActivityFile(d.journal, { name: 'tempo.gpx', bytes });
    if (first.kind !== 'imported') throw new Error(`expected an import, got ${first.kind}`);
    expect((await importActivityFile(d.journal, { name: 'tempo-copy.gpx', bytes })).kind).toBe('already_imported');
    await d.engine.run();
    const server = serverRunOf((await d.journal.getSavedRun(first.runId))!);
    expect(server).toMatchObject({ status: 'personal_only', reason_codes: ['file_import'], source: 'file_import', title: 'Tempo', source_app: 'Old Watch' });
    expect(server!.distance_m).toBeCloseTo(7_000, -2);
    expect((await d.api.getMe()).lifetime_xp).toBe(0);
    expect((await d.api.submitDiagnostics({ app_version: 'test' })).reportId).toEqual(expect.any(Number));
  });
});

describe('indoor runs through sync', () => {
  it('keeps a treadmill run as history with its steps, and counts it for the week', async () => {
    const runner = await db.createRunner('Treadmill Tia');
    const d = await device(runner, []);
    const start = inCurrentWeek(4);
    d.clock.wall = start;
    const indoor = new IndoorRunService({
      kv: d.journal,
      journal: d.journal,
      steps: { stepsBetween: async (from, to) => Math.round(((to - from) / 1000) * 2.8) },
      newRunId: randomUUID,
      now: () => d.clock.wall,
    });
    await indoor.start();
    d.clock.wall = start + 1_000_000;
    await indoor.pause();
    d.clock.wall = start + 1_120_000;
    await indoor.resume();
    d.clock.wall = start + 1_920_000;
    const runId = await indoor.finish(5_000);
    d.clock.wall = Date.now();
    expect(await d.engine.run()).toMatchObject({ pending: 0, needsAttention: 0 });

    const server = serverRunOf((await d.journal.getSavedRun(runId))!);
    expect(server).toMatchObject({ status: 'personal_only', reason_codes: ['indoor'], source: 'indoor', distance_m: 5000, active_ms: 1_800_000, steps: 5_040 });
    expect((await d.api.getMe()).lifetime_xp).toBe(0);
    expect((await d.api.getStreak()).this_week.active_days).toBe(1);
  });
});
