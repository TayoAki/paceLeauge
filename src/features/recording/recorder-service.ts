import type { Journal, RawSample, SavedRun, StoredSession } from '@/db/journal';
import { AutoPauseDetector } from '@/domain/auto-pause';
import { RECORDER_V1 } from '@/domain/config';
import { currentPaceSPerKm } from '@/domain/live-pace';
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
  | { name: 'auto_paused' }
  | { name: 'auto_resumed' }
  | { name: 'paused' }
  | { name: 'resumed' }
  | { name: 'run_saved_local'; runId: string; interrupted: boolean; activeMs: number; points: number }
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
  /** Whether auto-pause is on (read at each sample, so the setting applies mid-run). */
  autoPause?: () => boolean;
  /** Lap length in metres (a kilometre or a mile, following the runner's units). */
  lapUnitM?: () => number;
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
  private snapshot: RecorderSnapshot = { session: null, metrics: EMPTY_METRICS, lastSaved: null, autoPaused: false };
  private readonly autoPauser = new AutoPauseDetector();
  private autoPaused = false;
  private closedDistanceM = 0;
  /** Where the current lap began: the last full kilometre or mile. */
  private lap: { runId: string; unitM: number; index: number; startDistanceM: number; startActiveMs: number } | null = null;
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

  private readonly events = new Emitter<RecorderEvent>();

  subscribe = (listener: () => void): (() => void) => this.emitter.subscribe(listener);
  /** Recording events (start, pause, resume, save…) for voice cues and the run screen. */
  subscribeEvents = (listener: (event: RecorderEvent) => void): (() => void) => this.events.subscribe(listener);

  private emitEvent(event: RecorderEvent): void {
    this.deps.onEvent?.(event);
    this.events.emit(event);
  }
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
      this.emitEvent({ name: 'recorder_interrupted', reason: 'process' });
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
    this.autoPaused = false;
    this.autoPauser.reset(false);
    this.startHeartbeat();
    await this.deps.onRecordingChange?.(true);
    this.emitEvent({ name: 'run_started' });
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
    // A manual pause stays paused until the runner resumes it.
    this.autoPaused = false;
    this.autoPauser.reset(true);
    this.emitEvent({ name: 'paused' });
    await this.rebuild();
    return updated;
  }

  async resume(): Promise<StoredSession> {
    const updated = await this.resumeAt(this.clock.now());
    this.emitEvent({ name: 'resumed' });
    return updated;
  }

  private async resumeAt(at: EpochMs): Promise<StoredSession> {
    await this.requireSession();
    this.autoPaused = false;
    this.autoPauser.reset(false);
    const updated = await this.deps.journal.command({ type: 'resume', at });
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
    this.emitEvent({ name: 'recorder_interrupted', reason: 'permission' });
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
    this.emitEvent({ name: 'run_saved_local', runId: saved.runId, interrupted: saved.interrupted, activeMs: saved.activeMs, points: saved.pointCount });
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
    if (session?.status === 'paused' && this.autoPaused) {
      await this.watchForMovement(samples);
      return;
    }
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
    await this.watchForStop(samples, result.session);
  }

  /** Auto-pause: pause at the moment the runner stopped, so standing time is never credited. */
  private async watchForStop(samples: RawSample[], session: StoredSession | null): Promise<void> {
    if (!this.deps.autoPause?.() || session?.status !== 'recording' || !session.openSegment) return;
    for (const s of [...samples].sort((a, b) => a.timestamp - b.timestamp)) {
      const decision = this.autoPauser.push({ t: s.timestamp, lat: s.latitude, lon: s.longitude, accuracyM: s.accuracy });
      if (decision?.type !== 'pause') continue;
      const at = Math.min(this.openSegmentNow(session), Math.max(session.openSegment.startAt, decision.at));
      await this.deps.journal.command({ type: 'pause', at });
      this.mono = null;
      this.autoPaused = true;
      this.emitEvent({ name: 'auto_paused' });
      await this.rebuild();
      return;
    }
  }

  /** While auto-paused, samples only decide when to resume; they are not recorded. */
  private async watchForMovement(samples: RawSample[]): Promise<void> {
    for (const s of [...samples].sort((a, b) => a.timestamp - b.timestamp)) {
      const decision = this.autoPauser.push({ t: s.timestamp, lat: s.latitude, lon: s.longitude, accuracyM: s.accuracy });
      if (decision?.type !== 'resume') continue;
      await this.resumeAt(this.clock.now());
      this.emitEvent({ name: 'auto_resumed' });
      return;
    }
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

  /** Lap progress: the lap restarts at each full unit, at the interpolated moment it was crossed. */
  private lapProgress(runId: string, distanceM: number, activeMs: number): { lapDistanceM: number; lapActiveMs: number } {
    const unitM = this.deps.lapUnitM?.() ?? 1000;
    const index = Math.floor(distanceM / unitM);
    const lap = this.lap;
    if (!lap || lap.runId !== runId || lap.unitM !== unitM || index < lap.index) {
      // A new run, a relaunch mid-run or a units change: start from the last full unit, timed pro rata.
      const startDistanceM = index * unitM;
      this.lap = { runId, unitM, index, startDistanceM, startActiveMs: distanceM > 0 ? Math.round(activeMs * (startDistanceM / distanceM)) : 0 };
    } else if (index > lap.index) {
      const previous = this.snapshot.metrics;
      const boundary = index * unitM;
      const span = distanceM - previous.distanceM;
      const fraction = span > 0 ? Math.min(1, Math.max(0, (boundary - previous.distanceM) / span)) : 1;
      this.lap = { runId, unitM, index, startDistanceM: boundary, startActiveMs: Math.round(previous.activeMs + fraction * (activeMs - previous.activeMs)) };
    }
    return { lapDistanceM: distanceM - this.lap!.startDistanceM, lapActiveMs: Math.max(0, activeMs - this.lap!.startActiveMs) };
  }

  private publish(session: StoredSession | null): void {
    const now = this.clock.now();
    const distanceM = session ? this.closedDistanceM + (this.openTrack?.distanceM ?? 0) : 0;
    const activeMs = session ? activeElapsedMs(session, this.openSegmentNow(session)) : 0;
    const metrics: LiveMetrics = session
      ? {
          distanceM,
          activeMs,
          pointCount: session.pointCount,
          lastFixAt: this.lastFix?.at ?? null,
          lastAccuracyM: this.lastFix?.accuracy ?? null,
          quality: gpsQuality(now, this.lastFix?.at ?? null, this.lastFix?.accuracy ?? null, session.openSegment?.startAt ?? null),
          pointLimitReached: this.limitReached,
          currentPaceSPerKm: session.openSegment && this.openTrack ? currentPaceSPerKm(this.openTrack.credited, now) : null,
          ...this.lapProgress(session.runId, distanceM, activeMs),
        }
      : EMPTY_METRICS;
    this.snapshot = { ...this.snapshot, session, metrics, autoPaused: session?.status === 'paused' && this.autoPaused };
    this.emitter.emit();
  }
}
