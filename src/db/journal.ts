import { isValidCoordinate } from '@/domain/geo';
import { transition, type SessionCommand, type SessionState } from '@/domain/recorder-machine';
import { normalizeAccuracy, normalizeCoordinate } from '@/domain/route-codec';
import type { RunXpEstimate } from '@/domain/scoring';
import type { ActiveSegment, EpochMs, ReasonCode, RunOutcome, TrackPoint } from '@/domain/types';
import { systemClock, type Clock } from '@/lib/clock';
import { Emitter } from '@/lib/emitter';
import { Mutex } from '@/lib/mutex';

import { migrate } from './migrations';
import type { SqlDatabase, SqlValue } from './types';

/**
 * The account-scoped local journal: the authoritative store for an unsynced recording.
 * Every write runs in a serialized transaction, so a session transition and the points it
 * governs can never disagree, and a crash leaves the last committed checkpoint intact.
 */

export interface StoredSession extends SessionState {
  nextSeq: number;
  pointCount: number;
  lastPointAt: EpochMs | null;
  /** Last durable evidence that the recorder was alive (points or heartbeat). */
  lastCheckpointAt: EpochMs;
}

export interface RawSample {
  timestamp: number;
  latitude: number;
  longitude: number;
  accuracy: number | null | undefined;
}

export interface AppendResult {
  accepted: TrackPoint[];
  limitReached: boolean;
  session: StoredSession | null;
}

export type SyncState = 'pending' | 'uploading' | 'awaiting_validation' | 'synced' | 'needs_attention';

export interface LocalValidationSummary {
  outcome: RunOutcome;
  reasons: ReasonCode[];
  coverage: number;
  distanceCm: number;
  activeMs: number;
}

export interface SavedRun {
  runId: string;
  title: string;
  startedAt: EpochMs;
  endedAt: EpochMs;
  activeMs: number;
  distanceM: number;
  pointCount: number;
  segments: ActiveSegment[];
  interrupted: boolean;
  validation: LocalValidationSummary;
  provisionalXp: RunXpEstimate | null;
  syncState: SyncState;
  syncError: string | null;
  serverRunId: string | null;
  /** Last server representation (run_json), parsed by the API layer. */
  server: unknown;
  routeCached: boolean;
  deleted: boolean;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export type SavedRunDraft = Pick<
  SavedRun,
  'title' | 'startedAt' | 'endedAt' | 'activeMs' | 'distanceM' | 'segments' | 'interrupted' | 'validation' | 'provisionalXp'
>;

export type OutboxKind = 'upload_run' | 'rename_run' | 'delete_run';
export type OutboxState = 'pending' | 'uploading' | 'awaiting_validation' | 'succeeded' | 'needs_attention';

export interface OutboxItem {
  id: number;
  kind: OutboxKind;
  runId: string;
  payload: Record<string, unknown>;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: EpochMs;
  lastError: string | null;
  progress: Record<string, unknown> | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}

export interface QueuedEvent {
  eventId: string;
  name: string;
  occurredAt: EpochMs;
  props: Record<string, string | boolean>;
}

export type JournalChange = 'session' | 'points' | 'saved' | 'outbox' | 'kv' | 'events';

export class SessionMismatchError extends Error {
  constructor() {
    super('The active recording does not match this run.');
    this.name = 'SessionMismatchError';
  }
}

interface SessionRow {
  run_id: string;
  status: SessionState['status'];
  started_at: number;
  segments_json: string;
  open_segment_index: number | null;
  open_segment_started_at: number | null;
  interrupted_at: number | null;
  interrupt_reason: SessionState['interruptReason'];
  was_interrupted: number;
  next_seq: number;
  point_count: number;
  last_point_at: number | null;
  last_checkpoint_at: number;
}

interface SavedRunRow {
  run_id: string;
  title: string;
  started_at: number;
  ended_at: number;
  active_ms: number;
  distance_m: number;
  point_count: number;
  segments_json: string;
  interrupted: number;
  validation_json: string;
  provisional_xp_json: string | null;
  sync_state: SyncState;
  sync_error: string | null;
  server_run_id: string | null;
  server_json: string | null;
  route_cached: number;
  deleted: number;
  created_at: number;
  updated_at: number;
}

interface OutboxRow {
  id: number;
  kind: OutboxKind;
  run_id: string;
  payload_json: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  progress_json: string | null;
  created_at: number;
  updated_at: number;
}

interface PointRow {
  seq: number;
  segment_index: number;
  t: number;
  lat: number;
  lon: number;
  accuracy: number | null;
}

function toSession(row: SessionRow): StoredSession {
  return {
    status: row.status,
    runId: row.run_id,
    startedAt: row.started_at,
    segments: JSON.parse(row.segments_json) as ActiveSegment[],
    openSegment:
      row.open_segment_index === null || row.open_segment_started_at === null
        ? null
        : { index: row.open_segment_index, startAt: row.open_segment_started_at },
    interruptedAt: row.interrupted_at,
    interruptReason: row.interrupt_reason,
    wasInterrupted: row.was_interrupted === 1,
    nextSeq: row.next_seq,
    pointCount: row.point_count,
    lastPointAt: row.last_point_at,
    lastCheckpointAt: row.last_checkpoint_at,
  };
}

function toSavedRun(row: SavedRunRow): SavedRun {
  return {
    runId: row.run_id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    activeMs: row.active_ms,
    distanceM: row.distance_m,
    pointCount: row.point_count,
    segments: JSON.parse(row.segments_json) as ActiveSegment[],
    interrupted: row.interrupted === 1,
    validation: JSON.parse(row.validation_json) as LocalValidationSummary,
    provisionalXp: row.provisional_xp_json ? (JSON.parse(row.provisional_xp_json) as RunXpEstimate) : null,
    syncState: row.sync_state,
    syncError: row.sync_error,
    serverRunId: row.server_run_id,
    server: row.server_json ? JSON.parse(row.server_json) : null,
    routeCached: row.route_cached === 1,
    deleted: row.deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOutbox(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    kind: row.kind,
    runId: row.run_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    progress: row.progress_json ? (JSON.parse(row.progress_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPoint(row: PointRow): TrackPoint {
  return { seq: row.seq, segmentIndex: row.segment_index, t: row.t, lat: row.lat, lon: row.lon, accuracyM: row.accuracy };
}

export class Journal {
  readonly changes = new Emitter<JournalChange>();
  private readonly mutex = new Mutex();

  private constructor(
    readonly db: SqlDatabase,
    private readonly clock: Clock,
  ) {}

  static async open(db: SqlDatabase, clock: Clock = systemClock): Promise<Journal> {
    await migrate(db);
    return new Journal(db, clock);
  }

  async close(): Promise<void> {
    await this.mutex.run(() => this.db.closeAsync());
  }

  private read<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }

  private async write<T>(change: JournalChange | JournalChange[], fn: () => Promise<T>): Promise<T> {
    const result = await this.mutex.run(async () => {
      await this.db.execAsync('begin immediate');
      try {
        const value = await fn();
        await this.db.execAsync('commit');
        return value;
      } catch (error) {
        await this.db.execAsync('rollback').catch(() => undefined);
        throw error;
      }
    });
    for (const c of Array.isArray(change) ? change : [change]) this.changes.emit(c);
    return result;
  }

  // ---------------------------------------------------------------------------------------
  // Active session
  // ---------------------------------------------------------------------------------------
  private async loadSession(): Promise<StoredSession | null> {
    const row = await this.db.getFirstAsync<SessionRow>('select * from active_session where id = 1');
    return row ? toSession(row) : null;
  }

  private async saveSession(s: StoredSession): Promise<void> {
    await this.db.runAsync(
      `insert into active_session (id, run_id, status, started_at, segments_json, open_segment_index, open_segment_started_at,
         interrupted_at, interrupt_reason, was_interrupted, next_seq, point_count, last_point_at, last_checkpoint_at, updated_at)
       values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set run_id = excluded.run_id, status = excluded.status, started_at = excluded.started_at,
         segments_json = excluded.segments_json, open_segment_index = excluded.open_segment_index,
         open_segment_started_at = excluded.open_segment_started_at, interrupted_at = excluded.interrupted_at,
         interrupt_reason = excluded.interrupt_reason, was_interrupted = excluded.was_interrupted, next_seq = excluded.next_seq,
         point_count = excluded.point_count, last_point_at = excluded.last_point_at,
         last_checkpoint_at = excluded.last_checkpoint_at, updated_at = excluded.updated_at`,
      [
        s.runId,
        s.status,
        s.startedAt,
        JSON.stringify(s.segments),
        s.openSegment?.index ?? null,
        s.openSegment?.startAt ?? null,
        s.interruptedAt,
        s.interruptReason,
        s.wasInterrupted ? 1 : 0,
        s.nextSeq,
        s.pointCount,
        s.lastPointAt,
        s.lastCheckpointAt,
        this.clock.now(),
      ],
    );
  }

  private async logEvent(runId: string, type: string, at: EpochMs): Promise<void> {
    await this.db.runAsync(
      `insert into session_events (run_id, seq, type, at)
       values (?, coalesce((select max(seq) + 1 from session_events where run_id = ?), 0), ?, ?)`,
      [runId, runId, type, at],
    );
  }

  getSession(): Promise<StoredSession | null> {
    return this.read(() => this.loadSession());
  }

  startSession(runId: string, at: EpochMs): Promise<StoredSession> {
    return this.write('session', async () => {
      const result = transition(await this.loadSession(), { type: 'start', runId, at });
      if (!result.state) throw new Error('start produced no session');
      const stored: StoredSession = { ...result.state, nextSeq: 0, pointCount: 0, lastPointAt: null, lastCheckpointAt: at };
      await this.saveSession(stored);
      await this.logEvent(runId, 'start', at);
      return stored;
    });
  }

  /** pause / resume / interrupt / recover, persisted atomically with an event record. */
  command(command: Extract<SessionCommand, { type: 'pause' | 'resume' | 'interrupt' | 'recover' }>): Promise<StoredSession> {
    return this.write('session', async () => {
      const current = await this.loadSession();
      const result = transition(current, command);
      if (!current || !result.state) throw new Error('command produced no session');
      const at = 'at' in command ? command.at : this.clock.now();
      const stored: StoredSession = {
        ...result.state,
        nextSeq: current.nextSeq,
        pointCount: current.pointCount,
        lastPointAt: current.lastPointAt,
        lastCheckpointAt: command.type === 'interrupt' ? current.lastCheckpointAt : Math.max(current.lastCheckpointAt, at),
      };
      await this.saveSession(stored);
      await this.logEvent(stored.runId, command.type, at);
      return stored;
    });
  }

  /**
   * Appends received samples to the open segment. Samples captured before the segment began
   * (stale cached fixes) or implausibly in the future are skipped; nothing is appended unless
   * the session is recording. Coordinates are normalized here, at capture.
   */
  appendPoints(samples: readonly RawSample[], now: EpochMs, maxPoints: number): Promise<AppendResult> {
    return this.write('points', async () => {
      const session = await this.loadSession();
      if (!session || session.status !== 'recording' || !session.openSegment) {
        return { accepted: [], limitReached: false, session };
      }
      const accepted: TrackPoint[] = [];
      let limitReached = session.pointCount >= maxPoints;
      const ordered = [...samples].sort((a, b) => a.timestamp - b.timestamp);
      for (const sample of ordered) {
        if (session.pointCount + accepted.length >= maxPoints) {
          limitReached = true;
          break;
        }
        const t = Math.round(sample.timestamp);
        if (!Number.isFinite(t) || t < session.openSegment.startAt || t > now + 60_000) continue;
        const lat = normalizeCoordinate(sample.latitude);
        const lon = normalizeCoordinate(sample.longitude);
        if (!isValidCoordinate(lat, lon)) continue;
        const point: TrackPoint = {
          seq: session.nextSeq + accepted.length,
          segmentIndex: session.openSegment.index,
          t,
          lat,
          lon,
          accuracyM: normalizeAccuracy(sample.accuracy),
        };
        await this.db.runAsync(
          'insert into track_points (run_id, seq, segment_index, t, lat, lon, accuracy) values (?, ?, ?, ?, ?, ?, ?)',
          [session.runId, point.seq, point.segmentIndex, point.t, point.lat, point.lon, point.accuracyM],
        );
        accepted.push(point);
      }
      const lastT = accepted.reduce<number | null>((m, p) => (m === null || p.t > m ? p.t : m), session.lastPointAt);
      const updated: StoredSession = {
        ...session,
        nextSeq: session.nextSeq + accepted.length,
        pointCount: session.pointCount + accepted.length,
        lastPointAt: lastT,
        lastCheckpointAt: Math.max(session.lastCheckpointAt, now),
      };
      await this.saveSession(updated);
      return { accepted, limitReached, session: updated };
    });
  }

  /** Heartbeat: durable evidence that the recorder is alive even when no fix arrives. */
  checkpoint(now: EpochMs): Promise<void> {
    return this.write('session', async () => {
      await this.db.runAsync(
        `update active_session set last_checkpoint_at = max(last_checkpoint_at, ?), updated_at = ? where id = 1 and status = 'recording'`,
        [now, this.clock.now()],
      );
    });
  }

  /** Points of a run in sequence order; `afterSeq` reads only newer points (live map). */
  getRunPoints(runId: string, afterSeq = -1): Promise<TrackPoint[]> {
    return this.read(async () =>
      (
        await this.db.getAllAsync<PointRow>(
          'select seq, segment_index, t, lat, lon, accuracy from track_points where run_id = ? and seq > ? order by seq',
          [runId, afterSeq],
        )
      ).map(toPoint),
    );
  }

  /**
   * Commits the finished session as a saved run plus its upload outbox item in one
   * transaction. A repeated call for the same run returns the already-saved run.
   */
  finishSession(runId: string, build: (session: StoredSession, points: TrackPoint[]) => SavedRunDraft): Promise<SavedRun> {
    return this.write(['session', 'saved', 'outbox'], async () => {
      const session = await this.loadSession();
      if (!session) {
        const existing = await this.db.getFirstAsync<SavedRunRow>('select * from saved_runs where run_id = ?', [runId]);
        if (existing) return toSavedRun(existing);
        throw new SessionMismatchError();
      }
      if (session.runId !== runId) throw new SessionMismatchError();
      const result = transition(session, { type: 'finish' });
      if (!result.finished) throw new Error('finish produced no run');
      const finishedSession: StoredSession = { ...session, segments: result.finished.segments };
      const points = (
        await this.db.getAllAsync<PointRow>('select seq, segment_index, t, lat, lon, accuracy from track_points where run_id = ? order by seq', [runId])
      ).map(toPoint);
      const draft = build(finishedSession, points);
      const now = this.clock.now();
      await this.db.runAsync(
        `insert into saved_runs (run_id, title, started_at, ended_at, active_ms, distance_m, point_count, segments_json, interrupted,
           validation_json, provisional_xp_json, sync_state, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          runId,
          draft.title,
          draft.startedAt,
          draft.endedAt,
          draft.activeMs,
          draft.distanceM,
          points.length,
          JSON.stringify(draft.segments),
          draft.interrupted ? 1 : 0,
          JSON.stringify(draft.validation),
          draft.provisionalXp ? JSON.stringify(draft.provisionalXp) : null,
          now,
          now,
        ],
      );
      await this.db.runAsync(
        `insert into outbox (kind, run_id, payload_json, state, created_at, updated_at) values ('upload_run', ?, ?, 'pending', ?, ?)`,
        [runId, JSON.stringify({ title: draft.title }), now, now],
      );
      await this.db.runAsync('delete from active_session where id = 1');
      await this.db.runAsync('delete from session_events where run_id = ?', [runId]);
      const saved = await this.db.getFirstAsync<SavedRunRow>('select * from saved_runs where run_id = ?', [runId]);
      if (!saved) throw new Error('saved run missing after insert');
      return toSavedRun(saved);
    });
  }

  discardSession(runId: string): Promise<void> {
    return this.write(['session', 'points'], async () => {
      const session = await this.loadSession();
      if (!session) return;
      if (session.runId !== runId) throw new SessionMismatchError();
      transition(session, { type: 'discard' });
      await this.db.runAsync('delete from active_session where id = 1');
      await this.db.runAsync('delete from track_points where run_id = ?', [runId]);
      await this.db.runAsync('delete from session_events where run_id = ?', [runId]);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Saved runs
  // ---------------------------------------------------------------------------------------
  listSavedRuns(options: { includeDeleted?: boolean } = {}): Promise<SavedRun[]> {
    return this.read(async () =>
      (
        await this.db.getAllAsync<SavedRunRow>(
          `select * from saved_runs ${options.includeDeleted ? '' : 'where deleted = 0'} order by started_at desc`,
        )
      ).map(toSavedRun),
    );
  }

  getSavedRun(runId: string): Promise<SavedRun | null> {
    return this.read(async () => {
      const row = await this.db.getFirstAsync<SavedRunRow>('select * from saved_runs where run_id = ?', [runId]);
      return row ? toSavedRun(row) : null;
    });
  }

  updateSavedRun(
    runId: string,
    patch: Partial<Pick<SavedRun, 'title' | 'syncState' | 'syncError' | 'serverRunId' | 'server' | 'routeCached' | 'deleted'>>,
  ): Promise<void> {
    return this.write('saved', async () => {
      const sets: string[] = [];
      const values: SqlValue[] = [];
      const add = (column: string, value: SqlValue) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.title !== undefined) add('title', patch.title);
      if (patch.syncState !== undefined) add('sync_state', patch.syncState);
      if (patch.syncError !== undefined) add('sync_error', patch.syncError);
      if (patch.serverRunId !== undefined) add('server_run_id', patch.serverRunId);
      if (patch.server !== undefined) add('server_json', patch.server === null ? null : JSON.stringify(patch.server));
      if (patch.routeCached !== undefined) add('route_cached', patch.routeCached ? 1 : 0);
      if (patch.deleted !== undefined) add('deleted', patch.deleted ? 1 : 0);
      if (sets.length === 0) return;
      add('updated_at', this.clock.now());
      await this.db.runAsync(`update saved_runs set ${sets.join(', ')} where run_id = ?`, [...values, runId]);
    });
  }

  /** Removes a run and its route from this device (after the server confirmed, or never synced). */
  purgeSavedRun(runId: string): Promise<void> {
    return this.write(['saved', 'points', 'outbox'], async () => {
      await this.db.runAsync('delete from saved_runs where run_id = ?', [runId]);
      await this.db.runAsync('delete from track_points where run_id = ?', [runId]);
    });
  }

  /**
   * Route cache policy: keep points for the newest `keep` acknowledged runs; never evict a run
   * the server has not acknowledged.
   */
  pruneRouteCache(keep = 5): Promise<number> {
    return this.write('points', async () => {
      const stale = await this.db.getAllAsync<{ run_id: string }>(
        `select run_id from saved_runs where sync_state = 'synced' and route_cached = 1 and deleted = 0
         order by started_at desc limit -1 offset ?`,
        [keep],
      );
      for (const { run_id } of stale) {
        await this.db.runAsync('delete from track_points where run_id = ?', [run_id]);
        await this.db.runAsync('update saved_runs set route_cached = 0 where run_id = ?', [run_id]);
      }
      return stale.length;
    });
  }

  // ---------------------------------------------------------------------------------------
  // Outbox
  // ---------------------------------------------------------------------------------------
  enqueue(kind: OutboxKind, runId: string, payload: Record<string, unknown>): Promise<number> {
    return this.write('outbox', async () => {
      const now = this.clock.now();
      const result = await this.db.runAsync(
        `insert into outbox (kind, run_id, payload_json, state, created_at, updated_at) values (?, ?, ?, 'pending', ?, ?)`,
        [kind, runId, JSON.stringify(payload), now, now],
      );
      return result.lastInsertRowId;
    });
  }

  /** Outbox items not yet succeeded, oldest first. */
  openOutbox(): Promise<OutboxItem[]> {
    return this.read(async () =>
      (await this.db.getAllAsync<OutboxRow>(`select * from outbox where state <> 'succeeded' order by id`)).map(toOutbox),
    );
  }

  updateOutbox(id: number, patch: Partial<Pick<OutboxItem, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'progress' | 'payload'>>): Promise<void> {
    return this.write('outbox', async () => {
      const sets: string[] = [];
      const values: SqlValue[] = [];
      const add = (column: string, value: SqlValue) => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.state !== undefined) add('state', patch.state);
      if (patch.attempts !== undefined) add('attempts', patch.attempts);
      if (patch.nextAttemptAt !== undefined) add('next_attempt_at', patch.nextAttemptAt);
      if (patch.lastError !== undefined) add('last_error', patch.lastError);
      if (patch.progress !== undefined) add('progress_json', patch.progress === null ? null : JSON.stringify(patch.progress));
      if (patch.payload !== undefined) add('payload_json', JSON.stringify(patch.payload));
      add('updated_at', this.clock.now());
      await this.db.runAsync(`update outbox set ${sets.join(', ')} where id = ?`, [...values, id]);
    });
  }

  removeOutbox(id: number): Promise<void> {
    return this.write('outbox', async () => {
      await this.db.runAsync('delete from outbox where id = ?', [id]);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Key-value cache (offline copies of server reads, device preferences)
  // ---------------------------------------------------------------------------------------
  getKv<T>(key: string): Promise<{ value: T; updatedAt: EpochMs } | null> {
    return this.read(async () => {
      const row = await this.db.getFirstAsync<{ value_json: string; updated_at: number }>('select value_json, updated_at from kv where key = ?', [key]);
      return row ? { value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at } : null;
    });
  }

  setKv(key: string, value: unknown): Promise<void> {
    return this.write('kv', async () => {
      await this.db.runAsync(
        `insert into kv (key, value_json, updated_at) values (?, ?, ?)
         on conflict (key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), this.clock.now()],
      );
    });
  }

  deleteKv(key: string): Promise<void> {
    return this.write('kv', async () => {
      await this.db.runAsync('delete from kv where key = ?', [key]);
    });
  }

  // ---------------------------------------------------------------------------------------
  // Telemetry queue
  // ---------------------------------------------------------------------------------------
  queueEvent(event: QueuedEvent): Promise<void> {
    return this.write('events', async () => {
      await this.db.runAsync('insert or ignore into telemetry_queue (event_id, name, occurred_at, props_json) values (?, ?, ?, ?)', [
        event.eventId,
        event.name,
        event.occurredAt,
        JSON.stringify(event.props),
      ]);
      // Bound the queue: analytics must never grow without limit or block saving.
      await this.db.runAsync(
        'delete from telemetry_queue where event_id in (select event_id from telemetry_queue order by occurred_at desc limit -1 offset 500)',
      );
    });
  }

  peekEvents(limit: number): Promise<QueuedEvent[]> {
    return this.read(async () =>
      (
        await this.db.getAllAsync<{ event_id: string; name: string; occurred_at: number; props_json: string }>(
          'select * from telemetry_queue order by occurred_at limit ?',
          [limit],
        )
      ).map((r) => ({ eventId: r.event_id, name: r.name, occurredAt: r.occurred_at, props: JSON.parse(r.props_json) })),
    );
  }

  removeEvents(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.write('events', async () => {
      await this.db.runAsync(`delete from telemetry_queue where event_id in (${ids.map(() => '?').join(', ')})`, ids);
    });
  }
}
