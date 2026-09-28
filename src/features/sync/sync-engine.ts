import { ApiError, toApiError } from '@/api/errors';
import type { PaceApi, TelemetryEvent } from '@/api/pace-api';
import { serverRunSchema, type FinalizeResult, type ServerRun } from '@/api/schemas';
import type { Journal, OutboxItem, SavedRun } from '@/db/journal';
import { chunk, encodeChunk } from '@/domain/route-codec';
import { systemClock, type Clock } from '@/lib/clock';
import { Emitter } from '@/lib/emitter';

/**
 * Durable outbox processor (REQ-005). Saving a run never waits for the network: the
 * journal holds the run and an upload item; this engine uploads route chunks, finalizes,
 * and records the server's answer. Every step is idempotent, so an interrupted upload
 * resumes from what the server already has.
 */

export interface SyncStatus {
  running: boolean;
  pending: number;
  needsAttention: number;
  authBlocked: boolean;
  lastError: string | null;
  lastSyncedAt: number | null;
}

export interface SyncDeps {
  journal: Journal;
  api: PaceApi;
  sha256: (text: string) => Promise<string>;
  clock?: Clock;
  random?: () => number;
  environment?: string;
  /** A run the server has just accepted/classified (e.g. to refresh cached progress). */
  onRunSynced?: (run: SavedRun, result: FinalizeResult | null) => void;
  onEvent?: (name: 'run_sync_outcome' | 'sync_retry', props: Record<string, string | boolean>) => void;
}

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 15 * 60_000;
const RATE_LIMITED_DELAY_MS = 60_000;

export function backoffDelay(attempt: number, random: () => number, code?: string): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = exp * (0.5 + random() * 0.5);
  return code === 'rate_limited' ? Math.max(RATE_LIMITED_DELAY_MS, jittered) : jittered;
}

function latencyBucket(ms: number): string {
  if (ms < 5_000) return 'lt_5s';
  if (ms < 60_000) return 'lt_1m';
  if (ms < 3_600_000) return 'lt_1h';
  return 'ge_1h';
}

class AuthBlockedError extends Error {}
class WaitForUploadError extends Error {}

export class SyncEngine {
  readonly status = new Emitter<SyncStatus>();
  private readonly clock: Clock;
  private readonly random: () => number;
  private inFlight: Promise<SyncStatus> | null = null;
  private authBlocked = false;
  private lastError: string | null = null;
  private lastSyncedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: SyncDeps) {
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
  }

  /** Runs one pass (single-flight): concurrent callers share the same pass. */
  run(): Promise<SyncStatus> {
    this.inFlight ??= this.pass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Called after the session is refreshed or the user signs back in. */
  resumeAfterAuth(): Promise<SyncStatus> {
    this.authBlocked = false;
    return this.run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async currentStatus(running = false): Promise<SyncStatus> {
    const items = await this.deps.journal.openOutbox();
    return {
      running,
      pending: items.filter((i) => i.state !== 'needs_attention').length,
      needsAttention: items.filter((i) => i.state === 'needs_attention').length,
      authBlocked: this.authBlocked,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  private async pass(): Promise<SyncStatus> {
    if (this.stopped) return this.currentStatus();
    this.status.emit(await this.currentStatus(true));
    if (!this.authBlocked) {
      const items = await this.deps.journal.openOutbox();
      for (const item of items) {
        if (this.stopped || this.authBlocked) break;
        if (item.state === 'needs_attention' || item.nextAttemptAt > this.clock.now()) continue;
        await this.processItem(item);
      }
      await this.flushTelemetry();
    }
    const status = await this.currentStatus();
    await this.scheduleNext();
    this.status.emit(status);
    return status;
  }

  private async scheduleNext(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || this.authBlocked) return;
    const items = (await this.deps.journal.openOutbox()).filter((i) => i.state !== 'needs_attention');
    if (items.length === 0) return;
    const next = Math.min(...items.map((i) => i.nextAttemptAt));
    const delay = Math.max(1_000, next - this.clock.now());
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async processItem(item: OutboxItem): Promise<void> {
    try {
      if (item.kind === 'upload_run') await this.uploadRun(item);
      else if (item.kind === 'rename_run') await this.renameRun(item);
      else await this.deleteRun(item);
      this.lastError = null;
    } catch (error) {
      if (error instanceof WaitForUploadError) return;
      if (error instanceof AuthBlockedError) {
        this.authBlocked = true;
        await this.deps.journal.updateOutbox(item.id, { state: 'pending' });
        return;
      }
      const apiError = toApiError(error);
      this.lastError = apiError.code;
      if (apiError.isAuth) {
        this.authBlocked = true;
        await this.deps.journal.updateOutbox(item.id, { state: 'pending' });
        return;
      }
      const attempts = item.attempts + 1;
      if (apiError.isPermanent) {
        await this.deps.journal.updateOutbox(item.id, { state: 'needs_attention', attempts, lastError: apiError.code });
        if (item.kind === 'upload_run') {
          await this.deps.journal.updateSavedRun(item.runId, { syncState: 'needs_attention', syncError: apiError.code });
        }
        this.deps.onEvent?.('run_sync_outcome', { outcome: 'failed', reason: apiError.code });
        return;
      }
      await this.deps.journal.updateOutbox(item.id, {
        state: 'pending',
        attempts,
        lastError: apiError.code,
        nextAttemptAt: this.clock.now() + backoffDelay(attempts, this.random, apiError.code),
      });
      if (item.kind === 'upload_run') await this.deps.journal.updateSavedRun(item.runId, { syncState: 'pending', syncError: apiError.code });
      this.deps.onEvent?.('sync_retry', { reason: apiError.code, attempt_bucket: attempts < 3 ? 'lt_3' : attempts < 10 ? 'lt_10' : 'ge_10' });
    }
  }

  private async uploadRun(item: OutboxItem): Promise<void> {
    const { journal, api } = this.deps;
    const run = await journal.getSavedRun(item.runId);
    if (!run) {
      await journal.removeOutbox(item.id);
      return;
    }
    // A deletion is queued: its outbox item cancels this upload (and any staged server copy).
    if (run.deleted) return;
    const points = await journal.getRunPoints(run.runId);
    if (points.length !== run.pointCount) throw new ApiError('invalid_input', null, 'local_route_incomplete');

    await journal.updateOutbox(item.id, { state: 'uploading' });
    await journal.updateSavedRun(run.runId, { syncState: 'uploading', syncError: null });

    const chunks = await Promise.all(
      chunk(points).map(async (group, seq) => {
        const body = encodeChunk(group);
        return { seq, body, checksum: await this.deps.sha256(body) };
      }),
    );
    const title = typeof item.payload.title === 'string' ? item.payload.title : run.title;
    const start = await api.startRunUpload({
      clientRunId: run.runId,
      startedAtMs: run.startedAt,
      endedAtMs: run.endedAt,
      segments: run.segments,
      clientDistanceM: run.distanceM,
      clientActiveMs: run.activeMs,
      expectedPoints: points.length,
      expectedChunks: chunks.length,
      title,
      interrupted: run.interrupted,
      origin: run.origin,
    });

    if (start.status === 'deleted') {
      // Deleted elsewhere (or by a queued delete): the server keeps a tombstone.
      await journal.purgeSavedRun(run.runId);
      await journal.removeOutbox(item.id);
      return;
    }
    if (start.run) {
      await this.completeUpload(item, run, start.run, null);
      return;
    }

    await journal.updateOutbox(item.id, { progress: { serverRunId: start.run_id, version: start.version } });
    const received = new Set(start.received_chunks);
    for (const c of chunks) {
      if (!received.has(c.seq)) await api.putRouteChunk(start.run_id, c.seq, c.body, c.checksum);
    }

    await journal.updateOutbox(item.id, { state: 'awaiting_validation' });
    await journal.updateSavedRun(run.runId, { syncState: 'awaiting_validation', serverRunId: start.run_id });
    let result: FinalizeResult;
    try {
      result = await api.finalizeRun(
        start.run_id,
        start.version,
        chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })),
      );
    } catch (error) {
      // Chunks can be missing after an interrupted pass; the next pass resumes them.
      if (toApiError(error).code === 'upload_incomplete') throw new ApiError('upload_incomplete');
      throw error;
    }
    await this.completeUpload(item, run, result.run, result);
  }

  private async completeUpload(item: OutboxItem, run: SavedRun, server: ServerRun, result: FinalizeResult | null): Promise<void> {
    const { journal } = this.deps;
    await journal.updateSavedRun(run.runId, { syncState: 'synced', syncError: null, serverRunId: server.id, server, title: server.title });
    await journal.removeOutbox(item.id);
    await journal.pruneRouteCache(5);
    if (result) await journal.setKv('me.lifetime', { lifetimeXp: result.lifetime_xp, tier: result.tier });
    this.lastSyncedAt = this.clock.now();
    const synced = (await journal.getSavedRun(run.runId)) ?? run;
    this.deps.onRunSynced?.(synced, result);
    this.deps.onEvent?.('run_sync_outcome', {
      outcome: server.status,
      latency_bucket: latencyBucket(this.clock.now() - run.createdAt),
      reason: server.reason_codes[0] ?? 'none',
    });
  }

  private async serverIdFor(runId: string, item: OutboxItem): Promise<string | null> {
    const run = await this.deps.journal.getSavedRun(runId);
    if (run?.serverRunId) return run.serverRunId;
    if (typeof item.payload.serverRunId === 'string') return item.payload.serverRunId;
    const upload = (await this.deps.journal.openOutbox()).find((o) => o.kind === 'upload_run' && o.runId === runId);
    if (upload && upload.state !== 'needs_attention') throw new WaitForUploadError();
    const staged = upload?.progress?.serverRunId;
    return typeof staged === 'string' ? staged : null;
  }

  private async renameRun(item: OutboxItem): Promise<void> {
    const title = String(item.payload.title ?? '');
    const serverRunId = await this.serverIdFor(item.runId, item);
    if (!serverRunId) {
      await this.deps.journal.removeOutbox(item.id);
      return;
    }
    const server = await this.deps.api.renameRun(serverRunId, title, null);
    const local = await this.deps.journal.getSavedRun(item.runId);
    if (local) await this.deps.journal.updateSavedRun(item.runId, { server, title: server.title });
    await this.deps.journal.removeOutbox(item.id);
  }

  private async deleteRun(item: OutboxItem): Promise<void> {
    const { journal } = this.deps;
    let serverRunId: string | null;
    try {
      serverRunId = await this.serverIdFor(item.runId, item);
    } catch (error) {
      if (!(error instanceof WaitForUploadError)) throw error;
      // The upload has not reached the server yet: cancel it instead.
      const upload = (await journal.openOutbox()).find((o) => o.kind === 'upload_run' && o.runId === item.runId);
      const staged = upload?.progress?.serverRunId;
      serverRunId = typeof staged === 'string' ? staged : null;
      // Remember a staged server copy before dropping the upload, so a retry still deletes it.
      if (serverRunId) await journal.updateOutbox(item.id, { payload: { ...item.payload, serverRunId } });
      if (upload) await journal.removeOutbox(upload.id);
    }
    if (serverRunId) {
      try {
        await this.deps.api.deleteRun(serverRunId);
      } catch (error) {
        if (toApiError(error).code !== 'not_found') throw error;
      }
    }
    await journal.purgeSavedRun(item.runId);
    for (const other of (await journal.openOutbox()).filter((o) => o.runId === item.runId)) await journal.removeOutbox(other.id);
  }

  private async flushTelemetry(): Promise<void> {
    const batch = await this.deps.journal.peekEvents(50);
    if (batch.length === 0) return;
    const events: TelemetryEvent[] = batch.map((e) => ({
      event_id: e.eventId,
      name: e.name,
      environment: this.deps.environment ?? 'development',
      occurred_at_ms: e.occurredAt,
      props: e.props,
    }));
    try {
      await this.deps.api.logEvents(events);
      await this.deps.journal.removeEvents(batch.map((e) => e.eventId));
    } catch {
      // Analytics loss never blocks saving or syncing runs.
    }
  }
}

/** Parses the cached server representation of a saved run, if any. */
export function serverRunOf(run: SavedRun): ServerRun | null {
  const parsed = serverRunSchema.safeParse(run.server);
  return parsed.success ? parsed.data : null;
}
