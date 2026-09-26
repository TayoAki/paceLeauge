import {
  addDays,
  competitionDate,
  competitionWeekAt,
  competitionWeekForDate,
  isoWeekday,
  startOfDay,
  weekDates,
  weekStartOf,
} from '../calendar';

const HOUR = 3600_000;

describe('competition calendar (America/Chicago)', () => {
  it('assigns the fixture Friday run (12:00Z = 07:00 CDT) to Friday', () => {
    expect(competitionDate(Date.parse('2026-09-25T12:00:00Z'))).toBe('2026-09-25');
  });

  it('switches days at local midnight, not UTC midnight', () => {
    expect(competitionDate(Date.parse('2026-09-26T04:59:59.999Z'))).toBe('2026-09-25');
    expect(competitionDate(Date.parse('2026-09-26T05:00:00.000Z'))).toBe('2026-09-26');
    expect(competitionDate(Date.parse('2026-09-26T00:30:00Z'))).toBe('2026-09-25');
  });

  it('finds local midnight in daylight and standard time', () => {
    expect(startOfDay('2026-09-21')).toBe(Date.parse('2026-09-21T05:00:00Z'));
    expect(startOfDay('2026-12-07')).toBe(Date.parse('2026-12-07T06:00:00Z'));
  });

  it('handles the spring-forward week (167 hours)', () => {
    expect(startOfDay('2026-03-08')).toBe(Date.parse('2026-03-08T06:00:00Z'));
    expect(startOfDay('2026-03-09')).toBe(Date.parse('2026-03-09T05:00:00Z'));
    const week = competitionWeekForDate('2026-03-02');
    expect((week.endsAt - week.startsAt) / HOUR).toBe(167);
    // 01:59 CST then 03:00 CDT on 2026-03-08 are the same competition day.
    expect(competitionDate(Date.parse('2026-03-08T07:59:00Z'))).toBe('2026-03-08');
    expect(competitionDate(Date.parse('2026-03-08T08:00:00Z'))).toBe('2026-03-08');
  });

  it('handles the fall-back week (169 hours)', () => {
    expect(startOfDay('2026-11-01')).toBe(Date.parse('2026-11-01T05:00:00Z'));
    expect(startOfDay('2026-11-02')).toBe(Date.parse('2026-11-02T06:00:00Z'));
    const week = competitionWeekForDate('2026-10-26');
    expect((week.endsAt - week.startsAt) / HOUR).toBe(169);
  });

  it('computes Monday-start weeks and a 24-hour settlement', () => {
    expect(weekStartOf('2026-09-27')).toBe('2026-09-21');
    expect(weekStartOf('2026-09-21')).toBe('2026-09-21');
    expect(isoWeekday('2026-09-25')).toBe(4);
    const week = competitionWeekAt(Date.parse('2026-09-25T12:00:00Z'));
    expect(week).toEqual({
      weekStart: '2026-09-21',
      startsAt: Date.parse('2026-09-21T05:00:00Z'),
      endsAt: Date.parse('2026-09-28T05:00:00Z'),
      settlesAt: Date.parse('2026-09-29T05:00:00Z'),
    });
    expect(weekDates('2026-09-21')).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
  });

  it('does pure date arithmetic across months and years', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('ignores the device time zone: the same instant maps to the same competition day', () => {
    const instant = Date.parse('2026-09-23T03:30:00Z'); // Tue 22:30 CDT, Wed in UTC and Europe
    expect(competitionDate(instant)).toBe('2026-09-22');
    expect(competitionDate(instant, 'Europe/Berlin')).toBe('2026-09-23');
  });
});
