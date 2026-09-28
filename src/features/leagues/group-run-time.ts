/**
 * Picking a group run's time without a date picker (docs/ROADMAP.md 4.1): a day from the next two
 * weeks and a time in 15-minute steps, in the phone's time zone.
 */
export const GROUP_RUN_DAYS = 14;
export const TIME_STEP_MINUTES = 15;

/** The moment for `dayOffset` days from `now`'s date at `minutes` past local midnight. */
export function groupRunStart(now: number, dayOffset: number, minutes: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, Math.floor(minutes / 60), minutes % 60).getTime();
}

export function dayLabel(now: number, dayOffset: number): string {
  if (dayOffset === 0) return 'Today';
  if (dayOffset === 1) return 'Tomorrow';
  return new Date(groupRunStart(now, dayOffset, 12 * 60)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Where a saved start falls in the picker (its day and minutes), or null beyond the two weeks. */
export function pickerPosition(now: number, startsAtMs: number): { dayOffset: number; minutes: number } | null {
  const start = new Date(startsAtMs);
  for (let day = 0; day < GROUP_RUN_DAYS; day++) {
    const midnight = groupRunStart(now, day, 0);
    const next = groupRunStart(now, day + 1, 0);
    if (startsAtMs >= midnight && startsAtMs < next) return { dayOffset: day, minutes: start.getHours() * 60 + start.getMinutes() };
  }
  return null;
}

export function clockLabel(minutes: number, uses24h: boolean): string {
  const hour = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, '0');
  return uses24h ? `${String(hour).padStart(2, '0')}:${mm}` : `${hour % 12 === 0 ? 12 : hour % 12}:${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function whenLabel(startsAtMs: number, now: number, uses24h: boolean): string {
  const position = pickerPosition(now, startsAtMs);
  const start = new Date(startsAtMs);
  const time = clockLabel(start.getHours() * 60 + start.getMinutes(), uses24h);
  if (position) return `${dayLabel(now, position.dayOffset)}, ${time}`;
  return `${start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}
