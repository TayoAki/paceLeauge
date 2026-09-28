import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';
import { COUNTRIES } from '@/features/leaderboards/countries';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { currentWeekStartMs, routelessRun, uploadRun } from './helpers/runs';

/**
 * Global and regional leaderboards (docs/ROADMAP.md 4.7): opt-in weekly boards by tier and
 * country, scored with the capped best three days; provisional until the review window closes;
 * extra checks for the top of each board; reports; and the simulated cheating account (car-speed
 * runs, a replayed route, a typed-in run) that never reaches a final board.
 *
 * Boards are tested on last week, whose runs are all in the past. The job runs with an explicit
 * "now" either side of the week's review window.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

// Each test starts with empty boards: earlier runners leave, and last week isn't final yet.
beforeEach(async () => {
  await db.sql('update private.leaderboard_members set left_at = now() where joined_at is not null and left_at is null');
  await db.sql('delete from private.leaderboard_results');
  await db.sql('delete from private.leaderboard_weeks');
});

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** 07:00 (plus `hour`) Chicago time on `day` (0 = Monday) of the week `offset` weeks from this one. */
const at = (offset: number, day: number, hour = 0) => currentWeekStartMs() + offset * WEEK + day * DAY + (7 + hour) * 3_600_000;

let bearing = 3;
/** A run on a route of its own: synthetic runs with the same distance and time share every point otherwise. */
const run = (start: number, distanceM: number, durationS: number, direction?: number) => {
  bearing = (bearing + 11) % 360;
  return steadyRun(start, distanceM, durationS, { bearingDeg: direction ?? bearing });
};

/** Last week's final time, from the database. */
const lastWeekFinalAt = async () =>
  Number((await db.one<{ ms: string }>('select private.ts_to_ms(private.leaderboard_final_at(private.current_week_start() - 7))::text as ms')).ms);

async function refresh(nowMs: number) {
  return (await db.one<{ n: number }>('select private.refresh_leaderboards(to_timestamp($1::bigint / 1000.0)) as n', [nowMs])).n;
}
const inReview = async () => refresh((await lastWeekFinalAt()) - 3_600_000);
const finalize = async () => refresh((await lastWeekFinalAt()) + 60_000);

/**
 * A runner with a month-old account and runs in the two weeks before last, so they may appear
 * on last week's boards. `historyKm` sets their tier (10 km runs are 125 XP each).
 */
async function runner(alias: string, options: { country?: string; join?: boolean; historyKm?: number[] } = {}) {
  const user = await db.createRunner(alias);
  await db.sql(`update public.profiles set created_at = now() - interval '40 days' where user_id = $1`, [user.id]);
  const history = options.historyKm ?? [3, 3];
  for (const [i, km] of history.entries()) {
    await uploadRun(db, user, run(at(i % 2 === 0 ? -3 : -2, i % 5, i), km * 1_000, km * 330));
  }
  if (options.join !== false) await db.rpc(user, 'join_leaderboards', { p_country: options.country ?? 'US' });
  return user;
}

async function lastWeek(user: TestUser, runs: [number, number][]) {
  for (const [i, [km, day]] of runs.entries()) {
    await uploadRun(db, user, run(at(-1, day, i % 3), km * 1_000, km * 330));
  }
}

const board = (user: TestUser, args: Record<string, unknown>) => db.rpc(user, 'get_leaderboard', { p_week_offset: -1, ...args });
const names = (b: any) => b.rows.map((r: any) => [r.rank, r.alias, r.tier, r.score]);

describe('leaderboards', () => {
  it('are opt-in weekly boards by tier and country that show a name, tier and score and nothing else', async () => {
    const ann = await runner('Board Ann');
    const ben = await runner('Board Ben');
    const cat = await runner('Board Cat', { country: 'CA' });
    const dan = await runner('Board Dan', { historyKm: [10, 10, 10, 10, 10] }); // 625 XP before last week: Stride
    const eve = await runner('Board Eve', { join: false });
    await lastWeek(ann, [[5, 0], [5, 2], [5, 4]]); // 3 × 75
    await lastWeek(ben, [[5, 1], [5, 3]]); // 2 × 75
    await lastWeek(cat, [[5, 1]]);
    await lastWeek(dan, [[8, 0], [8, 1], [8, 2]]); // 3 × 105
    await lastWeek(eve, [[10, 0], [10, 1], [10, 2]]); // never joined: never on a board

    // Only GPS runs that were accepted in time count: not a treadmill run, not one the server
    // first had after the cutoff.
    await uploadRun(db, ann, routelessRun(at(-1, 5), 5_000, 1_500), {
      extra: { p_source: 'health_import', p_source_app: 'Workout', p_source_device: 'Apple Watch', p_external_id: `HK-${randomUUID()}`,
               p_indoor: true, p_claimed_distance_m: 5_000, p_steps: 4_300, p_avg_heart_rate: 150, p_max_heart_rate: 170 },
    });
    const late = await uploadRun(db, ben, run(at(-1, 6), 10_000, 3_300));
    await db.sql(`update public.runs set first_received_at = private.day_start(private.current_week_start()) + interval '25 hours' where id = $1`, [late.runId]);

    await inReview();
    const seed = await board(ann, { p_board: 'tier' });
    expect(seed).toMatchObject({ board: 'tier', key: 'Seed', state: 'in_review', runners: 3 });
    expect(names(seed)).toEqual([
      [1, 'Board Ann', 'Seed', 225],
      [2, 'Board Ben', 'Seed', 150],
      [3, 'Board Cat', 'Seed', 75],
    ]);
    expect(Object.keys(seed.rows[0]).sort()).toEqual(['alias', 'hidden', 'is_me', 'rank', 'result_id', 'score', 'tier']);
    expect(seed.me).toMatchObject({ alias: 'Board Ann', is_me: true, rank: 1 });
    expect(names(await board(ann, { p_board: 'tier', p_key: 'Stride' }))).toEqual([[1, 'Board Dan', 'Stride', 315]]);
    expect(names(await board(ann, { p_board: 'country' }))).toEqual([
      [1, 'Board Dan', 'Stride', 315],
      [2, 'Board Ann', 'Seed', 225],
      [3, 'Board Ben', 'Seed', 150],
    ]);
    expect(names(await board(cat, { p_board: 'country' }))).toEqual([[1, 'Board Cat', 'Seed', 75]]);
    // Anyone signed in can look; only runners who joined are on it.
    expect((await board(eve, { p_board: 'tier', p_key: 'Seed' })).runners).toBe(3);
    await expectCode(board(eve, { p_board: 'tier', p_key: 'Legend' }), 'invalid_input');
    await expectCode(board(eve, { p_board: 'country', p_key: 'ZZ' }), 'invalid_input');
    await expectCode(db.rpc(eve, 'join_leaderboards', { p_country: 'Narnia' }), 'invalid_input');

    // After the review window the board is final.
    await finalize();
    expect(await board(ann, { p_board: 'tier' })).toMatchObject({ state: 'final', runners: 3 });

    // A block hides the name; leaving takes a runner off every board, the final one included.
    await db.rpc(ann, 'block_runner', { p_public_id: (await db.rpc(cat, 'get_social_settings')).public_id });
    expect((await board(ann, { p_board: 'tier' })).rows[2]).toMatchObject({ alias: null, hidden: true, score: 75 });
    expect(await db.rpc(ben, 'leave_leaderboards')).toMatchObject({ joined: false });
    expect(names(await board(ann, { p_board: 'tier' })).map((r: any) => r[1])).toEqual(['Board Ann', null]);
    await db.rpc(ben, 'join_leaderboards', { p_country: 'US' });
    expect((await board(ann, { p_board: 'tier' })).runners).toBe(3);
  });

  it('let new accounts on after two weeks of runs', async () => {
    const fay = await db.createRunner('New Fay');
    await uploadRun(db, fay, run(at(-1, 1), 5_000, 1_650));
    const joined = await db.rpc(fay, 'join_leaderboards', { p_country: 'US' });
    expect(joined).toMatchObject({ joined: true, eligible: false, eligible_from: null, country: 'US' });
    await uploadRun(db, fay, run(at(0, 0), 5_000, 1_650));
    const status = await db.rpc(fay, 'get_leaderboard_status');
    // Two weeks of runs, and 14 days after the account was made: the Monday after that.
    expect(status.eligible).toBe(false);
    expect(Date.parse(status.eligible_from)).toBeGreaterThanOrEqual(Date.parse(new Date(currentWeekStartMs() + 14 * DAY).toISOString().slice(0, 10)));
    await refresh(Date.now());
    expect((await db.rpc(fay, 'get_leaderboard', { p_board: 'country' })).me).toBeNull();
  });

  it('never put a simulated cheating account on a final board', async () => {
    const hal = await runner('Honest Hal');
    const ivy = await runner('Honest Ivy');
    await lastWeek(hal, [[5, 0], [5, 2], [5, 4]]); // 225
    await lastWeek(ivy, [[4, 1], [4, 3], [4, 5]]); // 195

    // The cheater: an ordinary history (so they may appear), then last week car-speed runs, a
    // typed-in marathon, and one of their own earlier routes replayed with new times, three times.
    const cy = await db.createRunner('Cheater Cy');
    await db.sql(`update public.profiles set created_at = now() - interval '40 days' where user_id = $1`, [cy.id]);
    await uploadRun(db, cy, run(at(-3, 2), 10_000, 3_300, 42));
    await uploadRun(db, cy, run(at(-2, 2), 6_000, 2_000));
    await db.rpc(cy, 'join_leaderboards', { p_country: 'US' });
    const car = await uploadRun(db, cy, run(at(-1, 0, 2), 6_000, 700)); // 31 km/h
    expect(car.result.run).toMatchObject({ status: 'review', reason_codes: ['speed_anomaly'] });
    const motorway = await uploadRun(db, cy, run(at(-1, 5, 2), 30_000, 1_200)); // 90 km/h: too fast to track at all
    expect(motorway.result.run.status).not.toBe('accepted');
    const typed = await uploadRun(db, cy, routelessRun(at(-1, 1, 2), 42_195, 9_000), {
      extra: { p_source: 'health_import', p_external_id: `HK-${randomUUID()}`, p_manual_entry: true, p_claimed_distance_m: 42_195 },
    });
    expect(typed.result.run.status).toBe('personal_only');
    for (const day of [2, 3, 4]) {
      const replay = await uploadRun(db, cy, run(at(-1, day, 3), 10_000, 3_300, 42));
      expect(replay.result.run.status).toBe('accepted'); // the validator can't tell
    }
    // Without the checks Cy would top the board: 3 × 125 against Hal's 225.
    const scores = await db.sql<{ score: number }>('select score from private.leaderboard_week_scores(private.current_week_start() - 7, array[$1::uuid])', [cy.id]);
    expect(scores).toEqual([{ score: 375 }]);

    await inReview();
    const provisional = await board(hal, { p_board: 'country' });
    expect(provisional.rows.map((r: any) => r.alias)).not.toContain('Cheater Cy');
    expect(await board(cy, { p_board: 'country' })).toMatchObject({ me: null, my_status: 'held' });
    const moderator = await db.createRunner('Board Mod');
    await db.sql(`select private.grant_staff_role($1, 'moderator', 'leaderboards', 'ops-test')`, [moderator.id]);
    const held = (await db.rpc(moderator, 'mod_list_reports')).find((r: any) => r.target_kind === 'leaderboard' && r.content_snapshot.alias === 'Cheater Cy');
    expect(held).toMatchObject({
      reason_code: 'cheating',
      content_snapshot: { score: 375, tier: 'Seed', country: 'US', automatic: true, flags: ['replayed_route', 'speed_flags'] },
      target_state: { result_status: 'held' },
      actions: ['dismiss', 'release_result', 'remove_result', 'remove_from_leaderboards', 'reset_alias'],
    });

    await finalize();
    for (const args of [{ p_board: 'country', p_key: 'US' }, { p_board: 'tier', p_key: 'Seed' }]) {
      const final = await board(hal, args);
      expect(final.state).toBe('final');
      expect(final.rows.map((r: any) => r.alias)).not.toContain('Cheater Cy');
    }
    expect(await db.one('select status from private.leaderboard_results where user_id = $1', [cy.id])).toEqual({ status: 'held' });
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: held.report_id, p_action: 'remove_from_leaderboards', p_reason: 'Replayed routes' });
    expect(await db.rpc(cy, 'get_leaderboard_status')).toMatchObject({ joined: false, removed: true });
    await expectCode(db.rpc(cy, 'join_leaderboards', { p_country: 'US' }), 'leaderboards_removed');
  });

  it('let a moderator release a result the checks held, and remove one a runner reported', async () => {
    const fast = await runner('Fast Flo');
    const kim = await runner('Report Kim');
    const jo = await runner('Report Jo');
    // Under 3:00/km over 10 km: world-class, so a person looks before it's final.
    await lastWeek(fast, [[10, 0]]);
    await uploadRun(db, fast, run(at(-1, 2, 4), 10_000, 1_750));
    await lastWeek(kim, [[6, 0], [6, 1]]);
    await lastWeek(jo, [[3, 2]]);
    await inReview();
    expect(await board(fast, { p_board: 'tier' })).toMatchObject({ me: null, my_status: 'held' });

    const moderator = await db.createRunner('Release Mod');
    await db.sql(`select private.grant_staff_role($1, 'moderator', 'leaderboards', 'ops-test')`, [moderator.id]);
    const queue = await db.rpc(moderator, 'mod_list_reports');
    const flo = queue.find((r: any) => r.content_snapshot.alias === 'Fast Flo');
    expect(flo.content_snapshot.flags).toEqual(['elite_pace']);
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: flo.report_id, p_action: 'release_result', p_reason: 'Checked splits and heart rate' });

    // Jo reports Kim's result.
    const kimRow = (await board(jo, { p_board: 'tier' })).rows.find((r: any) => r.alias === 'Report Kim');
    await expectCode(db.rpc(kim, 'report_content', { p_kind: 'leaderboard', p_id: kimRow.result_id, p_reason: 'cheating' }), 'not_found');
    const report = await db.rpc(jo, 'report_content', { p_kind: 'leaderboard', p_id: kimRow.result_id, p_reason: 'cheating' });
    const listed = (await db.rpc(moderator, 'mod_list_reports')).find((r: any) => r.report_id === report.report_id);
    expect(listed).toMatchObject({ target_kind: 'leaderboard', content_snapshot: { alias: 'Report Kim', score: 170, tier: 'Seed', country: 'US' } });
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: report.report_id, p_action: 'remove_result', p_reason: 'GPS on a bike' });

    await finalize();
    const final = (await board(jo, { p_board: 'tier' })).rows.map((r: any) => r.alias);
    expect(final).toContain('Fast Flo'); // released, and not held again at the final check
    expect(final).not.toContain('Report Kim');
    expect(await board(kim, { p_board: 'tier' })).toMatchObject({ me: null, my_status: 'removed' });
  });

  it('invite a runner who won their league’s week, or had a full league week', async () => {
    const leo = await db.createRunner('Invite Leo');
    const created = await db.rpc(leo, 'create_league', { p_name: 'Invite crew' });
    const { code } = await db.rpc(leo, 'create_league_invite', { p_league_id: created.league.id });
    const mia = await db.createRunner('Invite Mia');
    await db.rpc(mia, 'join_league', { p_code: code });
    await db.sql(`update public.league_members set joined_at = now() - interval '30 days' where league_id = $1`, [created.league.id]);
    await uploadRun(db, leo, run(at(-1, 0), 6_000, 2_000));
    await uploadRun(db, leo, run(at(-1, 2), 6_000, 2_000));
    await uploadRun(db, mia, run(at(-1, 1), 3_000, 1_000));

    expect((await db.rpc(leo, 'get_leaderboard_status')).invite).toBe('won_league');
    expect((await db.rpc(mia, 'get_leaderboard_status')).invite).toBe('full_week');
    expect((await db.rpc(mia, 'dismiss_leaderboard_invite')).invite).toBeNull();
    expect((await db.rpc(leo, 'join_leaderboards', { p_country: 'US' })).invite).toBeNull();
    const loner = await db.createRunner('Invite Loner');
    expect((await db.rpc(loner, 'get_leaderboard_status')).invite).toBeNull();
  });

  it('accept exactly the countries the app offers', async () => {
    const { codes } = await db.one<{ codes: string[] }>('select private.country_codes() as codes');
    expect([...codes].sort()).toEqual(COUNTRIES.map((c) => c.code).sort());
  });

  it('are in the export', async () => {
    const pat = await runner('Export Pat', { country: 'GB' });
    await lastWeek(pat, [[5, 0]]);
    await inReview();
    const extras = (await db.one<{ x: any }>('select private.export_extras($1) as x', [pat.id])).x;
    expect(extras.leaderboards).toMatchObject({ joined: true, country: 'GB', results: [expect.objectContaining({ score: 75, status: 'provisional', country: 'GB' })] });
  });
});
