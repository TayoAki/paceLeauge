import { Journal, type RawSample } from '@/db/journal';
import { METRES_PER_MILE } from '@/domain/format';
import { steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { DEFAULT_RUN_SETTINGS, parseRunSettings } from '@/features/voice/run-settings';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';

const T0 = Date.parse('2026-09-25T12:00:00Z');

class FakeClock implements Clock {
  constructor(public wall: number) {}
  now = () => this.wall;
  monotonic = () => this.wall;
}

const driver: LocationDriver = { supportsBackground: true, start: async () => undefined, stop: async () => undefined, isRunning: async () => true };

async function run(unitM: number, distanceM: number, durationS: number) {
  const clock = new FakeClock(T0);
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const recorder = new RecorderService({ journal, location: driver, clock, newRunId: () => '00000000-0000-4000-8000-000000000001', lapUnitM: () => unitM });
  await recorder.start();
  const points = steadyRun(T0, distanceM, durationS).points;
  for (let i = 0; i < points.length; i += 5) {
    const slice: TrackPoint[] = points.slice(i, i + 5);
    clock.wall = slice[slice.length - 1]!.t;
    const samples: RawSample[] = slice.map((p) => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM }));
    await recorder.ingest(samples);
  }
  return recorder.getSnapshot().metrics;
}

describe('laps', () => {
  it('restarts the lap at each kilometre, at the moment it was crossed', async () => {
    // 2.5 km at 4 m/s: 500 m and 125 s into the third lap.
    const m = await run(1000, 2_500, 625);
    expect(m.lapDistanceM).toBeCloseTo(m.distanceM - 2000, 6);
    expect(m.lapActiveMs).toBeGreaterThan(120_000);
    expect(m.lapActiveMs).toBeLessThan(130_000);
  });

  it('uses miles for imperial runners', async () => {
    const m = await run(METRES_PER_MILE, 2_000, 500);
    expect(m.lapDistanceM).toBeCloseTo(m.distanceM - METRES_PER_MILE, 6);
    expect(m.lapActiveMs).toBeGreaterThan(90_000);
    expect(m.lapActiveMs).toBeLessThan(105_000);
  });
});

describe('run screen fields', () => {
  it('keeps one to three known fields', () => {
    expect(parseRunSettings({ screenFields: ['lapPace', 'time', 'lapPace', 'bogus', 'averagePace', 'currentPace'] }).screenFields).toEqual([
      'lapPace',
      'time',
      'averagePace',
    ]);
    expect(parseRunSettings({ screenFields: [] }).screenFields).toEqual(DEFAULT_RUN_SETTINGS.screenFields);
    expect(parseRunSettings({ screenFields: 'time' }).screenFields).toEqual(DEFAULT_RUN_SETTINGS.screenFields);
  });
});
