import { requireOptionalNativeModule } from 'expo';

import { formatDistance, formatPace } from '@/domain/format';
import type { Units } from '@/domain/types';
import type { RecorderEvent } from '@/features/recording/recorder-service';
import type { RecorderSnapshot } from '@/features/recording/types';

/**
 * The run on the lock screen and in the Dynamic Island (docs/ROADMAP.md 1.2). Started with the
 * run, updated from the recorder every few seconds (the lock-screen clock counts on its own in
 * between), and ended with the final numbers when the run is saved, or removed if it is discarded.
 */
export type RunActivityStatus = 'recording' | 'paused' | 'auto_paused' | 'finished';

export interface RunActivityState {
  status: RunActivityStatus;
  distance: string;
  distanceUnit: string;
  pace: string;
  paceUnit: string;
  activeSeconds: number;
  /** While recording: when the active clock would have read zero. */
  clockStartMs: number | null;
}

export interface RunActivityPort {
  isSupported(): boolean;
  start(state: RunActivityState): Promise<boolean>;
  update(state: RunActivityState): Promise<void>;
  end(state: RunActivityState, dismissAfterSeconds: number): Promise<void>;
}

interface RunActivityRecorder {
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeEvents(listener: (event: RecorderEvent) => void): () => void;
}

/** Updates at most this often, except when the run's state changes. */
export const UPDATE_EVERY_MS = 5_000;
/** How long the final numbers stay on the lock screen after a run is saved. */
export const FINISHED_VISIBLE_S = 15 * 60;

export function activityState(snapshot: RecorderSnapshot, units: Units, now: number): RunActivityState | null {
  const { session, metrics } = snapshot;
  if (!session) return null;
  const status: RunActivityStatus = session.status === 'recording' ? 'recording' : snapshot.autoPaused ? 'auto_paused' : 'paused';
  const distance = formatDistance(metrics.distanceM, units);
  // Current pace while moving; otherwise the run's average.
  const pace =
    status === 'recording' && metrics.currentPaceSPerKm !== null
      ? formatPace(metrics.currentPaceSPerKm * 1000, 1000, units)
      : formatPace(metrics.activeMs, metrics.distanceM, units);
  return {
    status,
    distance: distance.value,
    distanceUnit: distance.unit,
    pace: pace.value,
    paceUnit: pace.unit,
    activeSeconds: Math.floor(metrics.activeMs / 1000),
    clockStartMs: status === 'recording' ? now - metrics.activeMs : null,
  };
}

export class LiveActivityController {
  private active = false;
  private starting: Promise<boolean> | null = null;
  private last: { state: RunActivityState; at: number } | null = null;
  /** The newest state, sent or not: the final numbers come from here. */
  private latest: RunActivityState | null = null;
  private saved = false;
  private unsubscribers: (() => void)[] = [];

  constructor(
    private readonly recorder: RunActivityRecorder,
    private readonly port: RunActivityPort | null,
    private readonly units: () => Units,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (!this.port || this.unsubscribers.length > 0) return;
    this.unsubscribers = [
      this.recorder.subscribe(() => void this.onSnapshot()),
      this.recorder.subscribeEvents((event) => {
        if (event.name === 'run_saved_local') this.saved = true;
      }),
    ];
    void this.onSnapshot();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  private async onSnapshot(): Promise<void> {
    const port = this.port;
    if (!port) return;
    const snapshot = this.recorder.getSnapshot();
    const now = this.now();
    const state = activityState(snapshot, this.units(), now);

    if (!state) {
      if (!this.active && !this.starting) return;
      await this.starting;
      const final = this.latest ?? this.last?.state;
      this.active = false;
      this.last = null;
      this.latest = null;
      const saved = this.saved;
      this.saved = false;
      if (final && saved) {
        await port.end({ ...final, status: 'finished', clockStartMs: null }, FINISHED_VISIBLE_S).catch(() => undefined);
      } else {
        await port.end(final ?? { status: 'paused', distance: '0.00', distanceUnit: '', pace: '--:--', paceUnit: '', activeSeconds: 0, clockStartMs: null }, 0).catch(() => undefined);
      }
      return;
    }

    this.latest = state;
    if (!this.active) {
      if (this.starting || !port.isSupported()) return;
      this.saved = false;
      this.starting = port.start(state).catch(() => false);
      this.active = await this.starting;
      this.starting = null;
      if (this.active) this.last = { state, at: now };
      return;
    }

    const previous = this.last;
    const statusChanged = previous?.state.status !== state.status;
    const due = !previous || now - previous.at >= UPDATE_EVERY_MS;
    const changed = !previous || previous.state.distance !== state.distance || previous.state.pace !== state.pace;
    if (!statusChanged && !(due && changed)) return;
    this.last = { state, at: now };
    await port.update(state).catch(() => undefined);
  }
}

interface RunActivityNative {
  isSupported(): boolean;
  start(title: string, state: RunActivityState): Promise<string | null>;
  update(state: RunActivityState): Promise<void>;
  end(state: RunActivityState, dismissAfterSeconds: number): Promise<void>;
}

/** The RunActivity native module (modules/run-activity); null on web, Android and older builds. */
export function deviceRunActivity(): RunActivityPort | null {
  const native = requireOptionalNativeModule<RunActivityNative>('RunActivity');
  if (!native) return null;
  return {
    isSupported: () => {
      try {
        return native.isSupported();
      } catch {
        return false;
      }
    },
    start: async (state) => (await native.start('PaceLeague run', state)) !== null,
    update: (state) => native.update(state),
    end: (state, dismissAfterSeconds) => native.end(state, dismissAfterSeconds),
  };
}
