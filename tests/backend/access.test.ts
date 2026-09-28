import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb } from './helpers/db';
import { chunksFor, startArgs, uploadRun } from './helpers/runs';

/**
 * Guardrail map (TECHNICAL_SPEC.md): identity, ownership, membership and XP integrity are
 * enforced by the database, not by the client. These tests enumerate the catalog so that
 * any new function or table without the right protection fails CI.
 */

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const ANON_ALLOWED = ['get_app_config', 'get_invite_preview', 'get_live_location'];

describe('function privileges', () => {
  it('lets anonymous callers execute only the allowlisted public functions', async () => {
    const rows = await db.sql<{ proname: string; anon: boolean; authed: boolean; pub: boolean }>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authed,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    );
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.anon).map((r) => r.proname).sort()).toEqual(ANON_ALLOWED);
    expect(rows.filter((r) => r.pub)).toEqual([]);
    expect(rows.filter((r) => !r.authed)).toEqual([]);
  });

  it('keeps every private function out of reach of API roles (except the RLS helper)', async () => {
    const rows = await db.sql<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private'
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['is_active_member']);
  });

  it('pins search_path on every SECURITY DEFINER function', async () => {
    const rows = await db.sql<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef
         and not coalesce(p.proconfig @> array['search_path=""'], false)`,
    );
    expect(rows).toEqual([]);
  });

  it('rejects anonymous calls to authenticated RPCs', async () => {
    await expect(db.rpc('anon', 'get_me')).rejects.toMatchObject({ sqlState: '42501' });
    await expect(db.rpc('anon', 'list_my_runs')).rejects.toMatchObject({ sqlState: '42501' });
    await expect(db.rpc('anon', 'join_league', { p_code: 'ABCDEFGH' })).rejects.toMatchObject({ sqlState: '42501' });
    await expect(db.rpc('anon', 'get_app_config')).resolves.toMatchObject({ competition_time_zone: 'America/Chicago' });
  });

  it('requires a verified identity even when a function is reachable', async () => {
    // An authenticated role without a subject claim (e.g. a forged/partial token) is refused.
    const noSubject = { id: null as unknown as string, email: 'x@example.test', signedInAt: 0 };
    await expect(db.rpc(noSubject, 'get_me')).rejects.toMatchObject({ code: 'not_authenticated' });
  });
});

describe('table privileges and row level security', () => {
  it('enables RLS on every public table', async () => {
    const rows = await db.sql<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('grants API roles no write privilege on any table and nothing on private tables', async () => {
    const writes = await db.sql<{ tbl: string; role: string }>(
      `select n.nspname || '.' || c.relname as tbl, r.role
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join (values ('anon'), ('authenticated')) r(role)
       where n.nspname in ('public', 'private') and c.relkind = 'r'
         and (has_table_privilege(r.role, c.oid, 'insert') or has_table_privilege(r.role, c.oid, 'update')
              or has_table_privilege(r.role, c.oid, 'delete') or has_table_privilege(r.role, c.oid, 'truncate'))`,
    );
    expect(writes).toEqual([]);
    const privateReads = await db.sql<{ tbl: string }>(
      `select c.relname as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relkind = 'r'
         and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))`,
    );
    expect(privateReads).toEqual([]);
    const anonReads = await db.sql<{ tbl: string }>(
      `select c.relname as tbl from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'select')`,
    );
    expect(anonReads).toEqual([]);
  });

  it('shows a runner only their own rows through direct table reads', async () => {
    const a = await db.createRunner('Owner A');
    const b = await db.createRunner('Other B');
    await uploadRun(db, a, steadyRun(Date.parse('2026-09-25T12:00:00Z'), 5240, 1888));
    const readAs = (user: typeof a, sql: string) => db.as(user, async (c) => (await c.query(sql)).rows);
    expect(await readAs(b, 'select * from public.runs')).toEqual([]);
    expect(await readAs(b, 'select * from public.daily_scores')).toEqual([]);
    expect((await readAs(b, 'select user_id from public.profiles')).map((r: any) => r.user_id)).toEqual([b.id]);
    expect(await readAs(a, 'select * from public.runs')).toHaveLength(1);
    await expect(readAs(b, 'select * from private.run_routes')).rejects.toMatchObject({ code: '42501' });
    await expect(readAs(a, 'select * from private.run_routes')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses direct writes of scores, XP, profiles and memberships', async () => {
    const a = await db.createRunner('Direct Writer');
    const attempt = (sql: string) => db.as(a, (c) => c.query(sql));
    await expect(attempt(`insert into public.daily_scores values ('${a.id}', current_date, 1, 1, 1, 100, 25, 125, 1)`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(attempt(`update public.runs set distance_cm = 999999999`)).rejects.toMatchObject({ code: '42501' });
    await expect(attempt(`update public.profiles set alias = 'Hacked'`)).rejects.toMatchObject({ code: '42501' });
    await expect(attempt(`insert into public.league_members (league_id, user_id, role) values (gen_random_uuid(), '${a.id}', 'owner')`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(attempt(`update private.profile_stats set lifetime_xp = 99999`)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('object ownership through RPCs', () => {
  it('lets no one upload into, or finalize, someone else’s run', async () => {
    const a = await db.createRunner('Upload Owner');
    const b = await db.createRunner('Upload Intruder');
    const run = steadyRun(Date.parse('2026-09-25T12:00:00Z'), 2000, 700);
    const start = await db.rpc(a, 'start_run_upload', startArgs(run, '6f2b0a1e-9a7c-4f0e-8e7d-1c2b3a4d5e6f'));
    const [c] = chunksFor(run);
    if (!c) throw new Error('no chunk');
    await expectCode(db.rpc(b, 'put_route_chunk', { p_run_id: start.run_id, p_seq: 0, p_points: c.body, p_checksum: c.checksum }), 'not_found');
    await expectCode(db.rpc(b, 'finalize_run', { p_run_id: start.run_id, p_expected_version: 1, p_manifest: [] }), 'not_found');
    // The same client run id under another account is a separate, unrelated upload.
    const theirs = await db.rpc(b, 'start_run_upload', startArgs(run, '6f2b0a1e-9a7c-4f0e-8e7d-1c2b3a4d5e6f'));
    expect(theirs.run_id).not.toBe(start.run_id);
  });

  it('ignores any caller-supplied XP or owner fields (there are none to supply)', async () => {
    const signatures = await db.sql<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'`,
    );
    const forbidden = /\bp_(owner|owner_id|user_id|xp|lifetime_xp|role|score|entitlement)\b/;
    expect(signatures.filter((s) => forbidden.test(s.args))).toEqual([]);
  });

  it('requires staff roles for moderation', async () => {
    const runner = await db.createRunner('Not Staff');
    await expectCode(db.rpc(runner, 'mod_list_reports'), 'not_staff');
    await expectCode(db.rpc(runner, 'mod_resolve_report', { p_report_id: '00000000-0000-0000-0000-000000000000', p_action: 'dismiss', p_reason: 'nope' }), 'not_staff');
  });

  it('requires onboarding before recording-related mutations', async () => {
    const fresh = await db.createUser();
    const run = steadyRun(Date.parse('2026-09-25T12:00:00Z'), 2000, 700);
    await expectCode(db.rpc(fresh, 'start_run_upload', startArgs(run, '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e')), 'profile_required');
    await expectCode(db.rpc(fresh, 'create_league', { p_name: 'No Profile' }), 'profile_required');
    await expect(db.rpc(fresh, 'get_me')).resolves.toMatchObject({ profile: null, lifetime_xp: 0 });
  });
});

describe('profiles', () => {
  it('validates aliases: length, characters, filter and case-insensitive uniqueness', async () => {
    const user = await db.createUser();
    const save = (alias: string, ack = true) =>
      db.rpc(user, 'save_profile', { p_alias: alias, p_units: 'metric', p_goal_days: null, p_notification_tz: null, p_ack_eligibility: ack });
    await expectCode(save('Valid Alias', false), 'eligibility_required');
    await expectCode(save('x'), 'alias_invalid');
    await expectCode(save('x'.repeat(25)), 'alias_invalid');
    await expectCode(save('bad<tag>'), 'alias_invalid');
    await expectCode(save('You'), 'alias_not_allowed');
    await db.createRunner('Taken Name');
    await expectCode(save('taken name'), 'alias_taken');
    const me = await save('  Zoë   Runner ');
    expect(me.profile).toMatchObject({ alias: 'Zoë Runner', units: 'metric', goal_days: null, status: 'active' });
    const check = await db.rpc(user, 'check_alias', { p_alias: 'TAKEN NAME' });
    expect(check).toEqual({ alias: 'TAKEN NAME', available: false, problem: 'taken' });
    await expectCode(
      db.rpc(user, 'save_profile', { p_alias: 'Zoë Runner', p_units: 'furlongs', p_goal_days: null, p_notification_tz: null }),
      'invalid_input',
    );
    await expectCode(
      db.rpc(user, 'save_profile', { p_alias: 'Zoë Runner', p_units: 'metric', p_goal_days: 5, p_notification_tz: null }),
      'invalid_input',
    );
    await expectCode(
      db.rpc(user, 'save_profile', { p_alias: 'Zoë Runner', p_units: 'metric', p_goal_days: 2, p_notification_tz: 'Mars/Olympus' }),
      'invalid_input',
    );
  });
});
