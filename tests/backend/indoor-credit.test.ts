import { SCORING_V1 } from '@/domain/config';

import { TestDb, type TestUser } from './helpers/db';
import { backdateMembership, currentWeekStartMs, inCurrentWeek, routelessRun, runAt, uploadRun } from './helpers/runs';

/**
 * Indoor league credit (docs/ROADMAP.md 2.5): an indoor run from a watch, with heart rate and steps
 * that look like running, earns XP for up to 5 km a day. Anything else indoors is history.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

async function lifetimeXp(user: TestUser): Promise<number> {
  return (await db.rpc(user, 'get_me')).lifetime_xp;
}

let externalIds = 0;

/** An Apple Watch indoor run as the Health import sends it. */
function watchIndoor(distanceM: number, steps: number | null, extra: Record<string, unknown> = {}) {
  externalIds += 1;
  return {
    p_source: 'health_import',
    p_source_app: 'Workout',
    p_source_device: 'Apple Watch',
    p_external_id: `HK-INDOOR-${externalIds}`,
    p_indoor: true,
    p_claimed_distance_m: distanceM,
    p_steps: steps,
    p_avg_heart_rate: 152,
    p_max_heart_rate: 174,
    ...extra,
  };
}

describe('indoor league credit', () => {
  it('credits a watch treadmill run that looks like running, up to 5 km a day', async () => {
    const runner = await db.createRunner('Indoor Iris');
    // 8 km in 40 minutes: 5:00 per km at 170 steps a minute.
    const first = await uploadRun(db, runner, routelessRun(inCurrentWeek(0), 8_000, 2_400), { extra: watchIndoor(8_000, 6_800) });
    expect(first.result.run).toMatchObject({ status: 'accepted', indoor: true, reason_codes: [], distance_m: 8000, steps: 6800 });
    // The cap: 5 km of indoor distance (50 XP) plus the active-day bonus.
    expect(first.result.run.xp_award).toMatchObject({ total_xp: 75, distance_xp: 50, active_day_bonus: 25 });

    // More indoor distance the same day adds nothing …
    const second = await uploadRun(db, runner, routelessRun(inCurrentWeek(0, 5), 3_000, 900), { extra: watchIndoor(3_000, 2_550) });
    expect(second.result.run).toMatchObject({ status: 'accepted', xp_award: { total_xp: 0 } });
    // … but an outdoor run still earns its full distance on top.
    const outdoor = await uploadRun(db, runner, runAt(inCurrentWeek(0, 8), 4_000, 1_400));
    expect(outdoor.result.run.xp_award.total_xp).toBe(40);
    expect(await lifetimeXp(runner)).toBe(115);

    // The cap is per day: the next day earns again.
    const nextDay = await uploadRun(db, runner, routelessRun(inCurrentWeek(1), 6_000, 1_800), { extra: watchIndoor(6_000, 5_100) });
    expect(nextDay.result.run.xp_award.total_xp).toBe(75);

    // Deleting the first run gives its credit back to the second, still within the cap.
    await db.rpc(runner, 'delete_run', { p_run_id: first.runId });
    expect(await lifetimeXp(runner)).toBe(30 + 40 + 25 + 75);
  });

  it('keeps indoor runs that don’t look like running as history that counts for the goal', async () => {
    const runner = await db.createRunner('Walking Wes');
    // Each run lasts 30 minutes, and fails one check.
    const cases: [string[], Record<string, unknown>][] = [
      // 100 steps a minute is walking.
      [['cadence'], watchIndoor(5_000, 3_000)],
      [['heart_rate'], watchIndoor(5_000, 5_100, { p_avg_heart_rate: null, p_max_heart_rate: null })],
      [['heart_rate'], watchIndoor(5_000, 5_100, { p_avg_heart_rate: 72, p_max_heart_rate: 90 })],
      [['cadence', 'stride'], watchIndoor(5_000, null)],
      // 140 steps a minute covering 8.6 km is a 2 m stride.
      [['stride'], watchIndoor(8_610, 4_200)],
      // 12.3 km in 30 minutes is faster than a treadmill goes; 3 km is a walk.
      [['pace'], watchIndoor(12_285, 6_300)],
      [['pace'], watchIndoor(3_000, 4_500)],
    ];
    for (const [i, [failed, extra]] of cases.entries()) {
      const run = await uploadRun(db, runner, routelessRun(inCurrentWeek(i), 5_000, 1_800), { extra });
      expect(run.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['indoor_unverified'] });
      const checks = await db.one<{ c: string[] }>('select private.indoor_checks(r) as c from public.runs r where id = $1', [run.runId]);
      expect(checks.c).toEqual(failed);
    }
    expect(await lifetimeXp(runner)).toBe(0);
    await db.sql(`update public.profiles set goal_days = 3 where user_id = $1`, [runner.id]);
    expect((await db.rpc(runner, 'get_streak')).this_week).toMatchObject({ active_days: 7, met: true });
  });

  it('never credits a phone treadmill run or a typed-in one', async () => {
    const runner = await db.createRunner('Phone Pia');
    const phone = await uploadRun(db, runner, routelessRun(inCurrentWeek(2), 5_000, 1_800), {
      extra: { p_source: 'indoor', p_claimed_distance_m: 5_000, p_steps: 5_100, p_avg_heart_rate: 150 },
    });
    expect(phone.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['indoor'], indoor: true });
    const typed = await uploadRun(db, runner, routelessRun(inCurrentWeek(3), 5_000, 1_800), {
      extra: watchIndoor(5_000, 5_100, { p_manual_entry: true }),
    });
    expect(typed.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['manual_entry'] });
    expect(await lifetimeXp(runner)).toBe(0);
  });

  it('holds a late indoor run for review like any other', async () => {
    const runner = await db.createRunner('Late Lou');
    const late = await uploadRun(db, runner, routelessRun(inCurrentWeek(0) - 14 * 86_400_000, 6_000, 1_800), {
      extra: watchIndoor(6_000, 5_100),
      receivedAfterMs: 5 * 86_400_000,
    });
    expect(late.result.run).toMatchObject({ status: 'review', reason_codes: ['late_upload'] });
  });

  it('keeps the watch copy when the phone also recorded the treadmill run', async () => {
    const runner = await db.createRunner('Both Bea');
    const start = inCurrentWeek(4);
    const phone = await uploadRun(db, runner, routelessRun(start, 5_200, 1_800), {
      extra: { p_source: 'indoor', p_claimed_distance_m: 5_200, p_steps: 5_050 },
    });
    const watch = await uploadRun(db, runner, routelessRun(start + 20_000, 5_000, 1_790), { extra: watchIndoor(5_000, 5_070) });
    expect(watch.result.run.status).toBe('accepted');
    const phoneAfter = await db.rpc(runner, 'get_my_run', { p_run_id: phone.runId });
    expect(phoneAfter).toMatchObject({ status: 'duplicate', duplicate_of: watch.runId });
    expect(await lifetimeXp(runner)).toBe(75);
  });

  it('uses the cap the app explains', async () => {
    const cap = await db.one<{ c: string }>('select private.indoor_daily_cap_cm() as c');
    expect(Number(cap.c)).toBe(SCORING_V1.indoorDailyCapCm);
  });

  it('applies the cap in the league too', async () => {
    const owner = await db.createRunner('Treadmill Tom');
    await db.rpc(owner, 'create_league', { p_name: 'Gym Crew' });
    await backdateMembership(db, owner, currentWeekStartMs() - 2 * 86_400_000);
    await uploadRun(db, owner, routelessRun(inCurrentWeek(5), 10_000, 3_000), { extra: watchIndoor(10_000, 8_500) });
    const view = await db.rpc(owner, 'get_my_league');
    expect(view.me).toMatchObject({ weekly_xp: 75 });
  });
});
