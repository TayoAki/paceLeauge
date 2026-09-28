import { Journal } from '@/db/journal';
import { steadyRun } from '@/domain/synthetic';
import type { WatchLinkPort } from '@/features/watch/watch-link';
import { parseWatchRun, watchRun, WatchRunInbox, type WatchRunFile } from '@/features/watch/watch-runs';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

const T0 = Date.parse('2026-09-27T12:00:00Z');
const RUN_ID = '2d2d2d2d-0000-4000-8000-000000000001';

class FixedClock implements Clock {
  now = () => T0 + 3 * 3_600_000;
  monotonic = () => T0;
}

/** A 5 km watch run with a two-minute pause after 12 minutes. */
function watchFile(overrides: Partial<WatchRunFile> = {}): WatchRunFile {
  const route = steadyRun(T0, 5_000, 1_500).points;
  const pauseAt = T0 + 720_000;
  return {
    version: 1,
    run_id: RUN_ID,
    started_at: T0,
    ended_at: T0 + 1_620_000,
    segments: [
      [T0, pauseAt],
      [pauseAt + 120_000, T0 + 1_620_000],
    ],
    points: route.map((p) => [p.t < pauseAt ? p.t : p.t + 120_000, p.lat, p.lon, p.accuracyM ?? 5]),
    distance_m: 5_010,
    indoor: false,
    avg_heart_rate: 151.6,
    max_heart_rate: 173,
    steps: 4_210.4,
    device: 'Watch7,1',
    ...overrides,
  };
}

class FakeLink implements WatchLinkPort {
  files = new Map<string, string>();
  acked: string[] = [];
  listeners: (() => void)[] = [];
  status = () => ({ supported: true, paired: true, installed: true, reachable: true });
  updateContext = () => true;
  pendingRuns = () => [...this.files.entries()].map(([name, json]) => ({ name, json }));
  ackRun = (name: string) => {
    this.acked.push(name);
    this.files.delete(name);
  };
  onRun = (listener: () => void) => {
    this.listeners.push(listener);
    return () => undefined;
  };
  onWorkout = () => () => undefined;
}

describe('watch run files', () => {
  it('reads only well-formed files', () => {
    expect(parseWatchRun(JSON.stringify(watchFile()))?.run_id).toBe(RUN_ID);
    expect(parseWatchRun('not json')).toBeNull();
    expect(parseWatchRun(JSON.stringify({ ...watchFile(), run_id: 'nope' }))).toBeNull();
    expect(parseWatchRun(JSON.stringify({ ...watchFile(), ended_at: T0 - 1 }))).toBeNull();
    expect(parseWatchRun(JSON.stringify({ ...watchFile(), version: 2 }))).toBeNull();
  });

  it('keeps the watch’s pauses and GPS, and says where the run came from', () => {
    const { draft, points, origin } = watchRun(watchFile());
    expect(draft.segments).toHaveLength(2);
    expect(draft.activeMs).toBe(1_500_000);
    expect(new Set(points.map((p) => p.segmentIndex))).toEqual(new Set([0, 1]));
    expect(points.map((p) => p.seq)).toEqual(points.map((_, i) => i));
    expect(draft.distanceM).toBeGreaterThan(4_900);
    expect(draft.validation.outcome).toBe('accepted');
    expect(origin).toMatchObject({
      source: 'watch',
      sourceApp: 'PaceLeague',
      sourceDevice: 'Watch7,1',
      externalId: RUN_ID,
      avgHeartRate: 152,
      maxHeartRate: 173,
      steps: 4_210,
      indoor: false,
    });
  });

  it('keeps a treadmill run routeless, with its distance, heart rate and steps', () => {
    const { draft, points, origin } = watchRun(watchFile({ indoor: true, points: [], distance_m: 6_000, steps: 5_100 }));
    expect(points).toEqual([]);
    expect(draft.distanceM).toBe(6_000);
    expect(draft.title).toMatch(/treadmill$/);
    expect(origin).toMatchObject({ indoor: true, steps: 5_100, claimedDistanceM: 6_000 });
  });
});

describe('the watch inbox', () => {
  it('saves each run once, under the watch’s run id, and lets the files go', async () => {
    const journal = await Journal.open(new NodeSqliteDatabase(), new FixedClock());
    const link = new FakeLink();
    link.files.set(`${RUN_ID}.json`, JSON.stringify(watchFile()));
    link.files.set('broken.json', '{"version": 1}');
    const inbox = new WatchRunInbox({ journal, link });
    const received: number[] = [];
    inbox.received.subscribe((n) => received.push(n));

    expect(await inbox.drain()).toBe(1);
    expect(received).toEqual([1]);
    expect(link.acked.sort()).toEqual([`${RUN_ID}.json`, 'broken.json'].sort());
    expect(await journal.getSavedRun(RUN_ID)).toMatchObject({ syncState: 'pending', origin: { source: 'watch' } });
    expect((await journal.openOutbox()).map((o) => o.runId)).toEqual([RUN_ID]);

    // The same run again (the Health copy or a repeated transfer) changes nothing.
    link.files.set(`${RUN_ID}.json`, JSON.stringify(watchFile()));
    expect(await inbox.drain()).toBe(0);
    expect((await journal.openOutbox()).length).toBe(1);
  });

  it('drains when the watch sends a run, and does nothing without a watch', async () => {
    const journal = await Journal.open(new NodeSqliteDatabase(), new FixedClock());
    const link = new FakeLink();
    const inbox = new WatchRunInbox({ journal, link });
    inbox.watch();
    link.files.set(`${RUN_ID}.json`, JSON.stringify(watchFile()));
    link.listeners.forEach((l) => l());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await journal.getSavedRun(RUN_ID)).not.toBeNull();
    expect(await new WatchRunInbox({ journal, link: null }).drain()).toBe(0);
  });
});
