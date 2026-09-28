import { clockLabel, dayLabel, groupRunStart, pickerPosition, whenLabel } from '@/features/leagues/group-run-time';
import { recapWeek } from '@/features/leagues/recap';

/** Leagues 2.0 on the phone (docs/ROADMAP.md 4.1): picking a group run's time and the recap's week. */
describe('group run time', () => {
  // Wednesday 30 September 2026, 21:10 local time (the test runs in the process's zone).
  const now = new Date(2026, 8, 30, 21, 10).getTime();

  it('builds a start from a day and minutes past midnight, in local time', () => {
    const start = new Date(groupRunStart(now, 3, 7 * 60 + 30));
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()]).toEqual([2026, 9, 3, 7, 30]);
    expect(pickerPosition(now, start.getTime())).toEqual({ dayOffset: 3, minutes: 450 });
    expect(pickerPosition(now, groupRunStart(now, 20, 60))).toBeNull();
  });

  it('labels days and times the way the phone does', () => {
    expect(dayLabel(now, 0)).toBe('Today');
    expect(dayLabel(now, 1)).toBe('Tomorrow');
    expect(dayLabel(now, 3)).toBe('Sat, Oct 3');
    expect(clockLabel(7 * 60 + 5, false)).toBe('7:05 AM');
    expect(clockLabel(0, false)).toBe('12:00 AM');
    expect(clockLabel(18 * 60 + 30, true)).toBe('18:30');
    expect(whenLabel(groupRunStart(now, 1, 8 * 60), now, false)).toBe('Tomorrow, 8:00 AM');
  });
});

describe('weekly recap', () => {
  it('shows this week on Sunday, last week on Monday and Tuesday, and nothing midweek', () => {
    expect(recapWeek(new Date(2026, 9, 4, 18))).toBe(0); // Sunday
    expect(recapWeek(new Date(2026, 9, 5, 9))).toBe(-1); // Monday
    expect(recapWeek(new Date(2026, 9, 6, 9))).toBe(-1); // Tuesday
    expect(recapWeek(new Date(2026, 9, 7, 9))).toBeNull(); // Wednesday
  });
});
