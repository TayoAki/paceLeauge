import { formatInZone, weekStateLine } from '@/features/leagues/week-copy';

describe('league week copy', () => {
  const week = {
    state: 'in_progress' as const,
    ends_at_ms: Date.parse('2026-09-28T05:00:00Z'),
    settles_at_ms: Date.parse('2026-09-29T05:00:00Z'),
    revision: 0,
  };

  it('states the exact close in local time and in the competition zone', () => {
    expect(weekStateLine(week, 'America/Chicago')).toBe('Week closes Mon, Sep 28, 12:00 AM.');
    expect(weekStateLine(week, 'America/Los_Angeles')).toBe('Week closes Sun, Sep 27, 10:00 PM (Mon, Sep 28, 12:00 AM Central).');
  });

  it('handles the fall-back week and settled states', () => {
    expect(formatInZone(Date.parse('2026-11-02T06:00:00Z'), 'America/Chicago')).toBe('Mon, Nov 2, 12:00 AM');
    expect(weekStateLine({ ...week, state: 'settling' }, 'America/Chicago')).toBe('Week closed. Results are final Tue, Sep 29, 12:00 AM.');
    expect(weekStateLine({ ...week, state: 'final', revision: 1 }, 'America/Chicago')).toBe('Final results · revised after a correction.');
  });
});
