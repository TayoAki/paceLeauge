import type { EpochMs } from './types';
import type { CreditedStretch } from './validator';

/**
 * Current pace for the run screen and voice cues (docs/ROADMAP.md 1.2): the pace of the last
 * ~20 seconds of credited running, so it follows speed changes without the jitter of a single
 * fix. Only distance the validator credits counts, so GPS jumps never show as sprints.
 */
export const CURRENT_PACE_WINDOW_MS = 20_000;
/** Below this much distance in the window the runner is treated as stopped. */
const MIN_WINDOW_DISTANCE_M = 15;
/** No credited fix for this long: the current pace is unknown rather than stale. */
const STALE_AFTER_MS = 10_000;

/** Seconds per kilometre over the window ending at the latest credited point; null when stopped or unknown. */
export function currentPaceSPerKm(stretches: readonly CreditedStretch[], now: EpochMs, windowMs = CURRENT_PACE_WINDOW_MS): number | null {
  const last = stretches[stretches.length - 1];
  if (!last || now - last.t1 > STALE_AFTER_MS) return null;
  const from = last.t1 - windowMs;
  let distanceM = 0;
  let timeMs = 0;
  for (let i = stretches.length - 1; i >= 0; i -= 1) {
    const s = stretches[i]!;
    if (s.t1 <= from) break;
    const t0 = Math.max(s.t0, from);
    const span = s.t1 - s.t0;
    distanceM += span > 0 ? (s.distanceM * (s.t1 - t0)) / span : s.distanceM;
    timeMs += s.t1 - t0;
  }
  if (distanceM < MIN_WINDOW_DISTANCE_M || timeMs <= 0) return null;
  return timeMs / distanceM; // (ms / m) === (s / km)
}

/** Average pace in seconds per kilometre, or null before any distance. */
export function averagePaceSPerKm(distanceM: number, activeMs: number): number | null {
  if (distanceM < 10 || activeMs <= 0) return null;
  return activeMs / distanceM;
}
