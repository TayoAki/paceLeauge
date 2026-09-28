import type { ChallengeMetric, ChallengeState } from '@/api/challenge-schemas';
import { addDays, competitionDate, parseIsoDate } from '@/domain/calendar';

/**
 * Words and numbers for challenges (docs/ROADMAP.md 4.6). The server decides progress and
 * completion; this file only says them. Dates are competition dates ("2026-10-01"), shown as
 * calendar dates with no time-zone shift.
 */

function utc(date: string): Date {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** "Oct 12". */
export function dayLabel(date: string): string {
  return utc(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Oct 12, 2026". */
export function fullDayLabel(date: string): string {
  return utc(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** "October". */
export function monthLabel(startsOn: string): string {
  return utc(startsOn).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** Whole days from `from` to `to` (both competition dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);
}

/** Today in the league time zone, the calendar challenges use. */
export function challengeToday(now: number): string {
  return competitionDate(now);
}

export function unit(metric: ChallengeMetric, n: number): string {
  if (metric === 'active_days') return n === 1 ? 'day' : 'days';
  return n === 1 ? 'point' : 'points';
}

/** "5 of 12 days", "412 of 750 points". */
export function progressLabel(metric: ChallengeMetric, progress: number, target: number): string {
  return `${Math.min(progress, target).toLocaleString('en-US')} of ${target.toLocaleString('en-US')} ${unit(metric, target)}`;
}

export function progressFraction(progress: number, target: number): number {
  return target > 0 ? Math.max(0, Math.min(1, progress / target)) : 0;
}

/** What the challenge asks, in a sentence. */
export function goalLine(metric: ChallengeMetric, target: number): string {
  return metric === 'active_days'
    ? `Run on ${target} different days. A day counts with at least 1 km and 5 minutes of running.`
    : `Reach ${target.toLocaleString('en-US')} points. Each week your best three days count, up to 125 points a day.`;
}

/** Why one huge run or many short ones don't win it. */
export function fairnessLine(metric: ChallengeMetric): string {
  return metric === 'active_days'
    ? 'Only the days count, not the distance: a long run is still one day, and several runs on the same day are one day.'
    : 'A day tops out at 125 points (10 km plus the active-day bonus), and runs on the same day are added up first, so one huge run or many short ones can’t win it.';
}

/** When it runs, relative to today. */
export function stateLine(state: ChallengeState, startsOn: string, endsOn: string, today: string): string {
  if (state === 'upcoming') {
    const days = daysBetween(today, startsOn);
    return days <= 1 ? `Starts ${days <= 0 ? 'today' : 'tomorrow'}, ${dayLabel(startsOn)}` : `Starts ${dayLabel(startsOn)}, in ${days} days`;
  }
  if (state === 'open') {
    const left = daysBetween(today, endsOn);
    if (left <= 0) return 'Last day today';
    return `Ends ${dayLabel(endsOn)} · ${left + 1} days left`;
  }
  if (state === 'closing') return `Ended ${dayLabel(endsOn)} · runs from the last day can still arrive until tomorrow`;
  return `Ended ${dayLabel(endsOn)}`;
}

export interface TargetRange {
  min: number;
  max: number;
  step: number;
  presets: number[];
}

/** What the server accepts for a month of `daysInMonth` days (db/migrations/20261003000300_challenges.sql). */
export function targetRange(metric: ChallengeMetric, daysInMonth: number): TargetRange {
  if (metric === 'active_days') {
    return { min: 2, max: daysInMonth, step: 1, presets: [8, 12, 16, 20].filter((n) => n <= daysInMonth) };
  }
  return { min: 100, max: 1500, step: 50, presets: [300, 500, 750, 1000] };
}

export function clampTarget(metric: ChallengeMetric, daysInMonth: number, value: number): number {
  const { min, max, step } = targetRange(metric, daysInMonth);
  const stepped = Math.round(value / step) * step;
  return Math.max(min, Math.min(max, stepped));
}

/** The first day of this month (0) or next (1) in the league time zone, and its length. */
export function challengeMonth(now: number, offset: 0 | 1): { startsOn: string; days: number } {
  const { year, month } = parseIsoDate(challengeToday(now));
  const first = new Date(Date.UTC(year, month - 1 + offset, 1));
  const startsOn = first.toISOString().slice(0, 10);
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return { startsOn, days: daysBetween(startsOn, next) };
}

/** The title the server gives a challenge without a name of its own. */
export function defaultTitle(metric: ChallengeMetric, target: number, startsOn: string): string {
  return metric === 'active_days' ? `Run ${target} days in ${monthLabel(startsOn)}` : `Score ${target} in ${monthLabel(startsOn)}`;
}

/** The last day of the month that starts on `startsOn`. */
export function monthEnd(startsOn: string): string {
  const { year, month } = parseIsoDate(startsOn);
  return addDays(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10), -1);
}
