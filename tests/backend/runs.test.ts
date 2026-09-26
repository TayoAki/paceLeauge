import { randomUUID } from 'node:crypto';

import { encodeChunk } from '@/domain/route-codec';
import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { chunksFor, legsRun, runAt, sha256Hex, startArgs, uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const FRIDAY_7AM = Date.parse('2026-09-25T12:00:00Z');

async function scoreInvariants(user: TestUser) {
  const row = await db.one<{ lifetime: number; daily: number; ledger: number }>(
    `select coalesce((select lifetime_xp from private.profile_stats where user_id = $1), 0) as lifetime,
            coalesce((select sum(xp) from public.daily_scores where owner_id = $1), 0)::int as daily,
            coalesce((select sum(delta) from private.xp_ledger where owner_id = $1), 0)::int as ledger`,
    [user.id],
  );
  expect(row.lifetime).toBe(row.daily);
  expect(row.ledger).toBe(row.daily);
  return row.lifetime;
}

describe('run upload protocol', () => {
  it('accepts the 5.24 km / 31:28 fixture run and awards 52 + 25 = 77 XP', async () => {
    const runner = await db.createRunner('Friday Fixture');
    const { result } = await uploadRun(db, runner, runAt(FRIDAY_7AM, 5240, 1888), { title: 'Friday morning' });
    expect(result.run).toMatchObject({
      status: 'accepted',
      title: 'Friday morning',
      active_ms: 1_888_000,
      scoring_state: 'applied',
      reason_codes: [],
      xp_award: { total_xp: 77, distance_xp: 52, active_day_bonus: 25 },
    });
    expect(Math.abs(Number(result.run.distance_m) - 5240)).toBeLessThan(0.5);
    expect(result.lifetime_xp).toBe(77);
    expect(result.tier).toBe('Seed');
    expect(result.run.xp_award.days).toEqual([
      {
        competition_date: '2026-09-25',
        before: { distance_xp: 0, active_day_bonus: 0, xp: 0 },
        after: { distance_xp: 52, active_day_bonus: 25, xp: 77 },
        delta: 77,
      },
    ]);
    expect(await scoreInvariants(runner)).toBe(77);
  });

  it('returns the stored result for a repeated finalize (same run, same effects)', async () => {
    const runner = await db.createRunner('Repeat Finalize');
    const up = await uploadRun(db, runner, runAt(FRIDAY_7AM, 5240, 1888));
    const again = await db.rpc(runner, 'finalize_run', {
      p_run_id: up.runId,
      p_expected_version: 1,
      p_manifest: up.chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })),
    });
    expect(again).toEqual(up.result);
    const ledger = await db.sql('select * from private.xp_ledger where owner_id = $1', [runner.id]);
    expect(ledger).toHaveLength(1);
  });

  it('turns ten concurrent finalize requests into one accepted result and one set of score effects', async () => {
    const runner = await db.createRunner('Concurrent Ten');
    const up = await uploadRun(db, runner, runAt(FRIDAY_7AM, 5240, 1888), { finalize: false });
    const manifest = up.chunks.map((c) => ({ seq: c.seq, checksum: c.checksum }));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.rpc(runner, 'finalize_run', { p_run_id: up.runId, p_expected_version: 1, p_manifest: manifest })),
    );
    for (const r of results) expect(r.run.xp_award.total_xp).toBe(77);
    const ledger = await db.sql('select * from private.xp_ledger where owner_id = $1', [runner.id]);
    expect(ledger).toHaveLength(1);
    const daily = await db.sql('select * from public.daily_scores where owner_id = $1', [runner.id]);
    expect(daily).toHaveLength(1);
    expect(await scoreInvariants(runner)).toBe(77);
  });

  it('re-uses an upload for an identical retry and rejects a changed body with the same key', async () => {
    const runner = await db.createRunner('Idempotent Start');
    const run = runAt(FRIDAY_7AM, 3000, 900);
    const clientRunId = randomUUID();
    const first = await db.rpc(runner, 'start_run_upload', startArgs(run, clientRunId));
    const retry = await db.rpc(runner, 'start_run_upload', startArgs(run, clientRunId));
    expect(retry.run_id).toBe(first.run_id);
    const changed = { ...startArgs(run, clientRunId), p_client_distance_m: 9999 };
    await expectCode(db.rpc(runner, 'start_run_upload', changed), 'idempotency_conflict');
  });

  it('resumes a disconnected upload from the chunks the server already has', async () => {
    const runner = await db.createRunner('Resume Upload');
    const run = runAt(FRIDAY_7AM, 6000, 2400); // 2,401 points → 5 chunks
    const clientRunId = randomUUID();
    const start = await db.rpc(runner, 'start_run_upload', startArgs(run, clientRunId));
    await db.sql('update public.runs set first_received_at = to_timestamp($2::bigint / 1000.0) where id = $1', [start.run_id, run.endedAt + 5000]);
    const chunks = chunksFor(run);
    expect(chunks).toHaveLength(5);
    for (const c of chunks.slice(0, 2)) {
      await db.rpc(runner, 'put_route_chunk', { p_run_id: start.run_id, p_seq: c.seq, p_points: c.body, p_checksum: c.checksum });
    }
    const manifest = chunks.map((c) => ({ seq: c.seq, checksum: c.checksum }));
    const incomplete = await db.rpcError(runner, 'finalize_run', { p_run_id: start.run_id, p_expected_version: 1, p_manifest: manifest });
    expect(incomplete.code).toBe('upload_incomplete');
    expect(incomplete.detail).toBe('2,3,4');

    const resumed = await db.rpc(runner, 'start_run_upload', startArgs(run, clientRunId));
    expect(resumed.received_chunks).toEqual([0, 1]);
    for (const c of chunks.filter((x) => !resumed.received_chunks.includes(x.seq))) {
      await db.rpc(runner, 'put_route_chunk', { p_run_id: start.run_id, p_seq: c.seq, p_points: c.body, p_checksum: c.checksum });
    }
    const done = await db.rpc(runner, 'finalize_run', { p_run_id: start.run_id, p_expected_version: 1, p_manifest: manifest });
    expect(done.run.status).toBe('accepted');
    // Staged chunks are consolidated into the private route and removed.
    expect(await db.sql('select 1 from private.route_chunks where run_id = $1', [start.run_id])).toHaveLength(0);
    const route = await db.one<{ point_count: number }>('select point_count from private.run_routes where run_id = $1', [start.run_id]);
    expect(route.point_count).toBe(run.points.length);
  });

  it('accepts a retried chunk and rejects conflicting content at an existing sequence number', async () => {
    const runner = await db.createRunner('Chunk Rules');
    const run = runAt(FRIDAY_7AM, 2000, 700);
    const start = await db.rpc(runner, 'start_run_upload', startArgs(run, randomUUID()));
    const [c] = chunksFor(run);
    if (!c) throw new Error('no chunk');
    const put = (body: string, checksum = sha256Hex(body), seq = 0) =>
      db.rpc(runner, 'put_route_chunk', { p_run_id: start.run_id, p_seq: seq, p_points: body, p_checksum: checksum });
    await put(c.body);
    await expect(put(c.body)).resolves.toMatchObject({ status: 'stored' });
    const tampered = encodeChunk(run.points.slice(0, 500).map((p) => ({ ...p, lat: p.lat + 0.001 })));
    await expectCode(put(tampered), 'chunk_conflict');
    await expectCode(put(c.body, 'deadbeef'), 'checksum_mismatch');
    await expectCode(put(c.body, c.checksum, 7), 'invalid_chunk');
    await expectCode(put('x'.repeat(140_000)), 'chunk_too_large');
    await expectCode(put('[[1,2,3]]', sha256Hex('[[1,2,3]]'), 1), 'invalid_chunk');
    await expectCode(put('not json', sha256Hex('not json'), 1), 'invalid_chunk');
    await expectCode(put('[["a",1,2,3,4,0]]', sha256Hex('[["a",1,2,3,4,0]]'), 1), 'invalid_chunk');
  });

  it('rejects a manifest that does not match the stored chunks', async () => {
    const runner = await db.createRunner('Manifest Check');
    const up = await uploadRun(db, runner, runAt(FRIDAY_7AM, 2000, 700), { finalize: false });
    await expectCode(
      db.rpc(runner, 'finalize_run', { p_run_id: up.runId, p_expected_version: 1, p_manifest: [{ seq: 0, checksum: 'nope' }, { seq: 1, checksum: 'x' }] }),
      'manifest_mismatch',
    );
    await expectCode(db.rpc(runner, 'finalize_run', { p_run_id: up.runId, p_expected_version: 3, p_manifest: [] }), 'version_conflict');
  });

  it('validates start inputs', async () => {
    const runner = await db.createRunner('Start Inputs');
    const run = runAt(FRIDAY_7AM, 2000, 700);
    const base = startArgs(run, randomUUID());
    await expectCode(db.rpc(runner, 'start_run_upload', { ...base, p_expected_chunks: 9 }), 'invalid_input');
    await expectCode(db.rpc(runner, 'start_run_upload', { ...base, p_segments: [{ index: 0, startAt: 'x', endAt: 1 }] }), 'invalid_input');
    await expectCode(db.rpc(runner, 'start_run_upload', { ...base, p_expected_points: 50_001, p_expected_chunks: 101 }), 'invalid_input');
    await expectCode(db.rpc(runner, 'start_run_upload', { ...base, p_started_at_ms: 1000 }), 'invalid_input');
  });
});

describe('daily XP rules on the server', () => {
  it('implements the exact golden integer boundaries in SQL', async () => {
    const rows = await db.sql<{ x: number }>(
      `select (private.daily_xp(d, t)).xp as x from (values (524000::bigint, 1888000::bigint), (100000, 420000), (100000, 299999),
        (99999, 420000), (1000000, 300000), (999999, 300000), (660000, 2340000), (640000, 2342000)) v(d, t)`,
    );
    expect(rows.map((r) => r.x)).toEqual([77, 35, 10, 9, 125, 124, 91, 89]);
    const tiers = await db.one<{ t: string[] }>(
      `select array[private.tier_name(0), private.tier_name(499), private.tier_name(500), private.tier_name(897),
                    private.tier_name(1500), private.tier_name(4000), private.tier_name(10000)] as t`,
    );
    expect(tiers.t).toEqual(['Seed', 'Seed', 'Stride', 'Stride', 'Tempo', 'Surge', 'Elite']);
  });

  it('combines two 2,620 m runs on one day into 77 XP, not 102', async () => {
    const runner = await db.createRunner('Split Day');
    const first = await uploadRun(db, runner, runAt(FRIDAY_7AM, 2620, 944));
    expect(first.result.run.xp_award.total_xp).toBe(51);
    const second = await uploadRun(db, runner, runAt(FRIDAY_7AM + 3 * 3600_000, 2620, 944));
    expect(second.result.run.xp_award).toMatchObject({ total_xp: 26, distance_xp: 26, active_day_bonus: 0 });
    expect(second.result.lifetime_xp).toBe(77);
    expect(await scoreInvariants(runner)).toBe(77);
  });

  it('adds ~600 m / 240 s and ~400 m / 180 s into a 35 XP day', async () => {
    const runner = await db.createRunner('Tiny Runs');
    await uploadRun(db, runner, runAt(FRIDAY_7AM, 605, 240));
    const r = await uploadRun(db, runner, runAt(FRIDAY_7AM + 3600_000, 405, 180));
    expect(r.result.lifetime_xp).toBe(35);
  });

  it('caps a day at 125 XP however the distance is split', async () => {
    const runner = await db.createRunner('Capped Day');
    for (let i = 0; i < 3; i += 1) {
      await uploadRun(db, runner, runAt(FRIDAY_7AM + i * 2 * 3600_000, 4500, 1500));
    }
    expect(await scoreInvariants(runner)).toBe(125);
  });

  it('keeps short runs as personal history without XP', async () => {
    const runner = await db.createRunner('Short Stuff');
    const { result } = await uploadRun(db, runner, runAt(FRIDAY_7AM, 80, 90));
    expect(result.run).toMatchObject({ status: 'personal_only', reason_codes: ['too_short_distance'], scoring_state: 'none', xp_award: null });
    expect(await scoreInvariants(runner)).toBe(0);
  });

  it('holds an implausibly fast run and a late upload for review', async () => {
    const runner = await db.createRunner('Review Cases');
    const fast = await uploadRun(db, runner, runAt(FRIDAY_7AM, 4000, 500));
    expect(fast.result.run).toMatchObject({ status: 'review', reason_codes: ['speed_anomaly'] });
    const late = await uploadRun(db, runner, runAt(FRIDAY_7AM, 3050, 900), { receivedAfterMs: 73 * 3600_000 });
    expect(late.result.run).toMatchObject({ status: 'review', reason_codes: ['late_upload'] });
    expect(await scoreInvariants(runner)).toBe(0);

    // A documented operator decision credits the late run.
    const resolved = await db.one<{ run: any }>(
      `select private.resolve_run_review($1, 'accept', 'Verified with the runner: offline for 4 days', 'ops-test') as run`,
      [late.runId],
    );
    expect(resolved.run).toMatchObject({ status: 'accepted', scoring_state: 'applied' });
    expect(await scoreInvariants(runner)).toBe(55);
    const audit = await db.sql(`select * from private.audit_log where target = $1`, [late.runId]);
    expect(audit).toHaveLength(1);
  });

  it('allocates a run across local midnight to both competition days', async () => {
    const runner = await db.createRunner('Midnight Runner');
    const { result } = await uploadRun(db, runner, runAt(Date.parse('2026-09-23T04:50:00Z'), 3700, 1200));
    const days = result.run.xp_award.days.map((d: any) => [d.competition_date, d.after.xp]);
    expect(days).toEqual([
      ['2026-09-22', 18 + 25],
      ['2026-09-23', 18 + 25],
    ]);
  });

  it('ignores the phone time zone: allocation uses the competition calendar only', async () => {
    const runner = await db.createRunner('Traveller');
    // 23:30 CDT Tuesday is already Wednesday in UTC and in Europe.
    const { result } = await uploadRun(db, runner, runAt(Date.parse('2026-09-23T04:30:00Z'), 1500, 600));
    expect(result.run.xp_award.days.map((d: any) => d.competition_date)).toEqual(['2026-09-22']);
  });

  it('defers scoring while competition is disabled and applies it when re-enabled', async () => {
    const runner = await db.createRunner('Paused Scoring');
    await db.sql(`select private.set_flag('competition_enabled', false, 'pause for test', 'jest')`);
    try {
      const { result, runId } = await uploadRun(db, runner, runAt(FRIDAY_7AM, 5240, 1888));
      expect(result.run).toMatchObject({ status: 'accepted', scoring_state: 'pending', xp_award: null });
      expect(result.competition_enabled).toBe(false);
      await db.sql(`select private.set_flag('competition_enabled', true, 'resume for test', 'jest')`);
      const run = await db.rpc(runner, 'get_my_run', { p_run_id: runId });
      expect(run).toMatchObject({ scoring_state: 'applied', xp_award: { total_xp: 77 } });
    } finally {
      await db.sql(`select private.set_flag('competition_enabled', true, 'restore', 'jest')`);
    }
  });

  it('serializes finalizes from two devices on the same day (one day bonus)', async () => {
    const runner = await db.createRunner('Two Devices');
    const a = await uploadRun(db, runner, runAt(FRIDAY_7AM, 2620, 944), { finalize: false });
    const b = await uploadRun(db, runner, runAt(FRIDAY_7AM + 3600_000, 2620, 944), { finalize: false });
    const fin = (u: typeof a) =>
      db.rpc(runner, 'finalize_run', { p_run_id: u.runId, p_expected_version: 1, p_manifest: u.chunks.map((c) => ({ seq: c.seq, checksum: c.checksum })) });
    const [ra, rb] = await Promise.all([fin(a), fin(b)]);
    expect(ra.run.xp_award.total_xp + rb.run.xp_award.total_xp).toBe(77);
    expect(ra.run.xp_award.active_day_bonus + rb.run.xp_award.active_day_bonus).toBe(25);
    expect(await scoreInvariants(runner)).toBe(77);
  });
});

describe('history, rename and delete', () => {
  it('pages through history newest first with a keyset cursor', async () => {
    const runner = await db.createRunner('Pager');
    for (let i = 0; i < 5; i += 1) {
      await uploadRun(db, runner, runAt(FRIDAY_7AM - i * 86_400_000, 1500, 600), { title: `Run ${i}` });
    }
    const first = await db.rpc(runner, 'list_my_runs', { p_limit: 2 });
    expect(first.runs.map((r: any) => r.title)).toEqual(['Run 0', 'Run 1']);
    const second = await db.rpc(runner, 'list_my_runs', {
      p_limit: 2,
      p_before_started_at_ms: first.next_cursor.before_started_at_ms,
      p_before_id: first.next_cursor.before_id,
    });
    expect(second.runs.map((r: any) => r.title)).toEqual(['Run 2', 'Run 3']);
    const third = await db.rpc(runner, 'list_my_runs', {
      p_limit: 2,
      p_before_started_at_ms: second.next_cursor.before_started_at_ms,
      p_before_id: second.next_cursor.before_id,
    });
    expect(third.runs.map((r: any) => r.title)).toEqual(['Run 4']);
    expect(third.next_cursor).toBeNull();
  });

  it('renames the title only, with optimistic versioning', async () => {
    const runner = await db.createRunner('Renamer');
    const { runId, result } = await uploadRun(db, runner, runAt(FRIDAY_7AM, 3000, 900));
    const renamed = await db.rpc(runner, 'rename_run', { p_run_id: runId, p_title: '  Lakefront   loop ', p_expected_version: result.run.version });
    expect(renamed).toMatchObject({ title: 'Lakefront loop', version: result.run.version + 1, distance_m: result.run.distance_m });
    await expectCode(db.rpc(runner, 'rename_run', { p_run_id: runId, p_title: 'Again', p_expected_version: result.run.version }), 'version_conflict');
    await expectCode(db.rpc(runner, 'rename_run', { p_run_id: runId, p_title: '' }), 'invalid_input');
  });

  it('deletes a run, reverses its XP, leaves a tombstone and stays idempotent', async () => {
    const runner = await db.createRunner('Deleter');
    const keep = await uploadRun(db, runner, runAt(FRIDAY_7AM - 86_400_000, 5050, 1800));
    const friday = await uploadRun(db, runner, runAt(FRIDAY_7AM, 5240, 1888));
    expect(friday.result.lifetime_xp).toBe(75 + 77);

    const deleted = await db.rpc(runner, 'delete_run', { p_run_id: friday.runId });
    expect(deleted).toMatchObject({ deleted: true, lifetime_xp: 75 });
    expect(deleted.xp_changes[0]).toMatchObject({ competition_date: '2026-09-25', delta: -77 });
    expect(await scoreInvariants(runner)).toBe(75);

    await expect(db.rpc(runner, 'delete_run', { p_run_id: friday.runId })).resolves.toMatchObject({ deleted: true });
    await expectCode(db.rpc(runner, 'get_my_run', { p_run_id: friday.runId }), 'not_found');
    await expectCode(db.rpc(runner, 'get_my_run_route', { p_run_id: friday.runId }), 'not_found');
    const history = await db.rpc(runner, 'list_my_runs', {});
    expect(history.runs.map((r: any) => r.id)).toEqual([keep.runId]);
    expect(await db.sql('select 1 from private.run_routes where run_id = $1', [friday.runId])).toHaveLength(0);

    // A late retry of the same upload cannot resurrect the deleted run.
    const replay = await db.rpc(runner, 'start_run_upload', startArgs(runAt(FRIDAY_7AM, 5240, 1888), friday.clientRunId));
    expect(replay.status).toBe('deleted');
    const tombstone = await db.one<{ title: string; segments: unknown }>('select title, segments from public.runs where id = $1', [friday.runId]);
    expect(tombstone).toEqual({ title: '', segments: [] });
  });

  it('returns the private route only to its owner', async () => {
    const owner = await db.createRunner('Route Owner');
    const other = await db.createRunner('Route Other');
    const { runId } = await uploadRun(db, owner, legsRun(FRIDAY_7AM, [
      { kind: 'run', durationS: 300, speedMps: 3 },
      { kind: 'pause', durationS: 60 },
      { kind: 'run', durationS: 300, speedMps: 3 },
    ]));
    const route = await db.rpc(owner, 'get_my_run_route', { p_run_id: runId });
    expect(route.segments).toHaveLength(2);
    expect(route.points).toHaveLength(602);
    await expectCode(db.rpc(other, 'get_my_run_route', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(other, 'get_my_run', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(other, 'delete_run', { p_run_id: runId }), 'not_found');
    await expectCode(db.rpc(other, 'rename_run', { p_run_id: runId, p_title: 'mine now' }), 'not_found');
  });
});

describe('progress summaries', () => {
  it('summarizes the fixture week: 91 + 89 + 77 = 257 across Mon/Wed/Fri', async () => {
    const runner = await db.createRunner('Fixture Week');
    // +1 m keeps the exact 100 m boundaries stable under 1e-7° coordinate normalization.
    await uploadRun(db, runner, steadyRun(Date.parse('2026-09-21T12:00:00Z'), 6601, 2340));
    await uploadRun(db, runner, steadyRun(Date.parse('2026-09-23T12:00:00Z'), 6401, 2342));
    await uploadRun(db, runner, steadyRun(Date.parse('2026-09-25T12:00:00Z'), 5240, 1888));
    const week = await db.one<{ w: any }>(`select private.week_summary($1, '2026-09-21') as w`, [runner.id]);
    expect(week.w).toMatchObject({ week_start: '2026-09-21', active_days: 3, weekly_xp: 257, goal_days: 3 });
    expect(week.w.days.map((d: any) => d.xp)).toEqual([91, 0, 89, 0, 77, 0, 0]);
    expect(await scoreInvariants(runner)).toBe(257);
  });
});
