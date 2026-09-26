import { VALIDATOR_V1, type ValidatorConfig } from './config';
import { haversineM, isValidCoordinate } from './geo';
import {
  PERSONAL_ONLY_REASONS,
  REASON_CODES,
  REVIEW_REASONS,
  type ActiveSegment,
  type EpochMs,
  type ReasonCode,
  type RunOutcome,
  type TrackPoint,
} from './types';

/**
 * Run validator, version 1.
 *
 * Rules (mirrored exactly by private.validate_run in the SQL backend):
 * - Only samples inside an active segment, with valid coordinates and a reported horizontal
 *   accuracy ≤ 50 m, are usable. Samples are ordered by (t, seq); a sample whose timestamp is
 *   not later than the previous usable sample is a duplicate and ignored.
 * - Distance accrues between consecutive usable samples ("anchor" → sample) only when they
 *   are ≤ 15 s apart and the implied speed is ≤ 12 m/s. Gaps are never bridged.
 * - An implausibly fast sample is skipped without moving the anchor. If three consecutive
 *   skipped samples are plausible relative to each other, the anchor itself was the outlier:
 *   re-anchor on that chain (a cold-start fix or drift recovery) and credit the chain.
 * - A gap re-anchor that moved > 250 m at jump speed is a teleport.
 * - Coverage = usable active time / total active time, where each interval between adjacent
 *   samples counts at most the 15 s gap threshold. Segment start and end act as anchors so
 *   normal first-fix latency is not penalized (each boundary interval is capped likewise).
 * - Eligible (accepted) runs have ≥ 100 m, ≥ 60 s active time, ≥ 80% coverage, valid
 *   timestamps and no material anomaly. Anomalies and late uploads are held for review,
 *   never treated as proof of cheating.
 */

export interface CreditedStretch {
  t0: EpochMs;
  t1: EpochMs;
  distanceM: number;
}

export interface SegmentResult {
  index: number;
  startAt: EpochMs;
  endAt: EpochMs;
  activeMs: number;
  distanceM: number;
  coveredMs: number;
  credited: CreditedStretch[];
}

export interface ValidationDiagnostics {
  usableSamples: number;
  unusableSamples: number;
  duplicateSamples: number;
  outsideSegmentSamples: number;
  jumpSamples: number;
  teleports: number;
  gaps: number;
  anchorOutliers: number;
  averageSpeedMps: number;
}

export interface RunValidation {
  validatorVersion: number;
  outcome: RunOutcome;
  reasons: ReasonCode[];
  distanceM: number;
  /** Credited distance rounded half-up to whole centimetres. */
  distanceCm: number;
  activeMs: number;
  /** 0…1 */
  coverage: number;
  segments: SegmentResult[];
  diagnostics: ValidationDiagnostics;
}

/** Round half up (identical to SQL floor(x + 0.5)); Math.round differs for negatives only. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

export function metresToCentimetres(m: number): number {
  return roundHalfUp(m * 100);
}

export function isUsableSample(p: TrackPoint, config: ValidatorConfig = VALIDATOR_V1): boolean {
  return (
    isValidCoordinate(p.lat, p.lon) &&
    p.accuracyM !== null &&
    Number.isFinite(p.accuracyM) &&
    p.accuracyM >= 0 &&
    p.accuracyM <= config.maxHorizontalAccuracyM &&
    Number.isFinite(p.t)
  );
}

/** Incremental per-segment accumulator; used live by the recorder and in batch by validateRun. */
export class SegmentTrack {
  distanceM = 0;
  coveredMs = 0;
  usableSamples = 0;
  unusableSamples = 0;
  duplicateSamples = 0;
  jumpSamples = 0;
  teleports = 0;
  gaps = 0;
  anchorOutliers = 0;
  readonly credited: CreditedStretch[] = [];

  private anchor: TrackPoint | null = null;
  private lastSeenT = Number.NEGATIVE_INFINITY;
  private skipped: TrackPoint[] = [];

  constructor(
    readonly startAt: EpochMs,
    private readonly config: ValidatorConfig = VALIDATOR_V1,
  ) {}

  /** Last sample that anchors distance (null before the first usable sample). */
  get lastAnchor(): TrackPoint | null {
    return this.anchor;
  }

  push(p: TrackPoint): void {
    const cfg = this.config;
    if (!isUsableSample(p, cfg)) {
      this.unusableSamples += 1;
      return;
    }
    if (p.t <= this.lastSeenT) {
      this.duplicateSamples += 1;
      return;
    }
    this.lastSeenT = p.t;
    this.usableSamples += 1;
    const gap = cfg.gapThresholdMs;

    const anchor = this.anchor;
    if (anchor === null) {
      this.coveredMs += Math.min(Math.max(0, p.t - this.startAt), gap);
      this.anchor = p;
      return;
    }

    const dt = p.t - anchor.t;
    const d = haversineM(anchor, p);
    if (dt > gap) {
      if (d > cfg.teleportMinDistanceM && d / (dt / 1000) > cfg.jumpSpeedMps) this.teleports += 1;
      this.gaps += 1;
      this.coveredMs += gap;
      this.anchor = p;
      this.skipped = [];
      return;
    }

    if (d / (dt / 1000) <= cfg.jumpSpeedMps) {
      this.credit(anchor, p, d);
      this.anchor = p;
      this.skipped = [];
      return;
    }

    // Implausible relative to the anchor: skip it, but watch for a plausible chain.
    this.jumpSamples += 1;
    const last = this.skipped[this.skipped.length - 1];
    if (last !== undefined && haversineM(last, p) / ((p.t - last.t) / 1000) <= cfg.jumpSpeedMps) {
      this.skipped.push(p);
    } else {
      this.skipped = [p];
    }

    if (this.skipped.length >= cfg.outlierChainLength) {
      const chain = this.skipped;
      const first = chain[0] as TrackPoint;
      this.anchorOutliers += 1;
      this.jumpSamples -= chain.length;
      this.coveredMs += Math.min(first.t - anchor.t, gap);
      for (let i = 1; i < chain.length; i += 1) {
        const a = chain[i - 1] as TrackPoint;
        const b = chain[i] as TrackPoint;
        this.credit(a, b, haversineM(a, b));
      }
      this.anchor = chain[chain.length - 1] as TrackPoint;
      this.skipped = [];
    }
  }

  /** Closes the segment, adding the trailing boundary interval to coverage. */
  finish(index: number, endAt: EpochMs): SegmentResult {
    const tailFrom = this.anchor ? this.anchor.t : this.startAt;
    const tail = Math.min(Math.max(0, endAt - tailFrom), this.config.gapThresholdMs);
    return {
      index,
      startAt: this.startAt,
      endAt,
      activeMs: Math.max(0, endAt - this.startAt),
      distanceM: this.distanceM,
      coveredMs: this.coveredMs + tail,
      credited: this.credited.slice(),
    };
  }

  private credit(a: TrackPoint, b: TrackPoint, d: number): void {
    this.distanceM += d;
    this.coveredMs += b.t - a.t;
    this.credited.push({ t0: a.t, t1: b.t, distanceM: d });
  }
}

export interface RunValidationInput {
  startedAt: EpochMs;
  endedAt: EpochMs;
  segments: ActiveSegment[];
  points: TrackPoint[];
  /**
   * When the server first received the run. Null for on-device (provisional) validation,
   * which skips the future-timestamp and late-upload checks.
   */
  receivedAt: EpochMs | null;
  config?: ValidatorConfig;
}

export function segmentsAreValid(input: Pick<RunValidationInput, 'startedAt' | 'endedAt' | 'segments'>, config: ValidatorConfig = VALIDATOR_V1): boolean {
  const { startedAt, endedAt, segments } = input;
  if (segments.length === 0) return false;
  if (!Number.isInteger(startedAt) || !Number.isInteger(endedAt)) return false;
  if (startedAt < config.earliestValidTimestampMs || endedAt < startedAt) return false;
  let previousEnd = startedAt;
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i] as ActiveSegment;
    if (s.index !== i) return false;
    if (!Number.isInteger(s.startAt) || !Number.isInteger(s.endAt)) return false;
    if (s.startAt < previousEnd || s.endAt < s.startAt) return false;
    previousEnd = s.endAt;
  }
  return previousEnd <= endedAt;
}

function orderReasons(reasons: Set<ReasonCode>): ReasonCode[] {
  return REASON_CODES.filter((r) => reasons.has(r));
}

export function outcomeFor(reasons: readonly ReasonCode[]): RunOutcome {
  if (reasons.some((r) => PERSONAL_ONLY_REASONS.has(r))) return 'personal_only';
  if (reasons.some((r) => REVIEW_REASONS.has(r))) return 'review';
  return 'accepted';
}

export function validateRun(input: RunValidationInput): RunValidation {
  const config = input.config ?? VALIDATOR_V1;
  const reasons = new Set<ReasonCode>();
  const diagnostics: ValidationDiagnostics = {
    usableSamples: 0,
    unusableSamples: 0,
    duplicateSamples: 0,
    outsideSegmentSamples: 0,
    jumpSamples: 0,
    teleports: 0,
    gaps: 0,
    anchorOutliers: 0,
    averageSpeedMps: 0,
  };

  if (!segmentsAreValid(input, config)) {
    reasons.add('invalid_timestamps');
    const ordered = orderReasons(reasons);
    return {
      validatorVersion: config.version,
      outcome: outcomeFor(ordered),
      reasons: ordered,
      distanceM: 0,
      distanceCm: 0,
      activeMs: 0,
      coverage: 0,
      segments: [],
      diagnostics,
    };
  }

  const sorted = input.points.slice().sort((a, b) => a.t - b.t || a.seq - b.seq);
  const bySegment = new Map<number, TrackPoint[]>();
  for (const p of sorted) {
    const list = bySegment.get(p.segmentIndex);
    if (list) list.push(p);
    else bySegment.set(p.segmentIndex, [p]);
  }

  const segments: SegmentResult[] = [];
  let distanceM = 0;
  let activeMs = 0;
  let coveredMs = 0;
  let assigned = 0;
  for (const seg of input.segments) {
    const track = new SegmentTrack(seg.startAt, config);
    for (const p of bySegment.get(seg.index) ?? []) {
      if (p.t < seg.startAt || p.t > seg.endAt) continue;
      assigned += 1;
      track.push(p);
    }
    const result = track.finish(seg.index, seg.endAt);
    segments.push(result);
    distanceM += result.distanceM;
    activeMs += result.activeMs;
    coveredMs += result.coveredMs;
    diagnostics.usableSamples += track.usableSamples;
    diagnostics.unusableSamples += track.unusableSamples;
    diagnostics.duplicateSamples += track.duplicateSamples;
    diagnostics.jumpSamples += track.jumpSamples;
    diagnostics.teleports += track.teleports;
    diagnostics.gaps += track.gaps;
    diagnostics.anchorOutliers += track.anchorOutliers;
  }
  diagnostics.outsideSegmentSamples = sorted.length - assigned;
  diagnostics.averageSpeedMps = activeMs > 0 ? distanceM / (activeMs / 1000) : 0;

  const coverage = activeMs > 0 ? Math.min(1, coveredMs / activeMs) : 0;

  if (input.receivedAt !== null && input.endedAt > input.receivedAt + config.futureSkewMs) {
    reasons.add('future_timestamp');
  }
  if (distanceM < config.minDistanceM) reasons.add('too_short_distance');
  if (activeMs < config.minActiveMs) reasons.add('too_short_time');
  if (coverage < config.minCoverage) reasons.add('low_gps_coverage');

  const materialAnomaly =
    diagnostics.teleports > 0 ||
    (diagnostics.jumpSamples >= config.reviewJumpSampleMinCount &&
      diagnostics.jumpSamples > config.reviewJumpSampleFraction * diagnostics.usableSamples) ||
    (distanceM >= config.reviewAverageSpeedMinDistanceM && diagnostics.averageSpeedMps > config.reviewAverageSpeedMps);
  if (materialAnomaly) reasons.add('speed_anomaly');

  if (input.receivedAt !== null && input.receivedAt - input.endedAt > config.lateUploadReviewMs) {
    reasons.add('late_upload');
  }

  const ordered = orderReasons(reasons);
  return {
    validatorVersion: config.version,
    outcome: outcomeFor(ordered),
    reasons: ordered,
    distanceM,
    distanceCm: metresToCentimetres(distanceM),
    activeMs,
    coverage,
    segments,
    diagnostics,
  };
}
