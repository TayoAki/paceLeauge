import type { RunEditResult } from '@/api/schemas';
import type { Journal } from '@/db/journal';

/**
 * After a fix is saved on the server, bring this phone's copy in line: the kept run takes the new
 * server version (so lists and the run screen show the fixed numbers) and stops using the route
 * cached here, which is the pre-fix route; a run merged into another is hidden.
 */
export async function recordFixLocally(
  journal: Pick<Journal, 'listSavedRuns' | 'updateSavedRun'>,
  result: RunEditResult,
  localRunId?: string | null,
): Promise<void> {
  const locals = await journal.listSavedRuns({ includeDeleted: true });
  const kept = locals.find((r) => r.runId === localRunId) ?? locals.find((r) => r.serverRunId === result.run.id);
  if (kept) await journal.updateSavedRun(kept.runId, { server: result.run, routeCached: false });
  if (result.removed_run_id) {
    const removed = locals.find((r) => r.serverRunId === result.removed_run_id);
    if (removed) await journal.updateSavedRun(removed.runId, { deleted: true });
  }
}

export function fixErrorCopy(code: string): string {
  switch (code) {
    case 'network':
    case 'timeout':
      return 'You’re offline. Fixing a run needs a connection.';
    case 'version_conflict':
      return 'This run changed since you opened it. Go back and try again.';
    case 'edit_increases_distance':
      return 'A fix can only remove distance, never add it.';
    case 'cannot_undo_merge':
      return 'A merged run can’t be restored.';
    case 'invalid_input':
      return 'That fix isn’t possible. A run needs at least a minute, and merged runs must be the same activity within 6 hours.';
    case 'not_found':
      return 'This run isn’t available any more.';
    default:
      return 'Couldn’t save the fix. Try again.';
  }
}
