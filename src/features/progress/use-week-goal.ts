import { useMemo } from 'react';

import type { WeekSummary } from '@/api/schemas';
import type { GoalDay } from '@/components/progress/progress-components';
import type { SavedRun } from '@/db/journal';
import { competitionDate, competitionWeekAt, weekDates } from '@/domain/calendar';
import { useLocalRuns } from '@/features/data/hooks';
import { useNow } from '@/lib/use-now';

/** Active-day minimum for the weekly goal (the server's rule). */
const GOAL_DAY_MIN_M = 1_000;
const GOAL_DAY_MIN_MS = 300_000;

/**
 * Whether an unsynced run would make its day count: a recorded run by its provisional XP, and a
 * run from another source (an import or a treadmill run, kept as history) by its size.
 */
function countsForGoal(r: SavedRun): boolean {
  if (r.origin) return (r.origin.activityType ?? 'run') === 'run' && r.distanceM >= GOAL_DAY_MIN_M && r.activeMs >= GOAL_DAY_MIN_MS;
  return (r.provisionalXp?.activeDayBonus ?? 0) > 0;
}

/**
 * The current week's day markers: server-credited active days, plus days whose only
 * qualifying run is still waiting for the server (shown as pending, never as earned).
 */
export function useWeekGoalDays(week: WeekSummary | undefined, now?: number): GoalDay[] {
  const local = useLocalRuns();
  const clock = useNow(60_000);
  const at = now ?? clock;
  return useMemo(() => {
    const current = competitionWeekAt(at);
    const dates = week?.week_start === current.weekStart ? week.days.map((d) => d.date) : weekDates(current.weekStart);
    const activeByDate = new Map((week?.week_start === current.weekStart ? week.days : []).map((d) => [d.date, d.active]));
    const pendingDates = new Set(
      local
        .filter((r) => !r.deleted && r.syncState !== 'synced' && countsForGoal(r))
        .flatMap(
          (r) => r.provisionalXp?.days.filter((d) => d.after.activeDayBonus > 0).map((d) => d.competitionDate) ?? [competitionDate(r.startedAt)],
        ),
    );
    return dates.map((date) => ({
      date,
      active: activeByDate.get(date) ?? false,
      pending: pendingDates.has(date),
    }));
  }, [week, local, at]);
}
