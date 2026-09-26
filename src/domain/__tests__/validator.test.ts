import { destinationPoint } from '../geo';
import { buildSyntheticRun, CHICAGO_LAKEFRONT, steadyRun } from '../synthetic';
import type { TrackPoint } from '../types';
import { SegmentTrack, segmentsAreValid, validateRun } from '../validator';

const T0 = Date.parse('2026-09-25T12:00:00Z');
const received = (endedAt: number) => endedAt + 10_000;

function validate(run: ReturnType<typeof buildSyntheticRun>, receivedAt: number | null = received(run.endedAt)) {
  return validateRun({ ...run, receivedAt });
}

describe('validator v1', () => {
  it('accepts a clean 1 Hz run and measures its distance', () => {
    const v = validate(steadyRun(T0, 3000, 900));
    expect(v.outcome).toBe('accepted');
    expect(v.reasons).toEqual([]);
    expect(v.distanceM).toBeCloseTo(3000, 0);
    expect(v.activeMs).toBe(900_000);
    expect(v.coverage).toBe(1);
    expect(v.diagnostics.jumpSamples).toBe(0);
  });

  it('excludes paused time and movement during a pause', () => {
    const run = buildSyntheticRun({
      startAt: T0,
      legs: [
        { kind: 'run', durationS: 600, speedMps: 3 },
        { kind: 'pause', durationS: 300, movedM: 500 },
        { kind: 'run', durationS: 600, speedMps: 3 },
      ],
    });
    const v = validate(run);
    expect(run.segments).toHaveLength(2);
    expect(v.activeMs).toBe(1_200_000);
    expect(v.distanceM).toBeCloseTo(3600, 0);
    expect(v.outcome).toBe('accepted');
  });

  it('never bridges a GPS gap and charges it against coverage', () => {
    const run = buildSyntheticRun({
      startAt: T0,
      legs: [{ kind: 'run', durationS: 1200, speedMps: 3, dropouts: [[300, 360]] }],
    });
    const v = validate(run);
    expect(v.diagnostics.gaps).toBe(1);
    // Samples at 299 s and 360 s: a 61 s interval loses its ~183 m and counts only 15 s.
    expect(v.distanceM).toBeCloseTo(3600 - 61 * 3, 0);
    expect(v.coverage).toBeCloseTo((1200 - 61 + 15) / 1200, 6);
    expect(v.outcome).toBe('accepted');
  });

  it('makes a run personal-only when GPS covers less than 80% of active time', () => {
    const run = buildSyntheticRun({
      startAt: T0,
      legs: [{ kind: 'run', durationS: 1200, speedMps: 3, dropouts: [[100, 400], [500, 700]] }],
    });
    const v = validate(run);
    expect(v.coverage).toBeLessThan(0.8);
    expect(v.outcome).toBe('personal_only');
    expect(v.reasons).toEqual(['low_gps_coverage']);
  });

  it('treats inaccurate samples as unusable', () => {
    const v = validate(steadyRun(T0, 2000, 600, { accuracyM: 80 }));
    expect(v.diagnostics.usableSamples).toBe(0);
    expect(v.distanceM).toBe(0);
    expect(v.reasons).toEqual(['too_short_distance', 'low_gps_coverage']);
  });

  it('counts samples with 20 s spacing at the 15 s cap (75% coverage)', () => {
    const v = validate(steadyRun(T0, 2000, 600, { sampleIntervalS: 20 }));
    expect(v.distanceM).toBe(0);
    expect(v.coverage).toBeCloseTo(0.75, 5);
  });

  it('skips a single spike without losing the true distance', () => {
    const run = steadyRun(T0, 2400, 800);
    const spikeAt = run.points[400] as TrackPoint;
    const far = destinationPoint(spikeAt, 0, 300);
    run.points[400] = { ...spikeAt, lat: far.lat, lon: far.lon };
    const v = validate(run);
    expect(v.diagnostics.jumpSamples).toBe(1);
    expect(v.diagnostics.teleports).toBe(0);
    expect(v.distanceM).toBeCloseTo(2400, 0);
    expect(v.outcome).toBe('accepted');
  });

  it('recovers from a bad cold-start fix by re-anchoring on a plausible chain', () => {
    const run = steadyRun(T0, 2400, 800);
    const first = run.points[0] as TrackPoint;
    const bad = destinationPoint(first, 180, 500);
    run.points[0] = { ...first, lat: bad.lat, lon: bad.lon };
    const v = validate(run);
    expect(v.diagnostics.anchorOutliers).toBe(1);
    expect(v.diagnostics.teleports).toBe(0);
    expect(v.diagnostics.jumpSamples).toBe(0);
    expect(v.distanceM).toBeGreaterThan(2390);
    expect(v.outcome).toBe('accepted');
  });

  it('holds a run with a vehicle-speed stretch for review and credits none of it', () => {
    const run = buildSyntheticRun({
      startAt: T0,
      legs: [
        { kind: 'run', durationS: 600, speedMps: 3 },
        { kind: 'run', durationS: 300, speedMps: 20 },
        { kind: 'run', durationS: 600, speedMps: 3 },
      ],
    });
    // Merge the three legs into one continuous segment (no pauses).
    const merged = { ...run, segments: [{ index: 0, startAt: run.startedAt, endAt: run.endedAt }] };
    merged.points = merged.points.map((p) => ({ ...p, segmentIndex: 0 }));
    const v = validate(merged);
    expect(v.reasons).toContain('speed_anomaly');
    expect(v.outcome).toBe('review');
    expect(v.distanceM).toBeLessThan(3700);
  });

  it('holds a sustained implausible average speed for review', () => {
    const v = validate(steadyRun(T0, 4000, 500));
    expect(v.diagnostics.averageSpeedMps).toBeCloseTo(8, 1);
    expect(v.outcome).toBe('review');
    expect(v.reasons).toEqual(['speed_anomaly']);
  });

  it('ignores duplicate timestamps and sorts out-of-order samples', () => {
    const run = steadyRun(T0, 1500, 500);
    const shuffled = run.points.slice();
    const a = shuffled[100] as TrackPoint;
    shuffled[100] = shuffled[101] as TrackPoint;
    shuffled[101] = a;
    shuffled.push({ ...(run.points[200] as TrackPoint), seq: 99_999, lat: 0, lon: 0 });
    const v = validate({ ...run, points: shuffled });
    expect(v.diagnostics.duplicateSamples).toBe(1);
    expect(v.distanceM).toBeCloseTo(1500, 0);
  });

  it('ignores samples outside every active segment', () => {
    const run = steadyRun(T0, 1500, 500);
    run.points.push({ seq: 10_000, segmentIndex: 0, t: run.endedAt + 60_000, lat: 41.9, lon: -87.6, accuracyM: 5 });
    const v = validate(run);
    expect(v.diagnostics.outsideSegmentSamples).toBe(1);
    expect(v.distanceM).toBeCloseTo(1500, 0);
  });

  it('keeps short runs as personal history', () => {
    expect(validate(steadyRun(T0, 80, 90)).reasons).toEqual(['too_short_distance']);
    expect(validate(steadyRun(T0, 150, 50)).reasons).toEqual(['too_short_time']);
  });

  it('rejects malformed segment timelines as invalid timestamps', () => {
    const run = steadyRun(T0, 1500, 500);
    const overlapping = {
      ...run,
      segments: [
        { index: 0, startAt: T0, endAt: T0 + 300_000 },
        { index: 1, startAt: T0 + 200_000, endAt: T0 + 500_000 },
      ],
    };
    expect(segmentsAreValid(overlapping)).toBe(false);
    const v = validate(overlapping);
    expect(v).toMatchObject({ outcome: 'personal_only', reasons: ['invalid_timestamps'], distanceM: 0 });
    expect(segmentsAreValid({ ...run, segments: [] })).toBe(false);
    expect(segmentsAreValid({ ...run, endedAt: run.startedAt - 1 })).toBe(false);
  });

  it('flags end times in the future relative to the server clock', () => {
    const run = steadyRun(T0, 1500, 500);
    const v = validate(run, run.endedAt - 10 * 60_000);
    expect(v.reasons).toEqual(['future_timestamp']);
    expect(v.outcome).toBe('personal_only');
  });

  it('holds runs first received more than 72 hours after they ended', () => {
    const run = steadyRun(T0, 1500, 500);
    expect(validate(run, run.endedAt + 72 * 3600_000).outcome).toBe('accepted');
    const late = validate(run, run.endedAt + 72 * 3600_000 + 1);
    expect(late).toMatchObject({ outcome: 'review', reasons: ['late_upload'] });
  });

  it('skips server-only checks on the device', () => {
    const run = steadyRun(T0, 1500, 500);
    expect(validate(run, null).outcome).toBe('accepted');
  });

  it('computes live distance incrementally with the same rules', () => {
    const run = steadyRun(T0, 1500, 500);
    const track = new SegmentTrack(run.startedAt);
    for (const p of run.points) track.push(p);
    const batch = validate(run);
    expect(track.distanceM).toBeCloseTo(batch.distanceM, 9);
    expect(track.lastAnchor?.t).toBe(run.endedAt);
    expect(CHICAGO_LAKEFRONT.lat).toBeCloseTo(41.878, 2);
  });
});
