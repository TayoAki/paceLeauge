import { useMemo } from 'react';

import type { WeekSummary } from '@/api/schemas';
import type { GoalDay } from '@/components/progress/progress-components';
import { competitionDate, competitionWeekAt, weekDates } from '@/domain/calendar';
import { useLocalRuns } from '@/features/data/hooks';
import { useNow } from '@/lib/use-now';

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
        .filter((r) => !r.deleted && r.syncState !== 'synced' && (r.provisionalXp?.activeDayBonus ?? 0) > 0)
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
