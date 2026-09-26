import { computeSplits } from '../splits';
import { buildSyntheticRun, steadyRun } from '../synthetic';
import { validateRun } from '../validator';

const T0 = Date.parse('2026-09-25T12:00:00Z');

function splitsFor(run: ReturnType<typeof buildSyntheticRun>, units: 'metric' | 'imperial' = 'metric') {
  const v = validateRun({ ...run, receivedAt: null });
  return computeSplits(run.segments, v.segments, units);
}

describe('splits', () => {
  it('gives 6:00/km splits for the steady fixture run and a partial last split', () => {
    const splits = splitsFor(steadyRun(T0, 5240, 1888));
    expect(splits).toHaveLength(6);
    for (const s of splits.slice(0, 5)) expect(Math.abs(s.activeMs - 360_305)).toBeLessThan(500);
    expect(splits[5]).toMatchObject({ index: 6, partial: true });
    expect(splits[5]?.distanceM).toBeCloseTo(240, 0);
  });

  it('excludes paused time from the split that spans the pause', () => {
    const run = buildSyntheticRun({
      startAt: T0,
      legs: [
        { kind: 'run', durationS: 250, speedMps: 3 },
        { kind: 'pause', durationS: 600 },
        { kind: 'run', durationS: 250, speedMps: 3 },
      ],
    });
    const [first] = splitsFor(run);
    expect(first?.distanceM).toBe(1000);
    expect(Math.abs((first?.activeMs ?? 0) - 333_333)).toBeLessThan(1500);
  });

  it('supports miles', () => {
    const splits = splitsFor(steadyRun(T0, 3300, 1200), 'imperial');
    expect(splits.map((s) => s.partial)).toEqual([false, false, true]);
  });
});
