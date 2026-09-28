import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { backdateMembership, chunksFor, currentWeekStartMs, inCurrentWeek, startArgs, uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const FRIDAY = Date.parse('2026-09-25T12:00:00Z');

async function rowCounts(user: TestUser) {
  return db.one<Record<string, number>>(
    `select
       (select count(*) from auth.users where id = $1)::int as auth_user,
       (select count(*) from public.profiles where user_id = $1)::int as profiles,
       (select count(*) from public.runs where owner_id = $1)::int as runs,
       (select count(*) from private.run_routes where owner_id = $1)::int as routes,
       (select count(*) from private.run_day_allocations where owner_id = $1)::int as allocations,
       (select count(*) from public.daily_scores where owner_id = $1)::int as daily_scores,
       (select count(*) from private.xp_ledger where owner_id = $1)::int as ledger,
       (select count(*) from private.profile_stats where user_id = $1)::int as stats,
       (select count(*) from public.league_members where user_id = $1)::int as memberships,
       (select count(*) from public.blocks where blocker_id = $1 or blocked_id = $1)::int as blocks,
       (select count(*) from private.export_jobs where user_id = $1)::int as exports,
       (select count(*) from private.operational_events where subject = private.subject_ref($1))::int as events`,
    [user.id],
  );
}

describe('data export', () => {
  it('requires a recent sign-in and returns only the requester’s data', async () => {
    const me = await db.createRunner('Exporter');
    const other = await db.createRunner('Bystander');
    const mine = await uploadRun(db, me, steadyRun(FRIDAY, 5240, 1888), { title: 'Friday morning' });
    await uploadRun(db, other, steadyRun(FRIDAY, 3000, 900));

    await expectCode(db.rpc(me, 'request_export', {}, { recentAuth: false }), 'recent_auth_required');
    const job = await db.rpc(me, 'request_export');
    expect(job).toMatchObject({ export_id: expect.any(String), reused: false });
    expect(await db.rpc(me, 'request_export')).toMatchObject({ export_id: job.export_id, reused: true });

    const data = await db.rpc(me, 'get_export', { p_export_id: job.export_id });
    expect(data).toMatchObject({
      format: 'paceleague-export',
      format_version: 3,
      account: { email: me.email, alias: 'Exporter', units: 'metric' },
      lifetime_xp: 77,
      tier: 'Seed',
      blocked_count: 0,
    });
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0]).toMatchObject({ id: mine.runId, title: 'Friday morning', status: 'accepted' });
    expect(data.runs[0].segments).toHaveLength(1);
    expect(data.daily_scores).toEqual([{ date: '2026-09-25', rule_version: 1, distance_cm: expect.any(Number), active_ms: 1_888_000, xp: 77, revision: 1 }]);

    const route = await db.rpc(me, 'get_export_route', { p_export_id: job.export_id, p_run_id: mine.runId });
    expect(route.points.length).toBe(1889);

    // Other identities, stale jobs and guessed ids are refused.
    await expectCode(db.rpc(other, 'get_export', { p_export_id: job.export_id }), 'not_found');
    await expectCode(db.rpc(other, 'get_export_route', { p_export_id: job.export_id, p_run_id: mine.runId }), 'not_found');
    await expectCode(db.rpc(me, 'get_export', { p_export_id: randomUUID() }), 'not_found');
    await db.sql(`update private.export_jobs set expires_at = now() - interval '1 second' where id = $1`, [job.export_id]);
    await expectCode(db.rpc(me, 'get_export', { p_export_id: job.export_id }), 'not_found');
  });

  it('limits export requests to three per day', async () => {
    const me = await db.createRunner('Export Limit');
    for (let i = 0; i < 3; i += 1) {
      const job = await db.rpc(me, 'request_export');
      await db.sql(`update private.export_jobs set expires_at = now() - interval '1 second' where id = $1`, [job.export_id]);
    }
    await expectCode(db.rpc(me, 'request_export'), 'rate_limited');
  });
});

describe('account deletion', () => {
  it('hides the account immediately, hands over the league, then removes every owned record', async () => {
    const owner = await db.createRunner('Leaving Owner');
    const created = await db.rpc(owner, 'create_league', { p_name: 'Handover League' });
    expect(created.league.is_owner).toBe(true);
    const { code } = await db.rpc(owner, 'create_league_invite');
    const friend = await db.createRunner('Staying Friend');
    await db.rpc(friend, 'join_league', { p_code: code });
    await backdateMembership(db, owner, currentWeekStartMs() - 86_400_000);
    await uploadRun(db, owner, steadyRun(inCurrentWeek(0), 5240, 1888));
    await uploadRun(db, friend, steadyRun(FRIDAY, 3000, 900));
    const friendRow = (await db.rpc(owner, 'get_my_league')).standings.find((s: any) => s.alias === 'Staying Friend');
    await db.rpc(owner, 'block_member', { p_member_id: friendRow.member_id });
    await db.rpc(owner, 'request_export');
    await db.rpc(owner, 'log_events', {
      p_events: [{ event_id: randomUUID(), name: 'run_started', environment: 'test', occurred_at_ms: Date.now(), props: {} }],
    });

    await expectCode(db.rpc(owner, 'request_account_deletion', {}, { recentAuth: false }), 'recent_auth_required');
    const job = await db.rpc(owner, 'request_account_deletion');
    expect(job.state).toBe('queued');
    expect((await db.rpc(owner, 'request_account_deletion')).job_id).toBe(job.job_id);

    // Immediately: profile flagged, league handed to the longest-standing member, owner hidden.
    const friendView = await db.rpc(friend, 'get_my_league');
    expect(friendView.league).toMatchObject({ is_owner: true, member_count: 1 });
    expect(friendView.standings.map((s: any) => s.alias)).toEqual(['Staying Friend']);
    await expectCode(db.rpc(owner, 'start_run_upload', startArgs(steadyRun(FRIDAY, 1000, 400), randomUUID())), 'account_deleting');
    expect(await db.rpc(owner, 'get_account_deletion_status')).toMatchObject({ state: 'queued' });

    const done = await db.one<{ n: number }>('select private.process_deletion_jobs() as n');
    expect(done.n).toBe(1);
    expect(await rowCounts(owner)).toEqual({
      auth_user: 0,
      profiles: 0,
      runs: 0,
      routes: 0,
      allocations: 0,
      daily_scores: 0,
      ledger: 0,
      stats: 0,
      memberships: 0,
      blocks: 0,
      exports: 0,
      events: 0,
    });
    const jobRow = await db.one<{ state: string; completed_at: Date | null }>('select state, completed_at from private.deletion_jobs where id = $1', [
      job.job_id,
    ]);
    expect(jobRow.state).toBe('completed');
    expect(jobRow.completed_at).not.toBeNull();

    // Everyone else is untouched.
    const friendCounts = await rowCounts(friend);
    expect(friendCounts).toMatchObject({ auth_user: 1, profiles: 1, runs: 1, memberships: 1 });
    expect((await db.rpc(friend, 'get_me')).lifetime_xp).toBe(55);
  });

  it('closes a league whose only member deletes their account and cancels a pending upload', async () => {
    const solo = await db.createRunner('Solo Owner');
    await db.rpc(solo, 'create_league', { p_name: 'Solo League' });
    const run = steadyRun(FRIDAY, 2000, 700);
    const start = await db.rpc(solo, 'start_run_upload', startArgs(run, randomUUID()));
    await db.rpc(solo, 'request_account_deletion');
    const [c] = chunksFor(run);
    if (!c) throw new Error('no chunk');
    await expectCode(db.rpc(solo, 'put_route_chunk', { p_run_id: start.run_id, p_seq: 0, p_points: c.body, p_checksum: c.checksum }), 'account_deleting');
    const league = await db.one<{ status: string }>(`select status from public.leagues where name = 'Solo League'`);
    expect(league.status).toBe('closed');
    await db.sql('select private.process_deletion_jobs()');
    expect((await rowCounts(solo)).runs).toBe(0);
  });

  it('retries an interrupted cleanup and completes it later', async () => {
    const user = await db.createRunner('Retry Deletion');
    await uploadRun(db, user, steadyRun(FRIDAY, 3000, 900));
    await db.rpc(user, 'request_account_deletion');
    // Inject a failure: a trigger that refuses to delete this user's profile.
    await db.sql(`create function private.test_refuse() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$`);
    await db.sql(`create trigger test_refuse before delete on public.profiles for each row execute function private.test_refuse()`);
    try {
      await db.sql('select private.process_deletion_jobs()');
      const failed = await db.one<{ state: string; attempts: number; last_error: string }>(
        'select state, attempts, last_error from private.deletion_jobs where user_id = $1',
        [user.id],
      );
      expect(failed).toEqual({ state: 'retrying', attempts: 1, last_error: 'P0001' });
      // The partial attempt rolled back: nothing half-deleted.
      expect((await rowCounts(user)).runs).toBe(1);
    } finally {
      await db.sql('drop trigger test_refuse on public.profiles');
      await db.sql('drop function private.test_refuse()');
    }
    await db.sql(`update private.deletion_jobs set next_attempt_at = now() where user_id = $1`, [user.id]);
    await db.sql('select private.process_deletion_jobs()');
    expect(await rowCounts(user)).toMatchObject({ auth_user: 0, runs: 0 });
  });
});

describe('reports and moderation', () => {
  it('queues a report with a snapshot, and audits the moderator’s action', async () => {
    const owner = await db.createRunner('Report Owner');
    await db.rpc(owner, 'create_league', { p_name: 'Report Crew' });
    const { code } = await db.rpc(owner, 'create_league_invite');
    const rude = await db.createRunner('Rude Name');
    await db.rpc(rude, 'join_league', { p_code: code });
    const rudeRow = (await db.rpc(owner, 'get_my_league')).standings.find((s: any) => s.alias === 'Rude Name');

    await expectCode(db.rpc(owner, 'submit_report', { p_target_kind: 'member', p_member_id: rudeRow.member_id, p_reason: 'free text!' }), 'invalid_input');
    const report = await db.rpc(owner, 'submit_report', { p_target_kind: 'member', p_member_id: rudeRow.member_id, p_reason: 'offensive_name' });
    expect(report.status).toBe('open');
    await db.rpc(rude, 'submit_report', { p_target_kind: 'league', p_member_id: null, p_reason: 'spam' });

    const moderator = await db.createRunner('Mod Person');
    await db.sql(`select private.grant_staff_role($1, 'moderator', 'pilot moderation rota', 'ops-test')`, [moderator.id]);
    const queue = await db.rpc(moderator, 'mod_list_reports');
    expect(queue).toHaveLength(2);
    expect(queue.find((r: any) => r.report_id === report.report_id)).toMatchObject({
      target_kind: 'member',
      reason_code: 'offensive_name',
      content_snapshot: { alias: 'Rude Name', league_name: 'Report Crew' },
    });
    // The queue carries no routes, runs or contact details.
    expect(JSON.stringify(queue)).not.toMatch(/@example\.test|points|lat|lon/);

    await expectCode(db.rpc(moderator, 'mod_resolve_report', { p_report_id: report.report_id, p_action: 'reset_alias', p_reason: '' }), 'invalid_input');
    await db.rpc(moderator, 'mod_resolve_report', { p_report_id: report.report_id, p_action: 'reset_alias', p_reason: 'Offensive alias' });
    const renamed = await db.rpc(rude, 'get_me');
    expect(renamed.profile.alias).toMatch(/^Runner [0-9A-Z]{6}$/);
    await expectCode(
      db.rpc(moderator, 'mod_resolve_report', { p_report_id: report.report_id, p_action: 'dismiss', p_reason: 'again' }),
      'already_resolved',
    );
    const audit = await db.sql('select action, reason from private.moderation_actions where report_id = $1', [report.report_id]);
    expect(audit).toEqual([{ action: 'reset_alias', reason: 'Offensive alias' }]);
  });
});

describe('telemetry', () => {
  it('accepts only allowlisted events with enumerated props, and deduplicates event ids', async () => {
    const user = await db.createRunner('Telemetry User');
    const eventId = randomUUID();
    const result = await db.rpc(user, 'log_events', {
      p_events: [
        { event_id: eventId, name: 'run_saved_local', environment: 'test', occurred_at_ms: Date.now(), props: { interrupted: false, duration_bucket: 'm30_60', lat: '41.87' } },
        { event_id: eventId, name: 'run_saved_local', environment: 'test', occurred_at_ms: Date.now(), props: {} },
        { event_id: randomUUID(), name: 'share_sheet_opened', environment: 'test', occurred_at_ms: Date.now(), props: { format: '41.8781,-87.62' } },
        { event_id: randomUUID(), name: 'route_uploaded', environment: 'test', occurred_at_ms: Date.now(), props: {} },
        { event_id: 'not-a-uuid', name: 'run_started', environment: 'test', occurred_at_ms: Date.now() },
        { event_id: randomUUID(), name: 'run_started', environment: 'prod!', occurred_at_ms: Date.now() },
        { event_id: randomUUID(), name: 'run_started', environment: 'test', occurred_at_ms: Date.now() - 30 * 86_400_000 },
      ],
    });
    expect(result).toEqual({ accepted: 3, dropped: 4 });
    const rows = await db.sql<{ name: string; props: Record<string, unknown>; subject: string }>(
      `select name, props, subject from private.operational_events
       where subject = private.subject_ref($1) and name <> 'onboarding_completed' order by name`,
      [user.id],
    );
    expect(rows.map((r) => [r.name, r.props])).toEqual([
      ['run_saved_local', { interrupted: false, duration_bucket: 'm30_60' }],
      ['share_sheet_opened', {}],
    ]);
    // Pseudonymous subject, never the raw account id.
    expect(rows[0]?.subject).not.toContain(user.id);
    expect(rows[0]?.subject).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('maintenance', () => {
  it('expires staged uploads after seven days and reports operational health', async () => {
    const user = await db.createRunner('Stale Upload');
    const start = await db.rpc(user, 'start_run_upload', startArgs(steadyRun(FRIDAY, 2000, 700), randomUUID()));
    await db.sql(`update public.runs set first_received_at = now() - interval '8 days' where id = $1`, [start.run_id]);
    const purged = await db.one<{ r: any }>('select private.purge_expired() as r');
    expect(purged.r.staged_uploads).toBeGreaterThanOrEqual(1);
    expect(await db.sql('select 1 from public.runs where id = $1', [start.run_id])).toHaveLength(0);
    const health = await db.one<{ h: any }>('select private.health_report() as h');
    expect(health.h).toMatchObject({ failed_deletion_jobs: 0, flags: { competition_enabled: true, invites_enabled: true } });
  });

  it('runs the frequent job bundle', async () => {
    const r = await db.one<{ r: any }>('select private.run_frequent_jobs() as r');
    expect(r.r).toEqual({ deletions_completed: expect.any(Number), pending_scored: expect.any(Number) });
  });
});
