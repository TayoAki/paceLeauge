import { applyEdit, findStops, previewEdit } from '../run-fix';
import { buildSyntheticRun, steadyRun } from '../synthetic';

const T0 = Date.UTC(2026, 8, 20, 12);
const MIN = 60_000;

/** One segment with a two-minute stop in the middle (the runner waited at a crossing). */
function runWithStop() {
  const built = buildSyntheticRun({
    startAt: T0,
    legs: [
      { kind: 'run', durationS: 600, speedMps: 3 },
      { kind: 'run', durationS: 120, speedMps: 0 },
      { kind: 'run', durationS: 600, speedMps: 3 },
    ],
  });
  const points = built.points.map((p) => ({ ...p, segmentIndex: 0 }));
  return { segments: [{ index: 0, startAt: built.startedAt, endAt: built.endedAt }], points };
}

describe('fix a run', () => {
  it('trims to the kept window and cuts ranges into separate segments', () => {
    const run = steadyRun(T0, 6_000, 1_800);
    const edited = applyEdit(run.segments, run.points, {
      keepFromMs: T0 + 2 * MIN,
      keepToMs: T0 + 25 * MIN,
      cutRanges: [{ fromMs: T0 + 10 * MIN, toMs: T0 + 12 * MIN }],
    });
    expect(edited?.segments).toEqual([
      { index: 0, startAt: T0 + 2 * MIN, endAt: T0 + 10 * MIN },
      { index: 1, startAt: T0 + 12 * MIN, endAt: T0 + 25 * MIN },
    ]);
    expect(edited!.points.every((p) => (p.segmentIndex === 0 ? p.t <= T0 + 10 * MIN : p.t >= T0 + 12 * MIN))).toBe(true);
    expect(edited!.points[0]!.t).toBe(T0 + 2 * MIN);
  });

  it('refuses edits the server would refuse', () => {
    const run = steadyRun(T0, 6_000, 1_800);
    expect(applyEdit(run.segments, run.points, { keepToMs: T0 + 59_000 })).toBeNull();
    expect(applyEdit(run.segments, run.points, { keepFromMs: T0 - 1 })).toBeNull();
    expect(applyEdit(run.segments, run.points, { keepToMs: T0 + 5 * MIN, cutRanges: [{ fromMs: T0 + 4 * MIN, toMs: T0 + 6 * MIN }] })).toBeNull();
    expect(applyEdit(run.segments, run.points, { cutRanges: [{ fromMs: T0, toMs: T0 + 1_800_000 }] })).toBeNull();
  });

  it('previews the distance a trim leaves', () => {
    const run = steadyRun(T0, 12_000, 3_600);
    const preview = previewEdit(run.segments, run.points, { keepToMs: T0 + 30 * MIN });
    expect(preview?.distanceM).toBeCloseTo(6_000, -1);
    expect(preview?.activeMs).toBe(30 * MIN);
  });

  it('finds a stop and cutting it removes the standing time', () => {
    const run = runWithStop();
    const stops = findStops(run.segments, run.points);
    expect(stops).toHaveLength(1);
    const [stop] = stops;
    expect(stop!.toMs - stop!.fromMs).toBeGreaterThanOrEqual(110_000);
    expect(Math.abs(stop!.fromMs - (T0 + 600_000))).toBeLessThanOrEqual(3_000);
    expect(Math.abs(stop!.toMs - (T0 + 720_000))).toBeLessThanOrEqual(3_000);

    const whole = previewEdit(run.segments, run.points, {});
    const cut = previewEdit(run.segments, run.points, { cutRanges: stops });
    // Cutting the stop keeps (almost) all the running: at most a stride or two either side.
    expect(whole!.distanceM - cut!.distanceM).toBeLessThan(10);
    expect(whole!.activeMs - cut!.activeMs).toBe(stop!.toMs - stop!.fromMs);
  });

  it('never calls a steady jog a stop', () => {
    const run = steadyRun(T0, 2_000, 1_200);
    expect(findStops(run.segments, run.points)).toEqual([]);
  });
});
