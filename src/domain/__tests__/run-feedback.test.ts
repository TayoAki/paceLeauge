import { AutoPauseDetector, type MotionSample } from '../auto-pause';
import { CueScheduler, cueText, DEFAULT_CUE_SETTINGS, spokenDistance, spokenDuration, spokenPace, type CueSettings } from '../cues';
import { destinationPoint } from '../geo';
import { averagePaceSPerKm, currentPaceSPerKm } from '../live-pace';
import type { CreditedStretch } from '../validator';

const T0 = Date.UTC(2026, 8, 25, 12);

describe('current pace', () => {
  const steady = (speedMps: number, seconds: number, from = T0): CreditedStretch[] =>
    Array.from({ length: seconds }, (_, i) => ({ t0: from + i * 1000, t1: from + (i + 1) * 1000, distanceM: speedMps }));

  it('reads the pace of the last 20 seconds', () => {
    const stretches = [...steady(2.5, 60), ...steady(4, 30, T0 + 60_000)];
    expect(currentPaceSPerKm(stretches, T0 + 90_000)).toBeCloseTo(250, 5); // 4 m/s = 4:10/km
  });

  it('is null when stopped, stale or too short', () => {
    expect(currentPaceSPerKm([], T0)).toBeNull();
    expect(currentPaceSPerKm(steady(3, 30), T0 + 30_000 + 11_000)).toBeNull();
    expect(currentPaceSPerKm(steady(0.3, 30), T0 + 30_000)).toBeNull();
  });

  it('computes average pace and refuses tiny distances', () => {
    expect(averagePaceSPerKm(5_000, 1_500_000)).toBe(300);
    expect(averagePaceSPerKm(5, 60_000)).toBeNull();
  });
});

describe('auto-pause', () => {
  const origin = { lat: 41.88, lon: -87.63 };

  /** One fix a second: `plan` is a list of [seconds, speed m/s]. */
  function feed(detector: AutoPauseDetector, plan: [number, number][], accuracyM = 5) {
    const decisions: { type: string; at: number }[] = [];
    let t = T0;
    let position = origin;
    for (const [seconds, speed] of plan) {
      for (let i = 0; i < seconds; i += 1) {
        t += 1000;
        position = destinationPoint(position, 90, speed);
        const sample: MotionSample = { t, lat: position.lat, lon: position.lon, accuracyM };
        const d = detector.push(sample);
        if (d) decisions.push(d);
      }
    }
    return decisions;
  }

  it('pauses after a stop and dates the pause to when the runner stopped', () => {
    const detector = new AutoPauseDetector();
    const decisions = feed(detector, [
      [60, 3],
      [30, 0],
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.type).toBe('pause');
    // Stopped at T0 + 60 s; the pause lands within a couple of seconds of that.
    expect(Math.abs(decisions[0]!.at - (T0 + 60_000))).toBeLessThanOrEqual(3_000);
  });

  it('resumes when the runner moves again', () => {
    const detector = new AutoPauseDetector();
    const decisions = feed(detector, [
      [60, 3],
      [30, 0],
      [20, 3],
    ]);
    expect(decisions.map((d) => d.type)).toEqual(['pause', 'resume']);
  });

  it('ignores GPS jitter while standing still and never flickers at a slow jog', () => {
    const detector = new AutoPauseDetector();
    const jitter: MotionSample[] = [];
    for (let i = 0; i < 40; i += 1) {
      const wobble = destinationPoint(origin, (i * 73) % 360, 2.5);
      jitter.push({ t: T0 + i * 1000, lat: wobble.lat, lon: wobble.lon, accuracyM: 8 });
    }
    const decisions = jitter.map((s) => detector.push(s)).filter(Boolean);
    expect(decisions).toEqual([{ type: 'pause', at: expect.any(Number) }]);

    const jogger = new AutoPauseDetector();
    expect(feed(jogger, [[300, 1.8]])).toEqual([]);
  });

  it('skips inaccurate fixes', () => {
    const detector = new AutoPauseDetector();
    expect(
      feed(
        detector,
        [
          [60, 3],
          [30, 0],
        ],
        60,
      ),
    ).toEqual([]);
  });
});

describe('voice cues', () => {
  const metric = DEFAULT_CUE_SETTINGS;

  it('speaks at each kilometre with the split for that kilometre', () => {
    const scheduler = new CueScheduler(metric, 'metric');
    expect(scheduler.update({ distanceM: 500, activeMs: 150_000, currentPaceSPerKm: 300 })).toBeNull();
    const first = scheduler.update({ distanceM: 1_010, activeMs: 303_000, currentPaceSPerKm: 300 });
    expect(first).toMatchObject({ kind: 'progress', index: 1, distanceM: 1_000 });
    if (first?.kind !== 'progress') throw new Error('expected a progress cue');
    expect(first.activeMs).toBe(300_000);
    expect(first.splitMs).toBe(300_000);
    const second = scheduler.update({ distanceM: 2_000, activeMs: 590_000, currentPaceSPerKm: 290 });
    expect(second).toMatchObject({ index: 2, splitMs: 290_000 });
  });

  it('speaks only the newest boundary after a catch-up', () => {
    const scheduler = new CueScheduler(metric, 'metric');
    const cue = scheduler.update({ distanceM: 2_100, activeMs: 630_000, currentPaceSPerKm: null });
    expect(cue).toMatchObject({ index: 2, splitMs: null });
    expect(scheduler.update({ distanceM: 2_200, activeMs: 660_000, currentPaceSPerKm: null })).toBeNull();
  });

  it('supports half units, miles and time triggers', () => {
    const half = new CueScheduler({ ...metric, trigger: { kind: 'distance', every: 0.5 } }, 'imperial');
    expect(half.update({ distanceM: 810, activeMs: 240_000, currentPaceSPerKm: null })).toMatchObject({ index: 1, splitMs: null });
    expect(half.update({ distanceM: 1_610, activeMs: 480_000, currentPaceSPerKm: null })).toMatchObject({ index: 2 });

    const timed = new CueScheduler({ ...metric, trigger: { kind: 'time', everyMinutes: 5 } }, 'metric');
    expect(timed.update({ distanceM: 900, activeMs: 299_000, currentPaceSPerKm: null })).toBeNull();
    expect(timed.update({ distanceM: 1_000, activeMs: 301_000, currentPaceSPerKm: null })).toMatchObject({ index: 1, activeMs: 300_000 });
  });

  it('stays silent when switched off', () => {
    const off = new CueScheduler({ ...metric, enabled: false }, 'metric');
    expect(off.update({ distanceM: 5_000, activeMs: 1_500_000, currentPaceSPerKm: null })).toBeNull();
  });

  it('writes short sentences with only the chosen fields', () => {
    const cue = { kind: 'progress' as const, index: 2, distanceM: 2_000, activeMs: 604_000, splitMs: 301_000, currentPaceSPerKm: 290, heartRateBpm: 151 };
    expect(cueText(cue, metric, 'metric')).toBe('2 kilometers. Time 10 minutes 4 seconds. Split 5 minutes 1 second. Average pace 5 minutes 2 seconds per kilometer.');
    const important: CueSettings = { ...metric, mode: 'important' };
    expect(cueText(cue, important, 'metric')).toBe('2 kilometers. Split 5 minutes 1 second.');
    const everything: CueSettings = { ...metric, fields: { time: false, distance: false, averagePace: false, currentPace: true, split: false, heartRate: true } };
    expect(cueText(cue, everything, 'metric')).toBe('Current pace 4 minutes 50 seconds per kilometer. Heart rate 151.');
    expect(cueText({ kind: 'paused', auto: true }, metric, 'metric')).toBe('Auto-paused.');
  });

  it('formats spoken values', () => {
    expect(spokenDuration(3_661_000)).toBe('1 hour 1 minute');
    expect(spokenDuration(59_000)).toBe('59 seconds');
    expect(spokenDistance(2_500, 'metric')).toBe('2.5 kilometers');
    expect(spokenDistance(1_609.344, 'imperial')).toBe('1 mile');
    expect(spokenPace(300, 'imperial')).toBe('8 minutes 3 seconds per mile');
    expect(spokenPace(null, 'metric')).toBeNull();
    expect(spokenPace(5_000, 'metric')).toBeNull();
  });
});
