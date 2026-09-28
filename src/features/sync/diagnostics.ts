import type { OutboxItem, SavedRun } from '@/db/journal';

import type { SyncStatus } from './sync-engine';

/**
 * "Send diagnostics" (docs/ROADMAP.md 2.6): a small report for support about why runs aren't
 * syncing. It holds counts, states and error codes only: never coordinates, routes, titles, notes
 * or email addresses.
 */
export interface DiagnosticsInput {
  appVersion: string | null;
  build: string | null;
  platform: string;
  osVersion: string | number | null;
  status: SyncStatus | null;
  runs: readonly SavedRun[];
  outbox: readonly OutboxItem[];
  healthImport: { enabled: boolean; lastRunAtMs: number | null; lastImported: number } | null;
  now: number;
}

export function diagnosticsReport(input: DiagnosticsInput): Record<string, unknown> {
  const count = <T,>(items: readonly T[], key: (item: T) => string) =>
    items.reduce<Record<string, number>>((acc, item) => {
      const k = key(item);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const unsynced = input.runs.filter((r) => !r.deleted && r.syncState !== 'synced');
  return {
    app_version: input.appVersion,
    build: input.build,
    platform: input.platform,
    os_version: input.osVersion === null ? null : String(input.osVersion),
    generated_at_ms: input.now,
    sync: input.status
      ? {
          pending: input.status.pending,
          needs_attention: input.status.needsAttention,
          auth_blocked: input.status.authBlocked,
          last_error: input.status.lastError,
          last_synced_ago_s: input.status.lastSyncedAt === null ? null : Math.round((input.now - input.status.lastSyncedAt) / 1000),
        }
      : null,
    runs_by_state: count(input.runs.filter((r) => !r.deleted), (r) => r.syncState),
    runs_by_source: count(input.runs.filter((r) => !r.deleted), (r) => r.origin?.source ?? 'phone_gps'),
    unsynced: unsynced.slice(0, 50).map((r) => ({
      state: r.syncState,
      error: r.syncError,
      source: r.origin?.source ?? 'phone_gps',
      points: r.pointCount,
      age_h: Math.round((input.now - r.createdAt) / 3_600_000),
    })),
    outbox: input.outbox.slice(0, 50).map((o) => ({ kind: o.kind, state: o.state, attempts: o.attempts, error: o.lastError })),
    health_import: input.healthImport,
  };
}
