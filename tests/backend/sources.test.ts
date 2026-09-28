import { randomUUID } from 'node:crypto';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { inCurrentWeek, routelessRun, runAt, uploadRun } from './helpers/runs';

/** Phase 2 (docs/ROADMAP.md 2.1–2.5 and Part A): sources, history-only runs and duplicates. */
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

async function history(user: TestUser): Promise<string[]> {
  return (await db.rpc(user, 'list_my_runs', {})).runs.map((r: { id: string }) => r.id);
}

describe('run sources', () => {
  it('validates an Apple Health workout with a route like a phone run, once however often it is imported', async () => {
    const runner = await db.createRunner('Watch Wren');
    const workout = runAt(inCurrentWeek(0), 5_240, 1_888);
    const extra = { p_source: 'health_import', p_external_id: 'HK-1111', p_source_app: 'Workout', p_source_device: 'Apple Watch', p_avg_heart_rate: 151 };
    const first = await uploadRun(db, runner, workout, { extra });
    expect(first.result.run).toMatchObject({
      status: 'accepted',
      source: 'health_import',
      source_app: 'Workout',
      source_device: 'Apple Watch',
      avg_heart_rate: 151,
      xp_award: { total_xp: 77 },
    });
    // Imported again from another device (a different client id): the same run comes back.
    const again = await db.rpc(runner, 'start_run_upload', {
      p_client_run_id: randomUUID(),
      p_started_at_ms: workout.startedAt,
      p_ended_at_ms: workout.endedAt,
      p_segments: workout.segments,
      p_client_distance_m: 5240,
      p_client_active_ms: 1_888_000,
      p_expected_points: workout.points.length,
      p_expected_chunks: Math.ceil(workout.points.length / 500),
      p_title: 'Run',
      ...extra,
    });
    expect(again).toMatchObject({ run_id: first.runId, status: 'accepted' });
    expect(await lifetimeXp(runner)).toBe(77);
  });

  it('keeps a workout without a route, a typed-in run and an indoor run as history that counts for goals', async () => {
    const runner = await db.createRunner('Garmin Gus');
    await db.sql(`update public.profiles set goal_days = 3 where user_id = $1`, [runner.id]);
    const garmin = await uploadRun(db, runner, routelessRun(inCurrentWeek(0), 8_000, 2_700), {
      extra: { p_source: 'health_import', p_external_id: 'HK-G1', p_source_app: 'Garmin Connect', p_claimed_distance_m: 8_000 },
    });
    expect(garmin.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['no_route'], distance_m: 8000, scoring_state: 'none' });
    const typed = await uploadRun(db, runner, routelessRun(inCurrentWeek(1), 5_000, 1_800), {
      extra: { p_source: 'health_import', p_external_id: 'HK-M1', p_manual_entry: true, p_claimed_distance_m: 5_000 },
    });
    expect(typed.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['manual_entry'], manual_entry: true });
    const indoor = await uploadRun(db, runner, routelessRun(inCurrentWeek(2), 6_000, 2_100), {
      extra: { p_source: 'indoor', p_claimed_distance_m: 6_000, p_steps: 6_900 },
    });
    expect(indoor.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['indoor'], steps: 6900 });

    expect(await lifetimeXp(runner)).toBe(0);
    // No XP, but three active days meet the goal.
    const streak = await db.rpc(runner, 'get_streak');
    expect(streak.this_week).toMatchObject({ active_days: 3, goal_days: 3, met: true });
    // The week on Today shows the same three days.
    const week = await db.rpc(runner, 'get_week_summary', { p_week_offset: 0 });
    expect(week).toMatchObject({ active_days: 3, weekly_xp: 0 });
    expect(week.days.filter((d: { active: boolean }) => d.active)).toHaveLength(3);
    expect((await db.rpc(runner, 'get_personal_records')).records.every((r: { best: unknown }) => r.best === null)).toBe(true);
  });

  it('measures a file import from its points but never scores it', async () => {
    const runner = await db.createRunner('File Fay');
    const file = await uploadRun(db, runner, runAt(inCurrentWeek(0), 10_000, 3_000), {
      extra: { p_source: 'file_import', p_external_id: 'sha256:abc', p_source_app: 'GPX file' },
    });
    expect(file.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['file_import'], scoring_state: 'none' });
    expect(file.result.run.distance_m).toBeCloseTo(10_000, -1);
    expect(await lifetimeXp(runner)).toBe(0);
  });

  it('refuses an unknown source', async () => {
    const runner = await db.createRunner('Source Sam');
    await expectCode(uploadRun(db, runner, runAt(inCurrentWeek(0), 3_000, 900), { extra: { p_source: 'strava' } }), 'invalid_input');
  });
});

describe('duplicates across sources', () => {
  it('keeps the copy with the better GPS record and brings the other back if the kept one is deleted', async () => {
    const runner = await db.createRunner('Double Dee');
    const start = inCurrentWeek(0);
    // The phone lost its signal for a minute every five (still enough coverage to count) …
    const phone = await uploadRun(db, runner, {
      ...runAt(start, 6_000, 2_000),
      points: runAt(start, 6_000, 2_000).points.filter((_, i) => i % 300 < 200 || i % 300 >= 260),
    });
    expect(phone.result.run.status).toBe('accepted');
    expect(phone.result.run.coverage).toBeLessThan(0.95);
    const phoneXp = await lifetimeXp(runner);
    expect(phoneXp).toBeGreaterThan(0);

    // … and the watch recorded the same run cleanly; it arrives through Apple Health.
    const watch = await uploadRun(db, runner, runAt(start + 20_000, 6_050, 2_000), {
      extra: { p_source: 'health_import', p_external_id: 'HK-D1', p_source_device: 'Apple Watch' },
    });
    expect(watch.result.run.status).toBe('accepted');
    const phoneNow = await db.rpc(runner, 'get_my_run', { p_run_id: phone.runId });
    expect(phoneNow).toMatchObject({ status: 'duplicate', duplicate_of: watch.runId, scoring_state: 'none' });
    expect(await history(runner)).toEqual([watch.runId]);
    expect((await db.rpc(runner, 'list_run_duplicates', { p_run_id: watch.runId })).map((r: { id: string }) => r.id)).toEqual([phone.runId]);
    // One run's worth of XP, not two.
    expect(await lifetimeXp(runner)).toBe(watch.result.run.xp_award.total_xp + phoneXp - phoneXp);

    // Deleting the kept copy brings the phone's back and scores it again.
    await db.rpc(runner, 'delete_run', { p_run_id: watch.runId });
    expect(await db.rpc(runner, 'get_my_run', { p_run_id: phone.runId })).toMatchObject({ status: 'accepted', duplicate_of: null });
    expect(await history(runner)).toEqual([phone.runId]);
    expect(await lifetimeXp(runner)).toBe(phoneXp);
  });

  it('prefers a checked route over a workout without one', async () => {
    const runner = await db.createRunner('Route Rae');
    const start = inCurrentWeek(1);
    const phone = await uploadRun(db, runner, runAt(start, 5_000, 1_700));
    const garmin = await uploadRun(db, runner, routelessRun(start - 30_000, 5_100, 1_760), {
      extra: { p_source: 'health_import', p_external_id: 'HK-R1', p_source_app: 'Garmin Connect', p_claimed_distance_m: 5_100 },
    });
    expect(garmin.result.run).toMatchObject({ status: 'duplicate', duplicate_of: phone.runId });
    expect(await history(runner)).toEqual([phone.runId]);
  });

  it('leaves runs that only touch alone', async () => {
    const runner = await db.createRunner('Back To Back');
    const first = await uploadRun(db, runner, runAt(inCurrentWeek(2), 3_000, 1_000));
    const second = await uploadRun(db, runner, runAt(inCurrentWeek(2) + 900_000, 3_000, 1_000));
    expect(first.result.run.status).toBe('accepted');
    expect(second.result.run.status).toBe('accepted');
  });
});

describe('diagnostics', () => {
  it('stores a small report and limits how often', async () => {
    const runner = await db.createRunner('Diag Dot');
    const r = await db.rpc(runner, 'submit_diagnostics', { p_report: { app_version: '0.1.0', outbox: [{ kind: 'upload_run', state: 'needs_attention', error: 'invalid_input' }] } });
    expect(r.report_id).toEqual(expect.any(Number));
    await expectCode(db.rpc(runner, 'submit_diagnostics', { p_report: [1, 2] }), 'invalid_input');
    for (let i = 0; i < 4; i += 1) await db.rpc(runner, 'submit_diagnostics', { p_report: { n: i } });
    await expectCode(db.rpc(runner, 'submit_diagnostics', { p_report: { n: 5 } }), 'rate_limited');
  });
});
