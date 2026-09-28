import type { ReasonCode } from '@/domain/types';

/** Plain-language, non-accusatory explanations for personal-only and review outcomes. */
export const reasonCopy: Record<ReasonCode, string> = {
  too_short_distance: 'Runs need at least 100 m to count for league XP.',
  too_short_time: 'Runs need at least 1 minute of active time to count for league XP.',
  low_gps_coverage: 'GPS covered less than 80% of this run’s active time.',
  invalid_timestamps: 'This run’s timing couldn’t be checked.',
  future_timestamp: 'This phone’s clock was ahead of the server, so the run couldn’t be checked.',
  speed_anomaly: 'Part of this run looked unusually fast, so it’s held for a quick review. GPS glitches happen — this isn’t an accusation.',
  late_upload: 'This run reached us more than 72 hours after it ended, so it’s held for review before it counts.',
};

/** Reasons only the server adds (they are not part of the shared validator). */
const serverReasonCopy: Record<string, string> = {
  edited: 'This run was changed after it was saved, so it’s held for a quick review before it counts.',
  no_route: 'This workout came without a route, so it can’t be checked for the league. It still counts for your weekly goal and streak.',
  manual_entry: 'This run was typed in by hand, so it can’t earn league XP. It still counts for your weekly goal and streak.',
  indoor:
    'Indoor runs from your phone can’t be checked, so they don’t earn league XP. They count for your weekly goal and streak. Indoor runs recorded on a watch with heart rate can earn XP.',
  indoor_unverified:
    'This indoor run’s pace, steps and heart rate didn’t all look like running, so it can’t earn league XP. It still counts for your weekly goal and streak.',
  file_import: 'Imported files can be edited, so they’re kept as history. They count for your weekly goal and streak.',
};

/**
 * What happens to a run held for review, and how to ask for another look (docs/ROADMAP.md,
 * Phase 0). Operators decide held runs; the health report flags any older than 48 hours.
 */
export function reviewNextSteps(supportEmail: string): string {
  const ask = supportEmail ? ` To ask for another look, email ${supportEmail} with the run’s date.` : '';
  return `A person checks held runs, usually within 2 days, and the result shows here.${ask}`;
}

/** Why a run was set aside: another recording of the same run is the one that counts. */
export const duplicateCopy = 'Another recording of this run was kept (the one with the better GPS record), so it only counts once.';

export function reasonText(codes: readonly string[]): string {
  const first = codes[0];
  if (first && first in reasonCopy) return reasonCopy[first as ReasonCode];
  if (first && first in serverReasonCopy) return serverReasonCopy[first]!;
  return 'This run doesn’t meet the league rules.';
}

export const syncErrorCopy: Record<string, string> = {
  network: 'You’re offline. It will sync when you reconnect.',
  timeout: 'The connection is slow. It will try again.',
  rate_limited: 'Too many uploads at once. It will try again shortly.',
  account_deleting: 'Your account is being deleted.',
  idempotency_conflict: 'This run conflicts with a copy already uploaded.',
  invalid_input: 'This run couldn’t be uploaded. Your data is safe on this phone.',
};
