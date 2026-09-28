import type { SegmentLegend, SegmentSurface } from '@/api/segments-api';
import { formatDuration, formatPace } from '@/domain/format';
import type { Units } from '@/domain/types';
import { routeDistance } from '@/features/routes/route-text';

/**
 * Words for segments (docs/ROADMAP.md 5.3). The server matches runs and keeps the boards; this
 * file only says what they show.
 */

/** A time on a segment, to the nearest second: "3:20", "1:02:05". */
export function formatElapsed(ms: number): string {
  return formatDuration(Math.round(ms / 1000) * 1000);
}

export const SURFACE_NAMES: Record<SegmentSurface, string> = { path: 'Path', trail: 'Trail', track: 'Track', park: 'Park' };

/** "0.8 km · Path" */
export function segmentSummary(segment: { distance_m: number; surface: SegmentSurface }, units: Units): string {
  return `${routeDistance(segment.distance_m, units)} · ${SURFACE_NAMES[segment.surface]}`;
}

/** The pace of a time on the segment: "4:10 /km". */
export function effortPace(elapsedMs: number, distanceM: number, units: Units): string {
  const pace = formatPace(elapsedMs, distanceM, units);
  return `${pace.value} ${pace.unit}`;
}

/** Days in the window the local regular is counted over (the server's legend_days). */
export const REGULAR_DAYS = 90;

/**
 * The local regular: whoever ran the segment on the most different days in the last 90 (not the
 * most times, so ten laps in one day count once).
 */
export function regularLine(regular: SegmentLegend | null): string {
  if (!regular) return `Nobody yet. Run it on more different days than anyone in ${REGULAR_DAYS} days to be the local regular.`;
  const days = `${regular.days} different ${regular.days === 1 ? 'day' : 'days'} in the last ${REGULAR_DAYS}`;
  return regular.is_me ? `You are: ${days}.` : `${regular.alias}: ${days}.`;
}

/** The runner's own days, when someone else is the regular. */
export function myDaysLine(days: number, regular: SegmentLegend | null): string | null {
  if (regular?.is_me) return null;
  if (days === 0) return null;
  return `You: ${days} ${days === 1 ? 'day' : 'days'}.`;
}

/** "Mar 4, 2027" for a time on the board. */
export function effortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
