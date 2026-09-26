import { COMPETITION_TIME_ZONE } from '@/domain/config';

/** Formats an instant in a zone, e.g. "Mon, Sep 28, 12:00 AM". */
export function formatInZone(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t);
}

/**
 * The exact close of a league week (REQ-007): in the runner's local time, plus the shared
 * competition calendar when their zone differs.
 */
export function weekStateLine(
  week: { state: 'in_progress' | 'settling' | 'final'; ends_at_ms: number; settles_at_ms: number; revision: number },
  deviceZone: string,
): string {
  const sameZone = new Intl.DateTimeFormat('en-US', { timeZone: deviceZone }).resolvedOptions().timeZone === COMPETITION_TIME_ZONE;
  const ct = sameZone ? '' : ` (${formatInZone(week.ends_at_ms, COMPETITION_TIME_ZONE)} Central)`;
  if (week.state === 'in_progress') return `Week closes ${formatInZone(week.ends_at_ms, deviceZone)}${ct}.`;
  if (week.state === 'settling') return `Week closed. Results are final ${formatInZone(week.settles_at_ms, deviceZone)}.`;
  return week.revision > 0 ? 'Final results · revised after a correction.' : 'Final results.';
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? COMPETITION_TIME_ZONE;
}
