import { addDays } from './calendar';
import { EFFORT_DISTANCE_M, fitness5kS, HR_ZONE_FRACTIONS, riegel } from './plans/paces';
import type { EffortKey } from './plans/types';
import type { IsoDate } from './types';

/**
 * Training data (docs/ROADMAP.md 3.5), computed on the phone from the runner's own activities.
 * The definitions below are what the app shows beside each number; they describe training, not
 * health.
 */

export const DEFINITIONS = {
  load: 'Training load scores each workout by how long and how hard it was. An hour at the pace you could hold for about an hour of racing scores 100.',
  fitness: 'Fitness is your average daily load over the last 6 weeks. It rises slowly with steady training.',
  fatigue: 'Fatigue is your average daily load over the last week. It rises quickly after hard days and falls with rest.',
  form: 'Form is fitness minus fatigue. Below zero, you’re carrying tiredness; well above zero, you’re fresh.',
  prediction: 'Race predictions use Riegel’s formula on your best recent effort of a mile or more. They assume training for the distance.',
  efficiency: 'Aerobic efficiency is how far you run per heartbeat on easy runs. It rises as your aerobic fitness improves.',
  zones: 'Heart-rate zones split a run by the share of your maximum heart rate: 1 very easy, 2 easy, 3 steady, 4 hard, 5 very hard.',
  restingHr: 'Resting heart rate is your watch’s daily estimate of your heart rate at rest. It often drifts down as fitness builds.',
  hrv: 'Heart rate variability is how much the time between heartbeats varies, as your watch measures it. Compare it with your own usual range, not other people’s.',
  vo2max: 'VO2 max is your watch’s estimate of your aerobic capacity, usually from outdoor walks and runs.',
  sleep: 'Sleep is the time your watch or phone recorded you asleep each night, averaged over the week.',
} as const;

export type ActivityKind = 'run' | 'walk' | 'hike' | 'ride' | 'other';

export interface Activity {
  startedAtMs: number;
  date: IsoDate;
  activity: ActivityKind;
  activeMs: number;
  distanceM: number;
  avgHr: number | null;
  indoor?: boolean;
}

/** Intensity for activities without a pace to judge: relative to threshold effort. */
const DEFAULT_INTENSITY: Record<ActivityKind, number> = { run: 0.75, walk: 0.5, hike: 0.6, ride: 0.65, other: 0.65 };

/** The pace you could hold for about an hour: roughly Riegel from 5K to 60 minutes. */
export function thresholdPaceS(best: Partial<Record<EffortKey, number>>): number | null {
  const fiveK = fitness5kS(best);
  if (fiveK === null) return null;
  // Distance run in an hour at this fitness, by Riegel, then its pace.
  const hourM = 5000 * Math.pow(3600 / fiveK, 1 / 1.06);
  return 3600 / (hourM / 1000);
}

/**
 * Load for one activity: minutes × intensity² × 100/60, so an hour at threshold scores 100.
 * Runs with a distance are judged by pace against threshold; everything else by type.
 */
export function activityLoad(a: Activity, thresholdSPerKm: number | null): number {
  const minutes = a.activeMs / 60_000;
  if (minutes <= 0) return 0;
  let intensity = DEFAULT_INTENSITY[a.activity];
  if (a.activity === 'run' && thresholdSPerKm && a.distanceM > 200 && !a.indoor) {
    const paceS = a.activeMs / 1000 / (a.distanceM / 1000);
    intensity = Math.min(1.2, Math.max(0.5, thresholdSPerKm / paceS));
  }
  return Math.round(minutes * intensity * intensity * (100 / 60) * 10) / 10;
}

export function dailyLoads(activities: Activity[], thresholdSPerKm: number | null): Map<IsoDate, number> {
  const days = new Map<IsoDate, number>();
  for (const a of activities) days.set(a.date, (days.get(a.date) ?? 0) + activityLoad(a, thresholdSPerKm));
  return days;
}

export interface FitnessPoint {
  date: IsoDate;
  load: number;
  fitness: number;
  fatigue: number;
  form: number;
}

/**
 * Fitness (42-day) and fatigue (7-day) as exponentially weighted daily averages, from `from` to
 * `to`. Start `from` well before the dates you show: the averages need weeks to settle.
 */
export function fitnessFatigue(loads: Map<IsoDate, number>, from: IsoDate, to: IsoDate): FitnessPoint[] {
  const out: FitnessPoint[] = [];
  let fitness = 0;
  let fatigue = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const load = loads.get(d) ?? 0;
    // Form is yesterday's balance: what you bring into the day.
    const form = fitness - fatigue;
    fitness += (load - fitness) / 42;
    fatigue += (load - fatigue) / 7;
    out.push({ date: d, load, fitness: round1(fitness), fatigue: round1(fatigue), form: round1(form) });
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export type FormLabel = 'fresh' | 'ready' | 'building' | 'tired';

export function formLabel(form: number): FormLabel {
  if (form > 10) return 'fresh';
  if (form > -5) return 'ready';
  if (form > -25) return 'building';
  return 'tired';
}

export type RaceKey = '5k' | '10k' | 'half' | 'marathon';
export const RACE_KEYS: RaceKey[] = ['5k', '10k', 'half', 'marathon'];

/**
 * Race times from the best recent effort, and which effort they come from: the one that predicts
 * the fastest 5K, as plans use (`fitness5kS`).
 */
export function racePredictions(best: Partial<Record<EffortKey, number>>): { basedOn: EffortKey; times: Record<RaceKey, number> } | null {
  const fiveK = fitness5kS(best);
  if (fiveK === null) return null;
  let basedOn: EffortKey | null = null;
  let fastest = Infinity;
  for (const [key, timeS] of Object.entries(best) as [EffortKey, number | undefined][]) {
    if (!timeS || timeS <= 0 || key === '1k') continue;
    const predicted = riegel(timeS, EFFORT_DISTANCE_M[key], 5000);
    if (predicted < fastest) {
      fastest = predicted;
      basedOn = key;
    }
  }
  const times = Object.fromEntries(RACE_KEYS.map((key) => [key, Math.round(riegel(fiveK, 5000, EFFORT_DISTANCE_M[key]))])) as Record<RaceKey, number>;
  return { basedOn: basedOn!, times };
}

/**
 * Aerobic efficiency for easy runs with heart rate: metres per heartbeat. Hard runs are left out
 * (they'd mix effort into it), as are runs without a distance.
 */
export function efficiencyPoints(activities: Activity[], maxHr: number | null): { date: IsoDate; value: number }[] {
  return activities
    .filter((a) => a.activity === 'run' && a.avgHr && a.distanceM > 1000 && !a.indoor && a.activeMs > 10 * 60_000)
    .filter((a) => !maxHr || a.avgHr! <= maxHr * 0.8)
    .map((a) => ({ date: a.date, value: Math.round((a.distanceM / (a.activeMs / 60_000) / a.avgHr!) * 100) / 100 }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The highest heart rate seen in the runner's activities: a floor for their maximum. */
export function observedMaxHr(maxes: (number | null | undefined)[]): number | null {
  const seen = maxes.filter((m): m is number => typeof m === 'number' && m >= 120 && m <= 230);
  return seen.length ? Math.max(...seen) : null;
}

export interface HrSample {
  t: number;
  bpm: number;
}

/**
 * Seconds in each of the five zones. Each sample holds until the next (up to 30 s, so a gap in
 * the recording isn't counted), and only time inside the run's active stretches counts.
 */
export function hrZoneSeconds(samples: HrSample[], maxHr: number, active: { startAt: number; endAt: number }[]): number[] {
  const zones = [0, 0, 0, 0, 0];
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const overlap = (from: number, to: number) =>
    active.reduce((sum, s) => sum + Math.max(0, Math.min(to, s.endAt) - Math.max(from, s.startAt)), 0);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    // The last sample holds to the end of the run, within the same limit.
    const next = sorted[i + 1]?.t ?? Infinity;
    const ms = overlap(s.t, Math.min(next, s.t + 30_000));
    if (ms <= 0) continue;
    const fraction = s.bpm / maxHr;
    let zone = HR_ZONE_FRACTIONS.findIndex(([lo, hi]) => fraction >= lo && fraction < hi);
    if (zone < 0) zone = fraction < HR_ZONE_FRACTIONS[0]![0] ? 0 : 4;
    zones[zone]! += ms / 1000;
  }
  return zones.map((z) => Math.round(z));
}

/** Weekly load totals, Monday first. */
export function weeklyLoads(loads: Map<IsoDate, number>, mondays: IsoDate[]): number[] {
  return mondays.map((m) => {
    let total = 0;
    for (let d = 0; d < 7; d++) total += loads.get(addDays(m, d)) ?? 0;
    return Math.round(total);
  });
}

// ---------------------------------------------------------------------------------------------
// Health trends (Pro, iOS): read from Apple Health on the phone and never sent to the server.

export type TrendKind = 'restingHr' | 'hrv' | 'vo2max' | 'sleep';

export interface TrendSample {
  /** When the reading was taken (its start). */
  t: number;
  value: number;
}

/** One value per day: the day's average (Health can hold several readings, from several sources). */
export function dailyAverages(samples: TrendSample[], dateOf: (t: number) => IsoDate): Map<IsoDate, number> {
  const sums = new Map<IsoDate, { total: number; n: number }>();
  for (const s of samples) {
    if (!Number.isFinite(s.value) || s.value <= 0) continue;
    const date = dateOf(s.t);
    const cur = sums.get(date) ?? { total: 0, n: 0 };
    sums.set(date, { total: cur.total + s.value, n: cur.n + 1 });
  }
  return new Map([...sums].map(([date, { total, n }]) => [date, total / n]));
}

export interface SleepSample {
  startMs: number;
  endMs: number;
  /** Apple Health's sleep value: 0 in bed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM. */
  value: number;
}

const STAGES = new Set([3, 4, 5]);
/** A night runs from 6 pm to 6 pm, so sleep either side of midnight lands on the same morning. */
const NIGHT_SHIFT_MS = 6 * 3_600_000;

/**
 * Minutes asleep per night, credited to the morning you woke up. When a night has sleep stages
 * (from a watch), only the stages count, so the phone's rougher estimate of the same night doesn't
 * cover the time the watch saw you awake. Overlapping stretches are merged before adding up; time
 * in bed or awake never counts.
 */
export function sleepMinutesByNight(samples: SleepSample[], dateOf: (t: number) => IsoDate): Map<IsoDate, number> {
  const byNight = new Map<IsoDate, SleepSample[]>();
  for (const s of samples) {
    if (s.endMs <= s.startMs || !(s.value === 1 || STAGES.has(s.value))) continue;
    const night = dateOf(s.endMs + NIGHT_SHIFT_MS);
    byNight.set(night, [...(byNight.get(night) ?? []), s]);
  }
  const nights = new Map<IsoDate, number>();
  for (const [night, list] of byNight) {
    const staged = list.some((s) => STAGES.has(s.value));
    const asleep = list.filter((s) => (staged ? STAGES.has(s.value) : s.value === 1)).sort((a, b) => a.startMs - b.startMs);
    let total = 0;
    let open: { startMs: number; endMs: number } | null = null;
    for (const s of asleep) {
      if (open && s.startMs <= open.endMs) open.endMs = Math.max(open.endMs, s.endMs);
      else {
        if (open) total += open.endMs - open.startMs;
        open = { startMs: s.startMs, endMs: s.endMs };
      }
    }
    if (open) total += open.endMs - open.startMs;
    nights.set(night, Math.round(total / 60_000));
  }
  return nights;
}

/** The average of each week's daily values, Monday first; null for a week without any. */
export function weeklyAverages(days: Map<IsoDate, number>, mondays: IsoDate[]): (number | null)[] {
  return mondays.map((m) => {
    let total = 0;
    let n = 0;
    for (let d = 0; d < 7; d++) {
      const v = days.get(addDays(m, d));
      if (v !== undefined) {
        total += v;
        n += 1;
      }
    }
    return n > 0 ? total / n : null;
  });
}

/**
 * The change between the first and last weeks that have a value, for a one-line summary. Null
 * until there are two weeks to compare.
 */
export function trendChange(weeks: (number | null)[]): { from: number; to: number } | null {
  const present = weeks.filter((w): w is number => w !== null);
  if (present.length < 2) return null;
  return { from: present[0]!, to: present[present.length - 1]! };
}
