import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { currentWeekStartMs, inCurrentWeek, uploadRun } from './helpers/runs';

/**
 * Clubs (docs/ROADMAP.md 4.5): public and invite-only clubs, the weekly club board, roles and
 * admin tools, group runs, and club reports in the moderation queue.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const publicId = async (user: TestUser) => (await db.rpc(user, 'get_social_settings')).public_id as string;

async function club(ownerAlias: string, visibility: 'public' | 'invite_only', name = `${ownerAlias} Club`) {
  const owner = await db.createRunner(ownerAlias);
  const created = await db.rpc(owner, 'create_club', { p_name: name, p_description: 'Easy miles, good company.', p_visibility: visibility });
  return { owner, id: created.id as string };
}

async function joinByCode(clubId: string, admin: TestUser, alias: string) {
  const runner = await db.createRunner(alias);
  const { code } = await db.rpc(admin, 'create_club_invite', { p_club_id: clubId });
  await db.rpc(runner, 'join_club_by_code', { p_code: code });
  return runner;
}

const memberIdOf = async (clubId: string, user: TestUser) =>
  (await db.one<{ id: string }>('select id from private.club_members where club_id = $1 and user_id = $2 and left_at is null', [clubId, user.id])).id;

describe('finding and joining clubs', () => {
  it('finds public clubs by name and joins them in one tap; invite-only clubs need a code', async () => {
    const open = await club('Open Olga', 'public', 'Lakefront Striders');
    const closed = await club('Closed Cora', 'invite_only', 'Lakefront Secret');
    const runner = await db.createRunner('Club Seeker');

    const found = await db.rpc(runner, 'search_clubs', { p_query: 'lakefront' });
    expect(found.map((c: any) => c.name)).toEqual(['Lakefront Striders']);
    expect(found[0]).toMatchObject({ is_member: false, can_join: true, member_count: 1, chat_url: null, admins: [{ alias: 'Open Olga', role: 'owner' }] });
    expect(await db.rpc(runner, 'search_clubs', { p_query: 'la' })).toEqual([]);
    await expectCode(db.rpc(runner, 'get_club', { p_club_id: closed.id }), 'not_found');
    await expectCode(db.rpc(runner, 'join_club', { p_club_id: closed.id }), 'not_found');

    expect(await db.rpc(runner, 'join_club', { p_club_id: open.id })).toMatchObject({ is_member: true, my_role: 'member', member_count: 2 });
    expect(await db.rpc(runner, 'join_club', { p_club_id: open.id })).toMatchObject({ member_count: 2 });

    await expectCode(db.rpc(runner, 'join_club_by_code', { p_code: 'ZZZZZZZZ' }), 'club_invite_invalid');
    const { code } = await db.rpc(closed.owner, 'create_club_invite', { p_club_id: closed.id });
    await expectCode(db.rpc(runner, 'create_club_invite', { p_club_id: closed.id }), 'not_in_club');
    expect((await db.rpc(runner, 'join_club_by_code', { p_code: code.toLowerCase() })).name).toBe('Lakefront Secret');
    expect((await db.rpc(runner, 'list_my_clubs')).map((c: any) => c.name)).toEqual(['Lakefront Striders', 'Lakefront Secret']);

    // The chat link is for members only.
    await db.rpc(open.owner, 'set_club_chat_link', { p_club_id: open.id, p_url: 'https://discord.gg/lakefront' });
    expect((await db.rpc(runner, 'get_club', { p_club_id: open.id })).chat_url).toBe('https://discord.gg/lakefront');
    const visitor = await db.createRunner('Club Visitor');
    expect((await db.rpc(visitor, 'get_club', { p_club_id: open.id })).chat_url).toBeNull();
  });

  it('checks names and descriptions, and limits clubs per runner', async () => {
    const runner = await db.createRunner('Club Maker');
    await expectCode(db.rpc(runner, 'create_club', { p_name: 'ab', p_visibility: 'public' }), 'club_invalid');
    await expectCode(db.rpc(runner, 'create_club', { p_name: 'Good Name', p_description: 'join at www.spam.test.com', p_visibility: 'public' }), 'club_not_allowed');
    await expectCode(db.rpc(runner, 'create_club', { p_name: 'Good Name', p_visibility: 'secret' }), 'invalid_input');
    // Ten clubs at most: fill up with memberships of public clubs.
    for (let i = 0; i < 10; i++) {
      const c = await club(`Limit Owner ${i}`, 'public', `Limit Club ${i}`);
      await db.rpc(runner, 'join_club', { p_club_id: c.id });
    }
    const eleventh = await club('Limit Owner X', 'public', 'Limit Club X');
    await expectCode(db.rpc(runner, 'join_club', { p_club_id: eleventh.id }), 'club_limit');
    await expectCode(db.rpc(runner, 'create_club', { p_name: 'One Too Many', p_visibility: 'public' }), 'club_limit');
  });
});

describe('the club board', () => {
  it('ranks this week’s XP from when each member joined, for members only', async () => {
    const { owner, id } = await club('Board Bea', 'invite_only');
    const early = await joinByCode(id, owner, 'Board Early');
    const late = await joinByCode(id, owner, 'Board Late');
    const weekStart = currentWeekStartMs();
    await db.sql('update private.club_members set joined_at = to_timestamp($2::bigint / 1000.0) where club_id = $1', [id, weekStart - 86_400_000]);
    await db.sql('update private.club_members set joined_at = to_timestamp($3::bigint / 1000.0) where club_id = $1 and user_id = $2', [
      id,
      late.id,
      inCurrentWeek(1),
    ]);
    await uploadRun(db, early, steadyRun(inCurrentWeek(0), 5_250, 1888)); // 77
    await uploadRun(db, late, steadyRun(inCurrentWeek(0), 6_450, 2342)); // before joining: not counted
    await uploadRun(db, late, steadyRun(inCurrentWeek(2), 5_250, 1888)); // 77

    const board = await db.rpc(owner, 'get_club_board', { p_club_id: id });
    expect(board.members).toBe(3);
    expect(board.rows.map((r: any) => [r.rank, r.alias, r.weekly_xp])).toEqual([
      [1, 'Board Early', 77],
      [1, 'Board Late', 77],
      [3, 'Board Bea', 0],
    ]);
    expect(board.me).toMatchObject({ alias: 'Board Bea', is_me: true, role: 'owner' });
    // A blocked member stays on the board, without a name.
    await db.rpc(owner, 'block_runner', { p_public_id: await publicId(late) });
    expect((await db.rpc(owner, 'get_club_board', { p_club_id: id })).rows.find((r: any) => r.hidden)).toMatchObject({ alias: null, weekly_xp: 77 });
    const outsider = await db.createRunner('Board Outsider');
    await expectCode(db.rpc(outsider, 'get_club_board', { p_club_id: id }), 'not_in_club');
  });
});

describe('running a club', () => {
  it('lets admins remove a member and content; the removed member can’t come back', async () => {
    const { owner, id } = await club('Admin Ada', 'public');
    const admin = await joinByCode(id, owner, 'Admin Abe');
    const member = await joinByCode(id, owner, 'Member Mo');
    const pest = await joinByCode(id, owner, 'Member Pest');
    await expectCode(db.rpc(admin, 'promote_club_admin', { p_club_id: id, p_member_id: await memberIdOf(id, member) }), 'not_club_admin');
    await db.rpc(owner, 'promote_club_admin', { p_club_id: id, p_member_id: await memberIdOf(id, admin) });
    expect((await db.rpc(member, 'list_club_members', { p_club_id: id })).map((m: any) => [m.alias, m.role])).toEqual([
      ['Admin Ada', 'owner'],
      ['Admin Abe', 'admin'],
      ['Member Mo', 'member'],
      ['Member Pest', 'member'],
    ]);

    // Members plan group runs; admins can take one down.
    await db.rpc(member, 'register_push_token', { p_token: `ExponentPushToken[${randomUUID().replace(/-/g, '').slice(0, 22)}]`, p_platform: 'ios' });
    const run = await db.rpc(pest, 'create_group_run', {
      p_title: 'Pest party run',
      p_starts_at_ms: Date.now() + 2 * 86_400_000,
      p_meeting_point: 'Somewhere odd',
      p_club_id: id,
    });
    expect(run).toMatchObject({ club_id: id, league_id: null, can_edit: true });
    await db.rpc(member, 'rsvp_group_run', { p_group_run_id: run.id, p_status: 'going' });
    expect((await db.rpc(member, 'list_group_runs', { p_club_id: id })).map((g: any) => g.title)).toEqual(['Pest party run']);
    await expectCode(db.rpc(member, 'remove_group_run', { p_group_run_id: run.id }), 'not_allowed');
    expect(await db.rpc(admin, 'remove_group_run', { p_group_run_id: run.id })).toEqual({ removed: true });
    expect(await db.rpc(member, 'list_group_runs', { p_club_id: id })).toEqual([]);
    expect(
      (await db.sql<{ title: string }>(`select title from private.push_outbox where user_id = $1`, [member.id])).map((p) => p.title),
    ).toEqual(['Group run cancelled']);

    // Admins remove members, but not other admins; the owner can.
    await expectCode(db.rpc(member, 'remove_club_member', { p_club_id: id, p_member_id: await memberIdOf(id, pest) }), 'not_club_admin');
    await expectCode(db.rpc(admin, 'remove_club_member', { p_club_id: id, p_member_id: await memberIdOf(id, owner) }), 'not_club_owner');
    await db.rpc(admin, 'remove_club_member', { p_club_id: id, p_member_id: await memberIdOf(id, pest) });
    await expectCode(db.rpc(pest, 'get_club_board', { p_club_id: id }), 'not_in_club');
    await expectCode(db.rpc(pest, 'join_club', { p_club_id: id }), 'club_unavailable');
    const audit = await db.sql<{ action: string }>('select action from private.moderation_actions where moderator_id = $1 order by id', [admin.id]);
    expect(audit.map((a) => a.action)).toEqual(['group_run_removed', 'club_remove_member']);

    // Only the owner changes the name; admins edit the description.
    await expectCode(db.rpc(admin, 'update_club', { p_club_id: id, p_name: 'Taken Over', p_description: null, p_visibility: 'public' }), 'not_club_owner');
    expect((await db.rpc(admin, 'update_club', { p_club_id: id, p_name: 'Admin Ada Club', p_description: 'Tuesdays at six.', p_visibility: 'public' })).description).toBe(
      'Tuesdays at six.',
    );
  });

  it('hands the club on when its owner leaves or deletes their account', async () => {
    const { owner, id } = await club('Leaving Lea', 'invite_only');
    const admin = await joinByCode(id, owner, 'Heir Hal');
    const member = await joinByCode(id, owner, 'Plain Pat');
    await db.rpc(owner, 'promote_club_admin', { p_club_id: id, p_member_id: await memberIdOf(id, admin) });
    await expectCode(db.rpc(owner, 'leave_club', { p_club_id: id }), 'owner_must_transfer');
    await db.rpc(owner, 'request_account_deletion', {}, { recentAuth: true });
    expect((await db.rpc(member, 'list_club_members', { p_club_id: id })).map((m: any) => [m.alias, m.role])).toEqual([
      ['Heir Hal', 'owner'],
      ['Plain Pat', 'member'],
    ]);
    await db.rpc(member, 'leave_club', { p_club_id: id });
    await db.rpc(admin, 'leave_club', { p_club_id: id });
    expect(await db.one<{ status: string }>('select status from private.clubs where id = $1', [id])).toEqual({ status: 'closed' });
  });
});

describe('club reports', () => {
  it('reach the moderation queue, where a moderator can reset or close a club and remove a group run', async () => {
    await db.sql('delete from private.reports');
    const { owner, id } = await club('Report Rex', 'public', 'Rude Runners');
    const member = await joinByCode(id, owner, 'Report Rita');
    const run = await db.rpc(owner, 'create_group_run', {
      p_title: 'Rude run',
      p_starts_at_ms: Date.now() + 86_400_000,
      p_meeting_point: 'The corner',
      p_club_id: id,
    });
    const visitor = await db.createRunner('Report Visitor');
    const onClub = await db.rpc(visitor, 'report_content', { p_kind: 'club', p_id: id, p_reason: 'offensive_name' });
    const onRun = await db.rpc(member, 'report_content', { p_kind: 'group_run', p_id: run.id, p_reason: 'spam' });
    await expectCode(db.rpc(visitor, 'report_content', { p_kind: 'group_run', p_id: run.id, p_reason: 'spam' }), 'not_found');

    const moderator = await db.createRunner('Report Mod');
    await db.sql(`select private.grant_staff_role($1, 'moderator', 'club reports', 'ops-test')`, [moderator.id]);
    const queue = await db.rpc(moderator, 'mod_list_reports');
    expect(queue.find((r: any) => r.report_id === onClub.report_id)).toMatchObject({
      target_kind: 'club',
      content_snapshot: { club_name: 'Rude Runners', description: 'Easy miles, good company.', visibility: 'public' },
      target_state: { status: 'active', visibility: 'public' },
      actions: ['dismiss', 'reset_club', 'close_club'],
    });
    expect(queue.find((r: any) => r.report_id === onRun.report_id)).toMatchObject({
      target_kind: 'group_run',
      content_snapshot: { alias: 'Report Rex', title: 'Rude run', meeting_point: 'The corner', group: 'Rude Runners' },
      target_state: { removed: false },
    });

    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: onRun.report_id, p_action: 'remove_group_run', p_reason: 'Spam event' });
    expect(await db.rpc(member, 'list_group_runs', { p_club_id: id })).toEqual([]);
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: onClub.report_id, p_action: 'reset_club', p_reason: 'Offensive name' });
    const reset = await db.rpc(member, 'get_club', { p_club_id: id });
    expect(reset.name).toMatch(/^Club [0-9A-Z]{6}$/);
    expect(reset.description).toBeNull();
  });
});

describe('club export', () => {
  it('lists the runner’s clubs', async () => {
    const { owner, id } = await club('Export Eve', 'invite_only', 'Export Club');
    const member = await joinByCode(id, owner, 'Export Ed');
    const extras = (await db.one<{ x: any }>('select private.export_extras($1) as x', [member.id])).x;
    expect(extras.clubs).toEqual([{ club: 'Export Club', role: 'member', joined_at_ms: expect.any(Number), left_at_ms: null }]);
  });
});
