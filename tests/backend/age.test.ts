import { randomUUID } from 'node:crypto';

import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { startArgs } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const profileArgs = (alias: string) => ({
  p_alias: alias,
  p_units: 'metric',
  p_goal_days: 3,
  p_notification_tz: 'America/Chicago',
  p_ack_eligibility: true,
});

async function ageRow(user: TestUser) {
  return db.one<{ age_signal: string | null; age_signal_source: string | null; age_checked_at: Date | null }>(
    'select age_signal, age_signal_source, age_checked_at from public.profiles where user_id = $1',
    [user.id],
  );
}

describe('age assurance at sign-up', () => {
  it('records an adult store signal with its source', async () => {
    const user = await db.createUser();
    const me = await db.rpc(user, 'save_profile', { ...profileArgs('Adult Ada'), p_age_signal: 'adult', p_age_source: 'confirmed' });
    expect(me.profile.age_signal).toBe('adult');
    expect(me.profile.age_checked_at_ms).toEqual(expect.any(Number));
    const row = await ageRow(user);
    expect(row).toMatchObject({ age_signal: 'adult', age_signal_source: 'confirmed' });
  });

  it('accepts not_required, where the store says age rules do not apply', async () => {
    const user = await db.createUser();
    await db.rpc(user, 'save_profile', { ...profileArgs('Outside Olu'), p_age_signal: 'not_required', p_age_source: 'not_regulated' });
    expect((await ageRow(user)).age_signal).toBe('not_required');
  });

  it('refuses a minor and creates no profile', async () => {
    const user = await db.createUser();
    await expectCode(db.rpc(user, 'save_profile', { ...profileArgs('Young Yuki'), p_age_signal: 'minor', p_age_source: 'selfDeclared' }), 'age_restricted');
    const me = await db.rpc(user, 'get_me');
    expect(me.profile).toBeNull();
  });

  it('rejects unknown signals and malformed sources', async () => {
    const user = await db.createUser();
    await expectCode(db.rpc(user, 'save_profile', { ...profileArgs('Odd Otto'), p_age_signal: 'teen' }), 'invalid_input');
    await expectCode(db.rpc(user, 'save_profile', { ...profileArgs('Odd Otto'), p_age_signal: 'adult', p_age_source: 'drop table;' }), 'invalid_input');
  });

  it('still accepts clients that send no signal (older builds, web)', async () => {
    const user = await db.createUser();
    const me = await db.rpc(user, 'save_profile', profileArgs('Legacy Lee'));
    expect(me.profile.age_signal).toBeNull();
    expect((await ageRow(user)).age_checked_at).toBeNull();
  });

  it('keeps the recorded signal when a later profile edit sends none', async () => {
    const user = await db.createUser();
    await db.rpc(user, 'save_profile', { ...profileArgs('Keep Kai'), p_age_signal: 'adult', p_age_source: 'selfDeclared' });
    await db.rpc(user, 'save_profile', { ...profileArgs('Keep Kai'), p_goal_days: 2 });
    expect(await ageRow(user)).toMatchObject({ age_signal: 'adult', age_signal_source: 'selfDeclared' });
  });
});

describe('record_age_signal for existing accounts', () => {
  it('records a later adult answer', async () => {
    const runner = await db.createRunner('Later Lou');
    const me = await db.rpc(runner, 'record_age_signal', { p_signal: 'adult', p_source: 'guardianDeclared' });
    expect(me.profile.age_signal).toBe('adult');
  });

  it('locks a minor out of uploads and leagues, removes them from their league, and keeps export and deletion open', async () => {
    const owner = await db.createRunner('Owner Oona');
    await db.rpc(owner, 'create_league', { p_name: 'Family Five' });
    const invite = await db.rpc(owner, 'create_league_invite');
    const teen = await db.createRunner('Teen Tomas');
    await db.rpc(teen, 'join_league', { p_code: invite.code });

    const me = await db.rpc(teen, 'record_age_signal', { p_signal: 'minor', p_source: 'selfDeclared' });
    expect(me.profile.age_signal).toBe('minor');

    await expectCode(db.rpc(teen, 'start_run_upload', startArgs(steadyRun(Date.now() - 3_600_000, 5_000, 1_800), randomUUID())), 'age_restricted');
    await expectCode(db.rpc(teen, 'get_my_league'), 'age_restricted');
    // Their own history stays readable (and exportable).
    await db.rpc(teen, 'list_my_runs');
    await expectCode(db.rpc(teen, 'save_profile', profileArgs('Teen Tomas')), 'age_restricted');

    const membership = await db.one<{ left_reason: string | null }>(
      'select left_reason from public.league_members where user_id = $1 order by joined_at desc limit 1',
      [teen.id],
    );
    expect(membership.left_reason).toBe('age_restricted');
    const league = await db.rpc(owner, 'get_my_league');
    expect(JSON.stringify(league)).not.toContain('Teen Tomas');

    // Reading the account and deleting it still work.
    expect((await db.rpc(teen, 'get_me')).profile.alias).toBe('Teen Tomas');
    const deletion = await db.rpc(teen, 'request_account_deletion');
    expect(deletion.state).toBe('queued');
  });

  it('does not let a later adult answer unlock a locked account; staff can', async () => {
    const runner = await db.createRunner('Shared Sam');
    await db.rpc(runner, 'record_age_signal', { p_signal: 'minor' });
    const again = await db.rpc(runner, 'record_age_signal', { p_signal: 'adult', p_source: 'selfDeclared' });
    expect(again.profile.age_signal).toBe('minor');

    await db.sql(`select private.clear_age_restriction($1, 'checked ID with the account holder', 'ops@test')`, [runner.id]);
    expect((await ageRow(runner)).age_signal).toBe('adult');
    await db.rpc(runner, 'get_my_league');
    const audit = await db.one<{ action: string }>(`select action from private.audit_log where action = 'clear_age_restriction' limit 1`);
    expect(audit.action).toBe('clear_age_restriction');
  });

  it('needs a profile and a valid signal', async () => {
    const user = await db.createUser();
    await expectCode(db.rpc(user, 'record_age_signal', { p_signal: 'adult' }), 'profile_required');
    const runner = await db.createRunner('Valid Val');
    await expectCode(db.rpc(runner, 'record_age_signal', { p_signal: 'unknown' }), 'invalid_input');
  });

  it('is not callable anonymously', async () => {
    await expect(db.rpc('anon', 'record_age_signal', { p_signal: 'adult' })).rejects.toMatchObject({ sqlState: '42501' });
  });
});
