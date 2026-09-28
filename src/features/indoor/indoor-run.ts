import type { Journal, RunOrigin, SavedRunDraft } from '@/db/journal';
import type { ActiveSegment, EpochMs } from '@/domain/types';
import { defaultRunTitle } from '@/features/recording/run-draft';
import { Emitter } from '@/lib/emitter';

/**
 * Treadmill and indoor runs (docs/ROADMAP.md 2.5). There's no GPS indoors, so the run is a clock
 * with pauses and a step count; distance is estimated from steps and the runner's stride, and the
 * runner can type in what the treadmill says at the end. The server keeps indoor runs as history
 * (goals and streaks, not league XP). The session is saved as it goes, so closing the app doesn't
 * lose it.
 */
export interface IndoorSession {
  runId: string;
  startedAt: EpochMs;
  /** Closed active stretches. */
  segments: ActiveSegment[];
  /** Start of the open stretch while running; null while paused. */
  openSince: EpochMs | null;
}

export interface StepSource {
  /** Steps taken between two moments (iOS keeps a history, so this works after a relaunch). */
  stepsBetween(from: EpochMs, to: EpochMs): Promise<number | null>;
}

interface KvStore {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
  deleteKv(key: string): Promise<void>;
}

export const INDOOR_SESSION_KEY = 'indoor:session';
export const INDOOR_STRIDE_KEY = 'indoor:stride';
/** A typical running stride per step until the runner's own corrections teach us theirs. */
export const DEFAULT_STRIDE_M = 1.05;
const MIN_STRIDE_M = 0.5;
const MAX_STRIDE_M = 2;
/** How far one run moves the learned stride: a treadmill's reading is the same setting, so it counts more. */
const TREADMILL_WEIGHT = 0.5;
const OUTDOOR_WEIGHT = 0.3;
/** Too few steps say little about a stride. */
const MIN_LEARNING_STEPS = 200;
const MIN_OUTDOOR_M = 1_000;

function plausibleStride(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_STRIDE_M && value <= MAX_STRIDE_M;
}

export function activeMsOf(session: IndoorSession, now: EpochMs): number {
  const closed = session.segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0);
  return closed + (session.openSince !== null ? Math.max(0, now - session.openSince) : 0);
}

export class IndoorRunService {
  private session: IndoorSession | null = null;
  readonly changes = new Emitter<IndoorSession | null>();

  constructor(
    private readonly deps: {
      kv: KvStore;
      journal: Pick<Journal, 'getSession' | 'saveImportedRun'>;
      steps: StepSource | null;
      newRunId: () => string;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get current(): IndoorSession | null {
    return this.session;
  }

  /** Picks up a session left open by a previous launch. */
  async restore(): Promise<IndoorSession | null> {
    this.session = (await this.deps.kv.getKv<IndoorSession>(INDOOR_SESSION_KEY))?.value ?? null;
    this.changes.emit(this.session);
    return this.session;
  }

  private async persist(next: IndoorSession | null): Promise<void> {
    this.session = next;
    if (next) await this.deps.kv.setKv(INDOOR_SESSION_KEY, next);
    else await this.deps.kv.deleteKv(INDOOR_SESSION_KEY);
    this.changes.emit(next);
  }

  async start(): Promise<IndoorSession> {
    if (this.session) return this.session;
    if (await this.deps.journal.getSession()) throw new Error('A GPS run is already in progress.');
    const at = this.now();
    const session: IndoorSession = { runId: this.deps.newRunId(), startedAt: at, segments: [], openSince: at };
    await this.persist(session);
    return session;
  }

  async pause(): Promise<void> {
    const s = this.session;
    if (!s || s.openSince === null) return;
    const at = Math.max(s.openSince, this.now());
    await this.persist({ ...s, segments: [...s.segments, { index: s.segments.length, startAt: s.openSince, endAt: at }], openSince: null });
  }

  async resume(): Promise<void> {
    const s = this.session;
    if (!s || s.openSince !== null) return;
    await this.persist({ ...s, openSince: this.now() });
  }

  async discard(): Promise<void> {
    await this.persist(null);
  }

  /** Steps in the active stretches so far (null when the phone can't count steps). */
  async steps(): Promise<number | null> {
    const s = this.session;
    const source = this.deps.steps;
    if (!s || !source) return null;
    const stretches = [...s.segments.map((x) => [x.startAt, x.endAt] as const), ...(s.openSince !== null ? [[s.openSince, this.now()] as const] : [])];
    let total = 0;
    for (const [from, to] of stretches) {
      const n = await source.stepsBetween(from, to);
      if (n === null) return null;
      total += n;
    }
    return total;
  }

  async stride(): Promise<number> {
    const saved = (await this.deps.kv.getKv<number>(INDOOR_STRIDE_KEY))?.value;
    return plausibleStride(saved) ? saved : DEFAULT_STRIDE_M;
  }

  /** Moves the learned stride toward a measured one (the first measurement is taken as it is). */
  private async learn(distanceM: number, steps: number | null, weight: number): Promise<number | null> {
    if (steps === null || steps <= MIN_LEARNING_STEPS || distanceM <= 0) return null;
    const measured = distanceM / steps;
    if (!plausibleStride(measured)) return null;
    const saved = (await this.deps.kv.getKv<number>(INDOOR_STRIDE_KEY))?.value;
    const next = plausibleStride(saved) ? saved + (measured - saved) * weight : measured;
    await this.deps.kv.setKv(INDOOR_STRIDE_KEY, next);
    return next;
  }

  /**
   * Calibrates the stride against an outdoor run: its GPS distance over the steps the phone counted
   * while it was running.
   */
  async calibrateFromRun(distanceM: number, segments: readonly ActiveSegment[]): Promise<number | null> {
    const source = this.deps.steps;
    if (!source || distanceM < MIN_OUTDOOR_M || segments.length === 0) return null;
    let steps = 0;
    for (const s of segments) {
      const n = await source.stepsBetween(s.startAt, s.endAt);
      if (n === null) return null;
      steps += n;
    }
    return this.learn(distanceM, steps, OUTDOOR_WEIGHT);
  }

  async estimateM(): Promise<number | null> {
    const steps = await this.steps();
    return steps === null ? null : Math.round(steps * (await this.stride()));
  }

  /**
   * Saves the run with the distance the runner confirmed (the treadmill's reading, or the
   * estimate). A correction teaches the stride for next time, as outdoor runs do.
   */
  async finish(distanceM: number): Promise<string> {
    await this.pause();
    const s = this.session;
    if (!s || s.segments.length === 0) throw new Error('No indoor run to save.');
    const steps = await this.steps();
    await this.learn(distanceM, steps, TREADMILL_WEIGHT);
    const activeMs = activeMsOf(s, this.now());
    const endedAt = s.segments[s.segments.length - 1]!.endAt;
    const draft: SavedRunDraft = {
      title: `${defaultRunTitle(s.startedAt)} treadmill`,
      startedAt: s.startedAt,
      endedAt,
      activeMs,
      distanceM,
      segments: s.segments,
      interrupted: false,
      validation: { outcome: 'personal_only', reasons: [], coverage: 0, distanceCm: Math.round(distanceM * 100), activeMs },
      provisionalXp: null,
    };
    const origin: RunOrigin = { source: 'indoor', activityType: 'run', claimedDistanceM: distanceM, steps };
    await this.deps.journal.saveImportedRun(s.runId, draft, [], origin);
    await this.persist(null);
    return s.runId;
  }
}
