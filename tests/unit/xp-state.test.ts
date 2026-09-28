import type { ServerRun } from '@/api/schemas';
import type { SavedRun } from '@/db/journal';
import { xpPanelState } from '@/features/recording/xp-state';

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function localRun(overrides: Partial<SavedRun> = {}): SavedRun {
  return {
    runId: 'run-1',
    title: 'Friday morning',
    startedAt: T0,
    endedAt: T0 + 1_888_000,
    activeMs: 1_888_000,
    distanceM: 5240,
    pointCount: 1889,
    segments: [{ index: 0, startAt: T0, endAt: T0 + 1_888_000 }],
    interrupted: false,
    validation: { outcome: 'accepted', reasons: [], coverage: 1, distanceCm: 524_000, activeMs: 1_888_000 },
    provisionalXp: { days: [], totalXp: 77, distanceXp: 52, activeDayBonus: 25 },
    syncState: 'pending',
    syncError: null,
    serverRunId: null,
    server: null,
    routeCached: true,
    deleted: false,
    origin: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function serverRun(overrides: Partial<ServerRun> = {}): ServerRun {
  return {
    id: 'server-1',
    client_run_id: 'run-1',
    title: 'Friday morning',
    started_at_ms: T0,
    ended_at_ms: T0 + 1_888_000,
    active_ms: 1_888_000,
    distance_m: 5240,
    status: 'accepted',
    reason_codes: [],
    coverage: 1,
    interrupted: false,
    scoring_state: 'applied',
    xp_award: { days: [], total_xp: 77, distance_xp: 52, active_day_bonus: 25 },
    version: 1,
    validator_version: 1,
    rule_version: 1,
    finalized_at_ms: T0 + 1_900_000,
    ...overrides,
  };
}

describe('XP panel (saved ≠ synced ≠ accepted)', () => {
  it('shows earned XP only from the server’s accepted, scored result', () => {
    expect(xpPanelState(localRun(), serverRun(), false)).toEqual({ kind: 'accepted', totalXp: 77, distanceXp: 52, activeDayBonus: 25 });
  });

  it('labels a local save as an estimate while waiting, and as offline when there is no connection', () => {
    expect(xpPanelState(localRun(), null, false)).toEqual({ kind: 'pending', estimate: 77 });
    expect(xpPanelState(localRun(), null, true)).toEqual({ kind: 'offline', estimate: 77 });
    expect(xpPanelState(localRun({ syncError: 'network' }), null, false)).toEqual({ kind: 'offline', estimate: 77 });
  });

  it('never turns an estimate into earned XP while the upload is still in progress', () => {
    expect(xpPanelState(localRun({ syncState: 'uploading' }), serverRun({ status: 'uploading', xp_award: null }), false)).toEqual({
      kind: 'pending',
      estimate: 77,
    });
  });

  it('explains personal-only and review outcomes from the server’s reason codes', () => {
    const personal = xpPanelState(localRun(), serverRun({ status: 'personal_only', reason_codes: ['too_short_distance'], xp_award: null }), false);
    expect(personal.kind).toBe('personal_only');
    expect(personal).toHaveProperty('reason', expect.stringContaining('100 m'));
    const review = xpPanelState(localRun(), serverRun({ status: 'review', reason_codes: ['speed_anomaly'], xp_award: null }), false);
    expect(review.kind).toBe('review');
  });

  it('says scoring is paused when the server accepted the run but competition is off', () => {
    expect(xpPanelState(localRun(), serverRun({ scoring_state: 'pending', xp_award: null }), false)).toEqual({ kind: 'scoring_paused' });
  });

  it('keeps a locally ineligible run personal before any upload', () => {
    const run = localRun({ validation: { outcome: 'personal_only', reasons: ['too_short_distance'], coverage: 1, distanceCm: 7_000, activeMs: 40_000 }, provisionalXp: null });
    expect(xpPanelState(run, null, false).kind).toBe('personal_only');
  });

  it('asks for attention (with the stored reason) when sync failed permanently', () => {
    const state = xpPanelState(localRun({ syncState: 'needs_attention', syncError: 'idempotency_conflict' }), null, false);
    expect(state).toEqual({ kind: 'needs_attention', reason: 'This run conflicts with a copy already uploaded.' });
  });
});
