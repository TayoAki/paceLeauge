import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { LeagueView, WeekSummary } from '@/api/schemas';

/**
 * Numbers for the "this week" widget (docs/ROADMAP.md 1.11), written to the App Group the widget
 * extension reads (targets/widgets/WeekWidget.swift). Written after every load of the week and the
 * league, which includes right after a run syncs, and cleared on sign-out.
 */
export interface WidgetWeek {
  activeDays: number;
  goalDays: number | null;
  weeklyXp: number;
  weekEndsAtMs: number;
  leagueName: string | null;
  rank: number | null;
  members: number | null;
  updatedAtMs: number;
}

export const WIDGET_WEEK_KEY = 'paceleague.week';
export const WEEK_WIDGET_KIND = 'PaceLeagueWeek';

export function widgetWeekFrom(week: WeekSummary, league: LeagueView | null, now: number): WidgetWeek {
  const member = league?.league && league.me && !league.me.hidden ? league.me : null;
  return {
    activeDays: week.active_days,
    goalDays: week.goal_days,
    weeklyXp: week.weekly_xp,
    weekEndsAtMs: week.ends_at_ms,
    leagueName: league?.league?.name ?? null,
    rank: member?.rank ?? null,
    members: league?.league?.member_count ?? null,
    updatedAtMs: now,
  };
}

interface Storage {
  set(key: string, value: string | undefined): void;
}

interface StorageClass {
  new (appGroup: string): Storage;
  reloadWidget(name?: string): void;
}

let storage: { instance: Storage; reload: (kind: string) => void } | null | undefined;

function sharedStorage(): typeof storage {
  if (storage !== undefined) return storage;
  const appGroup = (Constants.expoConfig?.extra as { appGroup?: string | null } | undefined)?.appGroup ?? null;
  storage = null;
  if (Platform.OS !== 'ios' || !appGroup) return storage;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ExtensionStorage } = require('@bacons/apple-targets') as { ExtensionStorage: StorageClass };
    storage = { instance: new ExtensionStorage(appGroup), reload: (kind) => ExtensionStorage.reloadWidget(kind) };
  } catch {
    storage = null;
  }
  return storage;
}

/** Publishes the week to the widget (null clears it, e.g. on sign-out). */
export function writeWidgetWeek(data: WidgetWeek | null): void {
  const target = sharedStorage();
  if (!target) return;
  try {
    target.instance.set(WIDGET_WEEK_KEY, data ? JSON.stringify(data) : undefined);
    target.reload(WEEK_WIDGET_KIND);
  } catch {
    // The widget is a convenience; never let it disturb the app.
  }
}
