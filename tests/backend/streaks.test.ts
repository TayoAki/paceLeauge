import { steadyRun } from '@/domain/synthetic';

import { TestDb, type TestUser } from './helpers/db';
import { currentWeekStartMs, uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK_START = currentWeekStartMs();

/** 07:00 (Chicago-ish) on day `day` (0 = Monday) of the week `weekOffset` weeks back (negative). */
function at(weekOffset: number, day: number): number {
  return WEEK_START + weekOffset * 7 * DAY + day * DAY + 7 * HOUR;
}

/** An active day: 2 km in 12 minutes. */
async function activeDay(user: TestUser, weekOffset: number, day: number, options: { receivedAfterMs?: number } = {}) {
  return uploadRun(db, user, steadyRun(at(weekOffset, day), 2_000, 720), options);
}

async function streak(user: TestUser) {
  return db.rpc(user, 'get_streak');
}

async function badges(user: TestUser): Promise<string[]> {
  const result = await db.rpc(user, 'get_badges');
  return result.earned.map((b: { badge: string }) => b.badge);
}

describe('weekly streaks', () => {
  it('counts consecutive weeks that met the goal; an unfinished week never breaks it', async () => {
    const runner = await db.createRunner('Streak Stella', { goalDays: 2 });
    for (const week of [-3, -2, -1]) {
      await activeDay(runner, week, 1);
      await activeDay(runner, week, 3);
    }
    const state = await streak(runner);
    expect(state.current_weeks).toBe(3);
    expect(state.best_weeks).toBe(3);
    expect(state.this_week).toMatchObject({ goal_days: 2, met: false });
    expect(state.at_stake).toBe(true);
  });

  it('adds the current week once it meets the goal', async () => {
    if (Date.now() - WEEK_START < 30 * 60_000) return; // Monday just after midnight: no room for a run yet
    const runner = await db.createRunner('Now Nia', { goalDays: 1 });
    await activeDay(runner, -1, 2);
    await uploadRun(db, runner, steadyRun(Math.max(WEEK_START + 60_000, Date.now() - 2 * HOUR), 2_000, 720));
    const state = await streak(runner);
    expect(state.this_week.met).toBe(true);
    expect(state.current_weeks).toBe(2);
    expect(state.at_stake).toBe(false);
  });

  it('breaks on a week without enough active days, and counts short runs as nothing', async () => {
    const runner = await db.createRunner('Gap Gale', { goalDays: 1 });
    await activeDay(runner, -5, 1);
    // Week -4: only a 500 m jog, not an active day.
    await uploadRun(db, runner, steadyRun(at(-4, 1), 500, 360));
    await activeDay(runner, -3, 1);
    await activeDay(runner, -2, 1);
    await activeDay(runner, -1, 1);
    const state = await streak(runner);
    expect(state.current_weeks).toBe(3);
    expect(state.best_weeks).toBe(3);
  });

  it('keeps each past week’s goal when the goal changes', async () => {
    const runner = await db.createRunner('Goal Gio', { goalDays: 1 });
    await activeDay(runner, -2, 1);
    await activeDay(runner, -1, 1);
    expect((await streak(runner)).current_weeks).toBe(2);
    await db.rpc(runner, 'save_profile', {
      p_alias: 'Goal Gio',
      p_units: 'metric',
      p_goal_days: 3,
      p_notification_tz: 'America/Chicago',
    });
    const state = await streak(runner);
    expect(state.current_weeks).toBe(2);
    expect(state.this_week.goal_days).toBe(3);
  });

  it('still counts a run that synced days late', async () => {
    const runner = await db.createRunner('Late Lin', { goalDays: 1 });
    await activeDay(runner, -2, 1);
    const late = await activeDay(runner, -1, 1, { receivedAfterMs: 4 * DAY });
    expect(late.result.run.status).toBe('review');
    expect(late.result.run.reason_codes).toEqual(['late_upload']);
    expect((await streak(runner)).current_weeks).toBe(2);
  });

  it('reverses when the run that met a week is deleted', async () => {
    const runner = await db.createRunner('Undo Uma', { goalDays: 1 });
    await activeDay(runner, -2, 1);
    const last = await activeDay(runner, -1, 1);
    expect((await streak(runner)).current_weeks).toBe(2);
    await db.rpc(runner, 'delete_run', { p_run_id: last.runId });
    expect((await streak(runner)).current_weeks).toBe(0);
  });

  it('skips frozen weeks without breaking the streak', async () => {
    const runner = await db.createRunner('Frozen Fay', { goalDays: 1 });
    await activeDay(runner, -3, 1);
    await activeDay(runner, -1, 1);
    await db.sql(
      `insert into private.streak_weeks (user_id, week_start, frozen) values ($1, (select private.current_week_start() - 14), true)`,
      [runner.id],
    );
    expect((await streak(runner)).current_weeks).toBe(2);
  });
});

describe('badges', () => {
  it('earns run and distance badges and loses them when the run is deleted', async () => {
    const runner = await db.createRunner('Badge Bo');
    expect(await badges(runner)).toEqual([]);
    const first = await uploadRun(db, runner, steadyRun(at(-1, 1), 5_100, 1_700));
    expect(await badges(runner)).toEqual(expect.arrayContaining(['first_run', 'first_5k']));
    await db.rpc(runner, 'delete_run', { p_run_id: first.runId });
    expect(await badges(runner)).toEqual([]);
  });

  it('earns the ten-run badge on the tenth accepted run, dated to that run', async () => {
    const runner = await db.createRunner('Ten Tao');
    for (let i = 0; i < 10; i += 1) {
      await uploadRun(db, runner, steadyRun(at(-3, 0) + i * 2 * HOUR, 1_500, 600));
    }
    const result = await db.rpc(runner, 'get_badges');
    const ten = result.earned.find((b: { badge: string }) => b.badge === 'runs_10');
    expect(ten.earned_at_ms).toBe(at(-3, 0) + 9 * 2 * HOUR);
    expect(result.progress.accepted_runs).toBe(10);
  });

  it('earns tier badges from lifetime XP and streak badges from the best streak', async () => {
    const runner = await db.createRunner('Tier Tess', { goalDays: 1 });
    await db.sql('update private.profile_stats set lifetime_xp = 1600 where user_id = $1', [runner.id]);
    expect(await badges(runner)).toEqual(expect.arrayContaining(['tier_stride', 'tier_tempo']));
    for (const week of [-4, -3, -2, -1]) await activeDay(runner, week, 2);
    expect(await badges(runner)).toContain('streak_4');
  });

  it('never gives badges to anyone else’s runs', async () => {
    const a = await db.createRunner('Owner Ava');
    const b = await db.createRunner('Other Ben');
    await uploadRun(db, a, steadyRun(at(-1, 1), 5_100, 1_700));
    expect(await badges(b)).toEqual([]);
  });
});
