import { createHash } from 'node:crypto';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { inCurrentWeek, routelessRun, runAt, uploadRun } from './helpers/runs';

/**
 * Strava export (docs/ROADMAP.md 2.3), the database's side: connecting, which runs get posted,
 * the upload queue, disconnecting and account deletion. The HTTP side is in tests/server.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
  await db.sql(`select private.set_strava_integration(true, $1)`, [
    { client_id: '4242', redirect_uri: 'https://api.example.com/integrations/strava/callback', return_prefixes: ['paceleague://', 'https://app.example.com/'] },
  ]);
});

afterAll(async () => {
  await db.close();
});

let athletes = 1000;

/** Connects the runner as the service would after Strava's redirect. */
async function connect(user: TestUser, athleteId = (athletes += 1)): Promise<string> {
  const start = await db.rpc(user, 'start_strava_connect', { p_return_to: 'paceleague://strava' });
  const state = new URL(start.url).searchParams.get('state')!;
  const taken = await db.one<{ user_id: string; return_to: string; expired: boolean }>('select * from private.strava_take_state($1)', [state]);
  expect(taken).toMatchObject({ user_id: user.id, return_to: 'paceleague://strava', expired: false });
  const saved = await db.one<{ r: string }>(`select private.strava_save_connection($1, $2, 'Ada L', 'read,activity:write', 'v1.a', 'v1.r', now() + interval '6 hours') as r`, [
    user.id,
    athleteId,
  ]);
  return saved.r;
}

async function uploads(user: TestUser) {
  return db.sql<{ run_id: string; state: string; requested: boolean }>('select run_id, state, requested from private.strava_uploads where user_id = $1 order by created_at', [
    user.id,
  ]);
}

describe('connecting Strava', () => {
  it('builds Strava’s authorization URL with a one-time state, and only returns to the app', async () => {
    const runner = await db.createRunner('Strava Sam');
    expect(await db.rpc(runner, 'get_strava_status')).toMatchObject({ available: true, connected: false });
    const start = await db.rpc(runner, 'start_strava_connect', { p_return_to: 'paceleague://strava' });
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/mobile/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: '4242',
      redirect_uri: 'https://api.example.com/integrations/strava/callback',
      response_type: 'code',
      scope: 'activity:write',
    });
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // Stored only as a hash, and usable once.
    const stored = await db.sql('select state_hash from private.strava_connect_states where user_id = $1', [runner.id]);
    expect(stored).toEqual([{ state_hash: createHash('sha256').update(state).digest('hex') }]);
    expect(await db.sql('select * from private.strava_take_state($1)', [state])).toHaveLength(1);
    expect(await db.sql('select * from private.strava_take_state($1)', [state])).toHaveLength(0);

    await expectCode(db.rpc(runner, 'start_strava_connect', { p_return_to: 'https://evil.example.com/' }), 'invalid_input');
    expect((await db.rpc(runner, 'start_strava_connect', { p_return_to: 'https://app.example.com/strava' })).url).toContain('state=');
  });

  it('marks an old state as expired', async () => {
    const runner = await db.createRunner('Slow Sid');
    const start = await db.rpc(runner, 'start_strava_connect', { p_return_to: 'paceleague://strava' });
    const state = new URL(start.url).searchParams.get('state')!;
    await db.sql(`update private.strava_connect_states set created_at = now() - interval '20 minutes' where user_id = $1`, [runner.id]);
    expect(await db.one('select expired from private.strava_take_state($1)', [state])).toEqual({ expired: true });
  });

  it('keeps one Strava account to one PaceLeague account, and lets go of the old one when switching', async () => {
    const first = await db.createRunner('First Fay');
    const second = await db.createRunner('Second Sol');
    expect(await connect(first, 555)).toBe('connected');
    expect(await connect(second, 555)).toBe('athlete_in_use');
    expect(await db.rpc(second, 'get_strava_status')).toMatchObject({ connected: false });
    // Reconnecting the same account keeps it; switching to another queues the old grant's revocation.
    const before = Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n);
    expect(await connect(first, 555)).toBe('connected');
    expect(Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n)).toBe(before);
    expect(await connect(first, 556)).toBe('connected');
    expect(Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n)).toBe(before + 1);
    expect(await db.rpc(first, 'get_strava_status')).toMatchObject({ connected: true, athlete_name: 'Ada L', auto_upload: true });
  });

  it('is unavailable until the service has credentials', async () => {
    const runner = await db.createRunner('Early Eli');
    await db.sql(`update private.integrations set available = false where name = 'strava'`);
    try {
      expect(await db.rpc(runner, 'get_strava_status')).toMatchObject({ available: false });
      await expectCode(db.rpc(runner, 'start_strava_connect', { p_return_to: 'paceleague://strava' }), 'not_available');
    } finally {
      await db.sql(`update private.integrations set available = true where name = 'strava'`);
    }
  });
});

describe('what gets posted', () => {
  it('queues accepted runs recorded with PaceLeague after connecting, never imports or older runs', async () => {
    const runner = await db.createRunner('Poster Pat');
    const before = await uploadRun(db, runner, runAt(inCurrentWeek(0) - 14 * 86_400_000, 5_000, 1_500));
    await connect(runner);
    // Connecting "now": pretend the runner connected two weeks ago, after the old run.
    await db.sql(`update private.strava_connections set upload_since = to_timestamp($2::bigint / 1000.0) where user_id = $1`, [
      runner.id,
      inCurrentWeek(0) - 7 * 86_400_000,
    ]);
    const phone = await uploadRun(db, runner, runAt(inCurrentWeek(0), 5_000, 1_500));
    const short = await uploadRun(db, runner, runAt(inCurrentWeek(1), 60, 30));
    const imported = await uploadRun(db, runner, runAt(inCurrentWeek(2), 5_000, 1_500), {
      extra: { p_source: 'health_import', p_external_id: 'HK-S1', p_source_app: 'Workout' },
    });
    const routeless = await uploadRun(db, runner, routelessRun(inCurrentWeek(3), 5_000, 1_500), { extra: { p_source: 'indoor', p_claimed_distance_m: 5_000 } });
    expect(short.result.run.status).toBe('personal_only');

    await db.sql('select private.strava_enqueue()');
    expect((await uploads(runner)).map((u) => u.run_id)).toEqual([phone.runId]);
    // Idempotent.
    expect((await db.one<{ n: number }>('select private.strava_enqueue() as n')).n).toBe(0);

    // The runner can post an older run, or a history run with a route, by hand.
    expect(await db.rpc(runner, 'post_run_to_strava', { p_run_id: before.runId })).toMatchObject({ state: 'queued' });
    expect(await db.rpc(runner, 'post_run_to_strava', { p_run_id: short.runId })).toMatchObject({ state: 'queued' });
    await expectCode(db.rpc(runner, 'post_run_to_strava', { p_run_id: routeless.runId }), 'invalid_input');
    expect((await uploads(runner)).map((u) => [u.run_id, u.requested])).toEqual([
      [phone.runId, false],
      [before.runId, true],
      [short.runId, true],
    ]);
    void imported;
  });

  it('stops queueing while posting is off, and picks up from when it is turned back on', async () => {
    const runner = await db.createRunner('Pause Pia');
    await connect(runner);
    await db.sql(`update private.strava_connections set upload_since = now() - interval '30 days' where user_id = $1`, [runner.id]);
    expect(await db.rpc(runner, 'set_strava_auto_upload', { p_enabled: false })).toMatchObject({ auto_upload: false });
    await uploadRun(db, runner, runAt(inCurrentWeek(0) - 3 * 86_400_000, 5_000, 1_500));
    await db.sql('select private.strava_enqueue()');
    expect(await uploads(runner)).toEqual([]);
    await db.rpc(runner, 'set_strava_auto_upload', { p_enabled: true });
    await db.sql('select private.strava_enqueue()');
    expect(await uploads(runner)).toEqual([]);
  });

  it('refuses other runners’ runs', async () => {
    const owner = await db.createRunner('Owner Oli');
    const other = await db.createRunner('Other Ona');
    await connect(other);
    const run = await uploadRun(db, owner, runAt(inCurrentWeek(0), 5_000, 1_500));
    await expectCode(db.rpc(other, 'post_run_to_strava', { p_run_id: run.runId }), 'not_found');
    expect(await db.rpc(other, 'get_strava_upload', { p_run_id: run.runId })).toBeNull();
  });
});

describe('the upload queue', () => {
  it('leases claimed uploads, records results and reports them to the runner', async () => {
    const runner = await db.createRunner('Queue Quinn');
    await connect(runner);
    const run = await uploadRun(db, runner, runAt(inCurrentWeek(0), 5_000, 1_500));
    await db.rpc(runner, 'post_run_to_strava', { p_run_id: run.runId });
    const claimed = await db.sql<{ run_id: string }>('select * from private.strava_claim_uploads(50)');
    expect(claimed.map((c) => c.run_id)).toContain(run.runId);
    // Leased: a second claim doesn't see it.
    expect((await db.sql<{ run_id: string }>('select * from private.strava_claim_uploads(50)')).map((c) => c.run_id)).not.toContain(run.runId);

    const file = await db.one<{ f: { title: string; points: unknown[]; status: string } }>('select private.strava_run_file($1) as f', [run.runId]);
    expect(file.f).toMatchObject({ status: 'accepted', title: 'Test run' });
    expect(file.f.points.length).toBeGreaterThan(100);

    await db.sql(`select private.strava_record_upload($1, 'processing', 777, null, null, 0, false)`, [run.runId]);
    await db.sql(`select private.strava_record_upload($1, 'done', null, 12345678901, null, 0, false)`, [run.runId]);
    expect(await db.rpc(runner, 'get_strava_upload', { p_run_id: run.runId })).toMatchObject({ state: 'done', activity_id: '12345678901' });
    expect(await db.rpc(runner, 'get_strava_status')).toMatchObject({ posted: 1, pending: 0, failed: 0 });

    // A failed upload can be retried by hand; a done one stays done.
    await db.sql(`select private.strava_record_upload($1, 'failed', null, null, 'Bad file', 0, true)`, [run.runId]);
    expect(await db.rpc(runner, 'get_strava_status')).toMatchObject({ failed: 1, last_error: 'Bad file' });
    expect(await db.rpc(runner, 'post_run_to_strava', { p_run_id: run.runId })).toMatchObject({ state: 'queued', error: null });
  });
});

describe('disconnecting', () => {
  it('stops posting at once and queues the grant’s revocation', async () => {
    const runner = await db.createRunner('Leaving Lee');
    await connect(runner);
    const run = await uploadRun(db, runner, runAt(inCurrentWeek(0), 5_000, 1_500));
    await db.rpc(runner, 'post_run_to_strava', { p_run_id: run.runId });
    const before = Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n);
    expect(await db.rpc(runner, 'disconnect_strava')).toMatchObject({ connected: false });
    expect(await uploads(runner)).toEqual([{ run_id: run.runId, state: 'cancelled', requested: true }]);
    expect(Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n)).toBe(before + 1);
    // Disconnecting twice is harmless.
    await db.rpc(runner, 'disconnect_strava');
    await expectCode(db.rpc(runner, 'post_run_to_strava', { p_run_id: run.runId }), 'not_found');
  });

  it('forgets a grant revoked on Strava once the service confirms it', async () => {
    const runner = await db.createRunner('Revoked Rae');
    await connect(runner, 9_001);
    expect(await db.one<{ ok: boolean | null }>('select private.strava_athlete_deauthorized(9001) as ok')).toEqual({ ok: true });
    expect(await db.one<{ ok: boolean | null }>('select private.strava_athlete_deauthorized(1) as ok')).toEqual({ ok: null });
    // Flagged connections are not posted to until checked.
    const flagged = await db.one<{ v: string | null }>('select verify_requested_at as v from private.strava_connections where user_id = $1', [runner.id]);
    expect(flagged.v).not.toBeNull();
    await db.sql(`select private.strava_forget($1, 'revoked_on_strava')`, [runner.id]);
    expect(await db.rpc(runner, 'get_strava_status')).toMatchObject({ connected: false });
  });

  it('revokes the grant when the account is deleted, and keeps no tokens in the export', async () => {
    const runner = await db.createRunner('Export Eve');
    await connect(runner);
    const exportJob = await db.rpc(runner, 'request_export');
    const data = await db.rpc(runner, 'get_export', { p_export_id: exportJob.export_id });
    expect(data.format_version).toBe(3);
    expect(data.strava).toMatchObject({ connected: true, athlete_name: 'Ada L', uploads: [] });
    expect(JSON.stringify(data)).not.toContain('v1.a');
    expect(JSON.stringify(data)).not.toContain('v1.r');

    const before = Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n);
    await db.sql('select private.purge_user_data($1)', [runner.id]);
    expect(Number((await db.one<{ n: string }>('select count(*) as n from private.strava_revocations')).n)).toBe(before + 1);
    expect(await db.sql('select 1 from private.strava_connections where user_id = $1', [runner.id])).toEqual([]);
  });

  it('retries revocations with backoff and drops them after ten tries', async () => {
    await db.sql(`insert into private.strava_revocations (refresh_token_enc) values ('v1.retry')`);
    const [claimed] = await db.sql<{ id: string }>(`select * from private.strava_claim_revocations(50) where refresh_token_enc = 'v1.retry'`);
    await db.sql('select private.strava_revocation_result($1, false)', [claimed!.id]);
    expect(await db.one('select attempts from private.strava_revocations where id = $1', [claimed!.id])).toEqual({ attempts: 1 });
    await db.sql('update private.strava_revocations set attempts = 9 where id = $1', [claimed!.id]);
    await db.sql('select private.strava_revocation_result($1, false)', [claimed!.id]);
    expect(await db.sql('select 1 from private.strava_revocations where id = $1', [claimed!.id])).toEqual([]);
  });
});
