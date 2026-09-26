import { METRES_PER_MILE } from './format';
import type { ActiveSegment, Units } from './types';
import type { SegmentResult } from './validator';

export interface Split {
  /** 1-based split number. */
  index: number;
  distanceM: number;
  /** Active time for this split (pauses excluded). */
  activeMs: number;
  /** True for the final, partial split. */
  partial: boolean;
}

/**
 * Per-kilometre (or per-mile) splits from the validator's credited stretches. Boundary
 * crossings are interpolated within a stretch; times are measured in active time, so paused
 * intervals never count. Distance that the validator did not credit is never invented.
 */
export function computeSplits(segments: readonly ActiveSegment[], results: readonly SegmentResult[], units: Units): Split[] {
  const unit = units === 'imperial' ? METRES_PER_MILE : 1000;
  const ordered = [...segments].sort((a, b) => a.index - b.index);
  const activeBefore = new Map<number, number>();
  let acc = 0;
  for (const s of ordered) {
    activeBefore.set(s.index, acc);
    acc += s.endAt - s.startAt;
  }
  const activeAt = (segment: SegmentResult, t: number) => (activeBefore.get(segment.index) ?? 0) + (t - segment.startAt);

  const crossings: number[] = [0];
  let cumulative = 0;
  let next = unit;
  let lastActive = 0;
  for (const segment of [...results].sort((a, b) => a.index - b.index)) {
    for (const stretch of segment.credited) {
      while (cumulative + stretch.distanceM >= next) {
        const fraction = (next - cumulative) / stretch.distanceM;
        const t = stretch.t0 + fraction * (stretch.t1 - stretch.t0);
        crossings.push(activeAt(segment, t));
        next += unit;
      }
      cumulative += stretch.distanceM;
      lastActive = activeAt(segment, stretch.t1);
    }
  }
  const splits: Split[] = [];
  for (let i = 1; i < crossings.length; i += 1) {
    splits.push({ index: i, distanceM: unit, activeMs: Math.round((crossings[i] as number) - (crossings[i - 1] as number)), partial: false });
  }
  const remainder = cumulative - (crossings.length - 1) * unit;
  if (remainder >= 10) {
    splits.push({
      index: crossings.length,
      distanceM: remainder,
      activeMs: Math.round(lastActive - (crossings[crossings.length - 1] as number)),
      partial: true,
    });
  }
  return splits;
}
