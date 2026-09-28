import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { inCurrentWeek, routelessRun, uploadRun } from './helpers/runs';

/**
 * Teen accounts in family leagues (docs/ROADMAP.md 4.10, decision 3): 13–17 year olds join a
 * family league an adult runs, with that adult's approval as the parent's consent, and can't
 * reach anything outside it — checked here for every API function, not just the screens.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
  await db.sql(`select private.set_flag('teen_accounts_enabled', true, 'teen account tests', 'ops-test')`);
});

afterAll(async () => {
  await db.close();
});

async function teen(alias: string, band: '13_15' | '16_17' = '16_17'): Promise<TestUser> {
  const user = await db.createUser();
  await db.rpc(user, 'save_profile', {
    p_alias: alias,
    p_units: 'metric',
    p_goal_days: 3,
    p_notification_tz: 'America/Chicago',
    p_ack_eligibility: true,
    p_age_signal: `teen_${band}`,
    p_age_source: 'guardianDeclared',
  });
  return user;
}

async function familyLeague(ownerAlias: string) {
  const owner = await db.createRunner(ownerAlias);
  const created = await db.rpc(owner, 'create_league', { p_name: `The ${ownerAlias} family`, p_kind: 'family' });
  const leagueId = created.league.id as string;
  const { code } = await db.rpc(owner, 'create_league_invite', { p_league_id: leagueId });
  return { owner, leagueId, code: code as string };
}

async function joinFamily(family: Awaited<ReturnType<typeof familyLeague>>, kid: TestUser) {
  const request = await db.rpc(kid, 'request_family_join', { p_code: family.code });
  await db.rpc(family.owner, 'decide_family_request', { p_request_id: request.id, p_approve: true });
}

const publicId = async (user: TestUser) => (await db.rpc(user, 'get_social_settings')).public_id as string;

/** Straight SQL (not through an RPC) fails with the code as the message. */
const refusedBy = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ message: code });

describe('teen accounts', () => {
  it('join a family league only with the approval of the adult who runs it', async () => {
    const family = await familyLeague('Parent Pam');
    const kid = await teen('Teen Tom');
    expect((await db.rpc(kid, 'get_me')).profile).toMatchObject({ age_signal: 'teen_16_17', teen_consent_at_ms: null });
    await expectCode(db.rpc(kid, 'join_league', { p_code: family.code }), 'teen_restricted');

    const request = await db.rpc(kid, 'request_family_join', { p_code: family.code });
    expect(request).toMatchObject({ status: 'pending', league_name: 'The Parent Pam family', alias: 'Teen Tom', band: '16_17', is_mine: true });
    expect((await db.rpc(kid, 'get_my_league')).league).toBeNull();
    expect(await db.rpc(family.owner, 'list_family_requests')).toEqual([expect.objectContaining({ id: request.id, alias: 'Teen Tom' })]);
    const stranger = await db.createRunner('Not Parent');
    await expectCode(db.rpc(stranger, 'decide_family_request', { p_request_id: request.id, p_approve: true }), 'not_found');

    await db.rpc(family.owner, 'decide_family_request', { p_request_id: request.id, p_approve: true });
    const me = await db.rpc(kid, 'get_me');
    expect(me.profile.teen_consent_at_ms).toEqual(expect.any(Number));
    expect(await db.one('select teen_consent_by from public.profiles where user_id = $1', [kid.id])).toEqual({ teen_consent_by: family.owner.id });
    const view = await db.rpc(kid, 'get_my_league');
    expect(view.league).toMatchObject({ name: 'The Parent Pam family', kind: 'family' });

    // Other leagues' codes don't work, and a teen can't start or grow a league.
    const friends = await db.createRunner('Friends Owner');
    const crew = await db.rpc(friends, 'create_league', { p_name: 'Open crew' });
    const crewCode = (await db.rpc(friends, 'create_league_invite', { p_league_id: crew.league.id })).code;
    await expectCode(db.rpc(kid, 'request_family_join', { p_code: crewCode }), 'family_only');
    await expectCode(db.rpc(kid, 'create_league', { p_name: 'Teen crew', p_kind: 'family' }), 'teen_restricted');
    await expectCode(db.rpc(kid, 'create_league_invite', { p_league_id: family.leagueId }), 'teen_restricted');
    // Even the database won't seat a teen elsewhere, or make one an owner.
    await refusedBy(db.sql('insert into public.league_members (league_id, user_id, role) values ($1, $2, $3)', [crew.league.id, kid.id, 'member']), 'family_only');
    const kidMember = await db.one<{ id: string }>('select id from public.league_members where user_id = $1 and left_at is null', [kid.id]);
    await expectCode(db.rpc(family.owner, 'transfer_league_ownership', { p_member_id: kidMember.id }), 'teen_restricted');

    // The adult sees how the teen is doing, and can remove them.
    await uploadRun(db, kid, steadyRun(inCurrentWeek(0), 3_000, 1_100));
    expect(await db.rpc(family.owner, 'list_family_teens', { p_league_id: family.leagueId })).toEqual([
      expect.objectContaining({ alias: 'Teen Tom', band: '16_17', runs_this_week: 1, last_run_at_ms: expect.any(Number), consent_at_ms: expect.any(Number) }),
    ]);
    await expectCode(db.rpc(kid, 'list_family_teens', { p_league_id: family.leagueId }), 'teen_restricted');
    await db.rpc(family.owner, 'remove_league_member', { p_member_id: kidMember.id });
    expect((await db.rpc(kid, 'get_my_league')).league).toBeNull();
  });

  it('can’t reach any API function outside the family league', async () => {
    const kid = await teen('Teen Catalog');
    const allowed = (await db.one<{ a: string[] }>('select private.teen_allowed_rpcs() as a')).a;
    const functions = await db.sql<{ name: string; args: string }>(
      `select p.proname as name, coalesce(string_agg('null::' || format_type(t, null), ', ' order by o), '') as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       left join lateral unnest(p.proargtypes::oid[]) with ordinality as a(t, o) on true
       where n.nspname = 'public'
       group by p.oid, p.proname order by p.proname`,
    );
    const names = functions.map((f) => f.name);
    for (const name of allowed) expect(names).toContain(name);

    // Their own account, runs, records, training and data: fine for teens, and not profile-scoped.
    const personal = new Set([
      'get_app_config', 'get_invite_preview', 'get_live_location', 'get_me', 'save_profile', 'check_alias', 'record_age_signal',
      'list_my_runs', 'list_my_runs_between', 'get_my_run', 'get_my_run_route', 'rename_run', 'delete_run', 'undo_run_edits',
      'list_run_duplicates', 'get_week_summary', 'get_progress', 'get_streak', 'get_badges', 'get_personal_records',
      'get_record_history', 'get_run_efforts', 'get_stats', 'list_shoes', 'save_shoe', 'retire_shoe', 'delete_shoe',
      'get_plan', 'save_plan', 'end_plan', 'match_plan_session', 'set_session_feedback', 'get_entitlements',
      'list_blocks', 'unblock', 'log_events', 'submit_diagnostics', 'request_export', 'get_export', 'get_export_route',
      'request_account_deletion', 'get_account_deletion_status',
      // Connections they can't make (the database refuses a teen's Strava link, and Garmin under 16).
      'get_strava_status', 'get_strava_upload', 'disconnect_strava', 'post_run_to_strava', 'get_garmin_status', 'disconnect_garmin',
    ]);
    const staff = new Set(['mod_list_reports', 'mod_queue_health', 'mod_resolve_report', 'mod_create_segment', 'mod_retire_segment']);
    const refused: string[] = [];
    for (const f of functions) {
      if (personal.has(f.name) || staff.has(f.name)) continue;
      let code: string | null = null;
      try {
        await db.as(kid, (client) => client.query(`select public.${f.name}(${f.args})`));
      } catch (error) {
        code = (error as { message: string }).message;
      }
      if (allowed.includes(f.name)) {
        expect([f.name, code]).not.toEqual([f.name, 'teen_restricted']);
      } else {
        expect([f.name, code]).toEqual([f.name, 'teen_restricted']);
        refused.push(f.name);
      }
    }
    // Everything social outside the family is among them.
    expect(refused).toEqual(
      expect.arrayContaining([
        'get_feed', 'follow_runner', 'search_runners', 'get_runner_profile', 'add_comment', 'set_kudos', 'join_club', 'search_clubs',
        'get_leaderboard', 'join_leaderboards', 'join_league', 'create_league', 'start_strava_connect', 'create_challenge', 'get_shared_run',
      ]),
    );
  });

  it('keeps a teen’s runs, settings, challenges and live location inside the family', async () => {
    const family = await familyLeague('Parent Pia');
    const kid = await teen('Teen Tia');
    await joinFamily(family, kid);
    const run = await uploadRun(db, kid, steadyRun(inCurrentWeek(1), 4_000, 1_450));

    await expectCode(db.rpc(kid, 'set_run_sharing', { p_run_id: run.runId, p_visibility: 'everyone', p_map_shared: false }), 'teen_restricted');
    await db.rpc(kid, 'set_run_sharing', { p_run_id: run.runId, p_visibility: 'leagues', p_map_shared: false });
    await db.rpc(kid, 'set_social_settings', { p_default_visibility: 'everyone', p_default_map_shared: false, p_follow_approval: true, p_discoverable: true });
    expect(await db.rpc(kid, 'get_social_settings')).toMatchObject({ default_visibility: 'only_me', discoverable: false });

    // Family adults can see the run, but there are no comments or kudos on a teen's runs.
    await expectCode(db.rpc(family.owner, 'add_comment', { p_run_id: run.runId, p_body: 'Great run!' }), 'teen_restricted');
    await expectCode(db.rpc(family.owner, 'set_kudos', { p_run_id: run.runId, p_on: true }), 'teen_restricted');
    // Nobody can follow a teen.
    const outsider = await db.createRunner('Outside Olly');
    await expect(db.rpc(outsider, 'follow_runner', { p_public_id: await publicId(kid) })).rejects.toBeTruthy();
    expect(await db.sql('select 1 from private.follows where followee_id = $1', [kid.id])).toEqual([]);

    // Challenges: the family league's, not the monthly ones for everyone.
    const challenge = await db.rpc(family.owner, 'create_challenge', { p_metric: 'active_days', p_target: 8, p_month_offset: 1, p_league_id: family.leagueId });
    const list = await db.rpc(kid, 'list_challenges');
    expect(list.current.map((c: any) => c.id)).toEqual([challenge.id]);
    const monthly = (await db.one<{ id: string }>(`select id from private.challenges where scope = 'global' limit 1`)).id;
    await expectCode(db.rpc(kid, 'join_challenge', { p_challenge_id: monthly }), 'not_found');
    await db.rpc(kid, 'join_challenge', { p_challenge_id: challenge.id });

    // Live location opens only for family members who are signed in.
    const link = await db.rpc(kid, 'start_live_share', { p_minutes: 60 });
    await db.rpc(kid, 'post_live_location', { p_share_id: link.share_id, p_lat: 41.9, p_lon: -87.6 });
    expect(await db.rpc('anon', 'get_live_location', { p_token: link.token })).toEqual({ state: 'family_only' });
    expect(await db.rpc(outsider, 'get_live_location', { p_token: link.token })).toEqual({ state: 'family_only' });
    expect(await db.rpc(family.owner, 'get_live_location', { p_token: link.token })).toMatchObject({ state: 'live', alias: 'Teen Tia' });

    // The database itself refuses clubs, leaderboards and Strava for a teen.
    const club = await db.createRunner('Club Owner Teen Test');
    const created = await db.rpc(club, 'create_club', { p_name: 'Open Runners', p_visibility: 'public' });
    await refusedBy(db.sql(`insert into private.club_members (club_id, user_id) values ($1, $2)`, [created.id, kid.id]), 'teen_restricted');
    await refusedBy(db.sql(`insert into private.leaderboard_members (user_id, country, joined_at) values ($1, 'US', now())`, [kid.id]), 'teen_restricted');
    await refusedBy(db.sql(`insert into private.strava_connections (user_id, athlete_id, scope, access_token_enc, refresh_token_enc, expires_at)
              values ($1, 99, 'activity:write', 'x', 'y', now() + interval '1 hour')`, [kid.id]),
      'teen_restricted',
    );
  });

  it('keeps health data out under 16', async () => {
    const young = await teen('Teen Young', '13_15');
    await expectCode(
      uploadRun(db, young, routelessRun(inCurrentWeek(2), 5_000, 1_800), {
        extra: { p_source: 'health_import', p_external_id: `HK-${randomUUID()}`, p_claimed_distance_m: 5_000, p_avg_heart_rate: 150 },
      }),
      'teen_restricted',
    );
    const phone = await uploadRun(db, young, steadyRun(inCurrentWeek(2, 2), 3_000, 1_100), { extra: { p_avg_heart_rate: 150, p_max_heart_rate: 181 } });
    expect(await db.one('select avg_heart_rate, max_heart_rate from public.runs where id = $1', [phone.runId])).toEqual({ avg_heart_rate: null, max_heart_rate: null });
    await refusedBy(db.sql(`insert into private.aggregator_links (user_id, provider, aggregator, aggregator_user_id) values ($1, 'garmin', 'terra', 'u1')`, [young.id]),
      'teen_restricted',
    );
  });

  it('moves an adult account the store now says is a teen back to its family, for good', async () => {
    const pat = await db.createRunner('Was Adult Pat');
    const crew = await db.rpc(pat, 'create_league', { p_name: 'Pat crew' });
    const code = (await db.rpc(pat, 'create_league_invite', { p_league_id: crew.league.id })).code;
    const mate = await db.createRunner('Crew Mate');
    await db.rpc(mate, 'join_league', { p_code: code });
    const clubOwner = await db.createRunner('Pat Club Owner');
    const club = await db.rpc(clubOwner, 'create_club', { p_name: 'Pat Club', p_visibility: 'public' });
    await db.rpc(pat, 'join_club', { p_club_id: club.id });
    await db.rpc(pat, 'join_leaderboards', { p_country: 'US' });
    await db.rpc(mate, 'follow_runner', { p_public_id: await publicId(pat) });
    await db.rpc(pat, 'set_social_settings', { p_default_visibility: 'everyone', p_default_map_shared: false, p_follow_approval: false, p_discoverable: true });
    const shared = await uploadRun(db, pat, steadyRun(inCurrentWeek(0, 3), 5_000, 1_700));
    await db.rpc(pat, 'set_run_sharing', { p_run_id: shared.runId, p_visibility: 'everyone', p_map_shared: false });

    await db.rpc(pat, 'record_age_signal', { p_signal: 'teen_16_17', p_source: 'declared' });
    // The crew passes to the adult member; the club, the boards and follows are left behind.
    expect(await db.one('select owner_id, status from public.leagues where id = $1', [crew.league.id])).toEqual({ owner_id: mate.id, status: 'active' });
    expect(await db.sql('select 1 from public.league_members where user_id = $1 and left_at is null', [pat.id])).toEqual([]);
    expect(await db.sql('select 1 from private.club_members where user_id = $1 and left_at is null', [pat.id])).toEqual([]);
    expect(await db.one('select left_at is not null as left from private.leaderboard_members where user_id = $1', [pat.id])).toEqual({ left: true });
    expect(await db.sql('select 1 from private.follows where follower_id = $1 or followee_id = $1', [pat.id])).toEqual([]);
    expect(await db.one('select visibility from public.runs where id = $1', [shared.runId])).toEqual({ visibility: 'only_me' });
    expect(await db.one('select discoverable, default_visibility from public.profiles where user_id = $1', [pat.id])).toEqual({
      discoverable: false,
      default_visibility: 'only_me',
    });
    // A later "adult" answer doesn't undo it; staff can, after checking.
    await db.rpc(pat, 'record_age_signal', { p_signal: 'adult', p_source: 'declared' });
    expect((await db.rpc(pat, 'get_me')).profile.age_signal).toBe('teen_16_17');
    await expectCode(db.rpc(pat, 'get_feed', {}), 'teen_restricted');
    await db.sql(`select private.clear_teen_account($1, 'Turned 18, checked ID, ticket 7', 'ops-test')`, [pat.id]);
    expect((await db.rpc(pat, 'get_me')).profile.age_signal).toBe('adult');
    expect(await db.rpc(pat, 'get_feed', {})).toMatchObject({ items: expect.any(Array) });
  });

  it('stay off until an operator turns them on: under 18 is locked, as in the beta', async () => {
    await db.sql(`select private.set_flag('teen_accounts_enabled', false, 'off again', 'ops-test')`);
    try {
      expect((await db.rpc('anon', 'get_app_config')).teen_accounts_enabled).toBe(false);
      await expectCode(teen('Teen Too Soon'), 'age_restricted');
      const adult = await db.createRunner('Adult Then Teen');
      const crew = await db.rpc(adult, 'create_league', { p_name: 'Soon crew' });
      await db.rpc(adult, 'record_age_signal', { p_signal: 'teen_16_17', p_source: 'declared' });
      expect((await db.rpc(adult, 'get_me')).profile.age_signal).toBe('minor');
      await expectCode(db.rpc(adult, 'get_my_league'), 'age_restricted');
      expect(await db.one('select status from public.leagues where id = $1', [crew.league.id])).toEqual({ status: 'closed' });
    } finally {
      await db.sql(`select private.set_flag('teen_accounts_enabled', true, 'back on', 'ops-test')`);
    }
  });

  it('closes a family league when its adult leaves and only teens are left', async () => {
    const family = await familyLeague('Parent Gone');
    const kid = await teen('Teen Left');
    await joinFamily(family, kid);
    await db.sql(`select private.detach_from_league($1, 'account_deleted')`, [family.owner.id]);
    expect(await db.one('select status from public.leagues where id = $1', [family.leagueId])).toEqual({ status: 'closed' });
    expect((await db.rpc(kid, 'get_my_league')).league).toBeNull();
  });
});
