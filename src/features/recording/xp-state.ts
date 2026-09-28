import type { ServerRun } from '@/api/schemas';
import type { XpPanelState } from '@/components/run/run-components';
import type { SavedRun } from '@/db/journal';

import { duplicateCopy, reasonText, syncErrorCopy } from './reason-copy';

/**
 * What the XP panel may claim. Only a server-accepted, scored run shows earned XP; a local
 * save shows a labelled estimate at most (saved ≠ synced ≠ accepted).
 */
export function xpPanelState(local: SavedRun | null, server: ServerRun | null, offline: boolean): XpPanelState {
  if (server && server.status !== 'uploading') {
    if (server.status === 'duplicate') return { kind: 'personal_only', reason: duplicateCopy };
    if (server.status === 'personal_only') return { kind: 'personal_only', reason: reasonText(server.reason_codes) };
    if (server.status === 'review') return { kind: 'review', reason: reasonText(server.reason_codes) };
    if (server.scoring_state === 'pending') return { kind: 'scoring_paused' };
    if (server.xp_award) {
      return {
        kind: 'accepted',
        totalXp: server.xp_award.total_xp,
        distanceXp: server.xp_award.distance_xp,
        activeDayBonus: server.xp_award.active_day_bonus,
      };
    }
    return { kind: 'pending', estimate: null };
  }
  if (!local) return { kind: 'pending', estimate: null };
  if (local.syncState === 'needs_attention') {
    return { kind: 'needs_attention', reason: syncErrorCopy[local.syncError ?? ''] ?? 'It will need attention before it can sync.' };
  }
  if (local.validation.outcome !== 'accepted') return { kind: 'personal_only', reason: reasonText(local.validation.reasons) };
  const estimate = local.provisionalXp?.totalXp ?? null;
  return offline || local.syncError === 'network' ? { kind: 'offline', estimate } : { kind: 'pending', estimate };
}
