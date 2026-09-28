import { ApiError } from '@/api/errors';
import { createPaceApi } from '@/api/pace-api';
import { fromCompact } from '@/domain/route-codec';
import { findStops, previewEdit } from '@/domain/run-fix';
import { buildSyntheticRun, steadyRun } from '@/domain/synthetic';

import { sqlTransport } from '../support/sql-transport';
import { TestDb } from './helpers/db';
import { uploadRun } from './helpers/runs';

/**
 * The app's Phase 1 client methods against the real SQL functions: every response must pass the
 * client's runtime schemas, so a field renamed on one side fails here rather than on a phone.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const DAY = 86_400_000;
const MIN = 60_000;

describe('Phase 1 client methods', () => {
  it('reads and writes shoes, notes, records, streaks, badges, stats and the run calendar', async () => {
    const me = await db.createRunner('Client Cam');
    const api = createPaceApi(sqlTransport(db, me));

    const shoe = await api.saveShoe({ name: 'Road racer', limitKm: 600, isDefault: true });
    expect(shoe).toMatchObject({ name: 'Road racer', limit_km: 600, is_default: true, retired: false, runs: 0 });

    const start = Date.now() - 5 * DAY;
    const uploaded = await uploadRun(db, me, steadyRun(start, 10_500, 3_300));
    const withNotes = await api.updateRunDetails(uploaded.runId, { notes: 'Tempo, felt strong' });
    expect(withNotes).toMatchObject({ notes: 'Tempo, felt strong', shoe_id: shoe.id, activity_type: 'run' });
    expect(await api.updateRunDetails(uploaded.runId, { shoeId: null })).toMatchObject({ shoe_id: null, notes: 'Tempo, felt strong' });
    expect(await api.updateRunDetails(uploaded.runId, { notes: '' })).toMatchObject({ notes: null });

    const [listed] = await api.listShoes();
    expect(listed).toMatchObject({ id: shoe.id, runs: 0 });
    expect(await api.retireShoe(shoe.id, true)).toMatchObject({ retired: true, is_default: false });
    await api.deleteShoe(shoe.id);
    expect(await api.listShoes()).toEqual([]);

    const records = await api.getPersonalRecords();
    expect(records.records.map((r) => r.effort)).toEqual(['1k', '1mi', '5k', '10k', 'half', 'marathon']);
    expect(records.records.find((r) => r.effort === '10k')?.best).toMatchObject({ run_id: uploaded.runId });
    expect(records.longest_run).toMatchObject({ run_id: uploaded.runId });
    expect(await api.getRecordHistory('5k')).toHaveLength(1);
    const efforts = await api.getRunEfforts(uploaded.runId);
    expect(efforts).toMatchObject({ counts_for_records: true });
    expect(efforts.efforts.every((e) => e.rank === 1 && e.record_when_run)).toBe(true);

    const streak = await api.getStreak();
    expect(streak).toMatchObject({ current_weeks: expect.any(Number), this_week: { goal_days: expect.anything() } });
    const badges = await api.getBadges();
    expect(badges.earned.map((b) => b.badge)).toEqual(expect.arrayContaining(['first_run', 'first_5k', 'first_10k']));
    expect(badges.progress).toMatchObject({ accepted_runs: 1 });

    // Stats group by the competition calendar, so take a day either side of the run.
    const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const stats = await api.getStats({ from: isoDay(start - DAY), to: isoDay(start + DAY), bucket: 'week' });
    expect(stats.total).toMatchObject({ runs: 1, days: 1 });
    expect(stats.total.distance_m).toBeCloseTo(10_500, -1);

    const calendar = await api.listMyRunsBetween(start - DAY, start + DAY);
    expect(calendar.map((r) => r.id)).toEqual([uploaded.runId]);
    expect(await api.listMyRunsBetween(start - DAY, start + DAY, 'walk')).toEqual([]);
  });

  it('fixes a run: trim, change type, merge and undo', async () => {
    const me = await db.createRunner('Client Fix');
    const api = createPaceApi(sqlTransport(db, me));
    const start = Date.now() - 4 * DAY;
    const first = await uploadRun(db, me, steadyRun(start, 6_000, 1_800));
    const run = await api.getMyRun(first.runId);

    const trimmed = await api.editRun(first.runId, run.version, { keepToMs: start + 20 * MIN });
    expect(trimmed.run.distance_m).toBeLessThan(run.distance_m);
    expect(trimmed.can_undo).toBe(true);
    expect(trimmed.lifetime_xp).toBeLessThan((await api.getMe()).lifetime_xp + 1);

    const walk = await api.editRun(first.runId, trimmed.run.version, { activityType: 'walk' });
    expect(walk.run).toMatchObject({ activity_type: 'walk', scoring_state: 'none' });

    const restored = await api.undoRunEdits(first.runId, walk.run.version);
    expect(restored.run).toMatchObject({ activity_type: 'run', distance_m: run.distance_m });
    expect(restored.can_undo).toBe(false);

    const later = start + 40 * MIN;
    const second = await uploadRun(db, me, buildSyntheticRun({ startAt: later, legs: [{ kind: 'run', durationS: 900, speedMps: 3 }] }));
    const merged = await api.mergeRuns(first.runId, second.runId);
    expect(merged.removed_run_id).toBe(second.runId);
    expect(merged.run.distance_m).toBeCloseTo(run.distance_m + 2_700, -1);

    await expect(api.undoRunEdits(first.runId, merged.run.version)).rejects.toMatchObject({ code: 'cannot_undo_merge' });
  });

  it('previews a fix on the phone exactly as the server scores it', async () => {
    const me = await db.createRunner('Client Preview');
    const api = createPaceApi(sqlTransport(db, me));
    const start = Date.now() - 3 * DAY;
    const built = buildSyntheticRun({
      startAt: start,
      legs: [
        { kind: 'run', durationS: 900, speedMps: 3 },
        { kind: 'run', durationS: 180, speedMps: 0 },
        { kind: 'run', durationS: 900, speedMps: 3.2 },
      ],
    });
    // One segment with a three-minute stop in it, as a runner who forgot to pause would record.
    const oneSegment = { ...built, segments: [{ index: 0, startAt: built.startedAt, endAt: built.endedAt }], points: built.points.map((p) => ({ ...p, segmentIndex: 0 })) };
    const uploaded = await uploadRun(db, me, oneSegment);
    const run = await api.getMyRun(uploaded.runId);
    const route = await api.getMyRunRoute(uploaded.runId);
    const points = route.points.map(fromCompact);

    const stops = findStops(route.segments, points);
    expect(stops).toHaveLength(1);
    const edit = { keepFromMs: start + 30_000, cutRanges: stops.map((s) => ({ fromMs: s.fromMs, toMs: s.toMs })) };
    const preview = previewEdit(route.segments, points, edit);
    const saved = await api.editRun(uploaded.runId, run.version, edit);
    expect(saved.run.distance_m).toBeCloseTo(preview!.distanceCm / 100, 2);
    expect(saved.run.active_ms).toBe(preview!.activeMs);
  });

  it('cheers a league-mate', async () => {
    const owner = await db.createRunner('Client Olu');
    const mate = await db.createRunner('Client Mia');
    const ownerApi = createPaceApi(sqlTransport(db, owner));
    const mateApi = createPaceApi(sqlTransport(db, mate));
    await ownerApi.createLeague('Client crew');
    const invite = await ownerApi.createLeagueInvite();
    await mateApi.joinLeague(invite.code);
    const league = await mateApi.getMyLeague();
    const ownerMember = league.standings?.find((s) => s.alias === 'Client Olu');
    const cheers = await mateApi.cheerMember(ownerMember!.member_id);
    expect(cheers.mine).toEqual([ownerMember!.member_id]);
    expect((await ownerApi.getLeagueCheers()).cheered_me).toEqual(['Client Mia']);
    await expect(ownerApi.cheerMember(ownerMember!.member_id)).rejects.toBeInstanceOf(ApiError);
  });
});
