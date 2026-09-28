import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { uploadRun } from './helpers/runs';

/**
 * Challenges (docs/ROADMAP.md 4.6): the monthly challenges, league and club challenges, badges,
 * and the rule that a challenge can't be won by one very long run or by splitting runs.
 *
 * Tests use next month's challenges, which are open to join whatever today's date is; runs may
 * lie in the future because validation uses the test-controlled receipt time.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

/** `hour`:00 on `day` of next month, in the league time zone. */
async function nextMonth(day: number, hour = 7): Promise<number> {
  const row = await db.one<{ ms: string }>(
    'select (extract(epoch from private.day_start(private.challenge_month(1) + $1::integer) + make_interval(hours => $2::integer)) * 1000)::bigint::text as ms',
    [day - 1, hour],
  );
  return Number(row.ms);
}

const monthName = async (offset: number) =>
  (await db.one<{ m: string }>(`select to_char(private.challenge_month($1)::timestamp, 'FMMonth') as m`, [offset])).m;

async function league(ownerAlias: string, memberAliases: string[]) {
  const owner = await db.createRunner(ownerAlias);
  const created = await db.rpc(owner, 'create_league', { p_name: `${ownerAlias} crew` });
  const leagueId = created.league.id as string;
  const invite = await db.rpc(owner, 'create_league_invite', { p_league_id: leagueId });
  const members: TestUser[] = [];
  for (const alias of memberAliases) {
    const m = await db.createRunner(alias);
    await db.rpc(m, 'join_league', { p_code: invite.code });
    members.push(m);
  }
  return { owner, members, leagueId };
}

async function club(ownerAlias: string, memberAliases: string[]) {
  const owner = await db.createRunner(ownerAlias);
  const created = await db.rpc(owner, 'create_club', { p_name: `${ownerAlias} Club`, p_visibility: 'invite_only' });
  const clubId = created.id as string;
  const { code } = await db.rpc(owner, 'create_club_invite', { p_club_id: clubId });
  const members: TestUser[] = [];
  for (const alias of memberAliases) {
    const m = await db.createRunner(alias);
    await db.rpc(m, 'join_club_by_code', { p_code: code });
    members.push(m);
  }
  return { owner, members, clubId };
}

const globalChallenge = async (offset: number, metric: 'active_days' | 'capped_score') =>
  (
    await db.one<{ id: string }>(`select id from private.challenges where scope = 'global' and starts_on = private.challenge_month($1) and metric = $2`, [
      offset,
      metric,
    ])
  ).id;

const withDevice = (user: TestUser) =>
  db.rpc(user, 'register_push_token', { p_token: `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`, p_platform: 'ios' });

describe('the monthly challenges', () => {
  it('are there for everyone each month, and finishing one earns its badge until a run behind it is deleted', async () => {
    const runner = await db.createRunner('Monthly Mo');
    const list = await db.rpc(runner, 'list_challenges');
    const month = await monthName(0);
    const thisMonth = list.current.filter((c: any) => c.scope === 'global' && c.title.endsWith(month));
    expect(thisMonth.map((c: any) => [c.title, c.metric, c.target, c.joined])).toEqual([
      [`Run 12 days in ${month}`, 'active_days', 12, false],
      [`Score 750 in ${month}`, 'capped_score', 750, false],
    ]);
    expect(list.past).toEqual([]);

    // Next month's twelve days: open to join before it starts.
    const id = await globalChallenge(1, 'active_days');
    const joined = await db.rpc(runner, 'join_challenge', { p_challenge_id: id });
    expect(joined).toMatchObject({ scope: 'global', state: 'upcoming', joined: true, progress: 0, completed: false, board: null, can_manage: false });
    expect(joined.participants).toBeGreaterThanOrEqual(1);

    const runs: string[] = [];
    for (let day = 1; day <= 12; day++) {
      runs.push((await uploadRun(db, runner, steadyRun(await nextMonth(day), 1_200, 420))).runId);
    }
    const done = await db.rpc(runner, 'get_challenge', { p_challenge_id: id });
    const lastDay = (await db.one<{ d: string }>(`select to_char(private.challenge_month(1) + 11, 'YYYY-MM-DD') as d`)).d;
    expect(done).toMatchObject({ progress: 12, completed: true, completed_on: lastDay });
    const badges = await db.rpc(runner, 'get_badges');
    expect(badges.challenges).toEqual([
      expect.objectContaining({ challenge_id: id, title: `Run 12 days in ${await monthName(1)}`, scope: 'global', metric: 'active_days', target: 12, earned_on: lastDay }),
    ]);
    // Challenges never award XP: lifetime XP is the runs' own.
    expect(badges.progress.lifetime_xp).toBe(12 * (12 + 25));

    await db.rpc(runner, 'delete_run', { p_run_id: runs[4] });
    expect(await db.rpc(runner, 'get_challenge', { p_challenge_id: id })).toMatchObject({ progress: 11, completed: false, completed_on: null });
    expect((await db.rpc(runner, 'get_badges')).challenges).toEqual([]);

    // Leaving before it ends; there's nothing to report on a monthly challenge.
    expect(await db.rpc(runner, 'leave_challenge', { p_challenge_id: id })).toEqual({ left: true, challenge_id: id });
    expect((await db.rpc(runner, 'get_challenge', { p_challenge_id: id })).joined).toBe(false);
    await expectCode(db.rpc(runner, 'report_content', { p_kind: 'challenge', p_id: id, p_reason: 'spam' }), 'not_found');
  });
});

describe('fair challenges', () => {
  it('can’t be won by one very long run or by splitting runs', async () => {
    const { owner, members, leagueId } = await league('Fair Fay', ['Long Lou', 'Split Sam', 'Steady Stella']);
    const [lou, sam, stella] = members as [TestUser, TestUser, TestUser];
    const days = await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 3, p_month_offset: 1, p_league_id: leagueId });
    const score = await db.rpc(owner, 'create_challenge', { p_metric: 'capped_score', p_target: 150, p_month_offset: 1, p_league_id: leagueId });
    for (const m of members) {
      await db.rpc(m, 'join_challenge', { p_challenge_id: days.id });
      await db.rpc(m, 'join_challenge', { p_challenge_id: score.id });
    }

    // Lou: one marathon on the 3rd. Sam: 10 km as ten 1 km runs the same day. Stella: 4 km on
    // three days. Lou ran more than three times as far as Stella.
    await uploadRun(db, lou, steadyRun(await nextMonth(3), 42_200, 14_400, { sampleIntervalS: 5 }));
    for (let i = 0; i < 10; i++) {
      await uploadRun(db, sam, steadyRun((await nextMonth(3)) + i * 30 * 60_000, 1_000, 360));
    }
    for (const day of [3, 4, 5]) {
      await uploadRun(db, stella, steadyRun(await nextMonth(day), 4_000, 1_440));
    }

    const dayBoard = (await db.rpc(owner, 'get_challenge', { p_challenge_id: days.id })).board;
    expect(dayBoard.rows.map((r: any) => [r.rank, r.alias, r.progress, r.completed])).toEqual([
      [1, 'Steady Stella', 3, true],
      [2, 'Long Lou', 1, false],
      [2, 'Split Sam', 1, false],
      [4, 'Fair Fay', 0, false],
    ]);
    expect(dayBoard.finished).toBe(1);

    // A day's XP stops at 125 however far or however many runs: the marathon and the ten short
    // runs each make one day of 125, short of three ordinary days.
    const scoreBoard = (await db.rpc(owner, 'get_challenge', { p_challenge_id: score.id })).board;
    const fifth = (await db.one<{ d: string }>(`select to_char(private.challenge_month(1) + 4, 'YYYY-MM-DD') as d`)).d;
    expect(scoreBoard.rows.map((r: any) => [r.rank, r.alias, r.progress, r.completed_on])).toEqual([
      [1, 'Steady Stella', 195, fifth],
      [2, 'Long Lou', 125, null],
      [2, 'Split Sam', 125, null],
      [4, 'Fair Fay', 0, null],
    ]);
    expect(scoreBoard.me).toMatchObject({ alias: 'Fair Fay', is_me: true, progress: 0 });
  });

  it('counts each week’s best three days, accepted runs only, and only runs the server had by a day after the end', async () => {
    const { owner, leagueId } = await league('Week Wes', []);
    const score = await db.rpc(owner, 'create_challenge', { p_metric: 'capped_score', p_target: 1_500, p_month_offset: 1, p_league_id: leagueId });
    // Monday to Friday of the month's first full week: 20, 30, 40, 50 and 60 XP of distance, each
    // with the 25 bonus. The best three count: 85 + 75 + 65.
    const monday = (await db.one<{ d: number }>(`select 1 + (8 - extract(isodow from private.challenge_month(1))::integer) % 7 as d`)).d;
    const uploaded: string[] = [];
    for (const [i, km] of [2, 3, 4, 5, 6].entries()) {
      uploaded.push((await uploadRun(db, owner, steadyRun(await nextMonth(monday + i), km * 1_000, km * 360))).runId);
    }
    expect((await db.rpc(owner, 'get_challenge', { p_challenge_id: score.id })).progress).toBe(85 + 75 + 65);

    // A run the server first had after the cutoff doesn't count, even once it's accepted.
    await db.sql(`update public.runs set first_received_at = private.day_start(private.month_last_day(private.challenge_month(1)) + 2) + interval '1 hour' where id = $1`, [
      uploaded[4],
    ]);
    expect((await db.rpc(owner, 'get_challenge', { p_challenge_id: score.id })).progress).toBe(75 + 65 + 55);
    // A run held for review doesn't count until it's accepted.
    await db.sql(`update public.runs set status = 'review' where id = $1`, [uploaded[3]]);
    expect((await db.rpc(owner, 'get_challenge', { p_challenge_id: score.id })).progress).toBe(65 + 55 + 45);
  });
});

describe('league and club challenges', () => {
  it('are set by a league’s owner or a club’s admins, for members only, three at a time', async () => {
    const { owner, members, leagueId } = await league('Set Sue', ['Set Member']);
    const [member] = members as [TestUser];
    await withDevice(member);
    const outsider = await db.createRunner('Set Outsider');

    await expectCode(db.rpc(member, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_league_id: leagueId }), 'not_league_owner');
    await expectCode(db.rpc(outsider, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_league_id: leagueId }), 'not_in_league');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 8 }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'distance', p_target: 8, p_league_id: leagueId }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 1, p_league_id: leagueId }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 32, p_league_id: leagueId }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'capped_score', p_target: 50, p_league_id: leagueId }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'capped_score', p_target: 1_600, p_league_id: leagueId }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_month_offset: 2, p_league_id: leagueId }), 'invalid_input');
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_title: 'ab', p_league_id: leagueId }), 'challenge_invalid');
    await expectCode(
      db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_title: 'join www.spam.com', p_league_id: leagueId }),
      'challenge_not_allowed',
    );

    const created = await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_title: 'Hill month', p_month_offset: 1, p_league_id: leagueId });
    expect(created).toMatchObject({
      scope: 'league',
      league_id: leagueId,
      group_name: 'Set Sue crew',
      title: 'Hill month',
      custom_title: true,
      joined: true,
      can_manage: true,
      is_creator: true,
      participants: 1,
    });
    // League members hear about it.
    expect(await db.sql('select kind, title, body, url from private.push_outbox where user_id = $1', [member.id])).toEqual([
      { kind: 'league', title: 'New challenge in Set Sue crew', body: 'Set Sue started “Hill month”. Are you in?', url: `/league/challenges/${created.id}` },
    ]);
    const seen = await db.rpc(member, 'get_challenge', { p_challenge_id: created.id });
    expect(seen).toMatchObject({ joined: false, can_manage: false, created_by: 'Set Sue', board: { rows: [expect.objectContaining({ alias: 'Set Sue' })] } });
    expect((await db.rpc(member, 'list_challenges')).current.map((c: any) => c.id)).toContain(created.id);
    await expectCode(db.rpc(outsider, 'get_challenge', { p_challenge_id: created.id }), 'not_found');
    await expectCode(db.rpc(outsider, 'join_challenge', { p_challenge_id: created.id }), 'not_found');
    expect((await db.rpc(outsider, 'list_challenges')).current.map((c: any) => c.id)).not.toContain(created.id);
    await expectCode(db.rpc(member, 'remove_challenge', { p_challenge_id: created.id }), 'not_allowed');

    await db.rpc(owner, 'create_challenge', { p_metric: 'capped_score', p_target: 500, p_league_id: leagueId });
    await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 10, p_month_offset: 1, p_league_id: leagueId });
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 6, p_league_id: leagueId }), 'challenge_limit');
    expect(await db.rpc(owner, 'remove_challenge', { p_challenge_id: created.id })).toEqual({ removed: true });
    await expectCode(db.rpc(member, 'get_challenge', { p_challenge_id: created.id }), 'not_found');
    await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 6, p_league_id: leagueId });
    await expectCode(db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 4, p_month_offset: 1, p_league_id: leagueId }), 'challenge_limit');
  });

  it('lets club admins set and remove challenges, recorded when it’s someone else’s', async () => {
    const { owner, members, clubId } = await club('Club Cal', ['Club Admin Ann', 'Club Member Max']);
    const [admin, member] = members as [TestUser, TestUser];
    const adminMember = await db.one<{ id: string }>('select id from private.club_members where club_id = $1 and user_id = $2', [clubId, admin.id]);
    await db.rpc(owner, 'promote_club_admin', { p_club_id: clubId, p_member_id: adminMember.id });
    await expectCode(db.rpc(member, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_club_id: clubId }), 'not_club_admin');

    await withDevice(member);
    const created = await db.rpc(owner, 'create_challenge', { p_metric: 'capped_score', p_target: 600, p_month_offset: 1, p_club_id: clubId });
    expect(created).toMatchObject({ scope: 'club', club_id: clubId, group_name: 'Club Cal Club', title: `Score 600 in ${await monthName(1)}`, custom_title: false });
    // A club can be hundreds of people: no push, it's on the club page.
    expect(await db.sql('select 1 from private.push_outbox where user_id = $1', [member.id])).toEqual([]);

    await db.rpc(member, 'join_challenge', { p_challenge_id: created.id });
    expect((await db.rpc(admin, 'get_challenge', { p_challenge_id: created.id })).board.rows.map((r: any) => r.alias).sort()).toEqual(['Club Cal', 'Club Member Max']);
    // A member who leaves the club leaves its boards.
    await db.rpc(member, 'leave_club', { p_club_id: clubId });
    expect((await db.rpc(admin, 'get_challenge', { p_challenge_id: created.id })).board.rows.map((r: any) => r.alias)).toEqual(['Club Cal']);

    expect(await db.rpc(admin, 'remove_challenge', { p_challenge_id: created.id })).toEqual({ removed: true });
    expect(
      await db.sql('select action, target_user_id, target_club_id from private.moderation_actions where moderator_id = $1', [admin.id]),
    ).toEqual([{ action: 'challenge_removed', target_user_id: owner.id, target_club_id: clubId }]);
  });

  it('closes when the month is over: no joining or leaving, and it moves to the past', async () => {
    const { owner, members, leagueId } = await league('Closed Cleo', ['Closed Carl']);
    const [member] = members as [TestUser];
    const created = await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 5, p_league_id: leagueId });
    await db.sql(`update private.challenges set starts_on = private.challenge_month(-2), ends_on = private.month_last_day(private.challenge_month(-2)) where id = $1`, [
      created.id,
    ]);
    await expectCode(db.rpc(member, 'join_challenge', { p_challenge_id: created.id }), 'challenge_closed');
    await expectCode(db.rpc(owner, 'leave_challenge', { p_challenge_id: created.id }), 'challenge_closed');
    await expectCode(db.rpc(owner, 'remove_challenge', { p_challenge_id: created.id }), 'challenge_closed');
    const list = await db.rpc(owner, 'list_challenges');
    expect(list.current.map((c: any) => c.id)).not.toContain(created.id);
    expect(list.past).toEqual([expect.objectContaining({ id: created.id, state: 'final', joined: true })]);
    // It no longer counts against the three open challenges.
    await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 5, p_league_id: leagueId });
  });

  it('keeps a blocked runner on the board without a name', async () => {
    const { owner, members, leagueId } = await league('Block Bo', ['Block Bert']);
    const [member] = members as [TestUser];
    const created = await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 5, p_month_offset: 1, p_league_id: leagueId });
    await db.rpc(member, 'join_challenge', { p_challenge_id: created.id });
    const publicId = (await db.rpc(member, 'get_social_settings')).public_id as string;
    await db.rpc(owner, 'block_runner', { p_public_id: publicId });
    const board = (await db.rpc(owner, 'get_challenge', { p_challenge_id: created.id })).board;
    expect(board.rows.find((r: any) => r.hidden)).toMatchObject({ alias: null, tier: null, progress: 0 });
    expect((await db.rpc(member, 'get_challenge', { p_challenge_id: created.id })).created_by).toBeNull();
  });
});

describe('challenge reports', () => {
  it('reach the moderation queue, where a moderator can reset the name or remove the challenge', async () => {
    await db.sql('delete from private.reports');
    const { owner, members, clubId } = await club('Report Rae', ['Report Rob', 'Report Ros']);
    const [rob, ros] = members as [TestUser, TestUser];
    const first = await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 10, p_title: 'Rude name', p_month_offset: 1, p_club_id: clubId });
    await expectCode(db.rpc(owner, 'report_content', { p_kind: 'challenge', p_id: first.id, p_reason: 'offensive_name' }), 'not_found');
    const onFirst = await db.rpc(rob, 'report_content', { p_kind: 'challenge', p_id: first.id, p_reason: 'offensive_name' });
    expect(await db.rpc(rob, 'report_content', { p_kind: 'challenge', p_id: first.id, p_reason: 'offensive_name' })).toMatchObject({
      report_id: onFirst.report_id,
    });

    const moderator = await db.createRunner('Challenge Mod');
    await db.sql(`select private.grant_staff_role($1, 'moderator', 'challenge reports', 'ops-test')`, [moderator.id]);
    const queue = await db.rpc(moderator, 'mod_list_reports');
    expect(queue.find((r: any) => r.report_id === onFirst.report_id)).toMatchObject({
      target_kind: 'challenge',
      content_snapshot: { alias: 'Report Rae', title: 'Rude name', custom_title: true, metric: 'active_days', target: 10, group: 'Report Rae Club' },
      target_state: { removed: false, title: 'Rude name' },
      actions: ['dismiss', 'reset_challenge_name', 'remove_challenge', 'reset_alias'],
    });
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: onFirst.report_id, p_action: 'reset_challenge_name', p_reason: 'Offensive name' });
    expect(await db.rpc(rob, 'get_challenge', { p_challenge_id: first.id })).toMatchObject({ title: `Run 10 days in ${await monthName(1)}`, custom_title: false });

    // Removing it settles every open report about it.
    const second = await db.rpc(owner, 'create_challenge', { p_metric: 'active_days', p_target: 9, p_title: 'Promo month', p_month_offset: 1, p_club_id: clubId });
    const a = await db.rpc(rob, 'report_content', { p_kind: 'challenge', p_id: second.id, p_reason: 'spam' });
    const b = await db.rpc(ros, 'report_content', { p_kind: 'challenge', p_id: second.id, p_reason: 'spam' });
    expect(await db.rpc(moderator, 'mod_resolve_report', { p_report_id: a.report_id, p_action: 'remove_challenge', p_reason: 'Spam' })).toMatchObject({
      status: 'actioned',
      also_resolved: 1,
    });
    expect(await db.one('select status, resolution from private.reports where id = $1', [b.report_id])).toEqual({ status: 'actioned', resolution: 'remove_challenge' });
    await expectCode(db.rpc(rob, 'get_challenge', { p_challenge_id: second.id }), 'not_found');
  });
});

describe('challenge export', () => {
  it('lists the runner’s challenges with their progress', async () => {
    const runner = await db.createRunner('Export Ella');
    await db.rpc(runner, 'list_challenges');
    const id = await globalChallenge(1, 'capped_score');
    await db.rpc(runner, 'join_challenge', { p_challenge_id: id });
    await uploadRun(db, runner, steadyRun(await nextMonth(2), 3_000, 1_080));
    const extras = (await db.one<{ x: any }>('select private.export_extras($1) as x', [runner.id])).x;
    expect(extras.challenges).toEqual([
      expect.objectContaining({ title: `Score 750 in ${await monthName(1)}`, scope: 'global', metric: 'capped_score', target: 750, progress: 55, completed_on: null }),
    ]);
  });
});
