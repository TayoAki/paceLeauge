import { addDays, isoDateFromParts, isoWeekday, parseIsoDate, weekStartOf } from '@/domain/calendar';
import type { IsoDate } from '@/domain/types';

/**
 * Date ranges for stats (docs/ROADMAP.md 1.7) and the month grid for the run calendar (1.10).
 * Dates are competition-calendar dates (America/Chicago), the same days the server groups by.
 */
export type RangeKey = '12w' | '12m' | 'ytd' | '5y' | 'custom';
export type Bucket = 'week' | 'month' | 'year';

export interface StatsRange {
  from: IsoDate;
  to: IsoDate;
  bucket: Bucket;
}

/** The server accepts up to ten years. */
export const MAX_RANGE_DAYS = 3660;

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** A custom range picks the bucket that gives a readable number of bars. */
export function bucketForSpan(from: IsoDate, to: IsoDate): Bucket {
  const days = daysBetween(from, to);
  if (days <= 16 * 7) return 'week';
  if (days <= 731) return 'month';
  return 'year';
}

export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const { year, month, day } = parseIsoDate(text);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function rangeFor(key: RangeKey, today: IsoDate, custom?: { from: string; to: string }): StatsRange | null {
  const { year, month } = parseIsoDate(today);
  switch (key) {
    case '12w':
      return { from: addDays(weekStartOf(today), -11 * 7), to: today, bucket: 'week' };
    case '12m': {
      const first = addMonths(year, month, -11);
      return { from: isoDateFromParts(first.year, first.month, 1), to: today, bucket: 'month' };
    }
    case 'ytd':
      return { from: isoDateFromParts(year, 1, 1), to: today, bucket: 'month' };
    case '5y':
      return { from: isoDateFromParts(year - 4, 1, 1), to: today, bucket: 'year' };
    case 'custom': {
      if (!custom || !isIsoDate(custom.from) || !isIsoDate(custom.to)) return null;
      const days = daysBetween(custom.from, custom.to);
      if (days < 0 || days > MAX_RANGE_DAYS) return null;
      return { from: custom.from, to: custom.to, bucket: bucketForSpan(custom.from, custom.to) };
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function bucketLabel(start: IsoDate, bucket: Bucket): string {
  const { year, month, day } = parseIsoDate(start);
  if (bucket === 'year') return String(year);
  if (bucket === 'month') return MONTHS[month - 1]!;
  return `${MONTHS[month - 1]} ${day}`;
}

export function bucketLabelLong(start: IsoDate, bucket: Bucket): string {
  const { year, month, day } = parseIsoDate(start);
  if (bucket === 'year') return String(year);
  if (bucket === 'month') return `${MONTHS_LONG[month - 1]} ${year}`;
  return `Week of ${MONTHS_LONG[month - 1]} ${day}`;
}

export function monthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

/** Weeks of a month, Monday first; days outside the month are null. */
export function monthGrid(year: number, month: number): (IsoDate | null)[][] {
  const first = isoDateFromParts(year, month, 1);
  const next = addMonths(year, month, 1);
  const daysInMonth = daysBetween(first, isoDateFromParts(next.year, next.month, 1));
  const cells: (IsoDate | null)[] = [...Array<null>(isoWeekday(first)).fill(null)];
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(isoDateFromParts(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (IsoDate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
