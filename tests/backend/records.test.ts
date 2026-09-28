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

const DAY = 86_400_000;
const base = Date.now() - 20 * DAY;

type Records = { records: { effort: string; best: { run_id: string; elapsed_ms: number } | null; efforts: number }[]; longest_run: { run_id: string; distance_m: number } | null };

function bestOf(records: Records, effort: string) {
  return records.records.find((r) => r.effort === effort)?.best ?? null;
}

describe('personal records', () => {
  let runner: TestUser;

  beforeAll(async () => {
    runner = await db.createRunner('Record Rae');
  });

  it('finds best efforts inside an accepted run', async () => {
    // 6 km at 5:00/km.
    const run = await uploadRun(db, runner, steadyRun(base, 6_000, 1_800), { title: 'Steady six' });
    expect(run.result.run.status).toBe('accepted');
    const records: Records = await db.rpc(runner, 'get_personal_records');
    expect(bestOf(records, '1k')?.elapsed_ms).toBeGreaterThan(297_000);
    expect(bestOf(records, '1k')?.elapsed_ms).toBeLessThan(303_000);
    expect(bestOf(records, '5k')?.elapsed_ms).toBeGreaterThan(1_490_000);
    expect(bestOf(records, '5k')?.elapsed_ms).toBeLessThan(1_510_000);
    expect(bestOf(records, '10k')).toBeNull();
    expect(records.longest_run?.run_id).toBe(run.runId);
  });

  it('takes the faster run as the record, and keeps the history of improvements', async () => {
    const faster = await uploadRun(db, runner, steadyRun(base + 2 * DAY, 5_200, 1_300), { title: 'Fast five' }); // 4:10/km
    const slower = await uploadRun(db, runner, steadyRun(base + 4 * DAY, 5_100, 1_800), { title: 'Easy five' });
    const records: Records = await db.rpc(runner, 'get_personal_records');
    expect(bestOf(records, '5k')?.run_id).toBe(faster.runId);
    expect(records.records.find((r) => r.effort === '5k')?.efforts).toBe(3);

    const history = await db.rpc(runner, 'get_record_history', { p_effort: '5k' });
    expect(history.map((h: { title: string }) => h.title)).toEqual(['Steady six', 'Fast five']);

    const fastEfforts = await db.rpc(runner, 'get_run_efforts', { p_run_id: faster.runId });
    expect(fastEfforts.efforts.find((e: { effort: string }) => e.effort === '5k')).toMatchObject({ rank: 1, record_when_run: true });
    const slowEfforts = await db.rpc(runner, 'get_run_efforts', { p_run_id: slower.runId });
    expect(slowEfforts.efforts.find((e: { effort: string }) => e.effort === '5k')).toMatchObject({ rank: 3, record_when_run: false });
  });

  it('never lets an effort span a pause', async () => {
    const other = await db.createRunner('Pause Pim');
    const run = buildSyntheticRun({
      startAt: base,
      legs: [
        { kind: 'run', durationS: 900, speedMps: 3.4 }, // ~3.06 km
        { kind: 'pause', durationS: 300 },
        { kind: 'run', durationS: 900, speedMps: 3.4 },
      ],
    });
    await uploadRun(db, other, run);
    const records: Records = await db.rpc(other, 'get_personal_records');
    expect(bestOf(records, '1k')).not.toBeNull();
    expect(bestOf(records, '5k')).toBeNull();
  });

  it('ignores efforts faster than the world record as GPS error', async () => {
    const other = await db.createRunner('Glitch Gus');
    // 1.2 km at 10 m/s: plausible to the validator (under 12 m/s) but not a real 1K.
    await uploadRun(db, other, steadyRun(base, 1_200, 120));
    const records: Records = await db.rpc(other, 'get_personal_records');
    expect(bestOf(records, '1k')).toBeNull();
  });

  it('counts only accepted runs, and drops a deleted run from the records', async () => {
    const other = await db.createRunner('Delete Dee');
    const short = await uploadRun(db, other, steadyRun(base, 1_050, 50)); // too short in time: personal only
    expect(short.result.run.status).toBe('personal_only');
    let records: Records = await db.rpc(other, 'get_personal_records');
    expect(bestOf(records, '1k')).toBeNull();

    const good = await uploadRun(db, other, steadyRun(base + DAY, 3_000, 900));
    records = await db.rpc(other, 'get_personal_records');
    expect(bestOf(records, '1k')?.run_id).toBe(good.runId);
    await db.rpc(other, 'delete_run', { p_run_id: good.runId });
    records = await db.rpc(other, 'get_personal_records');
    expect(bestOf(records, '1k')).toBeNull();
    expect(records.longest_run).toBeNull();
  });

  it('keeps records private to their owner', async () => {
    const stranger = await db.createRunner('Stranger Sol');
    const mine = await uploadRun(db, runner, steadyRun(base + 6 * DAY, 2_000, 600));
    await expectCode(db.rpc(stranger, 'get_run_efforts', { p_run_id: mine.runId }), 'not_found');
    await expectCode(db.rpc(runner, 'get_record_history', { p_effort: '3k' }), 'invalid_input');
  });
});

describe('run log: notes, shoes and the calendar', () => {
  let runner: TestUser;

  beforeAll(async () => {
    runner = await db.createRunner('Shoe Shay');
  });

  it('adds shoes, gives new runs the default shoe and totals its distance', async () => {
    const shoe = await db.rpc(runner, 'save_shoe', { p_name: '  Daily   trainers ', p_limit_km: 700, p_is_default: true });
    expect(shoe).toMatchObject({ name: 'Daily trainers', limit_km: 700, is_default: true, runs: 0 });
    const run = await uploadRun(db, runner, steadyRun(base, 5_000, 1_500));
    const detail = await db.rpc(runner, 'get_my_run', { p_run_id: run.runId });
    expect(detail.shoe_id).toBe(shoe.id);
    const shoes = await db.rpc(runner, 'list_shoes');
    expect(shoes[0]).toMatchObject({ id: shoe.id, runs: 1 });
    expect(Number(shoes[0].distance_m)).toBeGreaterThan(4_900);
  });

  it('keeps one default shoe, retires shoes and deletes them without deleting runs', async () => {
    const racer = await db.rpc(runner, 'save_shoe', { p_name: 'Racers', p_is_default: true });
    const shoes = await db.rpc(runner, 'list_shoes');
    expect(shoes.filter((s: { is_default: boolean }) => s.is_default).map((s: { id: string }) => s.id)).toEqual([racer.id]);
    const retired = await db.rpc(runner, 'retire_shoe', { p_shoe_id: racer.id });
    expect(retired).toMatchObject({ retired: true, is_default: false });
    const daily = shoes.find((s: { name: string }) => s.name === 'Daily trainers');
    await db.rpc(runner, 'delete_shoe', { p_shoe_id: daily.id });
    const runs = await db.rpc(runner, 'list_my_runs');
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0].shoe_id).toBeNull();
  });

  it('saves and clears notes, and sets or clears a run’s shoe', async () => {
    const run = (await db.rpc(runner, 'list_my_runs')).runs[0];
    const shoe = await db.rpc(runner, 'save_shoe', { p_name: 'Trail pair' });
    let detail = await db.rpc(runner, 'update_run_details', { p_run_id: run.id, p_notes: 'Windy lakefront.', p_shoe_id: shoe.id });
    expect(detail).toMatchObject({ notes: 'Windy lakefront.', shoe_id: shoe.id });
    detail = await db.rpc(runner, 'update_run_details', { p_run_id: run.id, p_notes: '   ', p_clear_shoe: true });
    expect(detail).toMatchObject({ notes: null, shoe_id: null });
    await expectCode(db.rpc(runner, 'update_run_details', { p_run_id: run.id, p_notes: 'x'.repeat(1001) }), 'invalid_input');
  });

  it('never lets another runner read or use my shoes', async () => {
    const other = await db.createRunner('Other Oli');
    const mine = await db.rpc(runner, 'save_shoe', { p_name: 'Mine' });
    expect(await db.rpc(other, 'list_shoes')).toEqual([]);
    await expectCode(db.rpc(other, 'retire_shoe', { p_shoe_id: mine.id }), 'not_found');
    const run = await uploadRun(db, other, steadyRun(base, 2_000, 700));
    await expectCode(db.rpc(other, 'update_run_details', { p_run_id: run.runId, p_shoe_id: mine.id }), 'not_found');
  });

  it('lists runs in a date range for the calendar', async () => {
    const other = await db.createRunner('Calendar Cam');
    await uploadRun(db, other, steadyRun(base, 2_000, 700));
    await uploadRun(db, other, steadyRun(base + 10 * DAY, 2_000, 700));
    const window = await db.rpc(other, 'list_my_runs_between', { p_from_ms: base - DAY, p_to_ms: base + 5 * DAY });
    expect(window).toHaveLength(1);
    await expectCode(db.rpc(other, 'list_my_runs_between', { p_from_ms: base, p_to_ms: base + 500 * DAY }), 'invalid_input');
  });
});
