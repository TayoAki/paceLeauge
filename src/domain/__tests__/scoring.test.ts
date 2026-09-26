import fixtures from '../../../docs/packet/sample-fixtures.json';
import { allocateSegmentsToDays, totalsByDay } from '../allocation';
import { COMPETITION_TIME_ZONE, TIERS } from '../config';
import { dailyXp, estimateRunXp, isActiveDay, rankStandings, tierProgress, weeklyLeagueXp } from '../scoring';
import { steadyRun } from '../synthetic';
import { validateRun } from '../validator';

const M = 100; // centimetres per metre
const S = 1000; // milliseconds per second

describe('score contract v1 — golden fixtures (TECHNICAL_SPEC.md)', () => {
  it('first 5,240 m / 1,888 s run of a day earns 52 distance + 25 active-day = 77 XP', () => {
    expect(dailyXp(5240 * M, 1888 * S)).toEqual({ distanceXp: 52, activeDayBonus: 25, xp: 77 });
  });

  it('two accepted 2,620 m runs on the same day combine to 77 XP, not 102', () => {
    const firstAlone = dailyXp(2620 * M, 944 * S);
    expect(firstAlone.xp).toBe(51);
    const combined = dailyXp(2 * 2620 * M, 2 * 944 * S);
    expect(combined.xp).toBe(77);
    expect(firstAlone.xp * 2).toBe(102);

    const second = estimateRunXp(
      [{ segmentIndex: 0, segmentStartAt: 0, competitionDate: '2026-09-25', distanceCm: 2620 * M, activeMs: 944 * S }],
      new Map([['2026-09-25', { distanceCm: 2620 * M, activeMs: 944 * S }]]),
    );
    expect(second.totalXp).toBe(26);
    expect(second.activeDayBonus).toBe(0);
  });

  it('600 m / 240 s then 400 m / 180 s in one day totals 1,000 m / 420 s → 35 XP', () => {
    expect(dailyXp(600 * M, 240 * S).xp).toBe(6);
    expect(dailyXp(1000 * M, 420 * S)).toEqual({ distanceXp: 10, activeDayBonus: 25, xp: 35 });
  });

  it('caps a day at 125 XP from 10,000 m and 300 s', () => {
    expect(dailyXp(10_000 * M, 300 * S).xp).toBe(125);
    expect(dailyXp(42_195 * M, 4 * 3600 * S).xp).toBe(125);
    expect(dailyXp(9_999 * M, 300 * S).xp).toBe(124);
  });

  it('requires both 1,000 m and 300 s for the active-day bonus', () => {
    expect(isActiveDay(1000 * M, 299 * S)).toBe(false);
    expect(isActiveDay(999 * M, 3600 * S)).toBe(false);
    expect(isActiveDay(1000 * M, 300 * S)).toBe(true);
  });

  it('weekly league score counts the best three days: 125, 100, 80, 77 → 305 (all 382 count for lifetime)', () => {
    const days = [125, 100, 80, 77];
    expect(weeklyLeagueXp(days)).toBe(305);
    expect(days.reduce((a, b) => a + b, 0)).toBe(382);
    expect(weeklyLeagueXp([125, 125, 125, 125, 125, 125, 125])).toBe(375);
    expect(weeklyLeagueXp([40])).toBe(40);
    expect(weeklyLeagueXp([])).toBe(0);
  });

  it('matches every fixture run in sample-fixtures.json (91 + 89 + 77 = 257)', () => {
    expect(fixtures.competitionTimezone).toBe(COMPETITION_TIME_ZONE);
    const dayScores = fixtures.runs.map((run) => {
      const xp = dailyXp(run.distanceM * M, run.activeSeconds * S).xp;
      expect(xp).toBe(run.expectedDayXp);
      return xp;
    });
    expect(weeklyLeagueXp(dayScores)).toBe(fixtures.afterFriday.weeklyLeagueXp);
    expect(fixtures.lifetimeXpBeforeWeek + dayScores.reduce((a, b) => a + b, 0)).toBe(fixtures.afterFriday.lifetimeXp);
  });

  it('lifetime 820 → 897 after Friday: Stride, 603 to Tempo, 39.7% through the tier', () => {
    const before = tierProgress(fixtures.beforeFriday.lifetimeXp);
    expect(before.tier).toBe('Stride');
    expect(before.xpToNextTier).toBe(fixtures.beforeFriday.toTempoXp);
    expect(before.fraction).toBeCloseTo(0.32, 10);

    const after = tierProgress(fixtures.afterFriday.lifetimeXp);
    expect(after).toMatchObject({ tier: 'Stride', nextTier: 'Tempo', xpToNextTier: 603 });
    expect(after.fraction).toBeCloseTo(fixtures.afterFriday.tierProgressFraction, 3);
  });

  it('uses the tier thresholds from the fixtures and shows Elite as a completed tier', () => {
    expect(TIERS.map((t) => ({ name: t.name, minimumXp: t.minXp }))).toEqual(fixtures.tiers);
    expect(tierProgress(0)).toMatchObject({ tier: 'Seed', xpToNextTier: 500, fraction: 0 });
    expect(tierProgress(499).tier).toBe('Seed');
    expect(tierProgress(500)).toMatchObject({ tier: 'Stride', fraction: 0 });
    expect(tierProgress(1500).tier).toBe('Tempo');
    expect(tierProgress(3999).tier).toBe('Tempo');
    expect(tierProgress(4000).tier).toBe('Surge');
    expect(tierProgress(10_000)).toEqual({
      tier: 'Elite',
      tierMinXp: 10_000,
      nextTier: null,
      nextTierMinXp: null,
      xpToNextTier: null,
      fraction: 1,
    });
  });

  it('ranks ties together (1, 2, 2, 4) without alias giving a better place', () => {
    const ranked = rankStandings([
      { id: 'd', alias: 'Theo', xp: 230 },
      { id: 'c', alias: 'Jules', xp: 257 },
      { id: 'b', alias: 'You', xp: 257 },
      { id: 'a', alias: 'Maya', xp: 289 },
    ]);
    expect(ranked.map((r) => [r.alias, r.rank])).toEqual([
      ['Maya', 1],
      ['Jules', 2],
      ['You', 2],
      ['Theo', 4],
    ]);
  });

  it('reproduces the fixture league rows', () => {
    const rows = fixtures.league.visibleRows.map((r) => ({ id: r.alias, alias: r.alias, xp: r.weeklyXp }));
    expect(rankStandings(rows).map((r) => r.rank)).toEqual(fixtures.league.visibleRows.map((r) => r.rank));
  });
});

describe('end-to-end domain pipeline on a synthetic Friday run', () => {
  it('validates, allocates and estimates the 5.24 km / 31:28 fixture run as +77 XP', () => {
    const friday = fixtures.runs.find((r) => r.id === 'fixture-fri');
    if (!friday) throw new Error('fixture missing');
    const startAt = Date.parse(friday.startedAt);
    const run = steadyRun(startAt, friday.distanceM, friday.activeSeconds);
    const validation = validateRun({ ...run, receivedAt: run.endedAt + 5_000 });
    expect(validation.outcome).toBe('accepted');
    expect(validation.activeMs).toBe(1888 * S);
    expect(Math.abs(validation.distanceM - 5240)).toBeLessThan(0.5);

    const allocations = allocateSegmentsToDays(validation.segments);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.competitionDate).toBe('2026-09-25');

    const estimate = estimateRunXp(allocations, new Map());
    expect(estimate).toMatchObject({ totalXp: 77, distanceXp: 52, activeDayBonus: 25 });

    const totals = totalsByDay(allocations).get('2026-09-25');
    expect(totals?.activeMs).toBe(1888 * S);
  });

  it('splitting one distance into several runs cannot beat the daily cap', () => {
    const credited = new Map<string, { distanceCm: number; activeMs: number }>();
    let earned = 0;
    for (let i = 0; i < 6; i += 1) {
      const allocation = { segmentIndex: 0, segmentStartAt: 0, competitionDate: '2026-09-22', distanceCm: 2000 * M, activeMs: 600 * S };
      const estimate = estimateRunXp([allocation], credited);
      earned += estimate.totalXp;
      const day = credited.get('2026-09-22') ?? { distanceCm: 0, activeMs: 0 };
      credited.set('2026-09-22', { distanceCm: day.distanceCm + allocation.distanceCm, activeMs: day.activeMs + allocation.activeMs });
    }
    expect(earned).toBe(dailyXp(12_000 * M, 3600 * S).xp);
    expect(earned).toBe(125);
  });
});
