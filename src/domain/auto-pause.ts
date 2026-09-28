import { haversineM } from './geo';
import type { EpochMs } from './types';

/**
 * Auto-pause (docs/ROADMAP.md 1.3). The recorder pauses when the runner stops and resumes when they
 * move again. Speed is the straight-line displacement over the last few seconds, which GPS jitter
 * at a standstill barely moves, so standing at a crossing doesn't read as running. Two thresholds
 * with a hold time on each (hysteresis) keep it from flickering at walking pace.
 */
export interface AutoPauseConfig {
  /** Below this speed for `stopAfterMs`, the run pauses. */
  stopSpeedMps: number;
  stopAfterMs: number;
  /** Above this speed for `resumeAfterMs`, a paused run resumes. */
  resumeSpeedMps: number;
  resumeAfterMs: number;
  /** Displacement is measured over this window. */
  windowMs: number;
  /** Fixes less accurate than this are ignored. */
  maxAccuracyM: number;
}

export const AUTO_PAUSE_V1: AutoPauseConfig = {
  stopSpeedMps: 0.6,
  stopAfterMs: 8_000,
  resumeSpeedMps: 1.4,
  resumeAfterMs: 3_000,
  windowMs: 5_000,
  maxAccuracyM: 30,
};

export interface MotionSample {
  t: EpochMs;
  lat: number;
  lon: number;
  accuracyM: number | null | undefined;
}

/** `pause.at` is when the runner stopped, so the standing time is never credited. */
export type AutoPauseDecision = { type: 'pause'; at: EpochMs } | { type: 'resume'; at: EpochMs } | null;

export class AutoPauseDetector {
  private samples: MotionSample[] = [];
  private slowSince: EpochMs | null = null;
  private fastSince: EpochMs | null = null;
  private stopped = false;

  constructor(private readonly config: AutoPauseConfig = AUTO_PAUSE_V1) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Starts over, e.g. after a manual pause or resume. */
  reset(stopped = false): void {
    this.samples = [];
    this.slowSince = null;
    this.fastSince = null;
    this.stopped = stopped;
  }

  /** Current speed over the window, or null until the window spans enough time. */
  speedMps(): number | null {
    const last = this.samples[this.samples.length - 1];
    if (!last) return null;
    const first = this.samples.find((s) => last.t - s.t <= this.config.windowMs) ?? last;
    const span = last.t - first.t;
    if (span < this.config.windowMs * 0.6) return null;
    return haversineM(first, last) / (span / 1000);
  }

  push(sample: MotionSample): AutoPauseDecision {
    const cfg = this.config;
    if (sample.accuracyM == null || sample.accuracyM < 0 || sample.accuracyM > cfg.maxAccuracyM) return null;
    const last = this.samples[this.samples.length - 1];
    if (last && sample.t <= last.t) return null;
    this.samples.push(sample);
    while (this.samples.length > 2 && sample.t - this.samples[0]!.t > cfg.windowMs * 2) this.samples.shift();

    const speed = this.speedMps();
    if (speed === null) return null;

    if (!this.stopped) {
      if (speed < cfg.stopSpeedMps) {
        // The stop began about a window ago: that's when displacement stopped growing.
        this.slowSince ??= Math.max(this.samples[0]!.t, sample.t - cfg.windowMs);
        if (sample.t - this.slowSince >= cfg.stopAfterMs) {
          const at = this.slowSince;
          this.stopped = true;
          this.slowSince = null;
          this.fastSince = null;
          return { type: 'pause', at };
        }
      } else {
        this.slowSince = null;
      }
      return null;
    }

    if (speed > cfg.resumeSpeedMps) {
      this.fastSince ??= sample.t;
      if (sample.t - this.fastSince >= cfg.resumeAfterMs) {
        this.stopped = false;
        this.fastSince = null;
        this.slowSince = null;
        return { type: 'resume', at: sample.t };
      }
    } else {
      this.fastSince = null;
    }
    return null;
  }
}
