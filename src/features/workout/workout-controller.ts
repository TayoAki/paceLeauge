import type { PaceZones, WorkoutBlock } from '@/domain/plans/types';
import type { Units } from '@/domain/types';
import {
  advanceWorkout,
  flattenWorkout,
  skipStep,
  stepCueText,
  stepPosition,
  WORKOUT_DONE_TEXT,
  WORKOUT_START,
  type StepPosition,
  type TimelineStep,
  type WorkoutProgress,
} from '@/domain/workout';

/**
 * The workout a run follows (docs/ROADMAP.md 3.1 and 3.4): a plan session or a guided run. It is
 * prepared before the run starts, bound to the run when it does, moves with the run's active time
 * and distance, and is saved at every step so a relaunch carries on where it was. What to say at
 * each step goes to the voice cues (features/voice/cue-controller), which speak one thing at a
 * time.
 */
export interface ActiveWorkout {
  source: { kind: 'plan'; planId: string; sessionId: string } | { kind: 'guided'; guidedId: string };
  title: string;
  blocks: WorkoutBlock[];
  /** Pace ranges for the steps; null trains by effort. */
  zones: PaceZones | null;
}

export interface WorkoutSnapshot {
  workout: ActiveWorkout;
  steps: TimelineStep[];
  progress: WorkoutProgress;
  position: StepPosition;
  /** False while it waits for the run to start. */
  running: boolean;
}

export interface WorkoutKv {
  getKv<T>(key: string): Promise<{ value: T } | null>;
  setKv(key: string, value: unknown): Promise<void>;
}

/** What the voice cues ask of the workout. */
export interface WorkoutCues {
  /** A run began (or was found running): binds the prepared workout; returns its first cue. */
  runStarted(runId: string, units: Units): string | null;
  /** The run moved on; returns the cue for a step that began, if any. */
  update(runId: string, activeMs: number, distanceM: number, units: Units): string | null;
  runEnded(runId: string): void;
}

interface Stored {
  runId: string;
  workout: ActiveWorkout;
  progress: WorkoutProgress;
  done: boolean;
}

export const WORKOUT_KEY = 'workout:active';

export class WorkoutController implements WorkoutCues {
  private pending: ActiveWorkout | null = null;
  private active: Stored | null = null;
  private steps: TimelineStep[] = [];
  private metrics = { activeS: 0, distanceM: 0 };
  private queued: string | null = null;
  private snapshot: WorkoutSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly kv: WorkoutKv) {}

  /** Picks up the workout of a run that was recording when the app stopped. */
  async restore(): Promise<void> {
    const stored = await this.kv.getKv<Stored | null>(WORKOUT_KEY).catch(() => null);
    const value = stored?.value;
    if (value && typeof value.runId === 'string' && Array.isArray(value.workout?.blocks)) {
      this.active = value;
      this.steps = flattenWorkout(value.workout.blocks);
      this.metrics = { activeS: value.progress.startS, distanceM: value.progress.startM };
      this.emit();
    }
  }

  /** The workout for the next run. */
  prepare(workout: ActiveWorkout): void {
    this.pending = workout;
    this.emit();
  }

  /** The runner left the start screen without starting. */
  cancel(): void {
    if (!this.pending) return;
    this.pending = null;
    this.emit();
  }

  runStarted(runId: string, units: Units): string | null {
    if (this.active?.runId === runId) return null;
    if (!this.pending) {
      // A run without a workout: the last run's workout is over.
      if (this.active) this.clear();
      return null;
    }
    this.active = { runId, workout: this.pending, progress: WORKOUT_START, done: false };
    this.pending = null;
    this.steps = flattenWorkout(this.active.workout.blocks);
    this.metrics = { activeS: 0, distanceM: 0 };
    this.persist();
    this.emit();
    const first = this.steps[0];
    return first ? stepCueText(first, units) : null;
  }

  update(runId: string, activeMs: number, distanceM: number, units: Units): string | null {
    const active = this.active;
    if (!active || active.runId !== runId) return null;
    this.metrics = { activeS: activeMs / 1000, distanceM };
    let text = this.queued;
    this.queued = null;
    const { progress, entered } = advanceWorkout(this.steps, active.progress, this.metrics.activeS, distanceM);
    if (entered.length > 0) {
      const last = entered[entered.length - 1]!;
      const finished = last >= this.steps.length;
      text = finished ? (active.done ? null : WORKOUT_DONE_TEXT) : stepCueText(this.steps[last]!, units);
      this.active = { ...active, progress, done: active.done || finished };
      this.persist();
    }
    this.emit();
    return text;
  }

  /** Ends the current step now; the next one is announced with the next update. */
  skip(units: Units): void {
    const active = this.active;
    if (!active || active.progress.index >= this.steps.length) return;
    const progress = skipStep(this.steps, active.progress, this.metrics.activeS, this.metrics.distanceM);
    const finished = progress.index >= this.steps.length;
    this.queued = finished ? WORKOUT_DONE_TEXT : stepCueText(this.steps[progress.index]!, units);
    this.active = { ...active, progress, done: finished };
    this.persist();
    this.emit();
  }

  runEnded(runId: string): void {
    if (this.active?.runId === runId) this.clear();
  }

  getSnapshot = (): WorkoutSnapshot | null => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private clear(): void {
    this.active = null;
    this.steps = [];
    this.queued = null;
    void this.kv.setKv(WORKOUT_KEY, null).catch(() => undefined);
    this.emit();
  }

  private persist(): void {
    void this.kv.setKv(WORKOUT_KEY, this.active).catch(() => undefined);
  }

  private emit(): void {
    const workout = this.active?.workout ?? this.pending;
    if (!workout) {
      this.snapshot = null;
    } else {
      const steps = this.active ? this.steps : flattenWorkout(workout.blocks);
      const progress = this.active?.progress ?? WORKOUT_START;
      this.snapshot = {
        workout,
        steps,
        progress,
        position: stepPosition(steps, progress, this.metrics.activeS, this.metrics.distanceM),
        running: this.active !== null,
      };
    }
    for (const listener of this.listeners) listener();
  }
}
