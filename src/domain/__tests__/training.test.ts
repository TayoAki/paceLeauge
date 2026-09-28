import { addDays } from '../calendar';
import {
  activityLoad,
  dailyAverages,
  sleepMinutesByNight,
  trendChange,
  weeklyAverages,
  dailyLoads,
  DEFINITIONS,
  efficiencyPoints,
  fitnessFatigue,
  formLabel,
  hrZoneSeconds,
  observedMaxHr,
  racePredictions,
  thresholdPaceS,
  weeklyLoads,
  type Activity,
} from '../training';

const run = (date: string, minutes: number, km: number, extra: Partial<Activity> = {}): Activity => ({
  startedAtMs: Date.parse(`${date}T12:00:00Z`),
  date,
  activity: 'run',
  activeMs: minutes * 60_000,
  distanceM: km * 1000,
  avgHr: null,
  ...extra,
});

describe('training load', () => {
  // 25:00 5K: an hour's pace is about 5:15 /km.
  const threshold = thresholdPaceS({ '5k': 1500 })!;

  it('puts threshold a little slower than 5K pace', () => {
    expect(Math.round(threshold)).toBe(315);
    expect(thresholdPaceS({})).toBeNull();
  });

  it('scores an hour at threshold 100, easy running less, and other workouts by type', () => {
    expect(activityLoad(run('2026-10-01', 60, 3600 / threshold), threshold)).toBe(100);
    const easy = activityLoad(run('2026-10-01', 60, 9), threshold);
    expect(easy).toBeGreaterThan(50);
    expect(easy).toBeLessThan(80);
    expect(activityLoad({ ...run('2026-10-01', 60, 20), activity: 'ride' }, threshold)).toBe(42.3);
    // Treadmill distance is an estimate, so it's judged by time.
    expect(activityLoad(run('2026-10-01', 60, 12, { indoor: true }), threshold)).toBe(56.3);
    // Without fitness to compare against, runs are judged by time too.
    expect(activityLoad(run('2026-10-01', 60, 12), null)).toBe(56.3);
  });

  it('builds fitness slowly and fatigue quickly, and form falls after hard days', () => {
    const start = '2026-08-01';
    const loads = new Map<string, number>();
    for (let i = 0; i < 70; i++) if (i % 2 === 0) loads.set(addDays(start, i), 60);
    // A hard block in the last week.
    for (let i = 63; i < 70; i++) loads.set(addDays(start, i), 120);
    const points = fitnessFatigue(loads, start, addDays(start, 69));
    const last = points[points.length - 1]!;
    expect(last.fatigue).toBeGreaterThan(last.fitness);
    expect(formLabel(last.form)).toMatch(/building|tired/);
    const before = points[62]!;
    expect(Math.abs(before.form)).toBeLessThan(10);
    expect(formLabel(20)).toBe('fresh');
  });

  it('adds up days and weeks', () => {
    const loads = dailyLoads([run('2026-10-05', 30, 5), run('2026-10-05', 30, 5), run('2026-10-07', 60, 10)], null);
    expect(loads.get('2026-10-05')).toBeCloseTo(56.2, 5);
    expect(weeklyLoads(loads, ['2026-10-05', '2026-10-12'])).toEqual([113, 0]);
  });
});

describe('predictions and efficiency', () => {
  it('predicts race times from the best effort of a mile or more', () => {
    expect(racePredictions({ '5k': 1500 })).toEqual({ basedOn: '5k', times: { '5k': 1500, '10k': 3127, half: 6900, marathon: 14387 } });
    // The 10K predicts the quicker 5K here, so it's the one the predictions use.
    expect(racePredictions({ '5k': 1500, '10k': 3000 })?.basedOn).toBe('10k');
    expect(racePredictions({ '1k': 200 })).toBeNull();
  });

  it('measures efficiency on easy runs with heart rate only', () => {
    const points = efficiencyPoints(
      [
        run('2026-10-02', 50, 8, { avgHr: 140 }),
        run('2026-10-01', 50, 8, { avgHr: 150 }),
        run('2026-10-03', 30, 7, { avgHr: 175 }),
        run('2026-10-04', 40, 7),
      ],
      190,
    );
    expect(points).toEqual([
      { date: '2026-10-01', value: 1.07 },
      { date: '2026-10-02', value: 1.14 },
    ]);
    expect(observedMaxHr([150, null, 188, 250, 90])).toBe(188);
  });
});

describe('heart-rate zones', () => {
  it('counts time in each zone, inside the active time only', () => {
    const t0 = 0;
    const samples = [
      { t: t0, bpm: 100 },
      { t: t0 + 60_000, bpm: 130 },
      { t: t0 + 120_000, bpm: 150 },
      { t: t0 + 180_000, bpm: 165 },
      { t: t0 + 240_000, bpm: 185 },
    ];
    // Samples 5 s apart are the norm; here each holds at most 30 s.
    const zones = hrZoneSeconds(samples, 190, [{ startAt: t0, endAt: t0 + 300_000 }]);
    expect(zones).toEqual([30, 30, 30, 30, 30]);
    const paused = hrZoneSeconds(samples, 190, [{ startAt: t0 + 100_000, endAt: t0 + 300_000 }]);
    expect(paused).toEqual([0, 0, 30, 30, 30]);
  });

  it('explains every number it shows', () => {
    for (const text of Object.values(DEFINITIONS)) expect(text).toMatch(/\.$/);
  });
});

describe('health trends', () => {
  const dateOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  const at = (date: string, hour: number) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);

  it('averages each day, then each week', () => {
    const days = dailyAverages(
      [
        { t: at('2026-10-05', 7), value: 52 },
        { t: at('2026-10-05', 9), value: 54 },
        { t: at('2026-10-07', 7), value: 50 },
        { t: at('2026-10-08', 7), value: 0 },
      ],
      dateOf,
    );
    expect([...days]).toEqual([
      ['2026-10-05', 53],
      ['2026-10-07', 50],
    ]);
    expect(weeklyAverages(days, ['2026-10-05', '2026-10-12'])).toEqual([51.5, null]);
    expect(trendChange([null, 55, 54, null, 52])).toEqual({ from: 55, to: 52 });
    expect(trendChange([null, 55])).toBeNull();
  });

  it('counts each night once, preferring the watch’s stages, and leaves out time awake', () => {
    const nights = sleepMinutesByNight(
      [
        // The watch: core 23:00–03:00, awake 03:00–03:15, REM 03:15–06:30.
        { startMs: at('2026-10-05', 23), endMs: at('2026-10-06', 3), value: 3 },
        { startMs: at('2026-10-06', 3), endMs: at('2026-10-06', 3) + 15 * 60_000, value: 2 },
        { startMs: at('2026-10-06', 3) + 15 * 60_000, endMs: at('2026-10-06', 6) + 30 * 60_000, value: 5 },
        // The phone's rougher estimate of the same night is left out.
        { startMs: at('2026-10-05', 23), endMs: at('2026-10-06', 6), value: 1 },
        // In bed doesn't count.
        { startMs: at('2026-10-05', 22), endMs: at('2026-10-06', 7), value: 0 },
        // The next night only the phone saw: 22:30 before midnight to 05:30.
        { startMs: at('2026-10-06', 22) + 30 * 60_000, endMs: at('2026-10-06', 23) + 59 * 60_000, value: 1 },
        { startMs: at('2026-10-06', 23) + 59 * 60_000, endMs: at('2026-10-07', 5) + 30 * 60_000, value: 1 },
      ],
      dateOf,
    );
    expect(nights.get('2026-10-06')).toBe(7 * 60 + 15);
    expect(nights.get('2026-10-07')).toBe(7 * 60);
    expect(nights.size).toBe(2);
  });
});
