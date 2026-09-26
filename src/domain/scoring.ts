import { totalsByDay, type DayAllocation, type DayTotals } from './allocation';
import { SCORING_V1, TIERS, type TierName } from './config';
import type { IsoDate } from './types';

/**
 * Score contract, version 1 (TECHNICAL_SPEC.md). Distances are integer centimetres so the
 * floor in `distance_xp = min(100, floor(D / 100 m))` is exact on every platform.
 */

export interface DailyXp {
  distanceXp: number;
  activeDayBonus: number;
  xp: number;
}

export function dailyXp(distanceCm: number, activeMs: number): DailyXp {
  const distanceXp = Math.min(SCORING_V1.maxDistanceXp, Math.floor(Math.max(0, distanceCm) / SCORING_V1.centimetresPerDistanceXp));
  const activeDayBonus =
    distanceCm >= SCORING_V1.activeDayMinDistanceCm && activeMs >= SCORING_V1.activeDayMinActiveMs ? SCORING_V1.activeDayBonusXp : 0;
  return { distanceXp, activeDayBonus, xp: distanceXp + activeDayBonus };
}

/** An "active day" is one that earned the active-day bonus (≥ 1 km and ≥ 5 min). */
export function isActiveDay(distanceCm: number, activeMs: number): boolean {
  return dailyXp(distanceCm, activeMs).activeDayBonus > 0;
}

/** Weekly league XP: the three highest daily scores of the week (maximum 375). */
export function weeklyLeagueXp(dailyScores: readonly number[]): number {
  return dailyScores
    .slice()
    .sort((a, b) => b - a)
    .slice(0, SCORING_V1.weeklyCountingDays)
    .reduce((sum, xp) => sum + xp, 0);
}

export interface TierProgress {
  tier: TierName;
  tierMinXp: number;
  nextTier: TierName | null;
  nextTierMinXp: number | null;
  xpToNextTier: number | null;
  /** In-tier progress 0…1; Elite shows a completed tier. */
  fraction: number;
}

export function tierProgress(lifetimeXp: number): TierProgress {
  const xp = Math.max(0, Math.floor(lifetimeXp));
  let index = 0;
  for (let i = 0; i < TIERS.length; i += 1) {
    if (xp >= (TIERS[i] as (typeof TIERS)[number]).minXp) index = i;
  }
  const tier = TIERS[index] as (typeof TIERS)[number];
  const next = TIERS[index + 1];
  if (!next) {
    return { tier: tier.name, tierMinXp: tier.minXp, nextTier: null, nextTierMinXp: null, xpToNextTier: null, fraction: 1 };
  }
  return {
    tier: tier.name,
    tierMinXp: tier.minXp,
    nextTier: next.name,
    nextTierMinXp: next.minXp,
    xpToNextTier: next.minXp - xp,
    fraction: (xp - tier.minXp) / (next.minXp - tier.minXp),
  };
}

export interface RankableRow {
  id: string;
  alias: string;
  xp: number;
}

/**
 * Competition ranking: tied scores share a rank (1, 2, 2, 4). Alias then id order only
 * stabilizes row order; it never awards a better place.
 */
export function rankStandings<T extends RankableRow>(rows: readonly T[]): (T & { rank: number })[] {
  const sorted = rows.slice().sort((a, b) => {
    if (b.xp !== a.xp) return b.xp - a.xp;
    const aliasA = a.alias.toLowerCase();
    const aliasB = b.alias.toLowerCase();
    if (aliasA !== aliasB) return aliasA < aliasB ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.map((row) => ({ ...row, rank: 1 + rows.filter((other) => other.xp > row.xp).length }));
}

export interface DayXpChange {
  competitionDate: IsoDate;
  before: DailyXp;
  after: DailyXp;
  delta: number;
}

export interface RunXpEstimate {
  days: DayXpChange[];
  totalXp: number;
  distanceXp: number;
  activeDayBonus: number;
}

/**
 * The XP a run adds given the same-day totals already credited. Because the daily cap and
 * the active-day bonus are per day, a second run on a day earns only the marginal amount.
 * On the device this is always labelled provisional; the server result is authoritative.
 */
export function estimateRunXp(
  runAllocations: readonly DayAllocation[],
  creditedDays: ReadonlyMap<IsoDate, Pick<DayTotals, 'distanceCm' | 'activeMs'>>,
): RunXpEstimate {
  const days: DayXpChange[] = [];
  let distanceXp = 0;
  let activeDayBonus = 0;
  const runTotals = [...totalsByDay(runAllocations).values()].sort((a, b) => (a.competitionDate < b.competitionDate ? -1 : 1));
  for (const run of runTotals) {
    const existing = creditedDays.get(run.competitionDate) ?? { distanceCm: 0, activeMs: 0 };
    const before = dailyXp(existing.distanceCm, existing.activeMs);
    const after = dailyXp(existing.distanceCm + run.distanceCm, existing.activeMs + run.activeMs);
    days.push({ competitionDate: run.competitionDate, before, after, delta: after.xp - before.xp });
    distanceXp += after.distanceXp - before.distanceXp;
    activeDayBonus += after.activeDayBonus - before.activeDayBonus;
  }
  return { days, totalXp: distanceXp + activeDayBonus, distanceXp, activeDayBonus };
}
