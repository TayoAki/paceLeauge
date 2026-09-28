import { competitionWeekAt } from '@/domain/calendar';
import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { backdateMembership, currentWeekStartMs, inCurrentWeek, uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const WEEK_START = currentWeekStartMs();
const BEFORE_WEEK = WEEK_START - 2 * 86_400_000;

/** Creates a league owned by a new runner and returns the owner plus a fresh invite code. */
async function newLeague(name: string, ownerAlias: string) {
  const owner = await db.createRunner(ownerAlias);
  const created = await db.rpc(owner, 'create_league', { p_name: name });
  const invite = await db.rpc(owner, 'create_league_invite');
  return { owner, league: created.league, code: invite.code as string };
}

/** join_league reports invite failures as values (so rate limiting commits); surface the code. */
async function joinError(runner: TestUser, code: string): Promise<string | undefined> {
  const result = await db.rpc(runner, 'join_league', { p_code: code });
  return result.error;
}

async function joinAs(alias: string, code: string): Promise<TestUser> {
  const runner = await db.createRunner(alias);
  await db.rpc(runner, 'join_league', { p_code: code });
  return runner;
}

/** Runs on the given current-week day offsets, each `distanceM` over `durationS`. */
async function runDays(runner: TestUser, days: [dayOffset: number, distanceM: number, durationS: number][]) {
  for (const [day, distance, duration] of days) {
    await uploadRun(db, runner, steadyRun(inCurrentWeek(day), distance, duration));
  }
}

function rowsOf(view: any) {
  return view.standings.map((s: any) => [s.rank, s.hidden ? '(hidden)' : s.alias, s.weekly_xp]);
}

describe('creating, inviting and joining', () => {
  it('lets a visitor preview an invite and a runner explicitly join once', async () => {
    const { owner, league, code } = await newLeague('Friday Crew', 'Crew Owner');
    expect(league).toMatchObject({ name: 'Friday Crew', member_count: 1, capacity: 20, is_owner: true, calendar_zone: 'America/Chicago' });
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    const anonymous = await db.rpc('anon', 'get_invite_preview', { p_code: code });
    expect(anonymous).toEqual({ status: 'valid', league_name: 'Friday Crew', kind: 'friends', member_count: 1, capacity: 20, expires_at_ms: expect.any(Number) });
    // Codes are forgiving about case, separators and look-alike characters.
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`.replace(/1/g, 'l').replace(/0/g, 'o');
    expect((await db.rpc('anon', 'get_invite_preview', { p_code: typed })).status).toBe('valid');

    const maya = await db.createRunner('Maya');
    expect((await db.rpc(maya, 'get_invite_preview', { p_code: code })).status).toBe('valid');
    const joined = await db.rpc(maya, 'join_league', { p_code: code });
    expect(joined.league).toMatchObject({ name: 'Friday Crew', member_count: 2, is_owner: false });
    const again = await db.rpc(maya, 'join_league', { p_code: code });
    expect(again.league.member_count).toBe(2);
    expect((await db.rpc(maya, 'get_invite_preview', { p_code: code })).status).toBe('already_member');

    const ownerView = await db.rpc(owner, 'get_my_league');
    expect(ownerView.standings.map((s: any) => s.alias).sort()).toEqual(['Crew Owner', 'Maya']);
    // Member rows expose alias, tier and weekly XP only — never contact data or user ids.
    expect(Object.keys(ownerView.standings[0]).sort()).toEqual(['alias', 'hidden', 'is_me', 'is_owner', 'member_id', 'rank', 'tier', 'weekly_xp']);
  });

  it('reports unknown, revoked, expired, full and closed invitations explicitly', async () => {
    const { owner, code } = await newLeague('Expiry Club', 'Expiry Owner');
    const runner = await db.createRunner('Joiner One');
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: 'ZZZZZZZZ' })).status).toBe('not_found');
    expect(await joinError(runner, 'ZZZZZZZZ')).toBe('invite_not_found');

    const rotated = await db.rpc(owner, 'rotate_league_invites');
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: code })).status).toBe('revoked');
    expect(await joinError(runner, code)).toBe('invite_revoked');

    await db.sql(`update private.league_invites set expires_at = now() - interval '1 minute' where code_hash = private.invite_hash($1)`, [rotated.code]);
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: rotated.code })).status).toBe('expired');
    expect(await joinError(runner, rotated.code)).toBe('invite_expired');

    const fresh = await db.rpc(owner, 'create_league_invite');
    await db.sql(`update public.leagues set capacity = 2 where owner_id = $1`, [owner.id]);
    await joinAs('Joiner Two', fresh.code);
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: fresh.code })).status).toBe('full');
    expect(await joinError(runner, fresh.code)).toBe('league_full');

    await db.sql(`update public.leagues set status = 'closed' where owner_id = $1`, [owner.id]);
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: fresh.code })).status).toBe('closed');
    expect(await joinError(runner, fresh.code)).toBe('league_closed');
  });

  it('allows up to five leagues at a time (Leagues 2.0 lifted the one-league rule, D-008)', async () => {
    const a = await newLeague('League Alpha', 'Alpha Owner');
    const b = await newLeague('League Beta', 'Beta Owner');
    const runner = await joinAs('Both Ways', a.code);
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: b.code })).status).toBe('valid');
    expect((await db.rpc(runner, 'join_league', { p_code: b.code })).league.name).toBe('League Beta');
    for (const name of ['Third League', 'Fourth League', 'Fifth League']) await db.rpc(runner, 'create_league', { p_name: name });
    const c = await newLeague('League Gamma', 'Gamma Owner');
    expect((await db.rpc(runner, 'get_invite_preview', { p_code: c.code })).status).toBe('league_limit');
    expect(await joinError(runner, c.code)).toBe('league_limit');
    await expectCode(db.rpc(runner, 'create_league', { p_name: 'Sixth League' }), 'league_limit');
    // Without a league id, owner actions act on the first league joined, which this runner doesn't own.
    await expectCode(db.rpc(runner, 'create_league_invite'), 'not_league_owner');
  });

  it('never exceeds capacity when 25 runners join in parallel', async () => {
    const { owner, code } = await newLeague('Rush Hour', 'Rush Owner');
    const runners = await Promise.all(Array.from({ length: 25 }, (_, i) => db.createRunner(`Rusher ${i}`)));
    const results = await Promise.all(runners.map((r) => db.rpc(r, 'join_league', { p_code: code })));
    const joined = results.filter((r) => !r.error).length;
    const full = results.filter((r) => r.error === 'league_full').length;
    expect(joined).toBe(19);
    expect(full).toBe(6);
    const view = await db.rpc(owner, 'get_my_league');
    expect(view.league.member_count).toBe(20);
  });

  it('validates and filters league names', async () => {
    const runner = await db.createRunner('Namer');
    await expectCode(db.rpc(runner, 'create_league', { p_name: 'ab' }), 'league_name_invalid');
    await expectCode(db.rpc(runner, 'create_league', { p_name: 'visit www.spam.com' }), 'league_name_not_allowed');
    await expectCode(db.rpc(runner, 'create_league', { p_name: '<script>' }), 'league_name_invalid');
    await db.sql(`insert into private.blocked_terms (term) values ('badword') on conflict do nothing`);
    await expectCode(db.rpc(runner, 'create_league', { p_name: 'The B.a.d.w.o.r.d Crew' }), 'league_name_not_allowed');
  });
});

describe('weekly standings', () => {
  it('scores the best three days, ranks ties together and highlights the viewer', async () => {
    const { owner, code } = await newLeague('Standings Crew', 'Theo');
    const maya = await joinAs('Maya S', code);
    const jules = await joinAs('Jules', code);
    const you = await joinAs('You Runner', code);
    for (const r of [owner, maya, jules, you]) await backdateMembership(db, r, BEFORE_WEEK);

    // Maya: four days (125, 100, 80, 77) → 305. Jules and You tie on 257. Theo 230.
    await runDays(maya, [[0, 10_050, 3600], [1, 7_550, 2700], [2, 5_550, 2000], [3, 5_250, 1900]]);
    await runDays(jules, [[0, 6_650, 2340], [2, 6_450, 2342], [4, 5_250, 1888]]);
    await runDays(you, [[1, 6_650, 2340], [3, 6_450, 2342], [5, 5_250, 1888]]);
    await runDays(owner, [[0, 8_050, 2900], [6, 7_550, 2600]]);

    const view = await db.rpc(you, 'get_my_league');
    expect(rowsOf(view)).toEqual([
      [1, 'Maya S', 305],
      [2, 'Jules', 257],
      [2, 'You Runner', 257],
      [4, 'Theo', 205],
    ]);
    expect(view.me).toMatchObject({ rank: 2, weekly_xp: 257, is_me: true });
    expect(view.week).toMatchObject({ week_start: competitionWeekDate(), state: 'in_progress', revision: 0, offset: 0 });
    expect(view.standings.find((s: any) => s.alias === 'Theo').is_owner).toBe(true);
    // Lifetime XP keeps every day (Maya: 125 + 100 + 80 + 77), and drives the tier shown.
    expect(view.standings.find((s: any) => s.alias === 'Maya S').tier).toBe('Seed');
    const maya_me = await db.rpc(maya, 'get_me');
    expect(maya_me.lifetime_xp).toBe(382);
  });

  it('counts only segments after joining, and a rejoin starts a new membership period', async () => {
    const { owner, code } = await newLeague('Joiners Crew', 'Joiners Owner');
    const late = await db.createRunner('Late Joiner');
    // Monday's run happens before joining (no league yet).
    await runDays(late, [[0, 5_250, 1888]]);
    await db.rpc(late, 'join_league', { p_code: code });
    await backdateMembership(db, late, inCurrentWeek(1));
    await runDays(late, [[2, 6_450, 2342]]);
    let view = await db.rpc(owner, 'get_my_league');
    expect(view.standings.find((s: any) => s.alias === 'Late Joiner').weekly_xp).toBe(89);
    expect((await db.rpc(late, 'get_me')).lifetime_xp).toBe(77 + 89);

    await db.rpc(late, 'leave_league');
    await expect(db.rpc(late, 'get_my_league')).resolves.toMatchObject({ league: null });
    view = await db.rpc(owner, 'get_my_league');
    expect(view.standings.map((s: any) => s.alias)).toEqual(['Joiners Owner']);

    await db.rpc(late, 'join_league', { p_code: code });
    await backdateMembership(db, late, inCurrentWeek(3));
    view = await db.rpc(owner, 'get_my_league');
    expect(view.standings.find((s: any) => s.alias === 'Late Joiner').weekly_xp).toBe(0);
    const periods = await db.sql('select * from public.league_members where user_id = $1 order by joined_at', [late.id]);
    expect(periods).toHaveLength(2);
    expect((await db.rpc(late, 'get_me')).lifetime_xp).toBe(77 + 89);
  });

  it('excludes runs first received after the settlement deadline from that week', async () => {
    const { owner } = await newLeague('Settlement Crew', 'Settle Owner');
    await backdateMembership(db, owner, Date.parse('2026-08-01T00:00:00Z'));
    const monday = Date.parse('2026-08-31T12:00:00Z');
    await uploadRun(db, owner, steadyRun(monday, 5_250, 1888));
    // Tuesday's run first reaches the server 7.5 days later: after the week's settlement
    // deadline (Monday + 24 h) and after 72 h, so it is also held for review.
    const late = await uploadRun(db, owner, steadyRun(monday + 86_400_000, 6_450, 2342), { receivedAfterMs: 7.5 * 86_400_000 });
    await db.sql(`select private.resolve_run_review($1, 'accept', 'offline trip, verified', 'ops')`, [late.runId]);
    const standings = await db.one<{ s: any }>(`select private.league_standings(l.id, '2026-08-31', $1) as s from public.leagues l where l.owner_id = $1`, [
      owner.id,
    ]);
    expect(standings.s[0].weekly_xp).toBe(77);
    expect((await db.rpc(owner, 'get_me')).lifetime_xp).toBe(77 + 89);
  });

  it('uses the named time zone across the fall-back week', async () => {
    const { owner } = await newLeague('DST Crew', 'DST Owner');
    await backdateMembership(db, owner, Date.parse('2025-10-01T00:00:00Z'));
    // Clocks fell back on 2025-11-02. Sunday 23:30 CST is 2025-11-03T05:30Z — still that week.
    await uploadRun(db, owner, steadyRun(Date.parse('2025-11-03T05:30:00Z'), 5_250, 1500));
    // Monday 2025-11-03 00:30 CST belongs to the next week.
    await uploadRun(db, owner, steadyRun(Date.parse('2025-11-03T06:30:00Z'), 5_250, 1500));
    const rows = await db.sql<{ week: string; xp: number }>(
      `select w::text as week, (private.league_standings(l.id, w, $1) -> 0 ->> 'weekly_xp')::int as xp
       from public.leagues l, unnest(array['2025-10-27'::date, '2025-11-03'::date]) w where l.owner_id = $1 order by w`,
      [owner.id],
    );
    expect(rows).toEqual([
      { week: '2025-10-27', xp: 77 },
      { week: '2025-11-03', xp: 77 },
    ]);
  });

  it('keeps blocked members as hidden rows so ranks are not falsified', async () => {
    const { owner, code } = await newLeague('Block Crew', 'Block Owner');
    const noisy = await joinAs('Noisy', code);
    for (const r of [owner, noisy]) await backdateMembership(db, r, BEFORE_WEEK);
    await runDays(noisy, [[0, 6_450, 2342]]);
    const before = await db.rpc(owner, 'get_my_league');
    const noisyRow = before.standings.find((s: any) => s.alias === 'Noisy');
    await db.rpc(owner, 'block_member', { p_member_id: noisyRow.member_id });

    const ownerView = await db.rpc(owner, 'get_my_league');
    expect(rowsOf(ownerView)).toEqual([
      [1, '(hidden)', 89],
      [2, 'Block Owner', 0],
    ]);
    expect(ownerView.standings[0]).toMatchObject({ alias: null, tier: null, hidden: true });
    // Mutual: the blocked member cannot see the blocker either.
    const noisyView = await db.rpc(noisy, 'get_my_league');
    expect(noisyView.standings.find((s: any) => !s.is_me)).toMatchObject({ alias: null, hidden: true });

    const blocks = await db.rpc(owner, 'list_blocks');
    expect(blocks).toEqual([{ block_id: expect.any(String), alias: 'Noisy', created_at_ms: expect.any(Number) }]);
    await db.rpc(owner, 'unblock', { p_block_id: blocks[0].block_id });
    expect((await db.rpc(owner, 'get_my_league')).standings[0].alias).toBe('Noisy');
  });

  it('shows last week and labels a settled week that was later revised', async () => {
    const { owner } = await newLeague('Revision Crew', 'Revision Owner');
    const lastWeekMonday = WEEK_START - 7 * 86_400_000;
    await backdateMembership(db, owner, lastWeekMonday - 86_400_000);
    const run = await uploadRun(db, owner, steadyRun(lastWeekMonday + 12 * 3_600_000, 5_250, 1888));
    // Pretend last week settled (the deletion happens after the 24-hour deadline).
    const lastWeek = await db.rpc(owner, 'get_my_league', { p_week_offset: -1 });
    expect(lastWeek.week.offset).toBe(-1);
    expect(lastWeek.me.weekly_xp).toBe(77);
    if (Date.now() >= competitionWeekAt(lastWeekMonday).settlesAt) {
      await db.rpc(owner, 'delete_run', { p_run_id: run.runId });
      const revised = await db.rpc(owner, 'get_my_league', { p_week_offset: -1 });
      expect(revised.week).toMatchObject({ state: 'final', revision: 1 });
      expect(revised.me.weekly_xp).toBe(0);
    }
  });
});

describe('membership management', () => {
  it('requires the owner to transfer before leaving, and closes an empty league', async () => {
    const { owner, code } = await newLeague('Handover Crew', 'Handover Owner');
    const heir = await joinAs('Heir', code);
    await expectCode(db.rpc(owner, 'leave_league'), 'owner_must_transfer');
    const heirRow = (await db.rpc(owner, 'get_my_league')).standings.find((s: any) => s.alias === 'Heir');
    await expectCode(db.rpc(heir, 'remove_league_member', { p_member_id: heirRow.member_id }), 'not_league_owner');
    const transferred = await db.rpc(owner, 'transfer_league_ownership', { p_member_id: heirRow.member_id });
    expect(transferred.league.is_owner).toBe(false);
    await db.rpc(owner, 'leave_league');
    const heirView = await db.rpc(heir, 'get_my_league');
    expect(heirView.league).toMatchObject({ is_owner: true, member_count: 1 });
    await db.rpc(heir, 'leave_league');
    const league = await db.one<{ status: string }>('select status from public.leagues where name = $1', ['Handover Crew']);
    expect(league.status).toBe('closed');
  });

  it('removes a member, denies their reads immediately and blocks rejoining with an old invite', async () => {
    const { owner, code } = await newLeague('Removal Crew', 'Removal Owner');
    const removed = await joinAs('Removed', code);
    const row = (await db.rpc(owner, 'get_my_league')).standings.find((s: any) => s.alias === 'Removed');
    await expectCode(db.rpc(owner, 'remove_league_member', { p_member_id: (await db.rpc(owner, 'get_my_league')).me.member_id }), 'cannot_target_self');
    await db.rpc(owner, 'remove_league_member', { p_member_id: row.member_id });
    await expect(db.rpc(removed, 'get_my_league')).resolves.toMatchObject({ league: null });
    const leagueRows = await db.as(removed, (c) => c.query('select * from public.leagues'));
    expect(leagueRows.rows).toHaveLength(0);
    expect((await db.rpc(removed, 'get_invite_preview', { p_code: code })).status).toBe('unavailable');
    expect(await joinError(removed, code)).toBe('invite_unavailable');
  });

  it('prevents a runner who blocked the owner (or was blocked) from joining', async () => {
    const { owner, code } = await newLeague('Guarded Crew', 'Guard Owner');
    const member = await joinAs('Guard Member', code);
    const memberRow = (await db.rpc(owner, 'get_my_league')).standings.find((s: any) => s.alias === 'Guard Member');
    await db.rpc(owner, 'block_member', { p_member_id: memberRow.member_id });
    await db.rpc(member, 'leave_league');
    const fresh = await db.rpc(owner, 'create_league_invite');
    expect(await joinError(member, fresh.code)).toBe('invite_unavailable');
  });

  it('renames a league (owner only, filtered)', async () => {
    const { owner, code } = await newLeague('Old Name Crew', 'Rename Owner');
    const member = await joinAs('Rename Member', code);
    await expectCode(db.rpc(member, 'rename_league', { p_name: 'Hijacked' }), 'not_league_owner');
    const renamed = await db.rpc(owner, 'rename_league', { p_name: 'New Name Crew' });
    expect(renamed.league.name).toBe('New Name Crew');
  });

  it('rate-limits invite attempts to five per minute', async () => {
    const runner = await db.createRunner('Code Guesser');
    for (let i = 0; i < 5; i += 1) {
      expect(await joinError(runner, `GUESS00${i}`)).toBe('invite_not_found');
    }
    // Failed guesses count: the sixth attempt inside the window is refused.
    await expectCode(db.rpc(runner, 'join_league', { p_code: 'GUESS009' }), 'rate_limited');
  });
});

function competitionWeekDate(): string {
  return competitionWeekAt(Date.now()).weekStart;
}
