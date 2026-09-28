import { TestDb, type TestUser } from './helpers/db';

/**
 * Garmin through an aggregator (docs/ROADMAP.md 2.4), the database's side: linking a runner from
 * the aggregator's auth event, the event inbox, disconnecting and account deletion. Uploading the
 * activities themselves is tested through the API service (tests/server/garmin.test.ts).
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
  await db.sql(`select private.set_garmin_integration(true, '{"aggregator": "terra"}')`);
});

afterAll(async () => {
  await db.close();
});

async function link(user: TestUser, terraUserId: string): Promise<string> {
  const state = (await db.one<{ s: string }>('select private.garmin_new_state($1) as s', [user.id])).s;
  return (await db.one<{ r: string }>(`select private.aggregator_link($1, 'terra', $2) as r`, [state, terraUserId])).r;
}

async function revocations(): Promise<string[]> {
  return (await db.sql<{ id: string }>(`select aggregator_user_id as id from private.aggregator_revocations order by id`)).map((r) => r.id);
}

describe('linking Garmin', () => {
  it('links the runner who started the widget, once', async () => {
    const runner = await db.createRunner('Garmin Gia');
    expect(await db.rpc(runner, 'get_garmin_status')).toMatchObject({ available: true, connected: false, imported: 0 });
    const state = (await db.one<{ s: string }>('select private.garmin_new_state($1) as s', [runner.id])).s;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.one<{ r: string }>(`select private.aggregator_link($1, 'terra', 'terra-gia') as r`, [state])).r).toBe('linked');
    // The reference is spent.
    expect((await db.one<{ r: string }>(`select private.aggregator_link($1, 'terra', 'terra-gia-2') as r`, [state])).r).toBe('unknown_reference');
    expect((await db.one<{ r: string }>(`select private.aggregator_link('made-up', 'terra', 'terra-x') as r`)).r).toBe('unknown_reference');
    expect(await db.rpc(runner, 'get_garmin_status')).toMatchObject({ connected: true, connected_at_ms: expect.any(Number) });
    expect((await db.one<{ u: string }>(`select private.aggregator_user('terra', 'terra-gia') as u`)).u).toBe(runner.id);
  });

  it('refuses an old reference, a Garmin account linked elsewhere, and lets go of a replaced link', async () => {
    const runner = await db.createRunner('Garmin Gus');
    const other = await db.createRunner('Garmin Ola');
    const state = (await db.one<{ s: string }>('select private.garmin_new_state($1) as s', [runner.id])).s;
    await db.sql(`update private.aggregator_connect_states set created_at = now() - interval '2 days' where user_id = $1`, [runner.id]);
    expect((await db.one<{ r: string }>(`select private.aggregator_link($1, 'terra', 'terra-gus') as r`, [state])).r).toBe('unknown_reference');

    expect(await link(runner, 'terra-gus')).toBe('linked');
    expect(await link(other, 'terra-gus')).toBe('in_use');
    const before = await revocations();
    expect(await link(runner, 'terra-gus-new')).toBe('linked');
    expect(await revocations()).toEqual([...before, 'terra-gus']);
    expect((await db.one<{ u: string | null }>(`select private.aggregator_user('terra', 'terra-gus') as u`)).u).toBeNull();
  });

  it('follows the aggregator’s reauth and deauth events', async () => {
    const runner = await db.createRunner('Garmin Ren');
    await link(runner, 'terra-ren-1');
    expect((await db.one<{ ok: boolean | null }>(`select private.aggregator_reauth('terra', 'terra-ren-1', 'terra-ren-2') as ok`)).ok).toBe(true);
    expect((await db.one<{ u: string }>(`select private.aggregator_user('terra', 'terra-ren-2') as u`)).u).toBe(runner.id);
    expect((await db.one<{ ok: boolean }>(`select private.aggregator_unlink('terra', 'terra-ren-2') as ok`)).ok).toBe(true);
    expect((await db.one<{ ok: boolean }>(`select private.aggregator_unlink('terra', 'terra-ren-2') as ok`)).ok).toBe(false);
    expect(await db.rpc(runner, 'get_garmin_status')).toMatchObject({ connected: false });
  });

  it('is unavailable until the service has aggregator credentials, and needs a profile', async () => {
    await db.sql(`select private.set_garmin_integration(false, '{}')`);
    try {
      const runner = await db.createRunner('Garmin Early');
      expect(await db.rpc(runner, 'get_garmin_status')).toMatchObject({ available: false });
      await expect(db.one('select private.garmin_new_state($1)', [runner.id])).rejects.toMatchObject({ message: 'not_available' });
    } finally {
      await db.sql(`select private.set_garmin_integration(true, '{"aggregator": "terra"}')`);
    }
    const noProfile = await db.createUser();
    await expect(db.one('select private.garmin_new_state($1)', [noProfile.id])).rejects.toMatchObject({ message: 'profile_required' });
  });
});

describe('the event inbox', () => {
  it('leases events, retries failures with backoff and sets them aside after ten tries', async () => {
    const id = (await db.one<{ id: string }>(`select private.aggregator_enqueue('terra', 'activity', 'terra-inbox', '{"data": []}') as id`)).id;
    const claimed = await db.sql<{ id: string }>('select * from private.aggregator_claim_inbox(50)');
    expect(claimed.map((c) => c.id)).toContain(id);
    expect((await db.sql<{ id: string }>('select * from private.aggregator_claim_inbox(50)')).map((c) => c.id)).not.toContain(id);
    await db.sql(`select private.aggregator_inbox_result($1, false, 'rate_limited')`, [id]);
    expect(await db.one('select attempts, processed_at is null as open from private.aggregator_inbox where id = $1', [id])).toEqual({ attempts: 1, open: true });
    await db.sql('update private.aggregator_inbox set attempts = 9 where id = $1', [id]);
    await db.sql(`select private.aggregator_inbox_result($1, false, 'still failing')`, [id]);
    expect(await db.one('select processed_at is not null as closed, last_error from private.aggregator_inbox where id = $1', [id])).toEqual({
      closed: true,
      last_error: 'still failing',
    });
  });
});

describe('ending the link', () => {
  it('disconnecting queues the aggregator deauthorization', async () => {
    const runner = await db.createRunner('Garmin Dee');
    await link(runner, 'terra-dee');
    expect(await db.rpc(runner, 'disconnect_garmin')).toMatchObject({ connected: false });
    expect(await revocations()).toContain('terra-dee');
    // Twice is harmless.
    await db.rpc(runner, 'disconnect_garmin');
  });

  it('account deletion ends the link, drops queued events and keeps the link in the export until then', async () => {
    const runner = await db.createRunner('Garmin Exporter');
    await link(runner, 'terra-exp');
    await db.sql(`select private.aggregator_enqueue('terra', 'activity', 'terra-exp', '{"data": [{}]}')`);
    const job = await db.rpc(runner, 'request_export');
    const data = await db.rpc(runner, 'get_export', { p_export_id: job.export_id });
    expect(data.format_version).toBe(3);
    expect(data.garmin).toMatchObject({ connected: true, aggregator: 'terra' });
    expect(JSON.stringify(data.garmin)).not.toContain('terra-exp');

    await db.sql('select private.purge_user_data($1)', [runner.id]);
    expect(await revocations()).toContain('terra-exp');
    expect(await db.sql(`select 1 from private.aggregator_inbox where aggregator_user_id = 'terra-exp'`)).toEqual([]);
  });

  it('retries a failed deauthorization, then gives up', async () => {
    await db.sql(`insert into private.aggregator_revocations (aggregator, aggregator_user_id) values ('terra', 'terra-retry')`);
    const [row] = await db.sql<{ id: string }>(`select * from private.aggregator_claim_revocations(50) where aggregator_user_id = 'terra-retry'`);
    await db.sql('select private.aggregator_revocation_result($1, false)', [row!.id]);
    expect(await db.one('select attempts from private.aggregator_revocations where id = $1', [row!.id])).toEqual({ attempts: 1 });
    await db.sql('update private.aggregator_revocations set attempts = 9 where id = $1', [row!.id]);
    await db.sql('select private.aggregator_revocation_result($1, false)', [row!.id]);
    expect(await db.sql('select 1 from private.aggregator_revocations where id = $1', [row!.id])).toEqual([]);
  });
});
