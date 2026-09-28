import type { ActivityType, Stats } from '@/api/schemas';

/**
 * Walks, hikes, rides and other workouts (docs/ROADMAP.md 2.7): they live in the log next to runs,
 * never earn league XP, and totals keep running apart from everything else.
 */
export type ActivityFilter = ActivityType | 'all';

export const ACTIVITY_LABEL: Record<ActivityType, string> = { run: 'Run', walk: 'Walk', hike: 'Hike', ride: 'Ride', other: 'Other' };

const PLURAL: Record<ActivityType, [string, string]> = {
  run: ['run', 'runs'],
  walk: ['walk', 'walks'],
  hike: ['hike', 'hikes'],
  ride: ['ride', 'rides'],
  other: ['other workout', 'other workouts'],
};

export function activityCount(activity: ActivityType, n: number): string {
  return `${n} ${PLURAL[activity][n === 1 ? 0 : 1]}`;
}

/** Filter chips, most-used first. `all` sits where each screen wants it. */
export const ACTIVITY_FILTERS: { value: ActivityType; label: string }[] = [
  { value: 'run', label: 'Runs' },
  { value: 'walk', label: 'Walks' },
  { value: 'hike', label: 'Hikes' },
  { value: 'ride', label: 'Rides' },
  { value: 'other', label: 'Other' },
];

export interface ActivityTotals {
  count: number;
  distanceM: number;
  activeMs: number;
}

export interface RunningSplit {
  running: ActivityTotals;
  other: ActivityTotals;
  /** The other activities by type, in log order, for a short description. */
  otherKinds: { activity: ActivityType; count: number }[];
}

type ActivityRow = NonNullable<Stats['by_activity']>[number];

/** Running against everything else, from the per-activity totals. */
export function splitRunning(rows: readonly ActivityRow[]): RunningSplit {
  const empty = (): ActivityTotals => ({ count: 0, distanceM: 0, activeMs: 0 });
  const running = empty();
  const other = empty();
  const otherKinds: RunningSplit['otherKinds'] = [];
  for (const row of rows) {
    const target = row.activity === 'run' ? running : other;
    target.count += row.runs;
    target.distanceM += row.distance_m;
    target.activeMs += row.active_ms;
    if (row.activity !== 'run' && row.runs > 0) otherKinds.push({ activity: row.activity, count: row.runs });
  }
  return { running, other, otherKinds };
}

/** "3 walks, 1 hike and 2 rides". */
export function describeKinds(kinds: readonly { activity: ActivityType; count: number }[]): string {
  const parts = kinds.map((k) => activityCount(k.activity, k.count));
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
