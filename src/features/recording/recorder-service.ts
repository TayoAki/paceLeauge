import type { Journal, RawSample, SavedRun, StoredSession } from '@/db/journal';
import { RECORDER_V1 } from '@/domain/config';
import { activeElapsedMs } from '@/domain/recorder-machine';
import type { EpochMs } from '@/domain/types';
import { SegmentTrack } from '@/domain/validator';
import { systemClock, type Clock } from '@/lib/clock';
import { Emitter } from '@/lib/emitter';

import { buildSavedRunDraft, type CreditedDays } from './run-draft';
import { EMPTY_METRICS, type GpsQuality, type LiveMetrics, type LocationDriver, type RecorderSnapshot } from './types';

export class ActiveRunExistsError extends Error {
  constructor() {
    super('Finish or discard the current run before starting another.');
    this.name = 'ActiveRunExistsError';
  }
}

export class NoActiveRunError extends Error {
  constructor() {
    super('There is no run in progress.');
    this.name = 'NoActiveRunError';
  }
}

export type RecorderEvent =
  | { name: 'run_started' }
  | { name: 'run_saved_local'; interrupted: boolean; activeMs: number; points: number }
  | { name: 'recorder_interrupted'; reason: 'process' | 'permission' };

export interface RecorderDeps {
  journal: Journal;
  location: LocationDriver;
  clock?: Clock;
  newRunId: () => string;
  /** Same-day totals the server has already credited (for the provisional XP estimate). */
  creditedDays?: () => Promise<CreditedDays>;
  /** Called when recording starts/stops so a background relaunch can find this account. */
  onRecordingChange?: (active: boolean) => Promise<void> | void;
  onEvent?: (event: RecorderEvent) => void;
  heartbeatMs?: number;
  maxPoints?: number;
}

function gpsQuality(now: EpochMs, lastFixAt: EpochMs | null, accuracy: number | null, recordingSince: EpochMs | null): GpsQuality {
  if (lastFixAt === null || now - lastFixAt > RECORDER_V1.gapThresholdMs) {
    // Give the receiver a moment after starting before calling the signal weak.
    return recordingSince !== null && now - recordingSince > RECORDER_V1.gapThresholdMs ? 'weak' : 'searching';
  }
  if (accuracy === null || accuracy > RECORDER_V1.maxHorizontalAccuracyM) return 'weak';
  return accuracy <= RECORDER_V1.goodAccuracyM ? 'good' : 'fair';
}

/**
 * The single owner of recording state. Every transition is persisted through the journal
 * before it is reflected in the UI; success is only reported after the save commits.
 */
export class RecorderService {
  private readonly clock: Clock;
  private readonly emitter = new Emitter<void>();
  private snapshot: RecorderSnapshot = { session: null, metrics: EMPTY_METRICS, lastSaved: null };
  private closedDistanceM = 0;
  private openTrack: SegmentTrack | null = null;
  /** Monotonic reference for the open segment, when it was opened in this process. */
  private mono: { segmentIndex: number; monoAt: number } | null = null;
  private verifiedRunId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastFix: { at: EpochMs; accuracy: number | null } | null = null;
  private limitReached = false;

  constructor(private readonly deps: RecorderDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  subscribe = (listener: () => void): (() => void) => this.emitter.subscribe(listener);
  getSnapshot = (): RecorderSnapshot => this.snapshot;

  /**
   * Launch recovery. A session still marked "recording" whose last durable checkpoint is
   * older than the gap threshold means the process died: close the segment at that
   * checkpoint (the missing time is never credited) and mark the run interrupted.
   */
  async init(): Promise<void> {
    const session = await this.deps.journal.getSession();
    if (session?.status === 'recording') {
      await this.verifyLiveness(session);
    }
    await this.rebuild();
  }

  private async verifyLiveness(session: StoredSession): Promise<boolean> {
    const now = this.clock.now();
    if (now - session.lastCheckpointAt > RECORDER_V1.gapThresholdMs) {
      await this.deps.journal.command({ type: 'interrupt', at: now, lastEvidenceAt: session.lastCheckpointAt, reason: 'process' });
      await this.deps.location.stop().catch(() => undefined);
      this.stopHeartbeat();
      this.deps.onEvent?.({ name: 'recorder_interrupted', reason: 'process' });
      return false;
    }
    this.verifiedRunId = session.runId;
    this.startHeartbeat();
    if (!(await this.deps.location.isRunning())) {
      await this.deps.location.start(this.sink).catch(() => undefined);
    }
    return true;
  }

  private readonly sink = (samples: RawSample[]) => {
    void this.ingest(samples);
  };

  async start(): Promise<StoredSession> {
    if (await this.deps.journal.getSession()) throw new ActiveRunExistsError();
    const runId = this.deps.newRunId();
    // Start updates first: a permission problem must fail before any session exists.
    await this.deps.location.start(this.sink);
    let session: StoredSession;
    try {
      session = await this.deps.journal.startSession(runId, this.clock.now());
    } catch (error) {
      await this.deps.location.stop().catch(() => undefined);
      throw error;
    }
    this.verifiedRunId = runId;
    this.mono = { segmentIndex: 0, monoAt: this.clock.monotonic() };
    this.closedDistanceM = 0;
    this.openTrack = new SegmentTrack(session.startedAt);
    this.lastFix = null;
    this.limitReached = false;
    this.startHeartbeat();
    await this.deps.onRecordingChange?.(true);
    this.deps.onEvent?.({ name: 'run_started' });
    this.publish(session);
    return session;
  }

  /** End time of the open segment measured on the monotonic clock when possible. */
  private openSegmentNow(session: StoredSession): EpochMs {
    const open = session.openSegment;
    if (!open) return this.clock.now();
    if (this.mono && this.mono.segmentIndex === open.index) {
      return open.startAt + Math.max(0, Math.round(this.clock.monotonic() - this.mono.monoAt));
    }
    return this.clock.now();
  }

  async pause(): Promise<StoredSession> {
    const session = await this.requireSession();
    const updated = await this.deps.journal.command({ type: 'pause', at: this.openSegmentNow(session) });
    this.mono = null;
    await this.rebuild();
    return updated;
  }

  async resume(): Promise<StoredSession> {
    await this.requireSession();
    const updated = await this.deps.journal.command({ type: 'resume', at: this.clock.now() });
    if (updated.openSegment) {
      this.mono = { segmentIndex: updated.openSegment.index, monoAt: this.clock.monotonic() };
    }
    this.verifiedRunId = updated.runId;
    if (!(await this.deps.location.isRunning())) await this.deps.location.start(this.sink);
    this.startHeartbeat();
    await this.rebuild();
    return updated;
  }

  /** Interrupted → paused: keep the saved portion and decide what to do next. */
  async recover(): Promise<StoredSession> {
    await this.requireSession();
    const updated = await this.deps.journal.command({ type: 'recover' });
    await this.rebuild();
    return updated;
  }

  /** Called when location permission disappears mid-run. */
  async interruptForPermission(): Promise<void> {
    const session = await this.deps.journal.getSession();
    if (session?.status !== 'recording') return;
    await this.deps.journal.command({ type: 'interrupt', at: this.clock.now(), lastEvidenceAt: this.openSegmentNow(session), reason: 'permission' });
    this.mono = null;
    this.stopHeartbeat();
    await this.deps.location.stop().catch(() => undefined);
    this.deps.onEvent?.({ name: 'recorder_interrupted', reason: 'permission' });
    await this.rebuild();
  }

  /**
   * Durably commits the run and its upload outbox item, then stops location updates.
   * A failed write throws and leaves the session intact for another attempt; a repeated
   * call returns the same saved run.
   */
  async finish(): Promise<SavedRun> {
    const session = await this.deps.journal.getSession();
    if (!session) {
      if (this.snapshot.lastSaved) return this.snapshot.lastSaved;
      throw new NoActiveRunError();
    }
    const credited = (await this.deps.creditedDays?.().catch(() => null)) ?? new Map();
    const saved = await this.deps.journal.finishSession(session.runId, (s, points) => buildSavedRunDraft(s, points, credited));
    this.stopHeartbeat();
    await this.deps.location.stop().catch(() => undefined);
    await this.deps.onRecordingChange?.(false);
    this.mono = null;
    this.verifiedRunId = null;
    this.snapshot = { ...this.snapshot, lastSaved: saved };
    this.deps.onEvent?.({ name: 'run_saved_local', interrupted: saved.interrupted, activeMs: saved.activeMs, points: saved.pointCount });
    await this.rebuild();
    return saved;
  }

  async discard(): Promise<void> {
    const session = await this.requireSession();
    await this.deps.journal.discardSession(session.runId);
    this.stopHeartbeat();
    await this.deps.location.stop().catch(() => undefined);
    await this.deps.onRecordingChange?.(false);
    this.mono = null;
    this.verifiedRunId = null;
    await this.rebuild();
  }

  /** Receives location samples from the task handler (or the foreground watcher). */
  async ingest(samples: RawSample[]): Promise<void> {
    if (samples.length === 0) return;
    const session = await this.deps.journal.getSession();
    if (!session || session.status !== 'recording') return;
    if (this.verifiedRunId !== session.runId) {
      // First delivery in this process (e.g. relaunched in the background).
      if (!(await this.verifyLiveness(session))) {
        await this.rebuild();
        return;
      }
      await this.rebuild();
    }
    const latest = samples.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    this.lastFix = { at: latest.timestamp, accuracy: latest.accuracy ?? null };
    const result = await this.deps.journal.appendPoints(samples, this.clock.now(), this.deps.maxPoints ?? RECORDER_V1.maxPointsPerRun);
    this.limitReached = result.limitReached;
    for (const point of result.accepted) this.openTrack?.push(point);
    this.publish(result.session);
  }

  /** Heartbeat: refresh elapsed time and record liveness while recording. */
  async tick(): Promise<void> {
    const session = this.snapshot.session;
    if (session?.status !== 'recording') return;
    await this.deps.journal.checkpoint(this.clock.now());
    this.publish(session);
  }

  dispose(): void {
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat || !this.deps.heartbeatMs) return;
    this.heartbeat = setInterval(() => void this.tick(), this.deps.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async requireSession(): Promise<StoredSession> {
    const session = await this.deps.journal.getSession();
    if (!session) throw new NoActiveRunError();
    return session;
  }

  /** Recomputes distance from the journal (after transitions and on launch). */
  private async rebuild(): Promise<void> {
    const session = await this.deps.journal.getSession();
    this.closedDistanceM = 0;
    this.openTrack = null;
    if (session) {
      const points = await this.deps.journal.getRunPoints(session.runId);
      for (const segment of session.segments) {
        const track = new SegmentTrack(segment.startAt);
        for (const p of points) if (p.segmentIndex === segment.index && p.t >= segment.startAt && p.t <= segment.endAt) track.push(p);
        this.closedDistanceM += track.distanceM;
      }
      if (session.openSegment) {
        const open = session.openSegment;
        const track = new SegmentTrack(open.startAt);
        for (const p of points) if (p.segmentIndex === open.index && p.t >= open.startAt) track.push(p);
        this.openTrack = track;
      }
      this.limitReached = session.pointCount >= (this.deps.maxPoints ?? RECORDER_V1.maxPointsPerRun);
    }
    this.publish(session);
  }

  private publish(session: StoredSession | null): void {
    const now = this.clock.now();
    const metrics: LiveMetrics = session
      ? {
          distanceM: this.closedDistanceM + (this.openTrack?.distanceM ?? 0),
          activeMs: activeElapsedMs(session, this.openSegmentNow(session)),
          pointCount: session.pointCount,
          lastFixAt: this.lastFix?.at ?? null,
          lastAccuracyM: this.lastFix?.accuracy ?? null,
          quality: gpsQuality(now, this.lastFix?.at ?? null, this.lastFix?.accuracy ?? null, session.openSegment?.startAt ?? null),
          pointLimitReached: this.limitReached,
        }
      : EMPTY_METRICS;
    this.snapshot = { ...this.snapshot, session, metrics };
    this.emitter.emit();
  }
}
