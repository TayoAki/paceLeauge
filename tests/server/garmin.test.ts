import { createHmac } from 'node:crypto';

import { loadConfig } from '../../server/src/config';
import { activityRun, externalRunId, verifyTerraSignature, type TerraActivity, type TerraApi } from '../../server/src/garmin';
import { steadyRun } from '@/domain/synthetic';
import type { TestUser } from '../backend/helpers/db';
import { routelessRun, uploadRun } from '../backend/helpers/runs';
import { signIn, startTestApi, type TestApi } from './harness';

/**
 * Garmin through Terra (docs/ROADMAP.md 2.4) end to end: the widget session, Terra's signed
 * webhook, and activities uploaded as the runner — validated from their GPS, scored once, and kept
 * over the routeless Apple Health copy of the same workout.
 */
const SECRET = 'terra-signing-secret';
const TERRA_ENV = { TERRA_DEV_ID: 'paceleague-dev', TERRA_API_KEY: 'terra-key', TERRA_WEBHOOK_SECRET: SECRET };

class FakeTerra implements TerraApi {
  sessions: { referenceId: string; successUrl: string; failureUrl: string }[] = [];
  deauthorized: string[] = [];
  createWidgetSession = async (input: { referenceId: string; successUrl: string; failureUrl: string }) => {
    this.sessions.push(input);
    return `https://widget.example/session/${this.sessions.length}`;
  };
  deauthenticate = async (userId: string) => {
    this.deauthorized.push(userId);
  };
}

let api: TestApi;
let terra: FakeTerra;

beforeAll(async () => {
  terra = new FakeTerra();
  api = await startTestApi(TERRA_ENV, { terraApi: terra });
});

afterAll(async () => {
  await api.close();
});

const hoursAgo = (h: number) => Date.now() - h * 3_600_000;

function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

async function webhook(event: unknown, signature?: string): Promise<Response> {
  const body = JSON.stringify(event);
  return fetch(`${api.url}/integrations/garmin/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'terra-signature': signature ?? sign(body) },
    body,
  });
}

/** A Garmin run as Terra describes it, from a synthetic route (one GPS sample a second). */
function terraRun(summaryId: string, startAt: number, distanceM: number, durationS: number, extra: Partial<TerraActivity['metadata']> = {}): TerraActivity {
  const route = steadyRun(startAt, distanceM, durationS);
  return {
    metadata: {
      summary_id: summaryId,
      start_time: new Date(startAt).toISOString(),
      end_time: new Date(startAt + durationS * 1000).toISOString(),
      type: 8,
      name: 'Chicago Running',
      upload_type: 1,
      ...extra,
    },
    distance_data: { summary: { distance_meters: distanceM, steps: Math.round(durationS * 2.8) } },
    position_data: { position_samples: route.points.map((p) => ({ coords_lat_lng_deg: [p.lat, p.lon], timestamp: new Date(p.t).toISOString() })) },
    heart_rate_data: { summary: { avg_hr_bpm: 151, max_hr_bpm: 172 } },
    device_data: { name: 'Forerunner 265', manufacturer: 'Garmin' },
  };
}

/** Links a runner the way the widget does: a reference from the service, echoed in Terra's auth event. */
async function linked(alias: string, terraUserId: string): Promise<TestUser> {
  const runner = await api.db.createRunner(alias);
  const state = (await api.db.one<{ s: string }>('select private.garmin_new_state($1) as s', [runner.id])).s;
  const res = await webhook({ type: 'auth', status: 'success', reference_id: state, user: { user_id: terraUserId, provider: 'GARMIN', reference_id: state } });
  expect(res.status).toBe(200);
  expect(await api.db.rpc(runner, 'get_garmin_status')).toMatchObject({ available: true, connected: true });
  return runner;
}

async function lifetimeXp(user: TestUser): Promise<number> {
  return (await api.db.rpc(user, 'get_me')).lifetime_xp;
}

describe('connecting Garmin', () => {
  it('starts Terra’s widget with a one-time reference, and returns only to the app', async () => {
    const { client, session } = await signIn(api);
    const saved = await client.rpc('save_profile', {
      p_alias: 'Widget Wes',
      p_units: 'metric',
      p_goal_days: 3,
      p_notification_tz: 'America/Chicago',
      p_ack_eligibility: true,
    });
    expect(saved.error).toBeNull();
    const started = await client.rpc('start_garmin_connect', { p_return_to: 'paceleague://garmin' });
    expect(started.error).toBeNull();
    expect(started.data).toEqual({ url: 'https://widget.example/session/1' });
    expect(terra.sessions[0]).toMatchObject({
      referenceId: expect.stringMatching(/^[0-9a-f]{64}$/),
      successUrl: 'paceleague://garmin?garmin=connected',
      failureUrl: 'paceleague://garmin?garmin=error',
    });
    const refused = await client.rpc('start_garmin_connect', { p_return_to: 'https://evil.example/' });
    expect(refused.error?.message).toBe('invalid_input');

    // Terra's auth event with that reference links the runner.
    const res = await webhook({
      type: 'auth',
      status: 'success',
      reference_id: terra.sessions[0]!.referenceId,
      user: { user_id: 'terra-wes', provider: 'GARMIN', reference_id: terra.sessions[0]!.referenceId },
    });
    expect(res.status).toBe(200);
    const status = await client.rpc('get_garmin_status');
    expect(status.data).toMatchObject({ connected: true });
    void session;
  });

  it('refuses unsigned, forged and stale webhooks', async () => {
    const event = { type: 'deauth', user: { user_id: 'terra-anyone', provider: 'GARMIN' } };
    expect((await webhook(event, 'nonsense')).status).toBe(401);
    expect((await webhook(event, sign(JSON.stringify(event), 'wrong-secret'))).status).toBe(401);
    expect((await webhook(event, sign(JSON.stringify(event), SECRET, Math.floor(Date.now() / 1000) - 3_600))).status).toBe(401);
    const unsigned = await fetch(`${api.url}/integrations/garmin/webhook`, { method: 'POST', body: JSON.stringify(event) });
    expect(unsigned.status).toBe(401);
  });

  it('ends a connection nobody asked for instead of keeping it', async () => {
    const res = await webhook({ type: 'auth', status: 'success', reference_id: 'not-ours', user: { user_id: 'terra-stranger', provider: 'GARMIN' } });
    expect(res.status).toBe(200);
    await api.garmin!.runOnce();
    expect(terra.deauthorized).toContain('terra-stranger');
  });
});

describe('Garmin activities', () => {
  it('uploads a Garmin run with its route, scores it once, and keeps it over the Apple Health copy', async () => {
    const runner = await linked('Garmin Gwen', 'terra-gwen');
    // Terra sends activities soon after the watch syncs; older ones would wait for review as late.
    const start = hoursAgo(4);
    // Apple Health got the same workout first, without its route (Garmin doesn't share routes there).
    const health = await uploadRun(api.db, runner, routelessRun(start + 5_000, 8_000, 2_700), {
      extra: { p_source: 'health_import', p_external_id: 'HK-GARMIN-1', p_source_app: 'Garmin Connect', p_claimed_distance_m: 8_000 },
    });
    expect(health.result.run).toMatchObject({ status: 'personal_only', reason_codes: ['no_route'] });

    const activity = terraRun('garmin-summary-1', start, 8_000, 2_700);
    expect((await webhook({ type: 'activity', user: { user_id: 'terra-gwen', provider: 'GARMIN' }, data: [activity], version: '2022-03-16' })).status).toBe(200);
    expect(await api.garmin!.runOnce()).toMatchObject({ events: 1, runs: 1 });

    const run = await api.db.rpc(runner, 'get_my_run', { p_run_id: await runIdOf(runner, 'garmin-summary-1') });
    expect(run).toMatchObject({
      status: 'accepted',
      source: 'garmin',
      source_app: 'Garmin Connect',
      source_device: 'Garmin Forerunner 265',
      title: 'Chicago Running',
      avg_heart_rate: 151,
      xp_award: { total_xp: 105 },
    });
    expect(Number(run.distance_m)).toBeCloseTo(8_000, -2);
    expect(await api.db.rpc(runner, 'get_my_run', { p_run_id: health.runId })).toMatchObject({ status: 'duplicate', duplicate_of: run.id });
    expect(await lifetimeXp(runner)).toBe(105);

    // Terra delivers the same activity again: nothing changes.
    await webhook({ type: 'activity', user: { user_id: 'terra-gwen', provider: 'GARMIN' }, data: [activity] });
    expect(await api.garmin!.runOnce()).toMatchObject({ events: 1, runs: 0 });
    expect(await lifetimeXp(runner)).toBe(105);
    expect(await api.db.rpc(runner, 'get_garmin_status')).toMatchObject({ imported: 1 });
  });

  it('keeps walks, treadmill runs and typed-in workouts under their own rules', async () => {
    const runner = await linked('Garmin Mix', 'terra-mix');
    const walk = terraRun('garmin-walk', hoursAgo(10), 3_000, 2_100, { type: 7, name: null });
    const treadmill: TerraActivity = {
      ...terraRun('garmin-treadmill', hoursAgo(14), 6_000, 1_800, { type: 58, name: 'Treadmill Running' }),
      position_data: { position_samples: [] },
      distance_data: { summary: { distance_meters: 6_000, steps: 5_100 } },
    };
    const typed: TerraActivity = { ...terraRun('garmin-typed', hoursAgo(18), 5_000, 1_500, { upload_type: 2 }), position_data: null as never };
    await webhook({ type: 'activity', user: { user_id: 'terra-mix', provider: 'GARMIN' }, data: [walk, treadmill, typed] });
    expect(await api.garmin!.runOnce()).toMatchObject({ runs: 3 });

    expect(await api.db.rpc(runner, 'get_my_run', { p_run_id: await runIdOf(runner, 'garmin-walk') })).toMatchObject({ activity_type: 'walk', title: 'Garmin walk' });
    // A watch treadmill run with heart rate and steps earns capped indoor credit.
    expect(await api.db.rpc(runner, 'get_my_run', { p_run_id: await runIdOf(runner, 'garmin-treadmill') })).toMatchObject({
      status: 'accepted',
      indoor: true,
      xp_award: { total_xp: 75 },
    });
    expect(await api.db.rpc(runner, 'get_my_run', { p_run_id: await runIdOf(runner, 'garmin-typed') })).toMatchObject({
      status: 'personal_only',
      reason_codes: ['manual_entry'],
    });
  });

  it('drops activities for runners who aren’t linked, and stops after a deauthorization', async () => {
    await webhook({ type: 'activity', user: { user_id: 'terra-nobody', provider: 'GARMIN' }, data: [terraRun('garmin-orphan', hoursAgo(22), 5_000, 1_500)] });
    expect(await api.garmin!.runOnce()).toMatchObject({ runs: 0 });
    expect(await api.db.one(`select last_error from private.aggregator_inbox where aggregator_user_id = 'terra-nobody'`)).toEqual({ last_error: 'unknown_user' });

    const runner = await linked('Garmin Quit', 'terra-quit');
    expect((await webhook({ type: 'deauth', status: 'success', user: { user_id: 'terra-quit', provider: 'GARMIN' } })).status).toBe(200);
    expect(await api.db.rpc(runner, 'get_garmin_status')).toMatchObject({ connected: false });
  });

  it('ends the link with Terra when the runner disconnects', async () => {
    const runner = await linked('Garmin Bye', 'terra-bye');
    await api.db.rpc(runner, 'disconnect_garmin');
    await api.garmin!.runOnce();
    expect(terra.deauthorized).toContain('terra-bye');
  });
});

async function runIdOf(user: TestUser, summaryId: string): Promise<string> {
  const row = await api.db.one<{ id: string }>(`select id from public.runs where owner_id = $1 and external_id = $2`, [user.id, summaryId]);
  return row.id;
}

describe('Garmin helpers', () => {
  it('turns Terra’s activity into a run: stops split it, sparse GPS makes it routeless', () => {
    const start = Date.UTC(2026, 8, 1, 12);
    const activity = terraRun('split', start, 6_000, 2_000);
    // A ten-minute stop in the middle.
    const samples = activity.position_data!.position_samples!;
    const shifted = samples.map((s, i) => (i < 1_000 ? s : { ...s, timestamp: new Date(Date.parse(s.timestamp!) + 600_000).toISOString() }));
    const run = activityRun({ ...activity, metadata: { ...activity.metadata, end_time: new Date(start + 2_600_000).toISOString() }, position_data: { position_samples: shifted } })!;
    expect(run.segments).toHaveLength(2);
    expect(run.points.every((p) => p[4] === 5)).toBe(true);
    expect(new Set(run.points.map((p) => p[5]))).toEqual(new Set([0, 1]));
    expect(run.activeMs).toBeLessThan(2_000_000);

    const sparse = activityRun({ ...activity, position_data: { position_samples: [samples[0]!, { ...samples[1]!, timestamp: new Date(start + 1_000_000).toISOString() }] } })!;
    expect(sparse.points).toEqual([]);
    expect(sparse.segments).toEqual([{ index: 0, startAt: start, endAt: start + 2_000_000 }]);

    expect(activityRun({ metadata: { summary_id: 'x' } })).toBeNull();
    expect(externalRunId('terra', 'split')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(externalRunId('terra', 'split')).toBe(externalRunId('terra', 'split'));
  });

  it('checks Terra’s signature over the raw body', () => {
    const body = Buffer.from('{"type":"auth"}');
    const t = 1_790_000_000;
    const header = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.`).update(body).digest('hex')}`;
    expect(verifyTerraSignature(SECRET, header, body, t * 1000)).toBe(true);
    expect(verifyTerraSignature(SECRET, header, Buffer.from('{"type":"deauth"}'), t * 1000)).toBe(false);
    expect(verifyTerraSignature(SECRET, header, body, (t + 3_600) * 1000)).toBe(false);
    expect(verifyTerraSignature(SECRET, `t=${t},v0=abc,${header.split(',')[1]}`, body, t * 1000)).toBe(true);
    expect(verifyTerraSignature(SECRET, undefined, body)).toBe(false);
  });

  it('needs all of Terra’s settings together', () => {
    const base = { DATABASE_URL: 'postgres://localhost/x' };
    expect(loadConfig(base).garmin).toBeNull();
    expect(() => loadConfig({ ...base, TERRA_DEV_ID: 'x' })).toThrow(/together/);
    expect(loadConfig({ ...base, ...TERRA_ENV }).garmin).toMatchObject({ devId: 'paceleague-dev', returnPrefixes: ['paceleague://'] });
  });
});
