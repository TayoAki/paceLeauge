import { addDays, competitionDate, startOfDay } from './calendar';
import { COMPETITION_TIME_ZONE } from './config';
import type { EpochMs, IsoDate } from './types';
import { metresToCentimetres, type SegmentResult } from './validator';

/**
 * Distance and active time of one segment on one competition day. A segment that crosses
 * local midnight is split at the boundary using its timestamps; a credited stretch that
 * crosses midnight is split in proportion to time. Mirrors private.allocate_run_days (SQL).
 */
export interface DayAllocation {
  segmentIndex: number;
  /** Start of the whole segment; league scoring counts segments starting at/after joining. */
  segmentStartAt: EpochMs;
  competitionDate: IsoDate;
  distanceCm: number;
  activeMs: number;
}

interface DayWindow {
  date: IsoDate;
  from: EpochMs;
  to: EpochMs;
  distanceM: number;
}

function dayWindows(startAt: EpochMs, endAt: EpochMs, timeZone: string): DayWindow[] {
  const windows: DayWindow[] = [];
  let date = competitionDate(startAt, timeZone);
  let from = startAt;
  for (;;) {
    const nextDayStart = startOfDay(addDays(date, 1), timeZone);
    windows.push({ date, from, to: Math.min(endAt, nextDayStart), distanceM: 0 });
    if (endAt <= nextDayStart) break;
    date = addDays(date, 1);
    from = nextDayStart;
  }
  return windows;
}

export function allocateSegmentsToDays(segments: readonly SegmentResult[], timeZone: string = COMPETITION_TIME_ZONE): DayAllocation[] {
  const allocations: DayAllocation[] = [];
  for (const segment of segments) {
    if (segment.endAt <= segment.startAt) continue;
    const windows = dayWindows(segment.startAt, segment.endAt, timeZone);
    for (const stretch of segment.credited) {
      const span = stretch.t1 - stretch.t0;
      for (const w of windows) {
        if (stretch.t0 >= w.from && stretch.t1 <= w.to) {
          w.distanceM += stretch.distanceM;
          break;
        }
        const overlap = Math.min(stretch.t1, w.to) - Math.max(stretch.t0, w.from);
        if (overlap > 0) w.distanceM += (stretch.distanceM * overlap) / span;
      }
    }
    for (const w of windows) {
      const activeMs = w.to - w.from;
      const distanceCm = metresToCentimetres(w.distanceM);
      if (activeMs <= 0 && distanceCm <= 0) continue;
      allocations.push({
        segmentIndex: segment.index,
        segmentStartAt: segment.startAt,
        competitionDate: w.date,
        distanceCm,
        activeMs,
      });
    }
  }
  return allocations;
}

export interface DayTotals {
  competitionDate: IsoDate;
  distanceCm: number;
  activeMs: number;
}

export function totalsByDay(allocations: readonly Pick<DayAllocation, 'competitionDate' | 'distanceCm' | 'activeMs'>[]): Map<IsoDate, DayTotals> {
  const totals = new Map<IsoDate, DayTotals>();
  for (const a of allocations) {
    const current = totals.get(a.competitionDate);
    if (current) {
      current.distanceCm += a.distanceCm;
      current.activeMs += a.activeMs;
    } else {
      totals.set(a.competitionDate, { competitionDate: a.competitionDate, distanceCm: a.distanceCm, activeMs: a.activeMs });
    }
  }
  return totals;
}
