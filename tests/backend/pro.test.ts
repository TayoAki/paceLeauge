import { TestDb } from './helpers/db';

/**
 * Pro entitlements in the database (docs/ROADMAP.md 3.6): staff grants, what get_entitlements
 * reports, and that export and account deletion never depend on a subscription.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

describe('entitlements', () => {
  it('reports no Pro by default, a grant until it ends, and nothing after', async () => {
    const runner = await db.createRunner('Pro Pia');
    expect(await db.rpc(runner, 'get_entitlements')).toMatchObject({ pro: false, period: null, will_renew: false });

    await db.sql(`select private.grant_pro($1, now() + interval '30 days')`, [runner.id]);
    expect(await db.rpc(runner, 'get_entitlements')).toMatchObject({ pro: true, period: 'promotional', source: 'grant' });

    await db.sql(`select private.grant_pro($1, now() - interval '1 minute')`, [runner.id]);
    expect((await db.rpc(runner, 'get_entitlements')).pro).toBe(false);
  });

  it('keeps a store state only if it is newer than the one applied', async () => {
    const runner = await db.createRunner('Pro Quin');
    const state = (active: boolean) => ({ active, expires_at: new Date(Date.now() + 86_400_000).toISOString(), period_type: 'normal', will_renew: active });
    await db.sql(`select private.apply_entitlement($1, $2, now())`, [runner.id, state(true)]);
    await db.sql(`select private.apply_entitlement($1, $2, now() - interval '1 hour')`, [runner.id, state(false)]);
    expect((await db.rpc(runner, 'get_entitlements')).pro).toBe(true);
    await db.sql(`select private.apply_entitlement($1, $2, now() + interval '1 second')`, [runner.id, state(false)]);
    expect((await db.rpc(runner, 'get_entitlements')).pro).toBe(false);
  });

  it('exports the subscription, and deletes with the account whatever its state', async () => {
    const runner = await db.createRunner('Pro Rio');
    await db.sql(`select private.grant_pro($1, now() + interval '1 year')`, [runner.id]);
    await db.sql(`select private.billing_event_seen('evt-rio', $1, 'INITIAL_PURCHASE')`, [runner.id]);
    const job = await db.rpc(runner, 'request_export');
    const data = await db.rpc(runner, 'get_export', { p_export_id: job.export_id });
    expect(data.subscription).toMatchObject({ pro: true, source: 'grant' });

    await db.sql('select private.purge_user_data($1)', [runner.id]);
    expect(await db.sql('select 1 from private.entitlements where user_id = $1', [runner.id])).toEqual([]);
    expect(await db.sql(`select user_id from private.billing_events where event_id = 'evt-rio'`)).toEqual([{ user_id: null }]);
  });
});
