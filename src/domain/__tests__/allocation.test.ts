import { allocateSegmentsToDays, totalsByDay } from '../allocation';
import { dailyXp } from '../scoring';
import { buildSyntheticRun, steadyRun } from '../synthetic';
import { validateRun } from '../validator';

function allocate(run: ReturnType<typeof buildSyntheticRun>) {
  const v = validateRun({ ...run, receivedAt: null });
  return { v, allocations: allocateSegmentsToDays(v.segments) };
}

describe('competition-day allocation', () => {
  it('splits a run crossing local midnight at the boundary', () => {
    // 23:50 CDT → 00:10 CDT at a steady 3 m/s.
    const start = Date.parse('2026-09-23T04:50:00Z');
    const { v, allocations } = allocate(steadyRun(start, 3600, 1200));
    expect(allocations.map((a) => a.competitionDate)).toEqual(['2026-09-22', '2026-09-23']);
    expect(allocations.map((a) => a.activeMs)).toEqual([600_000, 600_000]);
    const [tue, wed] = allocations;
    expect(Math.abs((tue?.distanceCm ?? 0) - 180_000)).toBeLessThan(100);
    expect(Math.abs((wed?.distanceCm ?? 0) - 180_000)).toBeLessThan(100);
    expect(Math.abs((tue?.distanceCm ?? 0) + (wed?.distanceCm ?? 0) - v.distanceCm)).toBeLessThanOrEqual(1);
    expect(allocations.every((a) => a.segmentStartAt === start)).toBe(true);
  });

  it('keeps a run ending exactly at midnight on one day', () => {
    const start = Date.parse('2026-09-23T04:40:00Z');
    const { allocations } = allocate(steadyRun(start, 2400, 1200));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.competitionDate).toBe('2026-09-22');
  });

  it('splits across the fall-back night using real timestamps', () => {
    // 2026-11-01 is 25 hours long in Chicago; a run from 23:30 CDT Oct 31 to 00:30 CDT Nov 1.
    const start = Date.parse('2026-11-01T04:30:00Z');
    const { allocations } = allocate(steadyRun(start, 6000, 3600));
    expect(allocations.map((a) => [a.competitionDate, a.activeMs])).toEqual([
      ['2026-10-31', 1_800_000],
      ['2026-11-01', 1_800_000],
    ]);
  });

  it('allocates each segment separately and aggregates by day', () => {
    const run = buildSyntheticRun({
      startAt: Date.parse('2026-09-21T12:00:00Z'),
      legs: [
        { kind: 'run', durationS: 600, speedMps: 3 },
        { kind: 'pause', durationS: 120 },
        { kind: 'run', durationS: 600, speedMps: 3 },
      ],
    });
    const { allocations } = allocate(run);
    expect(allocations.map((a) => a.segmentIndex)).toEqual([0, 1]);
    const monday = totalsByDay(allocations).get('2026-09-21');
    expect(monday?.activeMs).toBe(1_200_000);
    expect(dailyXp(monday?.distanceCm ?? 0, monday?.activeMs ?? 0).xp).toBe(36 + 25);
  });

  it('assigns a run to the competition day even if the phone is in another zone', () => {
    // 21:00 in Los Angeles on Tuesday is 23:00 Tuesday in Chicago; 23:30 LA is Wednesday in Chicago.
    const start = Date.parse('2026-09-23T04:30:00Z');
    const { allocations } = allocate(steadyRun(start, 1000, 300));
    expect(allocations[0]?.competitionDate).toBe('2026-09-22');
  });
});
