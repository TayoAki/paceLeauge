import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { currentWeekStartMs, inCurrentWeek, uploadRun } from './helpers/runs';

/**
 * Leagues 2.0 (docs/ROADMAP.md 4.1): several leagues per runner with standings per league,
 * seasons and champions (across a daylight-saving change), duels, the weekly recap, group runs,
 * the group-chat link and the family template.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const BEFORE_WEEK = currentWeekStartMs() - 2 * 86_400_000;
const at = (iso: string) => Date.parse(iso);

async function league(ownerAlias: string, memberAliases: string[], options: { name?: string; kind?: string } = {}) {
  const owner = await db.createRunner(ownerAlias);
  const created = await db.rpc(owner, 'create_league', { p_name: options.name ?? `${ownerAlias} crew`, p_kind: options.kind ?? 'friends' });
  const leagueId = created.league.id as string;
  const invite = await db.rpc(owner, 'create_league_invite', { p_league_id: leagueId });
  const members: TestUser[] = [];
  for (const alias of memberAliases) {
    const m = await db.createRunner(alias);
    await db.rpc(m, 'join_league', { p_code: invite.code });
    members.push(m);
  }
  const memberId = async (user: TestUser) =>
    (await db.one<{ id: string }>('select id from public.league_members where league_id = $1 and user_id = $2 and left_at is null', [leagueId, user.id])).id;
  return { owner, members, leagueId, code: invite.code as string, memberId };
}

/** Moves one membership's start (the helper in runs.ts moves all of a runner's memberships). */
async function joinedAt(user: TestUser, leagueId: string, ms: number) {
  await db.sql('update public.league_members set joined_at = to_timestamp($3::bigint / 1000.0) where user_id = $1 and league_id = $2 and left_at is null', [
    user.id,
    leagueId,
    ms,
  ]);
}

function zoneAtHour(hour: number): string {
  const offset = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? 'Etc/GMT' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function withDevice(user: TestUser, hour = 12) {
  const token = `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`;
  await db.rpc(user, 'register_push_token', { p_token: token, p_platform: 'ios' });
  await db.sql('update public.profiles set notification_tz = $2 where user_id = $1', [user.id, zoneAtHour(hour)]);
}

const pushes = (user: TestUser) =>
  db.sql<{ kind: string; title: string; body: string; send_after: Date }>('select kind, title, body, send_after from private.push_outbox where user_id = $1 order by id', [
    user.id,
  ]);

describe('several leagues', () => {
  it('keeps standings per league, counting each league from when the runner joined it', async () => {
    const a = await league('Multi Owner', []);
    const b = await league('Other Owner', []);
    const runner = a.owner;
    await joinedAt(runner, a.leagueId, BEFORE_WEEK);
    await uploadRun(db, runner, steadyRun(inCurrentWeek(0), 5_250, 1888)); // 77 XP, Monday
    await db.rpc(runner, 'join_league', { p_code: b.code });
    await joinedAt(runner, b.leagueId, inCurrentWeek(1));
    await joinedAt(b.owner, b.leagueId, BEFORE_WEEK);
    await uploadRun(db, runner, steadyRun(inCurrentWeek(2), 6_450, 2342)); // 89 XP, Wednesday

    const inA = await db.rpc(runner, 'get_my_league', { p_league_id: a.leagueId });
    const inB = await db.rpc(runner, 'get_my_league', { p_league_id: b.leagueId });
    expect(inA.me).toMatchObject({ weekly_xp: 166, rank: 1 });
    expect(inB.me).toMatchObject({ weekly_xp: 89 });
    expect(inB.league).toMatchObject({ name: 'Other Owner crew', is_owner: false, kind: 'friends' });
    // Without a league id, the first league joined; the switcher lists both in that order.
    expect((await db.rpc(runner, 'get_my_league')).league.id).toBe(a.leagueId);
    expect(inA.leagues.map((l: any) => [l.name, l.is_owner])).toEqual([
      ['Multi Owner crew', true],
      ['Other Owner crew', false],
    ]);
    expect(inA.max_leagues).toBe(5);

    // A league the runner isn't in shows nothing but their own leagues.
    const outsider = await league('Outside Owner', []);
    expect(await db.rpc(runner, 'get_my_league', { p_league_id: outsider.leagueId })).toMatchObject({ league: null, leagues: expect.any(Array) });
    await expectCode(db.rpc(runner, 'rename_league', { p_name: 'Hijacked', p_league_id: outsider.leagueId }), 'not_in_league');
    await expectCode(db.rpc(runner, 'rename_league', { p_name: 'Not Mine', p_league_id: b.leagueId }), 'not_league_owner');
    expect((await db.rpc(runner, 'rename_league', { p_name: 'Renamed Alpha', p_league_id: a.leagueId })).league.name).toBe('Renamed Alpha');

    // Cheers and leaving work per league.
    const ownerB = await b.memberId(b.owner);
    expect((await db.rpc(runner, 'cheer_member', { p_member_id: ownerB })).league_id).toBe(b.leagueId);
    expect((await db.rpc(b.owner, 'get_league_cheers', { p_league_id: b.leagueId })).cheered_me).toEqual(['Multi Owner']);
    await expectCode(db.rpc(runner, 'cheer_member', { p_member_id: await outsider.memberId(outsider.owner) }), 'not_found');
    await db.rpc(runner, 'leave_league', { p_league_id: b.leagueId });
    expect((await db.rpc(runner, 'get_my_league')).leagues.map((l: any) => l.name)).toEqual(['Renamed Alpha']);
  });

  it('makes family leagues from the template, and shows the chat link to members only', async () => {
    const fam = await league('Parent Pat', ['Kid Kim'], { name: 'The Pat family', kind: 'family' });
    const [kid] = fam.members as [TestUser];
    expect((await db.rpc(kid, 'get_my_league')).league.kind).toBe('family');
    expect((await db.rpc('anon', 'get_invite_preview', { p_code: fam.code })).kind).toBe('family');
    await expectCode(db.rpc(fam.owner, 'create_league', { p_name: 'Odd Kind', p_kind: 'school' }), 'invalid_input');

    await expectCode(db.rpc(fam.owner, 'set_league_chat_link', { p_url: 'https://evil.example/join', p_league_id: fam.leagueId }), 'invalid_input');
    await expectCode(db.rpc(fam.owner, 'set_league_chat_link', { p_url: 'http://chat.whatsapp.com/AbCdEfGhIj12', p_league_id: fam.leagueId }), 'invalid_input');
    await expectCode(db.rpc(kid, 'set_league_chat_link', { p_url: 'https://chat.whatsapp.com/AbCdEfGhIj12' }), 'not_league_owner');
    await db.rpc(fam.owner, 'set_league_chat_link', { p_url: 'https://chat.whatsapp.com/AbCdEfGhIj12', p_league_id: fam.leagueId });
    expect((await db.rpc(kid, 'get_my_league')).league.chat_url).toBe('https://chat.whatsapp.com/AbCdEfGhIj12');
    expect(JSON.stringify(await db.rpc('anon', 'get_invite_preview', { p_code: fam.code }))).not.toContain('whatsapp');
    await db.rpc(fam.owner, 'set_league_chat_link', { p_url: 'https://discord.gg/pace-crew', p_league_id: fam.leagueId });
    await db.rpc(fam.owner, 'set_league_chat_link', { p_url: '', p_league_id: fam.leagueId });
    expect((await db.rpc(kid, 'get_my_league')).league.chat_url).toBeNull();
  });

  it('leaves every league when the account is deleted, handing each owned league on', async () => {
    const a = await league('Leaver Lou', ['Stayer Sue']);
    const b = await league('Host Hal', []);
    const [sue] = a.members as [TestUser];
    await db.rpc(a.owner, 'join_league', { p_code: b.code });
    await db.rpc(a.owner, 'request_account_deletion', {}, { recentAuth: true });
    const left = await db.sql<{ left_reason: string }>('select left_reason from public.league_members where user_id = $1 order by joined_at', [a.owner.id]);
    expect(left.map((l) => l.left_reason)).toEqual(['account_deleted', 'account_deleted']);
    expect((await db.rpc(sue, 'get_my_league')).league).toMatchObject({ is_owner: true, member_count: 1 });
  });
});

describe('seasons', () => {
  it('settles a four-week season across the end of daylight saving time, champions only once', async () => {
    // The season from Monday 13 October to Sunday 9 November 2025; clocks fell back on 2 November.
    const { owner, members, leagueId } = await league('Season Sol', ['Season Sam']);
    const [sam] = members as [TestUser];
    await db.sql(`update public.leagues set created_at = '2025-09-01T00:00:00Z' where id = $1`, [leagueId]);
    for (const u of [owner, sam]) await joinedAt(u, leagueId, at('2025-09-01T00:00:00Z'));

    await uploadRun(db, owner, steadyRun(at('2025-10-13T12:00:00Z'), 5_250, 1888)); // 77, week 1
    // Sunday 9 November from 23:00 to 23:39 CST, the season's last evening: it counts. (With the
    // clocks still on daylight time, midnight would have been 05:00 UTC and cut it out.)
    await uploadRun(db, owner, steadyRun(at('2025-11-10T05:00:00Z'), 6_450, 2342)); // 89, week 4
    await uploadRun(db, sam, steadyRun(at('2025-10-21T12:00:00Z'), 6_450, 2342)); // 89, week 2
    // Monday 10 November at 00:30 CST belongs to the next season.
    await uploadRun(db, sam, steadyRun(at('2025-11-10T06:30:00Z'), 6_450, 2342));

    const season = await db.one<{ s: any[] }>(`select private.league_season($1, '2025-10-13', $2, '2025-11-03') as s`, [leagueId, owner.id]);
    expect(season.s.map((r) => [r.rank, r.alias, r.season_xp])).toEqual([
      [1, 'Season Sol', 166],
      [2, 'Season Sam', 89],
    ]);
    const next = await db.one<{ s: any[] }>(`select private.league_season($1, '2025-11-10', $2, '2025-11-10') as s`, [leagueId, sam.id]);
    expect(next.s.find((r) => r.alias === 'Season Sam').season_xp).toBe(89);

    // Final a day after the season ends: Tuesday 11 November 00:00 CST (06:00 UTC).
    expect((await db.one<{ n: number }>(`select private.settle_seasons('2025-11-11T05:59:00Z') as n`)).n).toBe(0);
    expect((await db.one<{ n: number }>(`select private.settle_seasons('2025-11-11T06:01:00Z') as n`)).n).toBe(1);
    expect((await db.one<{ n: number }>(`select private.settle_seasons('2025-11-11T07:00:00Z') as n`)).n).toBe(0);
    const champions = await db.sql('select season_start::text, alias_snapshot, season_xp from private.season_champions where league_id = $1', [leagueId]);
    expect(champions).toEqual([{ season_start: '2025-10-13', alias_snapshot: 'Season Sol', season_xp: 166 }]);

    const view = await db.rpc(sam, 'get_league_season', { p_league_id: leagueId });
    // Created 1 September, in the season from 18 August: 13 October starts its third.
    expect(view.champions).toEqual([{ season_start: '2025-10-13', number: 3, alias: 'Season Sol', season_xp: 166, is_me: false }]);
    expect(view.week).toBeGreaterThanOrEqual(1);
    expect(view.week).toBeLessThanOrEqual(4);
    expect(view.ends_on).toBe(new Date(Date.parse(`${view.starts_on}T00:00:00Z`) + 27 * 86_400_000).toISOString().slice(0, 10));
  });

  it('shares the title on a tie, and names no champion when nobody ran', async () => {
    const tied = await league('Tie Tia', ['Tie Tom']);
    const quiet = await league('Quiet Quinn', ['Quiet Quade']);
    for (const l of [tied, quiet]) {
      await db.sql(`update public.leagues set created_at = '2025-09-01T00:00:00Z' where id = $1`, [l.leagueId]);
      for (const u of [l.owner, ...l.members]) await joinedAt(u, l.leagueId, at('2025-09-01T00:00:00Z'));
    }
    await uploadRun(db, tied.owner, steadyRun(at('2025-10-14T12:00:00Z'), 5_250, 1888));
    await uploadRun(db, tied.members[0]!, steadyRun(at('2025-10-15T12:00:00Z'), 5_250, 1888));
    await db.sql(`select private.settle_seasons('2025-11-12T12:00:00Z')`);
    const rows = await db.sql<{ league_id: string; alias_snapshot: string }>(
      'select league_id, alias_snapshot from private.season_champions where league_id = any($1) order by alias_snapshot',
      [[tied.leagueId, quiet.leagueId]],
    );
    expect(rows.map((r) => r.alias_snapshot)).toEqual(['Tie Tia', 'Tie Tom']);
  });
});

describe('duels', () => {
  it('challenges a league-mate for the week, who accepts or declines', async () => {
    const { owner, members, memberId } = await league('Duel Dana', ['Duel Dev', 'Duel Dot', 'Duel Dru', 'Duel Dee']);
    const [dev, dot, dru, dee] = members as [TestUser, TestUser, TestUser, TestUser];
    await withDevice(dev);

    const [pending] = await db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(dev) });
    expect(pending).toMatchObject({ status: 'pending', i_challenged: true, opponent: { alias: 'Duel Dev' }, state: 'in_progress', result: null });
    expect((await pushes(dev)).map((p) => p.title)).toEqual(['Duel challenge']);
    await expectCode(db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(dev) }), 'duel_exists');
    await expectCode(db.rpc(dev, 'challenge_duel', { p_member_id: await memberId(owner) }), 'duel_exists');
    await expectCode(db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(owner) }), 'cannot_target_self');

    const [accepted] = await db.rpc(dev, 'respond_duel', { p_duel_id: pending.id, p_accept: true });
    expect(accepted).toMatchObject({ status: 'accepted', i_challenged: false, opponent: { alias: 'Duel Dana' } });
    await expectCode(db.rpc(owner, 'respond_duel', { p_duel_id: pending.id, p_accept: true }), 'not_found');

    const against = (list: any[], alias: string) => list.find((d) => d.opponent.alias === alias);
    const declinable = against(await db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(dot) }), 'Duel Dot');
    expect(await db.rpc(dot, 'respond_duel', { p_duel_id: declinable.id, p_accept: false })).toEqual([]);
    await db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(dru) });
    const cancellable = against(await db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(dee) }), 'Duel Dee');
    // Three open duels a week at most (dev, dru and dee).
    await expectCode(db.rpc(owner, 'challenge_duel', { p_member_id: await memberId(dot) }), 'duel_limit');
    await db.rpc(owner, 'cancel_duel', { p_duel_id: cancellable.id });
    expect((await db.rpc(owner, 'list_duels')).map((d: any) => d.opponent.alias)).toEqual(['Duel Dev', 'Duel Dru']);

    // Blocked runners can't duel, and a duel never reaches outside the league.
    await db.rpc(dot, 'block_member', { p_member_id: await memberId(dru) });
    await expectCode(db.rpc(dru, 'challenge_duel', { p_member_id: await memberId(dot) }), 'not_found');
    const other = await league('Far Away', []);
    await expectCode(db.rpc(owner, 'challenge_duel', { p_member_id: await other.memberId(other.owner) }), 'not_found');
  });

  it('decides a duel on the week’s capped score once the week is final', async () => {
    const { owner, members, leagueId } = await league('Final Fay', ['Final Flo']);
    const [flo] = members as [TestUser];
    for (const u of [owner, flo]) await joinedAt(u, leagueId, at('2026-08-01T00:00:00Z'));
    await db.sql(
      `insert into private.duels (league_id, week_start, challenger_id, opponent_id, status) values ($1, '2026-08-31', $2, $3, 'accepted')`,
      [leagueId, owner.id, flo.id],
    );
    await uploadRun(db, owner, steadyRun(at('2026-08-31T12:00:00Z'), 5_250, 1888)); // 77
    await uploadRun(db, flo, steadyRun(at('2026-09-01T12:00:00Z'), 6_450, 2342)); // 89
    const [mine] = (await db.one<{ d: any[] }>(`select private.duels_json($1, $2, '2026-08-31') as d`, [owner.id, leagueId])).d;
    expect(mine).toMatchObject({ state: 'final', my_xp: 77, opponent: { alias: 'Final Flo', weekly_xp: 89 }, result: 'lost' });
    const [theirs] = (await db.one<{ d: any[] }>(`select private.duels_json($1, $2, '2026-08-31') as d`, [flo.id, leagueId])).d;
    expect(theirs.result).toBe('won');
  });
});

describe('group runs', () => {
  it('plans a run with a meeting point, takes RSVPs, and tells people when it changes', async () => {
    const { owner, members, leagueId } = await league('Group Gia', ['Group Gus', 'Group Gil']);
    const [gus, gil] = members as [TestUser, TestUser];
    await withDevice(gus);
    const outsider = await db.createRunner('Group Outsider');
    const saturday = Date.now() + 2 * 86_400_000;

    await expectCode(db.rpc(gus, 'create_group_run', { p_title: 'Past run', p_starts_at_ms: Date.now() - 60_000, p_meeting_point: 'The pier' }), 'invalid_input');
    await expectCode(
      db.rpc(gus, 'create_group_run', { p_title: 'Long run', p_starts_at_ms: saturday, p_meeting_point: 'The pier', p_notes: 'details at www.spam.test.com' }),
      'comment_not_allowed',
    );
    await expectCode(db.rpc(outsider, 'create_group_run', { p_title: 'Crash it', p_starts_at_ms: saturday, p_meeting_point: 'Pier', p_league_id: leagueId }), 'not_in_league');
    const run = await db.rpc(owner, 'create_group_run', {
      p_title: '  Saturday   long run ',
      p_starts_at_ms: saturday,
      p_meeting_point: 'Lakefront Trail at Fullerton',
      p_notes: 'Easy pace, coffee after.',
      p_league_id: leagueId,
    });
    expect(run).toMatchObject({ title: 'Saturday long run', host: 'Group Gia', is_host: true, can_edit: true, my_rsvp: 'going', going: ['Group Gia'], going_count: 1 });
    expect((await pushes(gus)).map((p) => [p.title, p.body.startsWith('Group Gia planned “Saturday long run”, ')])).toEqual([['Group run in Group Gia crew', true]]);

    expect(await db.rpc(gus, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'going' })).toMatchObject({ going_count: 2, my_rsvp: 'going', can_edit: false });
    expect(await db.rpc(gil, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'maybe' })).toMatchObject({ going_count: 2, maybe_count: 1 });
    await expectCode(db.rpc(outsider, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'going' }), 'not_found');
    await expectCode(db.rpc(gus, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'probably' }), 'invalid_input');
    expect((await db.rpc(gil, 'list_group_runs')).map((g: any) => g.title)).toEqual(['Saturday long run']);
    await expectCode(db.rpc(outsider, 'list_group_runs', { p_league_id: leagueId }), 'not_in_league');

    await expectCode(
      db.rpc(gus, 'update_group_run', { p_group_run_id: run.id, p_title: 'Mine now', p_starts_at_ms: saturday, p_meeting_point: 'Pier' }),
      'not_allowed',
    );
    await db.rpc(owner, 'update_group_run', {
      p_group_run_id: run.id,
      p_title: 'Saturday long run',
      p_starts_at_ms: saturday + 3_600_000,
      p_meeting_point: 'Lakefront Trail at Fullerton',
    });
    await db.rpc(owner, 'cancel_group_run', { p_group_run_id: run.id });
    expect((await pushes(gus)).map((p) => p.title)).toEqual(['Group run in Group Gia crew', 'Group run changed', 'Group run cancelled']);
    expect((await db.rpc(gus, 'list_group_runs'))[0]).toMatchObject({ cancelled: true });
    await expectCode(db.rpc(gus, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'going' }), 'invalid_input');
  });

  it('reminds everyone going an hour before, even early in the morning', async () => {
    const { owner, members } = await league('Early Eve', ['Early Eli']);
    const [eli] = members as [TestUser];
    await withDevice(eli, 5);
    const run = await db.rpc(owner, 'create_group_run', { p_title: 'Sunrise run', p_starts_at_ms: Date.now() + 60 * 60_000, p_meeting_point: 'Track gate' });
    await db.rpc(eli, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'going' });
    await db.sql('delete from private.push_outbox where user_id = $1', [eli.id]);
    expect((await db.one<{ n: number }>('select private.enqueue_group_run_reminders() as n')).n).toBe(1);
    expect((await db.one<{ n: number }>('select private.enqueue_group_run_reminders() as n')).n).toBe(0);
    const [reminder] = await pushes(eli);
    expect(reminder).toMatchObject({ kind: 'league', title: 'Group run soon' });
    expect(reminder!.body).toMatch(/^“Sunrise run” starts at \w{3} \d{1,2}:\d{2} (AM|PM) at Track gate\.$/);
    // It's 05:00 where Eli is, and the reminder still goes now.
    expect(reminder!.send_after.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);

    // A month after it happened, the group run and its meeting point are gone.
    await db.sql(`update private.group_runs set starts_at = now() - interval '31 days' where id = $1`, [run.id]);
    expect((await db.one<{ r: any }>('select private.purge_expired() as r')).r.group_runs).toBeGreaterThanOrEqual(1);
    expect(await db.sql('select 1 from private.group_runs where id = $1', [run.id])).toEqual([]);
  });
});

describe('weekly recap', () => {
  it('sums the league’s week and the runner’s own', async () => {
    const { owner, members, memberId } = await league('Recap Rae', ['Recap Rob', 'Recap Rue']);
    const [rob] = members as [TestUser, TestUser];
    for (const u of [owner, ...members]) await db.sql('update public.league_members set joined_at = to_timestamp($2::bigint / 1000.0) where user_id = $1', [u.id, BEFORE_WEEK]);
    await uploadRun(db, owner, steadyRun(inCurrentWeek(0), 5_250, 1888));
    await uploadRun(db, rob, steadyRun(inCurrentWeek(1), 6_450, 2342));
    await uploadRun(db, rob, steadyRun(inCurrentWeek(2), 5_250, 1888));
    await db.rpc(rob, 'cheer_member', { p_member_id: await memberId(owner) });

    const recap = await db.rpc(owner, 'get_week_recap');
    expect(recap.league).toEqual({ members: 3, runs: 3, distance_m: expect.any(Number), active_runners: 2, top: { alias: 'Recap Rob', weekly_xp: 166 } });
    expect(recap.league.distance_m).toBeGreaterThan(16_900);
    expect(recap.me).toMatchObject({ runs: 1, weekly_xp: 77, rank: 2, cheers: 1, duels: { won: 0, lost: 0, tied: 0, open: 0 } });
  });
});
