import { CueScheduler, cueText, type Cue } from '@/domain/cues';
import type { Units } from '@/domain/types';
import type { RecorderEvent } from '@/features/recording/recorder-service';
import type { RecorderSnapshot } from '@/features/recording/types';
import type { WorkoutCues } from '@/features/workout/workout-controller';

import { CUE_VOLUME, type RunSettings } from './run-settings';
import type { SpeakOutcome, VoiceOutput } from './voice-output';

/**
 * Connects the recorder to the voice (docs/ROADMAP.md 1.1). Progress cues come from the live
 * metrics; status cues (started, paused, resumed, finished) from recorder events; workout steps
 * (3.1, 3.4) from the workout the run follows. Cues that fall due together are spoken as one, so
 * none cuts another off. Nothing is spoken once the run has ended, and a run picked up after a
 * relaunch never replays the splits or steps it already passed.
 */
export interface CueRecorder {
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: RecorderEvent) => void): () => void;
}

export interface CueSettingsSource {
  get(): RunSettings;
  readonly units: Units;
  subscribe(listener: () => void): () => void;
}

export class CueController {
  private scheduler: CueScheduler | null = null;
  private runId: string | null = null;
  private schedulerFor: { settings: RunSettings; units: Units } | null = null;
  private lastMetrics = { distanceM: 0, activeMs: 0 };
  /** "Run started" waits for the run's first snapshot, to go with the workout's first step. */
  private startedPending = false;
  private unsubscribers: (() => void)[] = [];
  /** Outcomes of the cues spoken so far, newest last (kept short; for tests and diagnostics). */
  readonly spoken: { text: string; outcome: Promise<SpeakOutcome> }[] = [];

  constructor(
    private readonly recorder: CueRecorder,
    private readonly voice: VoiceOutput,
    private readonly settings: CueSettingsSource,
    private readonly workout: WorkoutCues | null = null,
  ) {}

  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers = [
      this.recorder.subscribe(() => this.onSnapshot()),
      this.recorder.subscribeEvents((event) => this.onEvent(event)),
      this.settings.subscribe(() => this.onSettings()),
    ];
    this.onSnapshot();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.scheduler = null;
    this.runId = null;
  }

  private onSnapshot(): void {
    const { session, metrics } = this.recorder.getSnapshot();
    if (!session) {
      this.scheduler = null;
      this.runId = null;
      return;
    }
    const units = this.settings.units;
    if (session.runId !== this.runId) {
      this.runId = session.runId;
      this.rebuildScheduler(metrics);
      const firstStep = this.workout?.runStarted(session.runId, units) ?? null;
      if (this.startedPending) this.sayAll([this.textOf({ kind: 'started' }), firstStep]);
      else this.sayAll([firstStep]);
      this.startedPending = false;
    }
    this.lastMetrics = { distanceM: metrics.distanceM, activeMs: metrics.activeMs };
    if (session.status !== 'recording' || !this.scheduler) return;
    // The workout moves on even with cues off, so the run screen stays right.
    const step = this.workout?.update(session.runId, metrics.activeMs, metrics.distanceM, units) ?? null;
    const cue = this.scheduler.update({ distanceM: metrics.distanceM, activeMs: metrics.activeMs, currentPaceSPerKm: metrics.currentPaceSPerKm });
    this.sayAll([step, cue ? this.textOf(cue) : null]);
  }

  private onEvent(event: RecorderEvent): void {
    switch (event.name) {
      case 'run_started':
        this.voice.beginRun();
        this.startedPending = true;
        return;
      case 'paused':
      case 'auto_paused':
        this.say({ kind: 'paused', auto: event.name === 'auto_paused' });
        return;
      case 'resumed':
      case 'auto_resumed':
        this.say({ kind: 'resumed', auto: event.name === 'auto_resumed' });
        return;
      case 'run_saved_local':
        this.workout?.runEnded(event.runId);
        this.say({ kind: 'finished', distanceM: this.lastMetrics.distanceM, activeMs: event.activeMs });
        return;
      case 'recorder_interrupted':
        void this.voice.stop();
        return;
    }
  }

  /** Mid-run changes apply from the next boundary; splits already passed are never replayed. */
  private onSettings(): void {
    const current = { settings: this.settings.get(), units: this.settings.units };
    if (!this.runId || (this.schedulerFor?.settings === current.settings && this.schedulerFor.units === current.units)) return;
    if (!current.settings.cues.enabled) void this.voice.stop();
    this.rebuildScheduler(this.recorder.getSnapshot().metrics);
  }

  private rebuildScheduler(metrics: { distanceM: number; activeMs: number; currentPaceSPerKm: number | null }): void {
    const settings = this.settings.get();
    const units = this.settings.units;
    this.schedulerFor = { settings, units };
    this.scheduler = new CueScheduler(settings.cues, units);
    // Prime with where the run already is, discarding the result.
    this.scheduler.update({ distanceM: metrics.distanceM, activeMs: metrics.activeMs, currentPaceSPerKm: metrics.currentPaceSPerKm });
    this.lastMetrics = { distanceM: metrics.distanceM, activeMs: metrics.activeMs };
  }

  private textOf(cue: Cue): string {
    return cueText(cue, this.settings.get().cues, this.settings.units);
  }

  private say(cue: Cue): void {
    this.sayAll([this.textOf(cue)]);
  }

  /** Speaks what's due as one cue. */
  private sayAll(parts: (string | null)[]): void {
    const settings = this.settings.get();
    const text = parts.filter((p): p is string => !!p).join(' ');
    if (!settings.cues.enabled || !text) return;
    const outcome = this.voice.speak(text, { volume: CUE_VOLUME[settings.cueVolume], allowSpeaker: settings.speakerFallback });
    this.spoken.push({ text, outcome });
    if (this.spoken.length > 20) this.spoken.shift();
  }
}
