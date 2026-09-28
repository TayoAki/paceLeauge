import type { ServerRun } from '@/api/schemas';
import { addDays } from '@/domain/calendar';
import type { Activity } from '@/domain/training';
import { CHART_WEEKS, resolveMaxHr, runHeartRate, toActivity, trainingSummary, YEAR_DAYS } from '@/features/training/training-data';

const today = '2026-10-07';
const run = (date: string, minutes: number, km: number, extra: Partial<Activity> = {}): Activity => ({
  startedAtMs: Date.parse(`${date}T12:00:00Z`),
  date,
  activity: 'run',
  activeMs: minutes * 60_000,
  distanceM: km * 1000,
  avgHr: null,
  ...extra,
});

describe('training summary', () => {
  it('shows 12 weeks, compares them with a year earlier, and predicts from recent efforts', () => {
    const activities = Array.from({ length: 60 }, (_, i) => run(addDays(today, -i * 3), 40, 7, { avgHr: 140 }));
    const yearAgo = [run(addDays(today, -YEAR_DAYS - 10), 60, 10)];
    const summary = trainingSummary({ today, activities, yearAgo, best: { '5k': 1500 }, maxHr: 190 });
    expect(summary.points).toHaveLength(CHART_WEEKS * 7);
    expect(summary.points[summary.points.length - 1]!.date).toBe(today);
    expect(summary.weeks).toHaveLength(CHART_WEEKS);
    expect(summary.weeks[CHART_WEEKS - 1]!.monday).toBe('2026-10-05');
    expect(summary.recentLoad).toBeGreaterThan(summary.yearAgoLoad!);
    expect(summary.yearAgoLoad).toBeGreaterThan(0);
    expect(summary.predictions?.basedOn).toBe('5k');
    expect(summary.thresholdS).not.toBeNull();
    // Only the last 12 weeks' easy runs with heart rate.
    expect(summary.efficiency.length).toBe(28);
    expect(summary.activities).toBe(28);
  });

  it('works with nothing to go on', () => {
    const summary = trainingSummary({ today, activities: [], yearAgo: null, best: {}, maxHr: null });
    expect(summary.current.fitness).toBe(0);
    expect(summary.predictions).toBeNull();
    expect(summary.yearAgoLoad).toBeNull();
    expect(summary.weeks.every((w) => w.load === 0)).toBe(true);
  });
});

describe('heart rate', () => {
  it('uses the maximum the runner set, else the highest seen', () => {
    expect(resolveMaxHr(185, [{ max_heart_rate: 192 }])).toEqual({ value: 185, source: 'set' });
    expect(resolveMaxHr(null, [{ max_heart_rate: 176 }, { max_heart_rate: null }], [181])).toEqual({ value: 181, source: 'observed' });
    expect(resolveMaxHr(null, [{ max_heart_rate: 100 }])).toBeNull();
  });

  it('counts zones from samples inside the run, and needs a minute of them', () => {
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    const segments = [{ index: 0, startAt: t0, endAt: t0 + 600_000 }];
    const samples = Array.from({ length: 121 }, (_, i) => ({ t: t0 + i * 5_000, bpm: i < 60 ? 125 : 160 }));
    // A reading from before the run is ignored.
    const result = runHeartRate([{ t: t0 - 60_000, bpm: 200 }, ...samples], 190, segments)!;
    expect(result.peakHr).toBe(160);
    expect(result.zonesS[1]).toBe(300);
    expect(result.zonesS[3]).toBe(300);
    expect(result.zonesS.reduce((a, b) => a + b, 0)).toBe(600);
    expect(runHeartRate(samples.slice(0, 5), 190, segments)).toBeNull();
  });

  it('maps a server run to an activity on the runner’s calendar', () => {
    const server = { started_at_ms: Date.parse('2026-10-07T03:00:00Z'), activity_type: 'ride', active_ms: 1, distance_m: 2, avg_heart_rate: 150, indoor: false } as ServerRun;
    expect(toActivity(server, 'America/Chicago')).toMatchObject({ date: '2026-10-06', activity: 'ride', avgHr: 150 });
  });
});
