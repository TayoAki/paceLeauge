import { useQuery } from '@tanstack/react-query';
import { useMemo, useSyncExternalStore } from 'react';

import { addDays, competitionDate, startOfDay, weekStartOf } from '@/domain/calendar';
import { dailyAverages, sleepMinutesByNight, weeklyAverages, type HrSample, type TrendKind } from '@/domain/training';
import type { ActiveSegment, IsoDate } from '@/domain/types';
import { useAccount, useAccountServices } from '@/features/account/account-provider';
import { usePersonalRecords, useRunsBetween } from '@/features/data/hooks';
import { deviceHealthData } from '@/features/health/health-data';
import { recentBestEfforts } from '@/features/plans/plan-client';
import { deviceTimeZone } from '@/features/plans/use-plan';
import type { RunSettings } from '@/features/voice/run-settings';
import { useNow } from '@/lib/use-now';

import { CHART_WEEKS, resolveMaxHr, runHeartRate, toActivity, trainingSummary, WINDOW_DAYS, YEAR_DAYS } from './training-data';

export function useRunSettings(): RunSettings {
  const { runtime } = useAccountServices();
  return useSyncExternalStore(runtime.runSettings.subscribe, runtime.runSettings.getSnapshot);
}

/** Today on this phone, re-read once a minute so screens follow midnight. */
export function useToday(): IsoDate {
  return competitionDate(useNow(60_000), deviceTimeZone());
}

function windowMs(from: IsoDate, toExclusive: IsoDate): { fromMs: number; toMs: number } {
  const zone = deviceTimeZone();
  return { fromMs: startOfDay(from, zone), toMs: startOfDay(toExclusive, zone) };
}

/** Every activity from the last six months: the same request for zones, analytics and plans. */
export function useRecentActivities(enabled = true) {
  const today = useToday();
  const { fromMs, toMs } = windowMs(addDays(today, -WINDOW_DAYS), addDays(today, 1));
  return { today, query: useRunsBetween(fromMs, toMs, null, enabled) };
}

export function useMaxHr(extra: number[] = []) {
  const settings = useRunSettings();
  const { query } = useRecentActivities();
  const runs = query.data?.data;
  const extraKey = extra.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => resolveMaxHr(settings.maxHr, runs ?? [], extra), [settings.maxHr, runs, extraKey]);
}

/** Training analytics (Pro): load, fitness and fatigue, predictions and efficiency. */
export function useTraining(enabled: boolean) {
  const { today, query } = useRecentActivities(enabled);
  const records = usePersonalRecords();
  const settings = useRunSettings();
  const lastYear = windowMs(addDays(today, -(CHART_WEEKS * 7 - 1) - YEAR_DAYS), addDays(today, 1 - YEAR_DAYS));
  const yearAgo = useRunsBetween(lastYear.fromMs, lastYear.toMs, null, enabled);
  const runs = query.data?.data;
  const oldRuns = yearAgo.data?.data;
  const recordData = records.data?.data ?? null;
  const summary = useMemo(() => {
    if (!runs) return null;
    const zone = deviceTimeZone();
    const maxHr = resolveMaxHr(settings.maxHr, runs)?.value ?? null;
    return trainingSummary({
      today,
      activities: runs.map((r) => toActivity(r, zone)),
      yearAgo: oldRuns ? oldRuns.map((r) => toActivity(r, zone)) : null,
      best: recentBestEfforts(recordData, startOfDay(today, zone)),
      maxHr,
    });
  }, [runs, oldRuns, recordData, settings.maxHr, today]);
  return {
    summary,
    records: recordData,
    isPending: query.isPending,
    isError: query.isError && !runs,
    offline: query.data?.source === 'cache',
    refetch: () => Promise.all([query.refetch(), yearAgo.refetch(), records.refetch()]),
  };
}

/** Heart rate for one run from Apple Health, while heart-rate zones are switched on. */
export function useRunHeartRate(run: { key: string; segments: readonly ActiveSegment[] } | null) {
  const { state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const settings = useRunSettings();
  const port = deviceHealthData();
  const segments = run?.segments ?? [];
  const startMs = segments[0]?.startAt ?? 0;
  const endMs = segments[segments.length - 1]?.endAt ?? 0;
  const enabled = !!port && settings.heartRateZones && !!run && endMs > startMs;
  const samples = useQuery<HrSample[]>({
    queryKey: [accountId, 'hr-samples', run?.key ?? '', startMs, endMs],
    enabled,
    staleTime: Infinity,
    queryFn: () => port!.heartRate(startMs, endMs),
  });
  const peaks = samples.data?.length ? [Math.max(...samples.data.map((s) => s.bpm))] : [];
  const maxHr = useMaxHr(peaks);
  const zones = useMemo(
    () => (samples.data && maxHr ? runHeartRate(samples.data, maxHr.value, segments) : null),
    // Segments come from the run; its key and span identify them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [samples.data, maxHr, startMs, endMs],
  );
  return { available: !!port, enabled, loading: enabled && samples.isPending, zones, maxHr, hasSamples: (samples.data?.length ?? 0) > 0 };
}

export interface HealthTrends {
  mondays: IsoDate[];
  weeks: Record<TrendKind, (number | null)[]>;
}

/** Pro: weekly averages of Apple Health's trend readings, while the switch is on. */
export function useHealthTrends(enabled: boolean) {
  const { state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const today = useToday();
  const port = deviceHealthData();
  return useQuery<HealthTrends>({
    queryKey: [accountId, 'health-trends', today],
    enabled: enabled && !!port,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const zone = deviceTimeZone();
      const thisMonday = weekStartOf(today);
      const mondays = Array.from({ length: CHART_WEEKS }, (_, i) => addDays(thisMonday, -7 * (CHART_WEEKS - 1 - i)));
      const fromMs = startOfDay(mondays[0]!, zone) - 86_400_000;
      const toMs = startOfDay(addDays(today, 1), zone);
      const dateOf = (t: number) => competitionDate(t, zone);
      const [restingHr, hrv, vo2max, sleep] = await Promise.all([
        port!.trend('restingHr', fromMs, toMs).catch(() => []),
        port!.trend('hrv', fromMs, toMs).catch(() => []),
        port!.trend('vo2max', fromMs, toMs).catch(() => []),
        port!.sleep(fromMs, toMs).catch(() => []),
      ]);
      return {
        mondays,
        weeks: {
          restingHr: weeklyAverages(dailyAverages(restingHr, dateOf), mondays),
          hrv: weeklyAverages(dailyAverages(hrv, dateOf), mondays),
          vo2max: weeklyAverages(dailyAverages(vo2max, dateOf), mondays),
          sleep: weeklyAverages(sleepMinutesByNight(sleep, dateOf), mondays),
        },
      };
    },
  });
}
