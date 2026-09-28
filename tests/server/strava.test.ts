import { randomBytes } from 'node:crypto';

import { ConfigError, loadConfig } from '../../server/src/config';
import {
  duplicateActivityId,
  openToken,
  runGpx,
  sealToken,
  secondsToNextWindow,
  StravaError,
  type StravaApi,
  type StravaTokens,
  type StravaUpload,
} from '../../server/src/strava';
import type { TestUser } from '../backend/helpers/db';
import { inCurrentWeek, runAt, uploadRun } from '../backend/helpers/runs';
import { startTestApi, type TestApi } from './harness';

/**
 * Strava export (docs/ROADMAP.md 2.3) through the real API service, with Strava itself replaced by a
 * fake: connecting through Strava's redirect, posting runs, token refresh, rate limits, revocation
 * and Strava's webhook.
 */
const TOKEN_KEY = randomBytes(32);
const STRAVA_ENV = {
  STRAVA_CLIENT_ID: '4242',
  STRAVA_CLIENT_SECRET: 'client-secret',
  STRAVA_TOKEN_KEY: TOKEN_KEY.toString('base64'),
  PUBLIC_URL: 'http://127.0.0.1',
  STRAVA_WEBHOOK_VERIFY_TOKEN: 'hook-token',
};

class FakeStrava implements StravaApi {
  athlete = 70_000;
  uploads: { token: string; gpx: string; name: string; externalId: string; sportType: string }[] = [];
  revoked: string[] = [];
  refreshed: string[] = [];
  /** Per-test behaviour; reset after each test. */
  onUpload: (() => Promise<StravaUpload>) | null = null;
  onStatus: ((uploadId: string) => Promise<StravaUpload>) | null = null;
  onRefresh: ((token: string) => Promise<StravaTokens>) | null = null;

  reset() {
    this.onUpload = null;
    this.onStatus = null;
    this.onRefresh = null;
  }

  exchangeCode = async (code: string): Promise<StravaTokens> => {
    if (code === 'broken') throw new StravaError(400, 'Bad Request');
    this.athlete += 1;
    return {
      accessToken: `access-${code}`,
      refreshToken: `refresh-${code}`,
      expiresAt: Date.now() + 6 * 3_600_000,
      scope: 'read,activity:write',
      athlete: { id: this.athlete, name: 'Ada Lovelace' },
    };
  };

  refresh = async (token: string): Promise<StravaTokens> => {
    this.refreshed.push(token);
    if (this.onRefresh) return this.onRefresh(token);
    return { accessToken: `access-after-${token}`, refreshToken: `refresh-after-${token}`, expiresAt: Date.now() + 6 * 3_600_000, scope: null, athlete: null };
  };

  upload = async (token: string, file: { gpx: string; name: string; externalId: string; sportType: string }): Promise<StravaUpload> => {
    this.uploads.push({ token, ...file });
    if (this.onUpload) return this.onUpload();
    return { uploadId: String(900 + this.uploads.length), activityId: null, error: null };
  };

  uploadStatus = async (_token: string, uploadId: string): Promise<StravaUpload> => {
    if (this.onStatus) return this.onStatus(uploadId);
    return { uploadId, activityId: `55${uploadId}`, error: null };
  };

  revoke = async (token: string): Promise<void> => {
    this.revoked.push(token);
  };
}

let api: TestApi;
let strava: FakeStrava;

beforeAll(async () => {
  strava = new FakeStrava();
  api = await startTestApi(STRAVA_ENV, { stravaApi: strava });
});

afterAll(async () => {
  await api.close();
});

afterEach(() => strava.reset());

async function startConnect(user: TestUser): Promise<string> {
  const start = await api.db.rpc(user, 'start_strava_connect', { p_return_to: 'paceleague://strava' });
  return new URL(start.url).searchParams.get('state')!;
}

async function callback(params: Record<string, string>): Promise<Response> {
  return fetch(`${api.url}/integrations/strava/callback?${new URLSearchParams(params)}`, { redirect: 'manual' });
}

/** Connects as a runner would, and backdates the connection so this week's runs are posted. */
async function connected(alias: string): Promise<TestUser> {
  const runner = await api.db.createRunner(alias);
  const res = await callback({ state: await startConnect(runner), code: `code-${alias.replace(/\W/g, '')}`, scope: 'read,activity:write' });
  expect(res.headers.get('location')).toBe('paceleague://strava?strava=connected');
  await api.db.sql(`update private.strava_connections set upload_since = now() - interval '30 days' where user_id = $1`, [runner.id]);
  return runner;
}

async function uploadRow(runId: string) {
  return api.db.one<{ state: string; activity_id: string | null; attempts: number; last_error: string | null; retry_in_s: number }>(
    `select state, activity_id::text, attempts, last_error, extract(epoch from next_attempt_at - now())::integer as retry_in_s
     from private.strava_uploads where run_id = $1`,
    [runId],
  );
}

describe('connecting through Strava', () => {
  it('exchanges the code, keeps the tokens sealed and sends the runner back to the app', async () => {
    const runner = await api.db.createRunner('Callback Cy');
    const state = await startConnect(runner);
    const res = await callback({ state, code: 'good', scope: 'read,activity:write' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('paceleague://strava?strava=connected');
    expect(await api.db.rpc(runner, 'get_strava_status')).toMatchObject({ available: true, connected: true, athlete_name: 'Ada Lovelace' });

    const row = await api.db.one<{ access_token_enc: string; refresh_token_enc: string }>(
      'select access_token_enc, refresh_token_enc from private.strava_connections where user_id = $1',
      [runner.id],
    );
    expect(row.access_token_enc).toMatch(/^v1\./);
    expect(row.access_token_enc).not.toContain('access-good');
    expect(openToken(TOKEN_KEY, row.access_token_enc)).toBe('access-good');
    expect(openToken(TOKEN_KEY, row.refresh_token_enc)).toBe('refresh-good');

    // A state works once.
    const again = await callback({ state, code: 'good', scope: 'read,activity:write' });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('already been used');
  });

  it('reports a declined connection, a missing upload permission and a failed exchange', async () => {
    const runner = await api.db.createRunner('Declined Dee');
    expect((await callback({ state: await startConnect(runner), error: 'access_denied' })).headers.get('location')).toBe('paceleague://strava?strava=denied');
    expect((await callback({ state: await startConnect(runner), code: 'x', scope: 'read' })).headers.get('location')).toBe('paceleague://strava?strava=scope');
    expect((await callback({ state: await startConnect(runner), code: 'broken', scope: 'read,activity:write' })).headers.get('location')).toBe(
      'paceleague://strava?strava=error',
    );
    expect((await callback({ state: 'made-up', code: 'x', scope: 'activity:write' })).status).toBe(400);
    expect(await api.db.rpc(runner, 'get_strava_status')).toMatchObject({ connected: false });
  });
});

describe('posting runs', () => {
  it('posts an accepted run once, as a GPX file with its route, and records Strava’s activity', async () => {
    const runner = await connected('Poster Poe');
    const run = await uploadRun(api.db, runner, runAt(inCurrentWeek(0), 5_000, 1_500), { title: 'Lakefront & back' });
    const before = strava.uploads.length;
    await api.strava!.runOnce();
    expect(strava.uploads.length).toBe(before + 1);
    const sent = strava.uploads[strava.uploads.length - 1]!;
    expect(sent).toMatchObject({ token: 'access-code-PosterPoe', name: 'Lakefront & back', externalId: `paceleague-${run.runId}.gpx`, sportType: 'Run' });
    expect(sent.gpx).toContain('<type>running</type>');
    expect(sent.gpx).toContain('<name>Lakefront &amp; back</name>');
    expect(sent.gpx.match(/<trkpt /g)?.length).toBeGreaterThan(1_000);
    expect(await uploadRow(run.runId)).toMatchObject({ state: 'done', activity_id: expect.stringMatching(/^55\d+$/) });
    expect(await api.db.rpc(runner, 'get_strava_upload', { p_run_id: run.runId })).toMatchObject({ state: 'done' });

    // Nothing is posted twice.
    await api.strava!.runOnce();
    expect(strava.uploads.length).toBe(before + 1);
  });

  it('treats Strava’s duplicate as already posted', async () => {
    const runner = await connected('Twice Tam');
    const run = await uploadRun(api.db, runner, runAt(inCurrentWeek(1), 5_000, 1_500));
    strava.onUpload = async () => ({ uploadId: '31', activityId: null, error: null });
    strava.onStatus = async (uploadId) => ({ uploadId, activityId: null, error: 'paceleague-x.gpx duplicate of activity 8888' });
    await api.strava!.runOnce();
    expect(await uploadRow(run.runId)).toMatchObject({ state: 'done', activity_id: '8888' });
  });

  it('waits for Strava’s rate-limit window, and backs off when Strava is down', async () => {
    const runner = await connected('Busy Bo');
    const limited = await uploadRun(api.db, runner, runAt(inCurrentWeek(2), 5_000, 1_500));
    strava.onUpload = async () => {
      throw new StravaError(429, 'Rate Limit Exceeded');
    };
    await api.strava!.runOnce();
    const waiting = await uploadRow(limited.runId);
    expect(waiting).toMatchObject({ state: 'queued', attempts: 0 });
    expect(waiting.retry_in_s).toBeGreaterThan(0);
    expect(waiting.retry_in_s).toBeLessThanOrEqual(15 * 60 + 5);

    const down = await uploadRun(api.db, runner, runAt(inCurrentWeek(3), 5_000, 1_500));
    strava.onUpload = async () => {
      throw new StravaError(503, 'Service Unavailable');
    };
    await api.db.sql(`update private.strava_uploads set next_attempt_at = now() where run_id = $1`, [limited.runId]);
    await api.strava!.runOnce();
    expect(await uploadRow(down.runId)).toMatchObject({ state: 'queued', attempts: 1 });
    expect((await uploadRow(down.runId)).retry_in_s).toBeGreaterThan(30);

    // A file Strava rejects fails for good, with Strava's reason.
    strava.onUpload = async () => {
      throw new StravaError(400, 'Bad file');
    };
    await api.db.sql(`update private.strava_uploads set next_attempt_at = now() where run_id = $1`, [down.runId]);
    await api.strava!.runOnce();
    expect(await uploadRow(down.runId)).toMatchObject({ state: 'failed', last_error: 'Bad file' });
  });
});

describe('tokens and revocation', () => {
  it('refreshes a token about to expire, and forgets a grant Strava refuses', async () => {
    const runner = await connected('Fresh Flo');
    await api.db.sql(`update private.strava_connections set expires_at = now() + interval '1 minute' where user_id = $1`, [runner.id]);
    const run = await uploadRun(api.db, runner, runAt(inCurrentWeek(4), 5_000, 1_500));
    await api.strava!.runOnce();
    expect(strava.refreshed).toContain('refresh-code-FreshFlo');
    expect(strava.uploads[strava.uploads.length - 1]!.token).toBe('access-after-refresh-code-FreshFlo');
    expect(await uploadRow(run.runId)).toMatchObject({ state: 'done' });

    // Later Strava refuses the refresh: the runner revoked PaceLeague on Strava.
    await api.db.sql(`update private.strava_connections set expires_at = now() where user_id = $1`, [runner.id]);
    const next = await uploadRun(api.db, runner, runAt(inCurrentWeek(5), 5_000, 1_500));
    strava.onRefresh = async () => {
      throw new StravaError(400, 'Bad Request');
    };
    await api.strava!.runOnce();
    expect(await api.db.rpc(runner, 'get_strava_status')).toMatchObject({ connected: false });
    expect(await uploadRow(next.runId)).toMatchObject({ state: 'cancelled', last_error: 'revoked_on_strava' });
  });

  it('revokes the grant with Strava after the runner disconnects', async () => {
    const runner = await connected('Gone Gil');
    await api.db.rpc(runner, 'disconnect_strava');
    await api.strava!.runOnce();
    expect(strava.revoked).toContain('refresh-code-GoneGil');
    expect(await api.db.sql(`select 1 from private.strava_revocations`)).toEqual([]);
  });
});

describe('Strava’s webhook', () => {
  it('answers Strava’s subscription check only with the verify token', async () => {
    const ok = await fetch(`${api.url}/integrations/strava/webhook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=hook-token`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ 'hub.challenge': 'abc123' });
    const wrong = await fetch(`${api.url}/integrations/strava/webhook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=guess`);
    expect(wrong.status).toBe(403);
  });

  it('checks a deauthorization with Strava before forgetting the grant', async () => {
    const real = await connected('Revoker Ren');
    const forged = await connected('Forged Fin');
    const athleteOf = async (user: TestUser) =>
      (await api.db.one<{ a: string }>('select athlete_id::text as a from private.strava_connections where user_id = $1', [user.id])).a;
    const post = (athlete: string) =>
      fetch(`${api.url}/integrations/strava/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ object_type: 'athlete', object_id: Number(athlete), aspect_type: 'update', owner_id: Number(athlete), updates: { authorized: 'false' } }),
      });
    const realAthlete = await athleteOf(real);
    expect((await post(realAthlete)).status).toBe(200);
    expect((await post(await athleteOf(forged))).status).toBe(200);
    // Activity events are ignored: nothing is read back from Strava.
    const activity = await fetch(`${api.url}/integrations/strava/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object_type: 'activity', object_id: 1, aspect_type: 'create', owner_id: 1 }),
    });
    expect(activity.status).toBe(200);

    // Strava refuses the real runner's refresh token, and accepts the other one.
    strava.onRefresh = async (token) => {
      if (token.includes('RevokerRen')) throw new StravaError(401, 'Authorization Error');
      return { accessToken: 'access-again', refreshToken: 'refresh-again', expiresAt: Date.now() + 6 * 3_600_000, scope: null, athlete: null };
    };
    await api.strava!.runOnce();
    expect(await api.db.rpc(real, 'get_strava_status')).toMatchObject({ connected: false });
    expect(await api.db.rpc(forged, 'get_strava_status')).toMatchObject({ connected: true });
    expect(await api.db.one('select verify_requested_at from private.strava_connections where user_id = $1', [forged.id])).toEqual({
      verify_requested_at: null,
    });
  });
});

describe('without Strava credentials', () => {
  it('has no Strava routes and reports Strava as unavailable', async () => {
    const plain = await startTestApi();
    try {
      expect((await fetch(`${plain.url}/integrations/strava/callback?state=x`)).status).toBe(404);
      const runner = await plain.db.createRunner('Plain Pax');
      expect(await plain.db.rpc(runner, 'get_strava_status')).toMatchObject({ available: false });
      expect(plain.strava).toBeNull();
    } finally {
      await plain.close();
    }
  });
});

describe('Strava helpers', () => {
  it('refuses a partial or unsafe Strava configuration', () => {
    const base = { DATABASE_URL: 'postgres://localhost/x' };
    expect(loadConfig(base).strava).toBeNull();
    expect(() => loadConfig({ ...base, STRAVA_CLIENT_ID: '4242' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...STRAVA_ENV, STRAVA_TOKEN_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...base, ...STRAVA_ENV, STRAVA_CLIENT_ID: 'abc' })).toThrow(/numeric/);
    const deployed = { ...base, APP_ENV: 'staging', EMAIL_PROVIDER: 'log', PUBLIC_API_KEY: 'pl_public_key_0123456789' };
    expect(() => loadConfig({ ...deployed, ...STRAVA_ENV })).toThrow(/https/);
    const config = loadConfig({ ...base, ...STRAVA_ENV, CORS_ORIGINS: 'https://app.example.com' }).strava!;
    expect(config.redirectUri).toBe('http://127.0.0.1/integrations/strava/callback');
    expect(config.returnPrefixes).toEqual(['paceleague://', 'https://app.example.com/']);
  });

  it('seals tokens so that tampering is detected', () => {
    const sealed = sealToken(TOKEN_KEY, 'secret-token');
    expect(sealed).not.toContain('secret-token');
    expect(openToken(TOKEN_KEY, sealed)).toBe('secret-token');
    expect(sealToken(TOKEN_KEY, 'secret-token')).not.toBe(sealed);
    const [v, iv, body, tag] = sealed.split('.');
    const flipped = `${v}.${iv}.${body!.slice(0, -2)}AA.${tag}`;
    expect(() => openToken(TOKEN_KEY, flipped)).toThrow();
    expect(() => openToken(randomBytes(32), sealed)).toThrow();
  });

  it('writes one track segment per active stretch, and reads Strava’s answers', () => {
    const gpx = runGpx({
      title: 'Hills <3',
      activity_type: 'hike',
      status: 'accepted',
      deleted: false,
      started_at_ms: Date.UTC(2026, 8, 1, 12),
      points: [
        [2, Date.UTC(2026, 8, 1, 12, 10), 41.9, -87.6, 5, 1],
        [0, Date.UTC(2026, 8, 1, 12, 0), 41.8, -87.6, 5, 0],
        [1, Date.UTC(2026, 8, 1, 12, 1), 41.81, -87.6, null, 0],
      ],
    });
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    expect(gpx).toContain('<type>hiking</type>');
    expect(gpx).toContain('<name>Hills &lt;3</name>');
    expect(gpx.indexOf('2026-09-01T12:00:00.000Z')).toBeLessThan(gpx.indexOf('2026-09-01T12:01:00.000Z'));
    expect(duplicateActivityId('x.gpx duplicate of activity 12345')).toBe('12345');
    expect(duplicateActivityId('duplicate of <a href="/activities/678">activity 678</a>')).toBe('678');
    expect(duplicateActivityId('Improperly formatted data')).toBeNull();
    expect(secondsToNextWindow(Date.UTC(2026, 8, 1, 12, 14, 30))).toBe(35);
  });
});
