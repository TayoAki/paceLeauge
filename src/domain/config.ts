/**
 * Versioned product rules. These mirror the "Score contract — version 1" and recorder
 * tuning inputs in docs/packet/specs/TECHNICAL_SPEC.md. The SQL backend
 * (db/migrations) implements the same numbers; tests/backend/parity.test.ts keeps
 * the two in lockstep. Changing any value requires a new version, never an in-place edit.
 */

/** Competition calendar shared by every pilot league (D-005). */
export const COMPETITION_TIME_ZONE = 'America/Chicago';

export const RULE_VERSION = 1;
export const VALIDATOR_VERSION = 1;

/** Recorder calibration inputs (initial values from the spec; tune with device evidence). */
export const RECORDER_V1 = {
  /** Preflight is "ready" only with a fix at most this old… */
  freshFixMaxAgeMs: 15_000,
  /** …and at least this accurate. */
  maxHorizontalAccuracyM: 50,
  /** No distance is ever bridged across a sampling gap longer than this. */
  gapThresholdMs: 15_000,
  /** Target: at most this much received data uncommitted. */
  checkpointIntervalMs: 5_000,
  countdownSeconds: 3,
  /** Accuracy at or below which the fix is described as good. */
  goodAccuracyM: 20,
  /** Recording stops appending points beyond this; time keeps running (NFR-008). */
  maxPointsPerRun: 50_000,
} as const;

/** Server-side run validation, version 1. */
export const VALIDATOR_V1 = {
  version: VALIDATOR_VERSION,
  maxHorizontalAccuracyM: 50,
  gapThresholdMs: 15_000,
  /** Implied speed that marks a sample implausible (heuristic, not proof of cheating). */
  jumpSpeedMps: 12,
  /** Consecutive mutually-plausible "jump" samples that prove the anchor was the outlier. */
  outlierChainLength: 3,
  /** A gap re-anchor this far away at jump speed counts as a teleport. */
  teleportMinDistanceM: 250,
  /** Sustained average speed that holds a run for review… */
  reviewAverageSpeedMps: 7,
  /** …when the run is at least this long. */
  reviewAverageSpeedMinDistanceM: 1_000,
  /** Unresolved jump samples that hold a run for review (count AND fraction). */
  reviewJumpSampleMinCount: 10,
  reviewJumpSampleFraction: 0.2,
  /** Allowed client clock skew before an end time counts as "in the future". */
  futureSkewMs: 5 * 60_000,
  /** Runs first received later than this after ending are held for review. */
  lateUploadReviewMs: 72 * 60 * 60_000,
  minDistanceM: 100,
  minActiveMs: 60_000,
  minCoverage: 0.8,
  /** Sanity floor for timestamps (earlier values are treated as invalid). */
  earliestValidTimestampMs: Date.UTC(2024, 0, 1),
} as const;

export type ValidatorConfig = typeof VALIDATOR_V1;

/** Daily/weekly XP, version 1. Distances are handled in integer centimetres. */
export const SCORING_V1 = {
  ruleVersion: RULE_VERSION,
  centimetresPerDistanceXp: 10_000,
  maxDistanceXp: 100,
  activeDayBonusXp: 25,
  activeDayMinDistanceCm: 100_000,
  activeDayMinActiveMs: 300_000,
  maxDailyXp: 125,
  weeklyCountingDays: 3,
  maxWeeklyXp: 375,
  /** League weeks settle this long after they close. */
  settlementGraceMs: 24 * 60 * 60_000,
} as const;

export const TIERS = [
  { name: 'Seed', minXp: 0 },
  { name: 'Stride', minXp: 500 },
  { name: 'Tempo', minXp: 1_500 },
  { name: 'Surge', minXp: 4_000 },
  { name: 'Elite', minXp: 10_000 },
] as const;

export type TierName = (typeof TIERS)[number]['name'];

export const PROFILE_RULES = {
  aliasMinLength: 2,
  aliasMaxLength: 24,
  goalDaysMin: 1,
  goalDaysMax: 3,
  runTitleMaxLength: 60,
} as const;

export const LEAGUE_RULES = {
  capacity: 20,
  nameMinLength: 3,
  nameMaxLength: 32,
  inviteTtlDays: 7,
  inviteCodeLength: 8,
} as const;

export const UPLOAD_RULES = {
  maxPointsPerChunk: 500,
  maxChunkBytes: 128 * 1024,
} as const;
