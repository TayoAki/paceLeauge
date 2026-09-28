import { expectCode, TestDb } from './helpers/db';

/**
 * Live location (docs/ROADMAP.md 4.8): a link for this run only, that anyone with it can open
 * without an account, showing the runner's name and latest position, and that stops working the
 * moment the run ends, when the runner stops sharing, or when its time runs out.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const view = (token: string) => db.rpc('anon', 'get_live_location', { p_token: token });
const stored = (shareId: string) =>
  db.one<{ lat: number | null; lon: number | null; position_at: Date | null; ended_reason: string | null }>(
    'select lat, lon, position_at, ended_reason from private.live_shares where id = $1',
    [shareId],
  );

describe('live location', () => {
  it('shows the latest position to anyone with the link, and nothing once the run ends', async () => {
    const runner = await db.createRunner('Live Lou');
    const link = await db.rpc(runner, 'start_live_share', { p_minutes: 90 });
    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    expect(link.expires_at_ms).toBeGreaterThan(Date.now() + 89 * 60_000);
    // Only a hash of the code is kept.
    expect(await db.sql('select 1 from private.live_shares where token_hash = $1', [link.token])).toEqual([]);

    expect(await view(link.token)).toMatchObject({ state: 'live', alias: 'Live Lou', position: null });
    const at = Date.now() - 2_000;
    expect(
      await db.rpc(runner, 'post_live_location', {
        p_share_id: link.share_id,
        p_lat: 41.9,
        p_lon: -87.62,
        p_accuracy_m: 6,
        p_at_ms: at,
        p_distance_m: 2_450,
        p_elapsed_ms: 840_000,
      }),
    ).toMatchObject({ live: true });
    const live = await view(link.token);
    expect(live).toMatchObject({ state: 'live', position: { lat: 41.9, lon: -87.62, accuracy_m: 6 }, distance_m: 2_450, elapsed_ms: 840_000 });
    expect(Math.abs(live.position.at_ms - at)).toBeLessThan(1_000);
    // An older position arriving late doesn't move the runner back.
    await db.rpc(runner, 'post_live_location', { p_share_id: link.share_id, p_lat: 41.8, p_lon: -87.6, p_at_ms: at - 60_000 });
    expect((await view(link.token)).position.lat).toBe(41.9);

    // The run ends: the link stops at once, and the position is gone from the database.
    expect(await db.rpc(runner, 'end_live_share', { p_share_id: link.share_id, p_reason: 'run_ended' })).toEqual({ ended: 1 });
    expect(await view(link.token)).toEqual({ state: 'ended' });
    expect(await stored(link.share_id)).toEqual({ lat: null, lon: null, position_at: null, ended_reason: 'run_ended' });
    expect(await db.rpc(runner, 'post_live_location', { p_share_id: link.share_id, p_lat: 41.9, p_lon: -87.62 })).toMatchObject({ live: false });
    expect(await view(link.token)).toEqual({ state: 'ended' });
  });

  it('stops when its time runs out, and one link at a time', async () => {
    const runner = await db.createRunner('Live Lena');
    const first = await db.rpc(runner, 'start_live_share', { p_minutes: 30 });
    await db.rpc(runner, 'post_live_location', { p_share_id: first.share_id, p_lat: 40.7, p_lon: -74 });
    const second = await db.rpc(runner, 'start_live_share', { p_minutes: 60 });
    expect(await view(first.token)).toEqual({ state: 'ended' });
    expect((await stored(first.share_id)).ended_reason).toBe('replaced');
    expect((await view(second.token)).state).toBe('live');

    await db.rpc(runner, 'post_live_location', { p_share_id: second.share_id, p_lat: 40.71, p_lon: -74.01 });
    await db.sql(`update private.live_shares set expires_at = now() - interval '1 second' where id = $1`, [second.share_id]);
    expect(await view(second.token)).toEqual({ state: 'ended' });
    expect((await db.one<{ n: number }>('select private.expire_live_shares() as n')).n).toBeGreaterThanOrEqual(1);
    expect(await stored(second.share_id)).toMatchObject({ lat: null, lon: null, ended_reason: 'expired' });

    // Stopping by hand ends whatever is open.
    const third = await db.rpc(runner, 'start_live_share', {});
    expect(await db.rpc(runner, 'end_live_share', {})).toEqual({ ended: 1 });
    expect(await view(third.token)).toEqual({ state: 'ended' });
  });

  it('is the runner’s alone to post to, checks what it’s given, and shows nothing for a made-up link', async () => {
    const runner = await db.createRunner('Live Lars');
    const other = await db.createRunner('Live Other');
    const link = await db.rpc(runner, 'start_live_share', { p_minutes: 60 });
    await expectCode(db.rpc(other, 'post_live_location', { p_share_id: link.share_id, p_lat: 1, p_lon: 1 }), 'not_found');
    await expectCode(db.rpc(runner, 'post_live_location', { p_share_id: link.share_id, p_lat: 91, p_lon: 1 }), 'invalid_input');
    await expectCode(db.rpc(runner, 'start_live_share', { p_minutes: 5 }), 'invalid_input');
    await expectCode(db.rpc(runner, 'start_live_share', { p_minutes: 600 }), 'invalid_input');
    await expectCode(db.rpc(runner, 'end_live_share', { p_reason: 'bored' }), 'invalid_input');
    expect(await view('0'.repeat(64))).toEqual({ state: 'ended' });
    expect(await view('not-a-token')).toEqual({ state: 'ended' });

    // Without an account only the viewer works.
    await expect(db.rpc('anon', 'start_live_share', { p_minutes: 60 })).rejects.toMatchObject({ sqlState: '42501' });
    await expect(db.rpc('anon', 'post_live_location', { p_share_id: link.share_id, p_lat: 1, p_lon: 1 })).rejects.toMatchObject({ sqlState: '42501' });

    // An account being deleted stops showing at once.
    await db.sql(`update public.profiles set status = 'deleting' where user_id = $1`, [runner.id]);
    expect(await view(link.token)).toEqual({ state: 'ended' });
  });
});
