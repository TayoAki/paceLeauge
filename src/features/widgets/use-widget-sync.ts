import { useEffect } from 'react';
import { Platform } from 'react-native';

import { useLeague, useWeek } from '@/features/data/hooks';

import { widgetWeekFrom, writeWidgetWeek } from './widget-data';

/** Keeps the "this week" widget in step with the week and league the app last loaded. */
export function useWidgetSync(): void {
  const week = useWeek();
  const league = useLeague(0);
  const weekData = week.data?.data;
  const leagueData = league.data?.data ?? null;
  useEffect(() => {
    if (Platform.OS !== 'ios' || !weekData) return;
    writeWidgetWeek(widgetWeekFrom(weekData, leagueData, Date.now()));
  }, [weekData, leagueData]);
}
