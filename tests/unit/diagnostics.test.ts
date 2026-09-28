import type { SavedRun } from '@/db/journal';
import { diagnosticsReport } from '@/features/sync/diagnostics';

const NOW = Date.UTC(2026, 8, 28, 12);

function run(overrides: Partial<SavedRun>): SavedRun {
  return {
    runId: 'r1',
    title: 'Secret loop by my house',
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 1_800_000,
    activeMs: 1_800_000,
    distanceM: 5000,
    pointCount: 1800,
    segments: [],
    interrupted: false,
    validation: { outcome: 'accepted', reasons: [], coverage: 1, distanceCm: 500_000, activeMs: 1_800_000 },
    provisionalXp: null,
    syncState: 'needs_attention',
    syncError: 'invalid_input',
    serverRunId: null,
    server: { notes: 'private note', title: 'Secret loop by my house' },
    routeCached: true,
    deleted: false,
    origin: { source: 'file_import', sourceDevice: 'home-route.gpx' },
    createdAt: NOW - 7_200_000,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('diagnostics report', () => {
  it('counts states and errors without titles, notes, file names or places', () => {
    const report = diagnosticsReport({
      appVersion: '0.1.0',
      build: '12',
      platform: 'ios',
      osVersion: '26.0',
      status: { running: false, pending: 1, needsAttention: 1, authBlocked: false, lastError: 'invalid_input', lastSyncedAt: NOW - 60_000 },
      runs: [run({}), run({ runId: 'r2', syncState: 'synced', syncError: null, origin: null })],
      outbox: [{ id: 1, kind: 'upload_run', runId: 'r1', payload: { title: 'Secret loop by my house' }, state: 'needs_attention', attempts: 3, nextAttemptAt: 0, lastError: 'invalid_input', progress: null, createdAt: 0, updatedAt: 0 }],
      healthImport: { enabled: true, lastRunAtMs: NOW - 5_000, lastImported: 2 },
      now: NOW,
    });
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/Secret|private note|home-route|"lat"|"lon"|latitude|longitude/);
    expect(report).toMatchObject({
      runs_by_state: { needs_attention: 1, synced: 1 },
      runs_by_source: { file_import: 1, phone_gps: 1 },
      unsynced: [{ state: 'needs_attention', error: 'invalid_input', source: 'file_import', points: 1800, age_h: 2 }],
      outbox: [{ kind: 'upload_run', state: 'needs_attention', attempts: 3, error: 'invalid_input' }],
      sync: { pending: 1, last_synced_ago_s: 60 },
    });
  });
});
