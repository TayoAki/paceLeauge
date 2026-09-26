import { COMPETITION_TIME_ZONE, SCORING_V1 } from './config';
import type { EpochMs, IsoDate } from './types';

/**
 * Time-zone aware calendar helpers built on Intl (available in Hermes and Node).
 * Competition days never assume 86,400 seconds: boundaries are computed from the named
 * zone, so daylight-saving weeks are 167 or 169 hours long.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(t: EpochMs, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(t))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? NaN,
    month: parts.month ?? NaN,
    day: parts.day ?? NaN,
    // Some engines render midnight as hour 24 even with h23.
    hour: (parts.hour ?? NaN) % 24,
    minute: parts.minute ?? NaN,
    second: parts.second ?? NaN,
  };
}

/** Offset of the zone from UTC at instant t, in milliseconds (local − UTC). */
export function timeZoneOffsetMs(t: EpochMs, timeZone: string): number {
  const p = zonedParts(t, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = Math.floor(t / 1000) * 1000;
  return asUtc - wholeSecond;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function isoDateFromParts(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

export function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid ISO date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Calendar date of instant t in the given zone. */
export function competitionDate(t: EpochMs, timeZone: string = COMPETITION_TIME_ZONE): IsoDate {
  const p = zonedParts(t, timeZone);
  return isoDateFromParts(p.year, p.month, p.day);
}

/** Pure calendar arithmetic on dates (no time zone involved). */
export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return isoDateFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = Monday … 6 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** Monday of the week containing `date`. */
export function weekStartOf(date: IsoDate): IsoDate {
  return addDays(date, -isoWeekday(date));
}

/**
 * First instant of `date` in the zone. Resolves via the zone offset (two passes handle
 * DST transitions). Local midnight exists in America/Chicago on every date; for zones where
 * it may not, the earliest instant with that local date is returned.
 */
export function startOfDay(date: IsoDate, timeZone: string = COMPETITION_TIME_ZONE): EpochMs {
  const { year, month, day } = parseIsoDate(date);
  const wallAsUtc = Date.UTC(year, month - 1, day);
  let t = wallAsUtc - timeZoneOffsetMs(wallAsUtc, timeZone);
  const offset = timeZoneOffsetMs(t, timeZone);
  if (wallAsUtc - offset !== t) t = wallAsUtc - offset;
  // If a DST gap swallowed midnight, step forward to the first instant of the date.
  if (competitionDate(t, timeZone) !== date) {
    const probe = t + 60 * 60_000;
    if (competitionDate(probe, timeZone) === date) {
      const p = zonedParts(probe, timeZone);
      t = probe - (p.hour * 3600 + p.minute * 60 + p.second) * 1000;
    }
  }
  return t;
}

export interface CompetitionWeek {
  weekStart: IsoDate;
  /** First instant of Monday. */
  startsAt: EpochMs;
  /** First instant of the following Monday (exclusive end). */
  endsAt: EpochMs;
  /** Scores become final at this instant. */
  settlesAt: EpochMs;
}

export function competitionWeekForDate(weekStart: IsoDate, timeZone: string = COMPETITION_TIME_ZONE): CompetitionWeek {
  const monday = weekStartOf(weekStart);
  const startsAt = startOfDay(monday, timeZone);
  const endsAt = startOfDay(addDays(monday, 7), timeZone);
  return { weekStart: monday, startsAt, endsAt, settlesAt: endsAt + SCORING_V1.settlementGraceMs };
}

export function competitionWeekAt(t: EpochMs, timeZone: string = COMPETITION_TIME_ZONE): CompetitionWeek {
  return competitionWeekForDate(weekStartOf(competitionDate(t, timeZone)), timeZone);
}

/** The seven dates of a competition week, Monday first. */
export function weekDates(weekStart: IsoDate): IsoDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}
