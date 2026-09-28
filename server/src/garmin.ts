import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { GarminConfig } from './config';
import type { Pool } from './db';
import type { Logger } from './log';
import { callRpc, type Claims } from './rpc';

/**
 * Garmin through the Terra aggregator (docs/ROADMAP.md 2.4 and decision 1). The runner connects
 * Garmin in Terra's widget; Terra then posts each activity, with its GPS samples, to our webhook.
 * The webhook only checks the signature and queues the event (db/migrations/…_garmin.sql); the
 * job uploads each activity as the runner through the same RPCs the app uses, with source
 * 'garmin', so it is validated from its GPS, scored once, and kept over the Apple Health copy of
 * the same workout, which has no route.
 */
export const TERRA_WIDGET_URL = 'https://access.tryterra.co/api/widget/session';
export const TERRA_DEAUTH_URL = 'https://api.tryterra.co/v2/auth/deauthenticateUser';
/** Signed events older than this are refused (replays). */
const SIGNATURE_TOLERANCE_S = 5 * 60;
/** GPS from a Garmin watch carries no accuracy; treat it like a good fix, as file imports do. */
const NOMINAL_ACCURACY_M = 5;
/** A stop longer than this splits the activity into separate active stretches. */
const PAUSE_GAP_MS = 5 * 60_000;
const MAX_POINTS = 50_000;
const POINTS_PER_CHUNK = 500;

export class TerraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TerraError';
  }
}

export interface TerraApi {
  /** A widget URL for connecting Garmin; `referenceId` comes back in the auth event. */
  createWidgetSession(input: { referenceId: string; successUrl: string; failureUrl: string }): Promise<string>;
  deauthenticate(terraUserId: string): Promise<void>;
}

export function createTerraApi(config: Pick<GarminConfig, 'devId' | 'apiKey'>, fetchImpl: typeof fetch = fetch): TerraApi {
  const headers = { 'dev-id': config.devId, 'x-api-key': config.apiKey };
  const request = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new TerraError(0, error instanceof Error ? error.message : 'network error');
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!res.ok) throw new TerraError(res.status, typeof body.message === 'string' ? body.message : `HTTP ${res.status}`);
    return body;
  };
  return {
    createWidgetSession: async ({ referenceId, successUrl, failureUrl }) => {
      const body = await request(TERRA_WIDGET_URL, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          reference_id: referenceId,
          providers: 'GARMIN',
          auth_success_redirect_url: successUrl,
          auth_failure_redirect_url: failureUrl,
          language: 'en',
        }),
      });
      if (typeof body.url !== 'string') throw new TerraError(502, 'no widget url');
      return body.url;
    },
    deauthenticate: async (terraUserId) => {
      await request(`${TERRA_DEAUTH_URL}?user_id=${encodeURIComponent(terraUserId)}`, { method: 'DELETE', headers });
    },
  };
}

/** Terra's `terra-signature: t=…,v1=…`: HMAC-SHA256 of `${t}.${raw body}` with the signing secret. */
export function verifyTerraSignature(secret: string, header: string | undefined, rawBody: Buffer, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d{1,12}$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// ---------------------------------------------------------------------------------------
// Terra's activity model → a run
// ---------------------------------------------------------------------------------------
export interface TerraActivity {
  metadata?: { start_time?: string; end_time?: string; type?: number; name?: string | null; summary_id?: string; upload_type?: number };
  distance_data?: { summary?: { distance_meters?: number | null; steps?: number | null } };
  position_data?: { position_samples?: { coords_lat_lng_deg?: (number | null)[] | null; timestamp?: string }[] | null };
  heart_rate_data?: { summary?: { avg_hr_bpm?: number | null; max_hr_bpm?: number | null } };
  active_durations_data?: { activity_seconds?: number | null };
  device_data?: { name?: string | null; manufacturer?: string | null };
}

type Activity = 'run' | 'walk' | 'hike' | 'ride' | 'other';

/** Terra's ActivityType values that matter here (running 8, treadmill 58, walking 7, hiking 35, biking 1/15/16). */
function activityOf(type: number | undefined): { activity: Activity; indoor: boolean } {
  switch (type) {
    case 8:
      return { activity: 'run', indoor: false };
    case 58:
      return { activity: 'run', indoor: true };
    case 7:
      return { activity: 'walk', indoor: false };
    case 35:
      return { activity: 'hike', indoor: false };
    case 1:
    case 15:
    case 16:
      return { activity: 'ride', indoor: false };
    default:
      return { activity: 'other', indoor: false };
  }
}

const TITLE: Record<Activity, string> = { run: 'Garmin run', walk: 'Garmin walk', hike: 'Garmin hike', ride: 'Garmin ride', other: 'Garmin workout' };

export interface ExternalRun {
  externalId: string;
  clientRunId: string;
  title: string;
  activity: Activity;
  indoor: boolean;
  manualEntry: boolean;
  startedAt: number;
  endedAt: number;
  segments: { index: number; startAt: number; endAt: number }[];
  /** Compact route points: [seq, t, lat, lon, accuracy, segment]. */
  points: [number, number, number, number, number, number][];
  distanceM: number;
  activeMs: number;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  steps: number | null;
  device: string | null;
}

/** A stable run id for an aggregator activity, so a redelivered event is the same run. */
export function externalRunId(aggregator: string, externalId: string): string {
  const h = createHash('sha256').update(`${aggregator}:${externalId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

const inRange = (v: number | null | undefined, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null;

export function activityRun(a: TerraActivity): ExternalRun | null {
  const summaryId = a.metadata?.summary_id;
  const start = Date.parse(a.metadata?.start_time ?? '');
  const end = Date.parse(a.metadata?.end_time ?? '');
  if (!summaryId || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const { activity, indoor } = activityOf(a.metadata?.type);

  // GPS samples inside the activity, in time order, one per timestamp.
  const samples = (a.position_data?.position_samples ?? [])
    .map((s) => ({ t: Date.parse(s.timestamp ?? ''), lat: s.coords_lat_lng_deg?.[0], lon: s.coords_lat_lng_deg?.[1] }))
    .filter(
      (s): s is { t: number; lat: number; lon: number } =>
        Number.isFinite(s.t) &&
        typeof s.lat === 'number' &&
        typeof s.lon === 'number' &&
        Math.abs(s.lat) <= 90 &&
        Math.abs(s.lon) <= 180 &&
        !(s.lat === 0 && s.lon === 0) &&
        s.t >= start - 60_000 &&
        s.t <= end + 60_000,
    )
    .sort((x, y) => x.t - y.t)
    .filter((s, i, all) => i === 0 || s.t !== all[i - 1]!.t);
  const step = Math.max(1, Math.ceil(samples.length / MAX_POINTS));
  const kept = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);

  // Stretches between long stops; a stretch with a single sample carries no distance and is dropped.
  const stretches: { startAt: number; endAt: number; samples: typeof kept }[] = [];
  for (const s of kept) {
    const last = stretches[stretches.length - 1];
    if (!last || s.t - last.endAt > PAUSE_GAP_MS) stretches.push({ startAt: s.t, endAt: s.t, samples: [s] });
    else {
      last.endAt = s.t;
      last.samples.push(s);
    }
  }
  const moving = stretches.filter((st) => st.endAt > st.startAt);
  const routed = moving.length > 0;
  const finalSegments: ExternalRun['segments'] = routed
    ? moving.map((st, index) => ({ index, startAt: st.startAt, endAt: st.endAt }))
    : [{ index: 0, startAt: start, endAt: end }];
  const finalPoints: ExternalRun['points'] = [];
  moving.forEach((st, index) => {
    for (const s of st.samples) finalPoints.push([finalPoints.length, s.t, s.lat, s.lon, NOMINAL_ACCURACY_M, index]);
  });
  const activeFromSegments = finalSegments.reduce((sum, seg) => sum + (seg.endAt - seg.startAt), 0);
  const reportedActive = a.active_durations_data?.activity_seconds;
  const distance = a.distance_data?.summary?.distance_meters;

  return {
    externalId: summaryId,
    clientRunId: externalRunId('terra', summaryId),
    title: (a.metadata?.name ?? '').trim().slice(0, 60) || TITLE[activity],
    activity,
    indoor: indoor && !routed,
    manualEntry: a.metadata?.upload_type === 2,
    startedAt: Math.min(start, finalSegments[0]?.startAt ?? start),
    endedAt: Math.max(end, finalSegments[finalSegments.length - 1]?.endAt ?? end),
    segments: finalSegments,
    points: finalPoints,
    distanceM: typeof distance === 'number' && Number.isFinite(distance) && distance >= 0 ? Math.min(distance, 1_000_000) : 0,
    activeMs: routed
      ? activeFromSegments
      : typeof reportedActive === 'number' && reportedActive > 0
        ? Math.round(reportedActive * 1000)
        : end - start,
    avgHeartRate: inRange(a.heart_rate_data?.summary?.avg_hr_bpm, 25, 250),
    maxHeartRate: inRange(a.heart_rate_data?.summary?.max_hr_bpm, 25, 250),
    steps: inRange(a.distance_data?.summary?.steps, 0, 1_000_000),
    device: [a.device_data?.manufacturer, a.device_data?.name].filter(Boolean).join(' ').slice(0, 100) || null,
  };
}

// ---------------------------------------------------------------------------------------
// Uploading as the runner
// ---------------------------------------------------------------------------------------
export class IngestError extends Error {
  constructor(
    readonly code: string,
    readonly retry: boolean,
  ) {
    super(code);
    this.name = 'IngestError';
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Uploads one activity through start_run_upload → put_route_chunk → finalize_run, as the runner. */
export async function ingestRun(pool: Pool, userId: string, run: ExternalRun): Promise<'created' | 'exists'> {
  const claims: Claims = { role: 'authenticated', sub: userId, aud: 'authenticated' };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const res = await callRpc(pool, fn, args, claims, { 'x-forwarded-for': 'garmin-sync' });
    if (res.status >= 300) {
      const code = (res.body as { message?: string } | null)?.message ?? `http_${res.status}`;
      throw new IngestError(code, code === 'rate_limited' || res.status >= 500);
    }
    return res.body as Record<string, unknown>;
  };
  const chunks: { seq: number; body: string; checksum: string }[] = [];
  for (let i = 0; i < run.points.length; i += POINTS_PER_CHUNK) {
    const body = JSON.stringify(run.points.slice(i, i + POINTS_PER_CHUNK));
    chunks.push({ seq: chunks.length, body, checksum: sha256Hex(body) });
  }
  const start = await rpc('start_run_upload', {
    p_client_run_id: run.clientRunId,
    p_started_at_ms: run.startedAt,
    p_ended_at_ms: run.endedAt,
    p_segments: run.segments,
    p_client_distance_m: run.distanceM,
    p_client_active_ms: run.activeMs,
    p_expected_points: run.points.length,
    p_expected_chunks: chunks.length,
    p_title: run.title,
    p_interrupted: false,
    p_source: 'garmin',
    p_activity_type: run.activity,
    p_source_app: 'Garmin Connect',
    p_source_device: run.device,
    p_manual_entry: run.manualEntry,
    p_external_id: run.externalId,
    p_claimed_distance_m: run.distanceM,
    p_avg_heart_rate: run.avgHeartRate,
    p_max_heart_rate: run.maxHeartRate,
    p_steps: run.steps,
    ...(run.indoor ? { p_indoor: true } : {}),
  });
  if (start.status !== 'uploading') return 'exists';
  const runId = String(start.run_id);
  for (const c of chunks) await rpc('put_route_chunk', { p_run_id: runId, p_seq: c.seq, p_points: c.body, p_checksum: c.checksum });
  await rpc('finalize_run', { p_run_id: runId, p_expected_version: start.version, p_manifest: chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })) });
  return 'created';
}

// ---------------------------------------------------------------------------------------
// The webhook and the job
// ---------------------------------------------------------------------------------------
interface TerraUser {
  user_id?: string;
  provider?: string;
  reference_id?: string | null;
}

/** Handles one signed Terra event. Quick by design: activities are only queued. */
export async function handleTerraEvent(pool: Pool, log: Logger, event: Record<string, unknown>): Promise<void> {
  const user = (event.user ?? {}) as TerraUser;
  const userId = typeof user.user_id === 'string' ? user.user_id : null;
  switch (event.type) {
    case 'auth': {
      if (event.status !== 'success' || !userId || String(user.provider ?? '').toUpperCase() !== 'GARMIN') return;
      const reference = typeof event.reference_id === 'string' ? event.reference_id : (user.reference_id ?? '');
      const { rows } = await pool.query<{ result: string }>(`select private.aggregator_link($1, 'terra', $2) as result`, [reference, userId]);
      const result = rows[0]?.result;
      // A connection we never asked for (or one too old to trust) is ended rather than paid for.
      if (result === 'unknown_reference') {
        await pool.query(`insert into private.aggregator_revocations (aggregator, aggregator_user_id) values ('terra', $1)`, [userId]);
      }
      log.info('garmin connect', { result });
      return;
    }
    case 'deauth':
    case 'access_revoked':
      if (userId) await pool.query(`select private.aggregator_unlink('terra', $1)`, [userId]);
      return;
    case 'user_reauth': {
      const oldId = (event.old_user as TerraUser | undefined)?.user_id;
      const newId = (event.new_user as TerraUser | undefined)?.user_id;
      if (oldId && newId) await pool.query(`select private.aggregator_reauth('terra', $1, $2)`, [oldId, newId]);
      return;
    }
    case 'activity':
      if (userId && Array.isArray(event.data) && event.data.length > 0) {
        await pool.query(`select private.aggregator_enqueue('terra', 'activity', $1, $2)`, [userId, event]);
      }
      return;
    default:
      // Sleep, daily, body and the rest aren't used.
      return;
  }
}

export interface GarminWorker {
  runOnce(): Promise<{ events: number; runs: number; revocations: number }>;
}

export function createGarminWorker(deps: { pool: Pool; terra: TerraApi; log: Logger }): GarminWorker {
  const { pool, terra, log } = deps;
  return {
    async runOnce() {
      let runs = 0;
      const claimed = await pool.query<{ id: string; aggregator_user_id: string; payload: { data?: TerraActivity[] } }>(
        'select id, aggregator_user_id, payload from private.aggregator_claim_inbox(5)',
      );
      for (const event of claimed.rows) {
        const owner = (await pool.query<{ u: string | null }>(`select private.aggregator_user('terra', $1) as u`, [event.aggregator_user_id])).rows[0]?.u ?? null;
        if (!owner) {
          await pool.query('select private.aggregator_inbox_result($1, true, $2)', [event.id, 'unknown_user']);
          continue;
        }
        try {
          let skipped = 0;
          for (const activity of event.payload.data ?? []) {
            const run = activityRun(activity);
            if (!run) {
              skipped += 1;
              continue;
            }
            if ((await ingestRun(pool, owner, run)) === 'created') runs += 1;
          }
          await pool.query('select private.aggregator_inbox_result($1, true, $2)', [event.id, skipped ? `skipped ${skipped}` : null]);
        } catch (error) {
          const retry = !(error instanceof IngestError) || error.retry;
          const message = error instanceof Error ? error.message : String(error);
          if (!retry) log.warn('garmin activity refused', { code: message });
          // A refusal (invalid input) won't get better with time; anything else is tried again.
          await pool.query('select private.aggregator_inbox_result($1, $2, $3)', [event.id, !retry, message]);
        }
      }

      const revocations = await pool.query<{ id: string; aggregator_user_id: string }>('select id, aggregator_user_id from private.aggregator_claim_revocations(10)');
      for (const r of revocations.rows) {
        let done = false;
        try {
          await terra.deauthenticate(r.aggregator_user_id);
          done = true;
        } catch (error) {
          done = error instanceof TerraError && error.status === 404;
          if (!done) log.warn('garmin deauth retry', { status: error instanceof TerraError ? error.status : 'error' });
        }
        await pool.query('select private.aggregator_revocation_result($1, $2)', [r.id, done]);
      }
      await pool.query('select private.aggregator_purge()');
      return { events: claimed.rows.length, runs, revocations: revocations.rows.length };
    },
  };
}

/** The service RPC that starts connecting: a fresh reference, then Terra's widget URL. */
export async function startGarminConnect(
  deps: { pool: Pool; terra: TerraApi; config: GarminConfig },
  userId: string,
  returnTo: unknown,
): Promise<{ url: string }> {
  if (typeof returnTo !== 'string' || returnTo.length > 300 || !deps.config.returnPrefixes.some((p) => returnTo.startsWith(p))) {
    throw new IngestError('invalid_input', false);
  }
  let state: string;
  try {
    state = (await deps.pool.query<{ s: string }>('select private.garmin_new_state($1) as s', [userId])).rows[0]!.s;
  } catch (error) {
    const message = (error as { message?: string }).message ?? 'error';
    throw new IngestError(message, false);
  }
  const back = (result: string) => {
    const url = new URL(returnTo);
    url.searchParams.set('garmin', result);
    return url.toString();
  };
  const url = await deps.terra.createWidgetSession({ referenceId: state, successUrl: back('connected'), failureUrl: back('error') });
  return { url };
}

/** Tells the database whether Garmin sync is available. */
export async function publishGarminSettings(pool: Pool, config: GarminConfig | null): Promise<void> {
  await pool.query('select private.set_garmin_integration($1, $2)', [config !== null, config ? { aggregator: 'terra' } : {}]);
}
