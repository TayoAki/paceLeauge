import type { ServerRun } from '@/api/schemas';
import type { SavedRun } from '@/db/journal';
import type { RunView } from '@/features/data/hooks';
import { serverRunOf } from '@/features/sync/sync-engine';

function localStatus(run: SavedRun): RunView['status'] {
  switch (run.syncState) {
    case 'synced':
      return serverRunOf(run)?.status ?? 'accepted';
    case 'needs_attention':
      return 'needs_attention';
    case 'uploading':
    case 'awaiting_validation':
      return 'syncing';
    default:
      return 'saved_local';
  }
}

/**
 * One list of runs from this device's journal and the server history. The server copy wins
 * once synced; runs deleted on this device are hidden immediately, before the server
 * confirms.
 */
export function mergeRunViews(local: readonly SavedRun[], server: readonly ServerRun[]): RunView[] {
  const localById = new Map(local.map((r) => [r.runId, r]));
  const views = new Map<string, RunView>();
  for (const s of server) {
    const l = localById.get(s.client_run_id) ?? null;
    if (l?.deleted) continue;
    views.set(s.client_run_id, {
      key: s.client_run_id,
      localRunId: l?.runId ?? null,
      serverRunId: s.id,
      title: l?.title ?? s.title,
      startedAt: s.started_at_ms,
      activeMs: s.active_ms,
      distanceM: s.distance_m,
      status: s.status,
      server: s,
      local: l,
    });
  }
  for (const l of local) {
    if (l.deleted || views.has(l.runId)) continue;
    const server = serverRunOf(l);
    // Another copy of this run was kept (Phase 2 duplicates); the list shows that one.
    if (server?.status === 'duplicate') continue;
    views.set(l.runId, {
      key: l.runId,
      localRunId: l.runId,
      serverRunId: l.serverRunId,
      title: l.title,
      startedAt: l.startedAt,
      activeMs: server?.active_ms ?? l.activeMs,
      distanceM: server?.distance_m ?? l.distanceM,
      status: localStatus(l),
      server,
      local: l,
    });
  }
  return [...views.values()].sort((a, b) => b.startedAt - a.startedAt);
}
