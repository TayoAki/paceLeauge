import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import type { StravaConfig } from './config';
import type { Pool } from './db';
import type { Logger } from './log';

/**
 * Strava export (docs/ROADMAP.md 2.3): the parts that need the client secret. The database keeps
 * the state (db/migrations/…_strava.sql); this module does the HTTP — the code exchange, token
 * refresh, uploads, revocation — and handles Strava's webhook. Nothing is ever read back from
 * Strava. Tokens are sealed with AES-256-GCM before they reach the database.
 */
export const STRAVA_TOKEN_URL = 'https://www.strava.com/api/v3/oauth/token';
export const STRAVA_UPLOADS_URL = 'https://www.strava.com/api/v3/uploads';
export const STRAVA_REVOKE_URL = 'https://www.strava.com/oauth/revoke';
/** Refresh this long before Strava's six-hour tokens expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_UPLOAD_ATTEMPTS = 8;
/** Uploads usually finish processing in under two seconds; after this many checks, give up. */
const MAX_STATUS_CHECKS = 30;

// ---------------------------------------------------------------------------------------
// Tokens at rest
// ---------------------------------------------------------------------------------------
export function sealToken(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function openToken(key: Buffer, sealed: string): string {
  const [version, iv, body, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('unreadable token');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------------------
// Strava's API
// ---------------------------------------------------------------------------------------
export class StravaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StravaError';
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }

  /** The grant is gone: the athlete revoked it, or the refresh token is no longer valid. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 400;
  }

  get transient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string | null;
  athlete: { id: number; name: string | null } | null;
}

export interface StravaUpload {
  uploadId: string;
  activityId: string | null;
  error: string | null;
}

export interface StravaApi {
  exchangeCode(code: string): Promise<StravaTokens>;
  refresh(refreshToken: string): Promise<StravaTokens>;
  upload(accessToken: string, file: { gpx: string; name: string; externalId: string; sportType: string }): Promise<StravaUpload>;
  uploadStatus(accessToken: string, uploadId: string): Promise<StravaUpload>;
  revoke(token: string): Promise<void>;
}

function tokensFrom(body: Record<string, unknown>): StravaTokens {
  const athlete = body.athlete as { id?: unknown; firstname?: unknown; lastname?: unknown } | undefined;
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_at !== 'number') {
    throw new StravaError(502, 'unexpected token response');
  }
  const name = [athlete?.firstname, athlete?.lastname].filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' ');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at * 1000,
    scope: typeof body.scope === 'string' ? body.scope : null,
    athlete: typeof athlete?.id === 'number' ? { id: athlete.id, name: name || null } : null,
  };
}

function uploadFrom(body: Record<string, unknown>): StravaUpload {
  const id = typeof body.id_str === 'string' ? body.id_str : typeof body.id === 'number' ? String(body.id) : null;
  if (!id) throw new StravaError(502, 'unexpected upload response');
  const activity = body.activity_id;
  return {
    uploadId: id,
    activityId: typeof activity === 'number' || (typeof activity === 'string' && activity !== '') ? String(activity) : null,
    error: typeof body.error === 'string' && body.error !== '' ? body.error : null,
  };
}

export function createStravaApi(config: Pick<StravaConfig, 'clientId' | 'clientSecret'>, fetchImpl: typeof fetch = fetch): StravaApi {
  const request = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new StravaError(0, error instanceof Error ? error.message : 'network error');
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!res.ok) {
      const message = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      throw new StravaError(res.status, message);
    }
    return body;
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields);
  return {
    exchangeCode: async (code) =>
      tokensFrom(
        await request(STRAVA_TOKEN_URL, {
          method: 'POST',
          body: form({ client_id: config.clientId, client_secret: config.clientSecret, code, grant_type: 'authorization_code' }),
        }),
      ),
    refresh: async (refreshToken) =>
      tokensFrom(
        await request(STRAVA_TOKEN_URL, {
          method: 'POST',
          body: form({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        }),
      ),
    upload: async (accessToken, file) => {
      const body = new FormData();
      body.set('file', new Blob([file.gpx], { type: 'application/gpx+xml' }), file.externalId);
      body.set('data_type', 'gpx');
      body.set('name', file.name);
      body.set('sport_type', file.sportType);
      body.set('external_id', file.externalId);
      return uploadFrom(await request(STRAVA_UPLOADS_URL, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body }));
    },
    uploadStatus: async (accessToken, uploadId) =>
      uploadFrom(
        await request(`${STRAVA_UPLOADS_URL}/${encodeURIComponent(uploadId)}`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }),
      ),
    revoke: async (token) => {
      const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      await request(STRAVA_REVOKE_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}` }, body: form({ token }) });
    },
  };
}

// ---------------------------------------------------------------------------------------
// The run as a GPX file
// ---------------------------------------------------------------------------------------
export interface RunFile {
  title: string;
  activity_type: string;
  status: string;
  deleted: boolean;
  started_at_ms: number;
  /** Compact route points: [seq, t, lat, lon, accuracy, segment]. */
  points: [number, number, number, number, number | null, number][];
}

const GPX_TYPE: Record<string, string> = { run: 'running', walk: 'walking', hike: 'hiking', ride: 'cycling', other: 'workout' };
const SPORT_TYPE: Record<string, string> = { run: 'Run', walk: 'Walk', hike: 'Hike', ride: 'Ride', other: 'Workout' };

export function sportTypeOf(activity: string): string {
  return SPORT_TYPE[activity] ?? 'Run';
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One track segment per active stretch, so paused time shows as a gap on Strava. */
export function runGpx(file: RunFile): string {
  const bySegment = new Map<number, RunFile['points']>();
  for (const p of [...file.points].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const list = bySegment.get(p[5]) ?? [];
    list.push(p);
    bySegment.set(p[5], list);
  }
  const segments = [...bySegment.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([, pts]) =>
        `<trkseg>${pts.map((p) => `<trkpt lat="${p[2].toFixed(7)}" lon="${p[3].toFixed(7)}"><time>${new Date(p[1]).toISOString()}</time></trkpt>`).join('')}</trkseg>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="PaceLeague" xmlns="http://www.topografix.com/GPX/1/1">' +
    `<metadata><time>${new Date(file.started_at_ms).toISOString()}</time></metadata>` +
    `<trk><name>${xml(file.title)}</name><type>${GPX_TYPE[file.activity_type] ?? 'running'}</type>${segments}</trk></gpx>\n`
  );
}

/** "duplicate of activity 12345" → "12345": Strava already has this run. */
export function duplicateActivityId(error: string | null): string | null {
  const match = error ? /duplicate of (?:<a[^>]*>)?activity (\d+)/i.exec(error) : null;
  return match?.[1] ?? null;
}

/** The next quarter hour, when Strava's 15-minute rate-limit window resets. */
export function secondsToNextWindow(now = Date.now()): number {
  const quarter = 15 * 60_000;
  return Math.ceil((quarter - (now % quarter)) / 1000) + 5;
}

// ---------------------------------------------------------------------------------------
// The background work
// ---------------------------------------------------------------------------------------
interface Connection {
  user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
}

export interface StravaWorker {
  runOnce(): Promise<{ enqueued: number; uploads: number; revocations: number; verified: number }>;
}

export function createStravaWorker(deps: { pool: Pool; api: StravaApi; config: StravaConfig; log: Logger; now?: () => number; sleep?: (ms: number) => Promise<void> }): StravaWorker {
  const { pool, api, config, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const seal = (token: string) => sealToken(config.tokenKey, token);
  const open = (sealed: string) => openToken(config.tokenKey, sealed);

  const connectionOf = async (userId: string): Promise<Connection | null> =>
    (
      await pool.query<Connection>(
        'select user_id, access_token_enc, refresh_token_enc, expires_at from private.strava_connections where user_id = $1',
        [userId],
      )
    ).rows[0] ?? null;

  /** A usable access token, refreshing it first when it is about to expire. Null when the grant is gone. */
  const accessToken = async (conn: Connection, force = false): Promise<string | null> => {
    if (!force && conn.expires_at.getTime() - now() > REFRESH_MARGIN_MS) return open(conn.access_token_enc);
    try {
      const tokens = await api.refresh(open(conn.refresh_token_enc));
      await pool.query('select private.strava_store_tokens($1, $2, $3, $4)', [
        conn.user_id,
        seal(tokens.accessToken),
        seal(tokens.refreshToken),
        new Date(tokens.expiresAt),
      ]);
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof StravaError && error.unauthorized) {
        await pool.query('select private.strava_forget($1, $2)', [conn.user_id, 'revoked_on_strava']);
        log.info('strava grant revoked', { status: error.status });
        return null;
      }
      throw error;
    }
  };

  const record = (runId: string, state: string, fields: { uploadId?: string | null; activityId?: string | null; error?: string | null; retryInS?: number; countAttempt?: boolean }) =>
    pool.query('select private.strava_record_upload($1, $2, $3, $4, $5, $6, $7)', [
      runId,
      state,
      fields.uploadId ?? null,
      fields.activityId ?? null,
      fields.error ?? null,
      fields.retryInS ?? 0,
      fields.countAttempt ?? false,
    ]);

  /** Follows an upload until Strava has processed it, checking a few times before handing back to the queue. */
  const follow = async (runId: string, token: string, uploadId: string, attempts: number): Promise<void> => {
    for (let check = 0; check < 3; check += 1) {
      const status = await api.uploadStatus(token, uploadId);
      const duplicate = duplicateActivityId(status.error);
      if (status.activityId || duplicate) return void (await record(runId, 'done', { uploadId, activityId: status.activityId ?? duplicate }));
      if (status.error) {
        // Strava's messages can include the file name; keep only the useful part.
        return void (await record(runId, 'failed', { uploadId, error: status.error.replace(/^.*?\.gpx\s*/i, '').slice(0, 300) }));
      }
      if (check < 2) await sleep(2_000);
    }
    if (attempts + 1 >= MAX_STATUS_CHECKS) return void (await record(runId, 'failed', { uploadId, error: 'Strava is still processing this run.' }));
    await record(runId, 'processing', { uploadId, retryInS: 30, countAttempt: true });
  };

  const processUpload = async (u: { run_id: string; user_id: string; state: string; upload_id: string | null; attempts: number }): Promise<void> => {
    const conn = await connectionOf(u.user_id);
    if (!conn) return void (await record(u.run_id, 'cancelled', { error: 'disconnected' }));
    try {
      let token = await accessToken(conn);
      if (!token) return;
      if (u.state === 'processing' && u.upload_id) return await follow(u.run_id, token, String(u.upload_id), u.attempts);
      const file = (await pool.query<{ f: RunFile | null }>('select private.strava_run_file($1) as f', [u.run_id])).rows[0]?.f ?? null;
      if (!file || file.deleted || !['accepted', 'review', 'personal_only'].includes(file.status) || file.points.length < 2) {
        return void (await record(u.run_id, 'cancelled', { error: 'run_removed' }));
      }
      const upload = { gpx: runGpx(file), name: file.title, externalId: `paceleague-${u.run_id}.gpx`, sportType: sportTypeOf(file.activity_type) };
      let result: StravaUpload;
      try {
        result = await api.upload(token, upload);
      } catch (error) {
        if (!(error instanceof StravaError) || error.status !== 401) throw error;
        // A token Strava no longer accepts: refresh once and try again.
        token = await accessToken(conn, true);
        if (!token) return;
        result = await api.upload(token, upload);
      }
      const duplicate = duplicateActivityId(result.error);
      if (result.activityId || duplicate) return void (await record(u.run_id, 'done', { uploadId: result.uploadId, activityId: result.activityId ?? duplicate }));
      if (result.error) return void (await record(u.run_id, 'failed', { uploadId: result.uploadId, error: result.error.slice(0, 300) }));
      await record(u.run_id, 'processing', { uploadId: result.uploadId });
      await follow(u.run_id, token, result.uploadId, 0);
    } catch (error) {
      if (error instanceof StravaError && error.rateLimited) {
        return void (await record(u.run_id, u.state, { uploadId: u.upload_id, retryInS: secondsToNextWindow(now()) }));
      }
      if (error instanceof StravaError && !error.transient) {
        return void (await record(u.run_id, 'failed', { uploadId: u.upload_id, error: error.message.slice(0, 300) }));
      }
      if (u.attempts + 1 >= MAX_UPLOAD_ATTEMPTS) {
        return void (await record(u.run_id, 'failed', { uploadId: u.upload_id, error: 'Strava was unavailable. Try posting again later.', countAttempt: true }));
      }
      log.warn('strava upload retry', { status: error instanceof StravaError ? error.status : 'error', attempts: u.attempts + 1 });
      await record(u.run_id, u.state, { uploadId: u.upload_id, retryInS: Math.min(3_600, 60 * 2 ** u.attempts), countAttempt: true });
    }
  };

  return {
    async runOnce() {
      const enqueued = Number((await pool.query<{ n: number }>('select private.strava_enqueue() as n')).rows[0]?.n ?? 0);

      // Connections Strava's webhook said were revoked: a refresh confirms it either way.
      const flagged = await pool.query<Connection>(
        `select user_id, access_token_enc, refresh_token_enc, expires_at from private.strava_connections
         where verify_requested_at is not null order by verify_requested_at limit 20`,
      );
      let verified = 0;
      for (const conn of flagged.rows) {
        try {
          await accessToken(conn, true);
          verified += 1;
        } catch (error) {
          log.warn('strava verify failed', { status: error instanceof StravaError ? error.status : 'error' });
        }
      }

      const claimed = await pool.query<{ run_id: string; user_id: string; state: string; upload_id: string | null; attempts: number }>(
        'select * from private.strava_claim_uploads(10)',
      );
      for (const u of claimed.rows) await processUpload(u);

      const revocations = await pool.query<{ id: string; refresh_token_enc: string; access_token_enc: string | null }>(
        'select * from private.strava_claim_revocations(10)',
      );
      for (const r of revocations.rows) {
        let done = false;
        try {
          await api.revoke(open(r.refresh_token_enc));
          done = true;
        } catch (error) {
          // A grant Strava no longer knows is as good as revoked.
          done = error instanceof StravaError && error.unauthorized;
          if (!done) log.warn('strava revoke retry', { status: error instanceof StravaError ? error.status : 'error' });
        }
        await pool.query('select private.strava_revocation_result($1, $2)', [r.id, done]);
      }
      await pool.query('select private.strava_purge()');
      return { enqueued, uploads: claimed.rows.length, revocations: revocations.rows.length, verified };
    },
  };
}

// ---------------------------------------------------------------------------------------
// HTTP: the OAuth callback and Strava's webhook
// ---------------------------------------------------------------------------------------
export interface StravaHttpResult {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

function page(status: number, message: string): StravaHttpResult {
  return {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" },
    body: `<!doctype html><meta name="viewport" content="width=device-width"><title>PaceLeague</title><p style="font:16px system-ui;margin:2em">${xml(message)}</p>`,
  };
}

function back(returnTo: string, result: string): StravaHttpResult {
  const target = new URL(returnTo);
  target.searchParams.set('strava', result);
  const href = target.toString();
  return {
    status: 302,
    headers: { Location: href, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" },
    body: `<!doctype html><title>PaceLeague</title><p><a href="${xml(href)}">Back to PaceLeague</a></p>`,
  };
}

/** Strava sends the runner here after they approve (or decline) the connection. */
export async function stravaCallback(deps: { pool: Pool; api: StravaApi; config: StravaConfig; log: Logger }, url: URL): Promise<StravaHttpResult> {
  const { pool, api, config, log } = deps;
  const taken = await pool.query<{ user_id: string; return_to: string; expired: boolean }>('select * from private.strava_take_state($1)', [
    url.searchParams.get('state') ?? '',
  ]);
  const state = taken.rows[0];
  if (!state) return page(400, 'This link has already been used or has expired. Go back to PaceLeague and connect Strava again.');
  if (state.expired) return back(state.return_to, 'expired');
  if (url.searchParams.get('error')) return back(state.return_to, 'denied');
  const code = url.searchParams.get('code');
  if (!code) return back(state.return_to, 'error');
  // The runner can untick the upload permission on Strava's screen; without it there is nothing to do.
  const granted = (url.searchParams.get('scope') ?? '').split(/[\s,]+/);
  if (!granted.includes('activity:write')) return back(state.return_to, 'scope');
  try {
    const tokens = await api.exchangeCode(code);
    if (!tokens.athlete) throw new StravaError(502, 'no athlete in token response');
    const saved = await pool.query<{ result: string }>('select private.strava_save_connection($1, $2, $3, $4, $5, $6, $7) as result', [
      state.user_id,
      tokens.athlete.id,
      tokens.athlete.name,
      tokens.scope ?? granted.join(','),
      sealToken(config.tokenKey, tokens.accessToken),
      sealToken(config.tokenKey, tokens.refreshToken),
      new Date(tokens.expiresAt),
    ]);
    const result = saved.rows[0]?.result ?? 'error';
    if (result === 'no_profile') await api.revoke(tokens.refreshToken).catch(() => undefined);
    log.info('strava connect', { result });
    return back(state.return_to, result);
  } catch (error) {
    log.warn('strava connect failed', { status: error instanceof StravaError ? error.status : 'error' });
    return back(state.return_to, 'error');
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Strava checks the webhook callback once, when the subscription is created. */
export function stravaWebhookChallenge(config: StravaConfig, url: URL): StravaHttpResult {
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  if (url.searchParams.get('hub.mode') !== 'subscribe' || !config.webhookVerifyToken || !safeEqual(token, config.webhookVerifyToken) || !challenge) {
    return { status: 403 };
  }
  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'hub.challenge': challenge }) };
}

/** Strava's events. Only an athlete revoking access matters; activity events are ignored (nothing is read back). */
export async function stravaWebhookEvent(pool: Pool, event: Record<string, unknown>): Promise<StravaHttpResult> {
  const updates = event.updates as Record<string, unknown> | undefined;
  const owner = event.owner_id ?? event.object_id;
  if (event.object_type === 'athlete' && updates && String(updates.authorized) === 'false' && (typeof owner === 'number' || typeof owner === 'string')) {
    const id = String(owner);
    if (/^\d{1,19}$/.test(id)) await pool.query('select private.strava_athlete_deauthorized($1)', [id]);
  }
  return { status: 200 };
}

/** Tells the database whether Strava is available and which public settings the app needs. */
export async function publishStravaSettings(pool: Pool, config: StravaConfig | null): Promise<void> {
  await pool.query('select private.set_strava_integration($1, $2)', [
    config !== null,
    config ? { client_id: config.clientId, redirect_uri: config.redirectUri, return_prefixes: config.returnPrefixes } : {},
  ]);
}
