import type { SavedRunDraft, StoredSession } from '@/db/journal';
import { allocateSegmentsToDays, type DayTotals } from '@/domain/allocation';
import { estimateRunXp } from '@/domain/scoring';
import type { EpochMs, IsoDate, TrackPoint } from '@/domain/types';
import { validateRun } from '@/domain/validator';

export type CreditedDays = ReadonlyMap<IsoDate, Pick<DayTotals, 'distanceCm' | 'activeMs'>>;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday morning" — from the runner's local clock at the start of the run. */
export function defaultRunTitle(startedAt: EpochMs): string {
  const d = new Date(startedAt);
  const hour = d.getHours();
  const period = hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 21 ? 'evening' : 'night';
  return `${WEEKDAYS[d.getDay()]} ${period}`;
}

/**
 * Provisional summary computed on the device when a run is saved. It uses the same
 * validator and score contract as the server but skips server-only checks, and is always
 * labelled as an estimate until the server accepts the run.
 */
export function buildSavedRunDraft(
  session: StoredSession,
  points: TrackPoint[],
  creditedDays: CreditedDays,
  title = defaultRunTitle(session.startedAt),
): SavedRunDraft {
  const endedAt = session.segments[session.segments.length - 1]?.endAt ?? session.startedAt;
  const validation = validateRun({ startedAt: session.startedAt, endedAt, segments: session.segments, points, receivedAt: null });
  const provisionalXp =
    validation.outcome === 'accepted' ? estimateRunXp(allocateSegmentsToDays(validation.segments), creditedDays) : null;
  return {
    title,
    startedAt: session.startedAt,
    endedAt,
    activeMs: session.segments.reduce((sum, s) => sum + (s.endAt - s.startAt), 0),
    distanceM: validation.distanceM,
    segments: session.segments,
    interrupted: session.wasInterrupted,
    validation: {
      outcome: validation.outcome,
      reasons: validation.reasons,
      coverage: validation.coverage,
      distanceCm: validation.distanceCm,
      activeMs: validation.activeMs,
    },
    provisionalXp,
  };
}
