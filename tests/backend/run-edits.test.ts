import { addDays, competitionDate, startOfDay } from '@/domain/calendar';
import { buildSyntheticRun, steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const MIN = 60_000;
// Late morning ten competition days ago, so an hour-long run never crosses midnight.
const base = startOfDay(addDays(competitionDate(Date.now()), -10)) + 10 * 60 * MIN;

async function lifetimeXp(user: TestUser): Promise<number> {
  return (await db.rpc(user, 'get_me')).lifetime_xp;
}

async function run(user: TestUser, id: string) {
  return db.rpc(user, 'get_my_run', { p_run_id: id });
}

describe('trimming and cutting', () => {
  it('trims the end of a run, lowers distance and XP, and can be undone', async () => {
    const runner = await db.createRunner('Trim Tia');
    // 12 km in 60 minutes; the runner meant to stop after 30.
    const uploaded = await uploadRun(db, runner, steadyRun(base, 12_000, 3_600));
    const before = await run(runner, uploaded.runId);
    const xpBefore = await lifetimeXp(runner);
    expect(xpBefore).toBe(125);

    const edited = await db.rpc(runner, 'edit_run', {
      p_run_id: uploaded.runId,
      p_expected_version: before.version,
      p_keep_to_ms: base + 30 * MIN,
    });
    expect(edited.run.status).toBe('accepted');
    expect(edited.run.distance_m).toBeGreaterThan(5_900);
    expect(edited.run.distance_m).toBeLessThan(6_100);
    expect(edited.run.edited_at_ms).toEqual(expect.any(Number));
    expect(edited.can_undo).toBe(true);
    expect(edited.lifetime_xp).toBe(85); // 60 distance XP + 25 active-day bonus

    const records = await db.rpc(runner, 'get_personal_records');
    expect(records.records.find((r: { effort: string }) => r.effort === '10k').best).toBeNull();

    const undone = await db.rpc(runner, 'undo_run_edits', { p_run_id: uploaded.runId });
    expect(undone.run.distance_m).toBeGreaterThan(11_900);
    expect(undone.lifetime_xp).toBe(125);
    expect(undone.can_undo).toBe(false);
  });

  it('cuts out a stretch in the middle, splitting it into two segments', async () => {
    const runner = await db.createRunner('Cut Cy');
    const uploaded = await uploadRun(db, runner, steadyRun(base, 6_000, 1_800));
    const edited = await db.rpc(runner, 'edit_run', {
      p_run_id: uploaded.runId,
      p_expected_version: uploaded.result.run.version,
      p_cut_ranges: [{ from_ms: base + 10 * MIN, to_ms: base + 20 * MIN }],
    });
    expect(edited.run.distance_m).toBeGreaterThan(3_900);
    expect(edited.run.distance_m).toBeLessThan(4_100);
    expect(edited.run.active_ms).toBe(20 * MIN);
  });

  it('refuses stale versions, empty results, bad ranges and other runners', async () => {
    const runner = await db.createRunner('Guard Gwen');
    const uploaded = await uploadRun(db, runner, steadyRun(base, 5_000, 1_500));
    await expectCode(db.rpc(runner, 'edit_run', { p_run_id: uploaded.runId, p_expected_version: 999, p_keep_to_ms: base + 10 * MIN }), 'version_conflict');
    await expectCode(
      db.rpc(runner, 'edit_run', { p_run_id: uploaded.runId, p_expected_version: null, p_keep_from_ms: base - MIN }),
      'invalid_input',
    );
    await expectCode(
      db.rpc(runner, 'edit_run', {
        p_run_id: uploaded.runId,
        p_expected_version: null,
        p_cut_ranges: [{ from_ms: base, to_ms: base + 25 * MIN }],
      }),
      'invalid_input',
    );
    const other = await db.createRunner('Other Olga');
    await expectCode(db.rpc(other, 'edit_run', { p_run_id: uploaded.runId, p_expected_version: null, p_activity_type: 'walk' }), 'not_found');
  });
});

describe('activity type', () => {
  it('turning a run into a walk removes its XP; turning it back goes to review', async () => {
    const runner = await db.createRunner('Walk Wes');
    const uploaded = await uploadRun(db, runner, steadyRun(base, 4_000, 1_800));
    expect(await lifetimeXp(runner)).toBe(65);
    const walk = await db.rpc(runner, 'edit_run', { p_run_id: uploaded.runId, p_expected_version: null, p_activity_type: 'walk' });
    expect(walk.run).toMatchObject({ activity_type: 'walk', scoring_state: 'none' });
    expect(walk.lifetime_xp).toBe(0);
    const back = await db.rpc(runner, 'edit_run', { p_run_id: uploaded.runId, p_expected_version: null, p_activity_type: 'run' });
    expect(back.run.status).toBe('review');
    expect(back.run.reason_codes).toContain('edited');
    expect(back.lifetime_xp).toBe(0);
  });
});

describe('editing never promotes a run', () => {
  it('holds a trimmed run for review when the original was not accepted', async () => {
    const runner = await db.createRunner('Patchy Pat');
    // The first 20 minutes have no GPS at all: low coverage, personal only.
    const patchy = buildSyntheticRun({
      startAt: base,
      legs: [{ kind: 'run', durationS: 1_800, speedMps: 3.3, dropouts: [[0, 1_200]] }],
    });
    const uploaded = await uploadRun(db, runner, patchy);
    expect(uploaded.result.run.status).toBe('personal_only');
    const edited = await db.rpc(runner, 'edit_run', {
      p_run_id: uploaded.runId,
      p_expected_version: null,
      p_keep_from_ms: base + 20 * MIN + 1_000,
    });
    expect(edited.run.status).toBe('review');
    expect(edited.run.reason_codes).toEqual(['edited']);
    expect(edited.lifetime_xp).toBe(0);
  });
});

describe('merging', () => {
  it('joins two consecutive runs without adding XP for the gap, and removes the second', async () => {
    const runner = await db.createRunner('Merge Mia');
    const first = await uploadRun(db, runner, steadyRun(base, 3_000, 900), { title: 'Out' });
    const second = await uploadRun(db, runner, steadyRun(base + 25 * MIN, 3_000, 900), { title: 'Back' });
    const xpBefore = await lifetimeXp(runner);

    const merged = await db.rpc(runner, 'merge_runs', { p_first_run_id: first.runId, p_second_run_id: second.runId });
    expect(merged.removed_run_id).toBe(second.runId);
    expect(merged.run.title).toBe('Out');
    expect(merged.run.status).toBe('accepted');
    expect(merged.run.distance_m).toBeGreaterThan(5_900);
    expect(merged.run.distance_m).toBeLessThan(6_100);
    expect(merged.lifetime_xp).toBe(xpBefore);
    expect(merged.can_undo).toBe(false);

    const history = await db.rpc(runner, 'list_my_runs');
    expect(history.runs.map((r: { id: string }) => r.id)).toEqual([first.runId]);
    await expectCode(db.rpc(runner, 'undo_run_edits', { p_run_id: first.runId }), 'cannot_undo_merge');
  });

  it('holds a merge for review when one part was not accepted', async () => {
    const runner = await db.createRunner('Short Shu');
    const first = await uploadRun(db, runner, steadyRun(base, 3_000, 900));
    const tiny = await uploadRun(db, runner, steadyRun(base + 20 * MIN, 150, 40)); // too short: personal only
    expect(tiny.result.run.status).toBe('personal_only');
    const merged = await db.rpc(runner, 'merge_runs', { p_first_run_id: first.runId, p_second_run_id: tiny.runId });
    expect(merged.run.status).toBe('review');
  });

  it('refuses runs out of order, too far apart, or of different types', async () => {
    const runner = await db.createRunner('Order Oma');
    const a = await uploadRun(db, runner, steadyRun(base, 3_000, 900));
    const b = await uploadRun(db, runner, steadyRun(base + 8 * 60 * MIN, 3_000, 900));
    await expectCode(db.rpc(runner, 'merge_runs', { p_first_run_id: b.runId, p_second_run_id: a.runId }), 'invalid_input');
    await expectCode(db.rpc(runner, 'merge_runs', { p_first_run_id: a.runId, p_second_run_id: b.runId }), 'invalid_input');
  });
});
