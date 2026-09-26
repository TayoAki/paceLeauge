/** Milliseconds since the Unix epoch, UTC. */
export type EpochMs = number;

/** A calendar date in the competition time zone, formatted YYYY-MM-DD. */
export type IsoDate = string;

export type Units = 'metric' | 'imperial';

/** One recorded GPS sample. Coordinates are normalized at capture (see route-codec). */
export interface TrackPoint {
  /** Monotonic per-run sequence number assigned by the local journal. */
  seq: number;
  /** Index of the active segment (pause/resume boundary) the sample was captured in. */
  segmentIndex: number;
  t: EpochMs;
  lat: number;
  lon: number;
  /** Horizontal accuracy radius in metres; null when the platform did not report one. */
  accuracyM: number | null;
}

/** A closed active-recording interval. Pauses are the gaps between segments. */
export interface ActiveSegment {
  index: number;
  startAt: EpochMs;
  endAt: EpochMs;
}

export type RunOutcome = 'accepted' | 'personal_only' | 'review';

/** Why a run is personal-only or held for review. Order is significant (stable output). */
export const REASON_CODES = [
  'invalid_timestamps',
  'future_timestamp',
  'too_short_distance',
  'too_short_time',
  'low_gps_coverage',
  'speed_anomaly',
  'late_upload',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** Reasons that make a run personal-only (it can never earn XP). */
export const PERSONAL_ONLY_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'invalid_timestamps',
  'future_timestamp',
  'too_short_distance',
  'too_short_time',
  'low_gps_coverage',
]);

/** Reasons that hold an otherwise-eligible run for a documented human review. */
export const REVIEW_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['speed_anomaly', 'late_upload']);
