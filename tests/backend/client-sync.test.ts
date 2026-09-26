import { createHash, randomUUID } from 'node:crypto';

import { ApiError } from '@/api/errors';
import { createPaceApi } from '@/api/pace-api';
import { Journal, type RawSample } from '@/db/journal';
import { steadyRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';
import { RecorderService } from '@/features/recording/recorder-service';
import type { LocationDriver } from '@/features/recording/types';
import { createRunActions } from '@/features/sync/run-actions';
import { serverRunOf, SyncEngine } from '@/features/sync/sync-engine';
import type { Clock } from '@/lib/clock';

import { NodeSqliteDatabase } from '../support/node-sqlite';
import { sqlTransport } from '../support/sql-transport';
import { TestDb, type TestUser } from './helpers/db';

/**
 * End-to-end client path against the real backend: the recorder saves a run to the local
 * journal, the sync engine uploads it through the real PaceApi to the real SQL functions,
 * and the server's verdict flows back into the journal.
 */

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const sha256 = async (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

class ManualClock implements Clock {
  constructor(public wall: number) {}
  now = () => this.wall;
  monotonic = () => this.wall;
}

const idleDriver: LocationDriver = {
  supportsBackground: true,
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: async () => true,
};

async function device(user: TestUser, faults: Parameters<typeof sqlTransport>[2] = {}) {
  const clock = new ManualClock(Date.parse('2026-09-25T12:00:00Z'));
  const journal = await Journal.open(new NodeSqliteDatabase(), clock);
  const recorder = new RecorderService({ journal, location: idleDriver, clock, newRunId: randomUUID });
  const api = createPaceApi(sqlTransport(db, user, faults));
  const engine = new SyncEngine({ journal, api, sha256, clock, random: () => 0.5, environment: 'test' });
  return { clock, journal, recorder, api, engine, actions: createRunActions(journal, engine) };
}

async function recordRun(d: Awaited<ReturnType<typeof device>>, points: TrackPoint[]) {
  d.clock.wall = (points[0] as TrackPoint).t;
  await d.recorder.start();
  for (let i = 0; i < points.length; i += 25) {
    const slice = points.slice(i, i + 25);
    d.clock.wall = (slice[slice.length - 1] as TrackPoint).t;
    await d.recorder.ingest(slice.map((p): RawSample => ({ timestamp: p.t, latitude: p.lat, longitude: p.lon, accuracy: p.accuracyM })));
  }
  await d.recorder.pause();
  return d.recorder.finish();
}

describe('client ↔ server sync', () => {
  it('records offline, then uploads and receives the accepted +77 XP', async () => {
    const runner = await db.createRunner('Sync Fixture');
    let offline = true;
    const d = await device(runner, { failNext: (fn) => (offline && fn === 'finalize_run' ? new ApiError('network', 0) : null) });
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-25T12:00:00Z'), 5240, 1888).points);
    expect(saved).toMatchObject({ syncState: 'pending', provisionalXp: { totalXp: 77 } });

    // The connection drops before finalize: the run stays saved and pending.
    await d.engine.run();
    let local = await d.journal.getSavedRun(saved.runId);
    expect(local).toMatchObject({ syncState: 'pending', syncError: 'network' });

    offline = false;
    d.clock.wall += 60_000;
    const status = await d.engine.run();
    expect(status).toMatchObject({ pending: 0, needsAttention: 0 });
    local = await d.journal.getSavedRun(saved.runId);
    const server = local ? serverRunOf(local) : null;
    expect(local?.syncState).toBe('synced');
    expect(server).toMatchObject({ status: 'accepted', xp_award: { total_xp: 77, distance_xp: 52, active_day_bonus: 25 } });
    expect((await d.api.getMe()).lifetime_xp).toBe(77);
    expect(await d.journal.getKv('me.lifetime')).toMatchObject({ value: { lifetimeXp: 77 } });
  });

  it('resumes an upload interrupted between chunks and credits it exactly once', async () => {
    const runner = await db.createRunner('Sync Resume');
    let chunkCalls = 0;
    const d = await device(runner, {
      failNext: (fn) => {
        if (fn === 'put_route_chunk' && ++chunkCalls === 3) return new ApiError('network', 0);
        return null;
      },
    });
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-24T12:00:00Z'), 6000, 2400).points);
    await d.engine.run();
    expect((await d.journal.openOutbox())[0]).toMatchObject({ state: 'pending', attempts: 1, lastError: 'network' });
    d.clock.wall += 60_000;
    await d.engine.run();
    expect((await d.journal.getSavedRun(saved.runId))?.syncState).toBe('synced');
    const ledger = await db.sql('select * from private.xp_ledger where owner_id = $1', [runner.id]);
    expect(ledger).toHaveLength(1);
  });

  it('waits for authentication instead of failing when the session expires', async () => {
    const runner = await db.createRunner('Sync Auth');
    let expired = true;
    const d = await device(runner, { failNext: () => (expired ? new ApiError('auth_expired', 401) : null) });
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-23T12:00:00Z'), 3050, 900).points);
    const blocked = await d.engine.run();
    expect(blocked).toMatchObject({ authBlocked: true, pending: 1, needsAttention: 0 });
    expect((await d.journal.openOutbox())[0]?.attempts).toBe(0);
    expired = false;
    await d.engine.resumeAfterAuth();
    expect((await d.journal.getSavedRun(saved.runId))?.syncState).toBe('synced');
  });

  it('marks an item for attention on a permanent error and keeps the run locally', async () => {
    const runner = await db.createRunner('Sync Attention');
    const d = await device(runner, { failNext: (fn) => (fn === 'start_run_upload' ? new ApiError('invalid_input', 400) : null) });
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-23T12:00:00Z'), 2000, 700).points);
    const status = await d.engine.run();
    expect(status.needsAttention).toBe(1);
    expect(await d.journal.getSavedRun(saved.runId)).toMatchObject({ syncState: 'needs_attention', syncError: 'invalid_input' });
    expect(await d.journal.getRunPoints(saved.runId)).toHaveLength(saved.pointCount);
  });

  it('keeps a personal-only run as history without XP', async () => {
    const runner = await db.createRunner('Sync Short');
    const d = await device(runner);
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-22T12:00:00Z'), 80, 90).points);
    expect(saved.validation.reasons).toEqual(['too_short_distance']);
    expect(saved.provisionalXp).toBeNull();
    await d.engine.run();
    const local = await d.journal.getSavedRun(saved.runId);
    expect(local && serverRunOf(local)).toMatchObject({ status: 'personal_only', reason_codes: ['too_short_distance'] });
  });

  it('renames before upload by rewriting the unsent request, and after upload through the outbox', async () => {
    const runner = await db.createRunner('Sync Rename');
    const d = await device(runner);
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-22T12:00:00Z'), 2000, 700).points);
    await d.actions.rename(saved.runId, 'Lakefront loop');
    await d.engine.run();
    let local = await d.journal.getSavedRun(saved.runId);
    expect(local && serverRunOf(local)?.title).toBe('Lakefront loop');
    await d.actions.rename(saved.runId, '  Easy   shakeout ');
    await d.engine.run();
    local = await d.journal.getSavedRun(saved.runId);
    expect(local?.title).toBe('Easy shakeout');
    expect((await d.api.getMyRun(local?.serverRunId ?? '')).title).toBe('Easy shakeout');
  });

  it('deletes a synced run everywhere and reverses its XP', async () => {
    const runner = await db.createRunner('Sync Delete');
    const d = await device(runner);
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-21T12:00:00Z'), 5240, 1888).points);
    await d.engine.run();
    expect((await d.api.getMe()).lifetime_xp).toBe(77);
    await d.actions.remove(saved.runId);
    expect(await d.journal.listSavedRuns()).toEqual([]);
    await d.engine.run();
    expect(await d.journal.getSavedRun(saved.runId)).toBeNull();
    expect((await d.api.getMe()).lifetime_xp).toBe(0);
    expect((await d.api.listMyRuns()).runs).toEqual([]);
  });

  it('deletes a run that never reached the server without any network call', async () => {
    const runner = await db.createRunner('Sync Delete Local');
    let calls = 0;
    const d = await device(runner, {
      failNext: () => {
        calls += 1;
        return new ApiError('network', 0);
      },
    });
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-21T12:00:00Z'), 2000, 700).points);
    await d.actions.remove(saved.runId);
    await d.engine.run();
    expect(await d.journal.getSavedRun(saved.runId)).toBeNull();
    expect(await d.journal.openOutbox()).toEqual([]);
    expect(calls).toBe(0);
  });

  it('isolates accounts: another account cannot see or claim this run', async () => {
    const owner = await db.createRunner('Sync Owner');
    const intruder = await db.createRunner('Sync Intruder');
    const d = await device(owner);
    const saved = await recordRun(d, steadyRun(Date.parse('2026-09-21T12:00:00Z'), 2000, 700).points);
    await d.engine.run();
    const serverId = (await d.journal.getSavedRun(saved.runId))?.serverRunId ?? '';
    const intruderApi = createPaceApi(sqlTransport(db, intruder));
    await expect(intruderApi.getMyRun(serverId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(intruderApi.getMyRunRoute(serverId)).rejects.toMatchObject({ code: 'not_found' });
    expect((await intruderApi.listMyRuns()).runs).toEqual([]);
  });
});
