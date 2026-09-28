import type { ServerRun } from '@/api/schemas';
import { addDays, competitionDate, weekStartOf } from '@/domain/calendar';
import type { EffortKey } from '@/domain/plans/types';
import {
  dailyLoads,
  efficiencyPoints,
  fitnessFatigue,
  hrZoneSeconds,
  observedMaxHr,
  racePredictions,
  thresholdPaceS,
  weeklyLoads,
  type Activity,
  type FitnessPoint,
  type HrSample,
} from '@/domain/training';
import type { ActiveSegment, IsoDate } from '@/domain/types';

/**
 * Training analytics from the runner's activities (docs/ROADMAP.md 3.5), worked out on the phone.
 * The loads warm up over six months, so the 12 weeks shown are settled.
 */
export const WINDOW_DAYS = 182;
export const CHART_WEEKS = 12;
/** A year earlier, whole weeks back so weekdays line up. */
export const YEAR_DAYS = 364;

export function toActivity(run: ServerRun, timeZone: string): Activity {
  return {
    startedAtMs: run.started_at_ms,
    date: competitionDate(run.started_at_ms, timeZone),
    activity: run.activity_type ?? 'run',
    activeMs: run.active_ms,
    distanceM: run.distance_m,
    avgHr: run.avg_heart_rate ?? null,
    indoor: run.indoor ?? false,
  };
}

export type MaxHrSource = 'set' | 'observed';

/** The maximum heart rate zones use: the runner's own, else the highest seen in their runs. */
export function resolveMaxHr(setting: number | null, runs: readonly Pick<ServerRun, 'max_heart_rate'>[], extra: number[] = []): { value: number; source: MaxHrSource } | null {
  if (setting) return { value: setting, source: 'set' };
  const seen = observedMaxHr([...runs.map((r) => r.max_heart_rate), ...extra]);
  return seen ? { value: seen, source: 'observed' } : null;
}

export interface TrainingSummary {
  /** Threshold pace in s/km, from recent best efforts; null judges runs by time alone. */
  thresholdS: number | null;
  current: FitnessPoint;
  /** Daily fitness and fatigue for the chart (the last 12 weeks). */
  points: FitnessPoint[];
  weeks: { monday: IsoDate; load: number }[];
  /** Load over the last 12 weeks, and the same weeks a year earlier (null when not loaded). */
  recentLoad: number;
  yearAgoLoad: number | null;
  predictions: ReturnType<typeof racePredictions>;
  efficiency: { date: IsoDate; value: number }[];
  activities: number;
}

export function trainingSummary(input: {
  today: IsoDate;
  activities: Activity[];
  yearAgo: Activity[] | null;
  best: Partial<Record<EffortKey, number>>;
  maxHr: number | null;
}): TrainingSummary {
  const { today } = input;
  const thresholdS = thresholdPaceS(input.best);
  const loads = dailyLoads(input.activities, thresholdS);
  const all = fitnessFatigue(loads, addDays(today, -WINDOW_DAYS), today);
  const points = all.slice(-CHART_WEEKS * 7);
  const thisMonday = weekStartOf(today);
  const mondays = Array.from({ length: CHART_WEEKS }, (_, i) => addDays(thisMonday, -7 * (CHART_WEEKS - 1 - i)));
  const firstDay = addDays(today, -(CHART_WEEKS * 7 - 1));
  const sumFrom = (days: Map<IsoDate, number>, from: IsoDate, to: IsoDate) => {
    let total = 0;
    for (const [date, load] of days) if (date >= from && date <= to) total += load;
    return Math.round(total);
  };
  const yearAgoLoads = input.yearAgo ? dailyLoads(input.yearAgo, thresholdS) : null;
  return {
    thresholdS,
    current: all[all.length - 1]!,
    points,
    weeks: weeklyLoads(loads, mondays).map((load, i) => ({ monday: mondays[i]!, load })),
    recentLoad: sumFrom(loads, firstDay, today),
    yearAgoLoad: yearAgoLoads ? sumFrom(yearAgoLoads, addDays(firstDay, -YEAR_DAYS), addDays(today, -YEAR_DAYS)) : null,
    predictions: racePredictions(input.best),
    efficiency: efficiencyPoints(
      input.activities.filter((a) => a.date >= firstDay),
      input.maxHr,
    ),
    activities: input.activities.filter((a) => a.date >= firstDay).length,
  };
}

export interface RunHeartRate {
  zonesS: number[];
  avgHr: number;
  peakHr: number;
}

/**
 * Zones for one run from Health's samples, counting only the active stretches. Null when there's
 * less than a minute of heart rate to go on (a watch worn loosely, or none at all).
 */
export function runHeartRate(samples: HrSample[], maxHr: number, segments: readonly ActiveSegment[]): RunHeartRate | null {
  const active = segments.map((s) => ({ startAt: s.startAt, endAt: s.endAt }));
  const inside = samples.filter((s) => active.some((a) => s.t >= a.startAt && s.t <= a.endAt) && s.bpm >= 30 && s.bpm <= 240);
  if (inside.length === 0) return null;
  const zonesS = hrZoneSeconds(inside, maxHr, active);
  if (zonesS.reduce((a, b) => a + b, 0) < 60) return null;
  return {
    zonesS,
    avgHr: Math.round(inside.reduce((sum, s) => sum + s.bpm, 0) / inside.length),
    peakHr: Math.round(Math.max(...inside.map((s) => s.bpm))),
  };
}
