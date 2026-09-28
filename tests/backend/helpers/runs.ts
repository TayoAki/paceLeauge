import { createHash, randomUUID } from 'node:crypto';

import { competitionWeekAt } from '@/domain/calendar';
import { chunk, encodeChunk } from '@/domain/route-codec';
import { buildSyntheticRun, steadyRun, type Leg, type SyntheticRun } from '@/domain/synthetic';

import type { TestDb, TestUser } from './db';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface UploadOptions {
  title?: string;
  clientRunId?: string;
  /** Pretend the server first received the run this long after it ended (default 5 s). */
  receivedAfterMs?: number;
  finalize?: boolean;
  /** Extra start_run_upload arguments (source, provenance…). */
  extra?: Record<string, unknown>;
}

export interface Uploaded {
  runId: string;
  clientRunId: string;
  chunks: { seq: number; body: string; checksum: string }[];
  start: any;
  result: any;
}

export function chunksFor(run: SyntheticRun) {
  return chunk(run.points).map((points, seq) => {
    const body = encodeChunk(points);
    return { seq, body, checksum: sha256Hex(body) };
  });
}

export function startArgs(run: SyntheticRun, clientRunId: string, title = 'Test run') {
  const expectedChunks = Math.ceil(run.points.length / 500);
  return {
    p_client_run_id: clientRunId,
    p_started_at_ms: run.startedAt,
    p_ended_at_ms: run.endedAt,
    p_segments: run.segments,
    p_client_distance_m: run.truthDistanceM,
    p_client_active_ms: run.segments.reduce((s, x) => s + (x.endAt - x.startAt), 0),
    p_expected_points: run.points.length,
    p_expected_chunks: expectedChunks,
    p_title: title,
    p_interrupted: false,
  };
}

/** Full client upload protocol: start → chunks → finalize. */
export async function uploadRun(db: TestDb, user: TestUser, run: SyntheticRun, options: UploadOptions = {}): Promise<Uploaded> {
  const clientRunId = options.clientRunId ?? randomUUID();
  const start = await db.rpc(user, 'start_run_upload', { ...startArgs(run, clientRunId, options.title), ...options.extra });
  // Tests control "when the server first saw the run" independently of the wall clock.
  await db.sql('update public.runs set first_received_at = to_timestamp(($2::bigint + $3::bigint) / 1000.0) where id = $1', [
    start.run_id,
    run.endedAt,
    options.receivedAfterMs ?? 5_000,
  ]);
  const chunks = chunksFor(run);
  for (const c of chunks) {
    await db.rpc(user, 'put_route_chunk', { p_run_id: start.run_id, p_seq: c.seq, p_points: c.body, p_checksum: c.checksum });
  }
  let result: any = null;
  if (options.finalize !== false) {
    result = await db.rpc(user, 'finalize_run', {
      p_run_id: start.run_id,
      p_expected_version: start.version,
      p_manifest: chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })),
    });
  }
  return { runId: start.run_id, clientRunId, chunks, start, result };
}

export function runAt(startAt: number, distanceM: number, durationS: number): SyntheticRun {
  return steadyRun(startAt, distanceM, durationS);
}

export function legsRun(startAt: number, legs: Leg[]): SyntheticRun {
  return buildSyntheticRun({ startAt, legs });
}

/**
 * An instant inside the current competition week: Monday 07:00 CT plus `dayOffset` days and
 * `hourOffset` hours. It may lie in the future; validation uses the test-controlled receipt
 * time, never the wall clock, so tests are stable at any time of the week.
 */
export function inCurrentWeek(dayOffset: number, hourOffset = 0): number {
  const week = competitionWeekAt(Date.now());
  return week.startsAt + (dayOffset * 24 + 7 + hourOffset) * 3_600_000;
}

export function currentWeekStartMs(): number {
  return competitionWeekAt(Date.now()).startsAt;
}

/** Moves a runner's current membership start (tests simulate having joined earlier). */
export async function backdateMembership(db: TestDb, user: TestUser, joinedAtMs: number): Promise<void> {
  await db.sql('update public.league_members set joined_at = to_timestamp($2::bigint / 1000.0) where user_id = $1 and left_at is null', [
    user.id,
    joinedAtMs,
  ]);
}

/** A workout with times but no route (a Garmin run via Apple Health, a typed-in run, indoor). */
export function routelessRun(startAt: number, distanceM: number, durationS: number): SyntheticRun {
  const endedAt = startAt + durationS * 1000;
  return { startedAt: startAt, endedAt, segments: [{ index: 0, startAt, endAt: endedAt }], points: [], truthDistanceM: distanceM };
}
