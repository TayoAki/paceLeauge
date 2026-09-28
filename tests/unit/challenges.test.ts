import {
  challengeMonth,
  clampTarget,
  dayLabel,
  daysBetween,
  fullDayLabel,
  defaultTitle,
  goalLine,
  monthEnd,
  monthLabel,
  progressFraction,
  progressLabel,
  stateLine,
  targetRange,
} from '@/features/challenges/challenge-text';

/** Challenge copy and goal limits (docs/ROADMAP.md 4.6), matching db/migrations/20261003000300_challenges.sql. */
describe('challenge text', () => {
  it('shows dates as calendar dates and months by name', () => {
    expect(dayLabel('2026-10-01')).toBe('Oct 1');
    expect(fullDayLabel('2026-10-01')).toBe('Oct 1, 2026');
    expect(monthLabel('2026-10-01')).toBe('October');
    expect(daysBetween('2026-10-29', '2026-10-31')).toBe(2);
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1); // across the end of daylight saving time
    expect(monthEnd('2026-02-01')).toBe('2026-02-28');
    expect(monthEnd('2028-02-01')).toBe('2028-02-29');
    expect(monthEnd('2026-12-01')).toBe('2026-12-31');
  });

  it('names challenges the way the server does, and says their progress', () => {
    expect(defaultTitle('active_days', 12, '2026-10-01')).toBe('Run 12 days in October');
    expect(defaultTitle('capped_score', 750, '2026-10-01')).toBe('Score 750 in October');
    expect(progressLabel('active_days', 5, 12)).toBe('5 of 12 days');
    expect(progressLabel('capped_score', 1250, 1000)).toBe('1,000 of 1,000 points');
    expect(progressFraction(5, 12)).toBeCloseTo(5 / 12);
    expect(progressFraction(20, 12)).toBe(1);
    expect(goalLine('active_days', 1)).toContain('1 km and 5 minutes');
  });

  it('says when a challenge runs', () => {
    expect(stateLine('upcoming', '2026-11-01', '2026-11-30', '2026-10-28')).toBe('Starts Nov 1, in 4 days');
    expect(stateLine('upcoming', '2026-11-01', '2026-11-30', '2026-10-31')).toBe('Starts tomorrow, Nov 1');
    expect(stateLine('open', '2026-10-01', '2026-10-31', '2026-10-29')).toBe('Ends Oct 31 · 3 days left');
    expect(stateLine('open', '2026-10-01', '2026-10-31', '2026-10-31')).toBe('Last day today');
    expect(stateLine('final', '2026-10-01', '2026-10-31', '2026-11-05')).toBe('Ended Oct 31');
  });

  it('keeps goals within what the server accepts', () => {
    expect(targetRange('active_days', 30)).toMatchObject({ min: 2, max: 30, step: 1, presets: [8, 12, 16, 20] });
    expect(targetRange('capped_score', 28)).toMatchObject({ min: 100, max: 1500, step: 50 });
    expect(clampTarget('active_days', 28, 31)).toBe(28);
    expect(clampTarget('active_days', 30, 1)).toBe(2);
    expect(clampTarget('capped_score', 31, 777)).toBe(800);
    expect(clampTarget('capped_score', 31, 20)).toBe(100);
    expect(clampTarget('capped_score', 31, 9000)).toBe(1500);
  });

  it('finds this month and next in the league time zone', () => {
    // 2026-10-31 23:30 in Chicago is already November in UTC.
    const lateOctober = Date.parse('2026-11-01T04:30:00Z');
    expect(challengeMonth(lateOctober, 0)).toEqual({ startsOn: '2026-10-01', days: 31 });
    expect(challengeMonth(lateOctober, 1)).toEqual({ startsOn: '2026-11-01', days: 30 });
    expect(challengeMonth(Date.parse('2026-12-15T12:00:00Z'), 1)).toEqual({ startsOn: '2027-01-01', days: 31 });
  });
});
