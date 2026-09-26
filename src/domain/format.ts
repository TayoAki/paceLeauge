import type { Units } from './types';

export const METRES_PER_MILE = 1609.344;

export interface FormattedDistance {
  value: string;
  unit: 'km' | 'mi';
  unitLong: 'kilometers' | 'miles';
}

/** Distance is floored to 0.01 so the display never overstates completed distance. */
export function formatDistance(metres: number, units: Units): FormattedDistance {
  const perUnit = units === 'imperial' ? METRES_PER_MILE : 1000;
  const hundredths = Math.floor((Math.max(0, metres) / perUnit) * 100 + 1e-9);
  const value = (hundredths / 100).toFixed(2);
  return units === 'imperial' ? { value, unit: 'mi', unitLong: 'miles' } : { value, unit: 'km', unitLong: 'kilometers' };
}

/** 31:28, or 1:04:05 from one hour. Seconds are floored (time you have actually run). */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Average active pace in whole seconds per unit, or null below 10 m (too noisy to show). */
export function averagePaceSeconds(activeMs: number, metres: number, units: Units): number | null {
  if (metres < 10 || activeMs <= 0) return null;
  const perUnit = units === 'imperial' ? METRES_PER_MILE : 1000;
  return Math.round(activeMs / 1000 / (metres / perUnit));
}

export interface FormattedPace {
  value: string;
  unit: '/km' | '/mi';
  unitLong: 'per kilometer' | 'per mile';
}

export function formatPace(activeMs: number, metres: number, units: Units): FormattedPace {
  const seconds = averagePaceSeconds(activeMs, metres, units);
  const unit = units === 'imperial' ? ({ unit: '/mi', unitLong: 'per mile' } as const) : ({ unit: '/km', unitLong: 'per kilometer' } as const);
  if (seconds === null || seconds >= 100 * 60) return { value: '--:--', ...unit };
  return { value: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, ...unit };
}

export function formatXp(xp: number): string {
  return Math.round(xp).toLocaleString('en-US');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Screen-reader phrasing: "31 minutes 28 seconds". */
export function describeDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(plural(h, 'hour'));
  if (m > 0 || h > 0) parts.push(plural(m, 'minute'));
  parts.push(plural(s, 'second'));
  return parts.join(' ');
}

export function describeDistance(metres: number, units: Units): string {
  const d = formatDistance(metres, units);
  return `${d.value} ${d.unitLong}`;
}

export function describePace(activeMs: number, metres: number, units: Units): string {
  const seconds = averagePaceSeconds(activeMs, metres, units);
  const unit = units === 'imperial' ? 'per mile' : 'per kilometer';
  if (seconds === null) return 'Pace not available yet';
  return `${plural(Math.floor(seconds / 60), 'minute')} ${plural(seconds % 60, 'second')} ${unit}`;
}

/** Regions whose default running units are miles. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

export function defaultUnitsForRegion(regionCode: string | null | undefined): Units {
  return regionCode && IMPERIAL_REGIONS.has(regionCode.toUpperCase()) ? 'imperial' : 'metric';
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
