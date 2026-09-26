import { Journal, type RawSample } from '@/db/journal';
import { buildSyntheticRun, steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { ActiveRunExistsError, NoActiveRunError, RecorderService, type RecorderEvent } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

class FakeClock implements Clock {
  constructor(
    public wall: number,
    public mono = 0,
  ) {}
  now = () => this.wall;
  monotonic = () => this.mono;
  advance(ms: number) {
    this.wall += ms;
    this.mono += ms;
  }
}

class FakeDriver implements LocationDriver {
  readonly supportsBackground = true;
  running = false;
  starts = 0;
  stops = 0;
  failStart: Error | null = null;
  async start() {
    if (this.failStart) throw this.failStart;
    this.running = true;
    this.starts += 1;
  }
  async stop() {
    this.running = false;
    this.stops += 1;
  }
  async isRunning() {
    return this.running;
  }
}

const T0 = Date.parse('2026-09-25T12:00:00Z');

function samples(points: TrackPoint[]): RawSample[] {
  return points.map((p) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }));
}

async function setup(options: { maxPoints?: number } = {}) {
  const db = new NodeSqliteDatabase();
  const clock = new FakeClock(T0);
  const journal = await Journal.open(db, clock);
  const driver = new FakeDriver();
  const events: RecorderEvent[] = [];
  let ids = 0;
  const make = () =>
    new RecorderService({
      journal,
      location: driver,
      clock,
      newRunId: () => `00000000-0000-4000-8000-00000000000${ids++}`,
      onEvent: (e) => events.push(e),
      maxPoints: options.maxPoints,
    });
  return { db, clock, journal, driver, events, recorder: make(), make };
}

/** Feeds synthetic samples while advancing the clock in step, like a live GPS stream. */
async function stream(recorder: RecorderService, clock: FakeClock, points: TrackPoint[], batch = 5) {
  for (let i = 0; i < points.length; i += batch) {
    const slice = points.slice(i, i + batch);
    const last = slice[slice.length - 1] as TrackPoint;
    clock.advance(last.t - clock.wall);
    await recorder.ingest(samples(slice));
  }
}

describe('recorder service', () => {
  it('records, pauses, resumes and saves one run with pause time excluded', async () => {
    const { recorder, clock, journal, driver, events } = await setup();
    await recorder.init();
    await recorder.start();
    expect(driver.running).toBe(true);
    const route = buildSyntheticRun({
      startAt: T0,
      legs: [
        { kind: 'run', durationS: 900, speedMps: 3 },
        { kind: 'pause', durationS: 300, movedM: 400 },
        { kind: 'run', durationS: 900, speedMps: 3 },
      ],
    });
    const first = route.points.filter((p) => p.segmentIndex === 0);
    const second = route.points.filter((p) => p.segmentIndex === 1);
    await stream(recorder, clock, first);
    await recorder.pause();
    expect(recorder.getSnapshot().session?.status).toBe('paused');
    // Points delivered while paused are not recorded.
    clock.advance(300_000);
    await recorder.ingest([{ timestamp: clock.wall, latitude: 41.9, longitude: -87.6, accuracy: 5 }]);
    await recorder.resume();
    await stream(recorder, clock, second.map((p) => ({ ...p, t: p.t })));
    await recorder.pause();

    const live = recorder.getSnapshot().metrics;
    expect(live.activeMs).toBe(1_800_000);
    expect(live.distanceM).toBeCloseTo(5400, 0);

    const saved = await recorder.finish();
    expect(saved).toMatchObject({ activeMs: 1_800_000, syncState: 'pending', interrupted: false, pointCount: first.length + second.length });
    expect(saved.segments).toHaveLength(2);
    expect(saved.distanceM).toBeCloseTo(5400, 0);
    expect(saved.validation.outcome).toBe('accepted');
    expect(saved.provisionalXp).toMatchObject({ totalXp: 54 + 25 });
    expect(driver.running).toBe(false);
    expect(await journal.getSession()).toBeNull();
    expect((await journal.openOutbox()).map((o) => [o.kind, o.runId])).toEqual([['upload_run', saved.runId]]);
    expect(events.map((e) => e.name)).toEqual(['run_started', 'run_saved_local']);
  });

  it('saves the 5.24 km fixture run with a provisional +77 XP estimate', async () => {
    const { recorder, clock } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 5240, 1888).points, 20);
    await recorder.pause();
    const saved = await recorder.finish();
    expect(saved.activeMs).toBe(1_888_000);
    expect(saved.provisionalXp).toMatchObject({ totalXp: 77, distanceXp: 52, activeDayBonus: 25 });
  });

  it('refuses a second run until the first is resolved', async () => {
    const { recorder } = await setup();
    await recorder.start();
    await expect(recorder.start()).rejects.toBeInstanceOf(ActiveRunExistsError);
  });

  it('does not create a session when location updates cannot start (permission denied)', async () => {
    const { recorder, driver, journal } = await setup();
    driver.failStart = new Error('Not authorized to use background location services');
    await expect(recorder.start()).rejects.toThrow('Not authorized');
    expect(await journal.getSession()).toBeNull();
  });

  it('turns repeated Finish taps into one saved run', async () => {
    const { recorder, clock, journal } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 1500, 500).points, 50);
    await recorder.pause();
    const [a, b] = await Promise.all([recorder.finish(), recorder.finish()]);
    expect(a.runId).toBe(b.runId);
    expect(await journal.listSavedRuns()).toHaveLength(1);
    expect(await journal.openOutbox()).toHaveLength(1);
  });

  it('never reports success when the local write fails, and keeps the session for retry', async () => {
    const { recorder, clock, db, journal } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 1500, 500).points, 50);
    await recorder.pause();
    db.failWhen = /insert into saved_runs/;
    await expect(recorder.finish()).rejects.toThrow('injected disk failure');
    expect((await journal.getSession())?.status).toBe('paused');
    expect(await journal.listSavedRuns()).toHaveLength(0);
    expect(await journal.openOutbox()).toHaveLength(0);
    db.failWhen = null;
    const saved = await recorder.finish();
    expect(saved.pointCount).toBe(501);
  });

  it('recovers a run after the process died: the segment ends at the last checkpoint', async () => {
    const { recorder, clock, make, driver, events } = await setup();
    await recorder.start();
    const route = steadyRun(T0, 3000, 1200).points;
    await stream(recorder, clock, route.slice(0, 601), 10); // 10 minutes recorded
    const lastEvidence = clock.wall;

    // The app is force-quit; the runner reopens it 20 minutes later.
    recorder.dispose();
    clock.advance(20 * 60_000);
    const relaunched = make();
    await relaunched.init();
    const session = relaunched.getSnapshot().session;
    expect(session?.status).toBe('interrupted');
    expect(session?.segments).toEqual([{ index: 0, startAt: T0, endAt: lastEvidence }]);
    expect(driver.running).toBe(false);
    expect(events.some((e) => e.name === 'recorder_interrupted')).toBe(true);
    expect(relaunched.getSnapshot().metrics.activeMs).toBe(600_000);

    // Save the partial run: the missing 20 minutes are never credited.
    await relaunched.recover();
    const saved = await relaunched.finish();
    expect(saved).toMatchObject({ interrupted: true, activeMs: 600_000 });
    expect(saved.distanceM).toBeCloseTo(1500, 0);
  });

  it('can resume an interrupted run with a new segment', async () => {
    const { recorder, clock, make } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 1500, 600).points, 10);
    clock.advance(5 * 60_000);
    const relaunched = make();
    await relaunched.init();
    await relaunched.recover();
    await relaunched.resume();
    const session = relaunched.getSnapshot().session;
    expect(session?.openSegment?.index).toBe(1);
    expect(session?.wasInterrupted).toBe(true);
  });

  it('continues a recording when the process restarts within the gap threshold', async () => {
    const { recorder, clock, make, driver } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 600, 200).points.slice(0, 100), 10);
    driver.running = false;
    clock.advance(5_000);
    const relaunched = make();
    await relaunched.init();
    expect(relaunched.getSnapshot().session?.status).toBe('recording');
    expect(driver.running).toBe(true);
  });

  it('interrupts a stale session on the first background delivery after a relaunch', async () => {
    const { recorder, clock, make } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 600, 200).points.slice(0, 50), 10);
    clock.advance(10 * 60_000);
    const headless = make(); // created by the task handler, not yet initialized by the UI
    await headless.ingest([{ timestamp: clock.wall, latitude: 41.88, longitude: -87.62, accuracy: 5 }]);
    const session = headless.getSnapshot().session;
    expect(session?.status).toBe('interrupted');
    expect(session?.pointCount).toBe(50);
  });

  it('interrupts on permission loss and stops updates', async () => {
    const { recorder, clock, driver } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 600, 200).points.slice(0, 60), 10);
    await recorder.interruptForPermission();
    expect(recorder.getSnapshot().session).toMatchObject({ status: 'interrupted', interruptReason: 'permission' });
    expect(driver.running).toBe(false);
  });

  it('discards only after confirmation-level intent (paused) and removes all points', async () => {
    const { recorder, clock, journal, db } = await setup();
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 600, 200).points, 20);
    await expect(recorder.discard()).rejects.toThrow();
    await recorder.pause();
    await recorder.discard();
    expect(await journal.getSession()).toBeNull();
    expect(await db.getAllAsync('select * from track_points')).toEqual([]);
    await expect(recorder.pause()).rejects.toBeInstanceOf(NoActiveRunError);
  });

  it('stops appending at the point limit but keeps time running', async () => {
    const { recorder, clock } = await setup({ maxPoints: 100 });
    await recorder.start();
    await stream(recorder, clock, steadyRun(T0, 1000, 300).points, 25);
    const { metrics } = recorder.getSnapshot();
    expect(metrics.pointCount).toBe(100);
    expect(metrics.pointLimitReached).toBe(true);
    expect(metrics.activeMs).toBe(300_000);
  });

  it('ignores stale cached fixes from before the run started', async () => {
    const { recorder, clock } = await setup();
    await recorder.start();
    clock.advance(1000);
    await recorder.ingest([
      { timestamp: T0 - 60_000, latitude: 41.8, longitude: -87.6, accuracy: 5 },
      { timestamp: T0 + 1000, latitude: 41.8781136, longitude: -87.6297982, accuracy: 5 },
    ]);
    expect(recorder.getSnapshot().metrics.pointCount).toBe(1);
  });

  it('describes GPS quality from fix age and accuracy', async () => {
    const { recorder, clock } = await setup();
    await recorder.start();
    expect(recorder.getSnapshot().metrics.quality).toBe('searching');
    clock.advance(1000);
    await recorder.ingest([{ timestamp: clock.wall, latitude: 41.8781136, longitude: -87.6297982, accuracy: 8 }]);
    expect(recorder.getSnapshot().metrics.quality).toBe('good');
    clock.advance(1000);
    await recorder.ingest([{ timestamp: clock.wall, latitude: 41.8781236, longitude: -87.6297982, accuracy: 35 }]);
    expect(recorder.getSnapshot().metrics.quality).toBe('fair');
    clock.advance(30_000);
    await recorder.tick();
    expect(recorder.getSnapshot().metrics.quality).toBe('weak');
  });
});
