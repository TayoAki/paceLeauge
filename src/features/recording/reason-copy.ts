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
};

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
