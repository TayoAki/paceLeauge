import { Journal } from '@/db/journal';
import { DEFAULT_STRIDE_M, INDOOR_SESSION_KEY, INDOOR_STRIDE_KEY, IndoorRunService, activeMsOf, type StepSource } from '@/features/indoor/indoor-run';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

const T0 = Date.parse('2026-09-28T07:00:00Z');

class MovableClock implements Clock {
  t = T0;
  now = () => this.t;
  monotonic = () => this.t;
}

/** Steps at a steady cadence (3 steps a second), like a runner on a treadmill. */
class SteadySteps implements StepSource {
  asked: [number, number][] = [];
  constructor(private readonly perSecond = 3) {}
  stepsBetween = async (from: number, to: number) => {
    this.asked.push([from, to]);
    return Math.round(((to - from) / 1000) * this.perSecond);
  };
}

let ids = 0;

async function setup(steps: StepSource | null = new SteadySteps()) {
  const clock = new MovableClock();
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const service = () => new IndoorRunService({ kv: journal, journal, steps, newRunId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`, now: clock.now });
  return { clock, journal, indoor: service(), service };
}

describe('Indoor runs', () => {
  it('counts only the time spent running, across pauses', async () => {
    const { clock, indoor } = await setup();
    await indoor.start();
    clock.t += 600_000;
    await indoor.pause();
    clock.t += 120_000;
    expect(activeMsOf(indoor.current!, clock.now())).toBe(600_000);
    await indoor.resume();
    clock.t += 300_000;
    expect(activeMsOf(indoor.current!, clock.now())).toBe(900_000);
    // Pausing twice, or resuming a running session, changes nothing.
    await indoor.resume();
    await indoor.pause();
    await indoor.pause();
    expect(indoor.current!.segments).toHaveLength(2);
    expect(activeMsOf(indoor.current!, clock.now() + 60_000)).toBe(900_000);
  });

  it('counts steps only while running and estimates the distance from the stride', async () => {
    const source = new SteadySteps();
    const { clock, indoor } = await setup(source);
    await indoor.start();
    clock.t += 600_000;
    await indoor.pause();
    clock.t += 300_000;
    await indoor.resume();
    clock.t += 100_000;
    expect(await indoor.steps()).toBe(2_100);
    expect(source.asked).toEqual([
      [T0, T0 + 600_000],
      [T0 + 900_000, T0 + 1_000_000],
    ]);
    expect(await indoor.estimateM()).toBe(Math.round(2_100 * DEFAULT_STRIDE_M));
  });

  it('saves the confirmed distance as an indoor run that syncs like any other', async () => {
    const { clock, journal, indoor } = await setup();
    const session = await indoor.start();
    clock.t += 1_200_000;
    const runId = await indoor.finish(4_000);
    expect(runId).toBe(session.runId);
    expect(indoor.current).toBeNull();
    expect(await journal.getKv(INDOOR_SESSION_KEY)).toBeNull();

    const saved = await journal.getSavedRun(runId);
    expect(saved).toMatchObject({
      distanceM: 4_000,
      activeMs: 1_200_000,
      startedAt: T0,
      endedAt: T0 + 1_200_000,
      pointCount: 0,
      syncState: 'pending',
      origin: { source: 'indoor', activityType: 'run', claimedDistanceM: 4_000, steps: 3_600 },
    });
    expect(saved!.title).toMatch(/treadmill$/);
    expect(saved!.validation.outcome).toBe('personal_only');
    expect((await journal.openOutbox()).map((o) => [o.kind, o.runId])).toEqual([['upload_run', runId]]);
  });

  it('learns the runner’s stride from the treadmill’s distance', async () => {
    const { clock, indoor, service } = await setup();
    await indoor.start();
    clock.t += 1_000_000;
    // 3,000 steps; the treadmill says 3.6 km, so the stride is 1.2 m.
    await indoor.finish(3_600);
    const next = service();
    expect(await next.stride()).toBeCloseTo(1.2, 5);
    await next.start();
    clock.t += 100_000;
    expect(await next.estimateM()).toBe(360);
  });

  it('calibrates the stride against outdoor runs, and blends later measurements', async () => {
    const { indoor } = await setup();
    // 5 km outdoors in 25 minutes at 3 steps a second: 4,500 steps, a 1.11 m stride.
    const segments = [
      { index: 0, startAt: T0 - 3_600_000, endAt: T0 - 3_000_000 },
      { index: 1, startAt: T0 - 2_900_000, endAt: T0 - 2_000_000 },
    ];
    expect(await indoor.calibrateFromRun(5_000, segments)).toBeCloseTo(5_000 / 4_500, 5);
    // A second outdoor run moves it part of the way (30%) toward what it measured.
    const next = await indoor.calibrateFromRun(6_000, segments);
    expect(next).toBeCloseTo(5_000 / 4_500 + (6_000 / 4_500 - 5_000 / 4_500) * 0.3, 5);
    expect(await indoor.stride()).toBeCloseTo(next!, 5);
    // Short runs and runs without step counts teach nothing.
    expect(await indoor.calibrateFromRun(800, segments)).toBeNull();
    const { indoor: noSteps } = await setup(null);
    expect(await noSteps.calibrateFromRun(5_000, segments)).toBeNull();
  });

  it('ignores implausible strides and short runs when learning', async () => {
    const { clock, journal, indoor } = await setup();
    await indoor.start();
    clock.t += 1_000_000;
    // 3,000 steps for 15 km is a 5 m stride: a typo, not a stride.
    await indoor.finish(15_000);
    expect(await journal.getKv(INDOOR_STRIDE_KEY)).toBeNull();
    await indoor.start();
    clock.t += 30_000;
    // 90 steps is too few to learn from.
    await indoor.finish(100);
    expect(await journal.getKv(INDOOR_STRIDE_KEY)).toBeNull();
    await journal.setKv(INDOOR_STRIDE_KEY, 9);
    expect(await indoor.stride()).toBe(DEFAULT_STRIDE_M);
  });

  it('picks up an open run after the app is closed', async () => {
    const { clock, indoor, service } = await setup();
    const session = await indoor.start();
    clock.t += 300_000;
    const reopened = service();
    const restored = await reopened.restore();
    expect(restored?.runId).toBe(session.runId);
    clock.t += 200_000;
    await reopened.pause();
    expect(activeMsOf(reopened.current!, clock.now())).toBe(500_000);
  });

  it('keeps working without step counting', async () => {
    const { clock, journal, indoor } = await setup(null);
    await indoor.start();
    clock.t += 900_000;
    expect(await indoor.steps()).toBeNull();
    expect(await indoor.estimateM()).toBeNull();
    const runId = await indoor.finish(2_500);
    expect((await journal.getSavedRun(runId))?.origin).toMatchObject({ source: 'indoor', steps: null, claimedDistanceM: 2_500 });
  });

  it('won’t start while a GPS run is recording, and discards cleanly', async () => {
    const { clock, journal, indoor } = await setup();
    await journal.startSession('11111111-1111-4111-8111-111111111111', clock.now());
    await expect(indoor.start()).rejects.toThrow(/GPS run/);
    await journal.command({ type: 'pause', at: clock.now() });
    await journal.discardSession('11111111-1111-4111-8111-111111111111');
    await indoor.start();
    const seen: (string | null)[] = [];
    indoor.changes.subscribe((s) => seen.push(s?.runId ?? null));
    await indoor.discard();
    expect(indoor.current).toBeNull();
    expect(seen).toEqual([null]);
    await expect(indoor.finish(1_000)).rejects.toThrow(/No indoor run/);
  });
});
