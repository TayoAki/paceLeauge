import type { RawSample, SavedRun, StoredSession } from '@/db/journal';
import type { EpochMs } from '@/domain/types';

export type GpsQuality = 'searching' | 'good' | 'fair' | 'weak';

export interface LiveMetrics {
  distanceM: number;
  activeMs: number;
  pointCount: number;
  lastFixAt: EpochMs | null;
  lastAccuracyM: number | null;
  quality: GpsQuality;
  pointLimitReached: boolean;
  /** Pace of the last ~20 s of credited running (seconds per km); null when stopped or unknown. */
  currentPaceSPerKm: number | null;
  /** Distance and active time into the current lap (each full kilometre or mile). */
  lapDistanceM: number;
  lapActiveMs: number;
}

export interface RecorderSnapshot {
  session: StoredSession | null;
  metrics: LiveMetrics;
  /** The run saved most recently in this process (drives the summary screen). */
  lastSaved: SavedRun | null;
  /** The run is paused because the runner stopped (it resumes when they move). */
  autoPaused: boolean;
}

export type SampleSink = (samples: RawSample[]) => void;

/**
 * Delivers location samples while a run is recording. On iOS the native driver starts a
 * background location task (screen-locked recording) whose handler forwards samples to the
 * active recorder; the web driver is a foreground watcher for development previews only.
 */
export interface LocationDriver {
  readonly supportsBackground: boolean;
  start(sink: SampleSink): Promise<void>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
}

export const EMPTY_METRICS: LiveMetrics = {
  distanceM: 0,
  activeMs: 0,
  pointCount: 0,
  lastFixAt: null,
  lastAccuracyM: null,
  quality: 'searching',
  pointLimitReached: false,
  currentPaceSPerKm: null,
  lapDistanceM: 0,
  lapActiveMs: 0,
};
