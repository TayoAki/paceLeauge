import { steadyRun } from '@/domain/synthetic';

import { TestDb, type TestUser } from './helpers/db';
import { uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const DAY = 86_400_000;
const MIN = 60_000;

/** Phase 1 data joins the export (docs/ROADMAP.md: "the new features are in the data export"). */
describe('export format 2', () => {
  it('includes the age check, shoes, notes, records, badges, streak weeks, cheers and edits', async () => {
    const me = await db.createRunner('Export Eve');
    const mate = await db.createRunner('Export Mate');
    await db.rpc(me, 'record_age_signal', { p_signal: 'adult', p_source: 'apple_declared_range' });
    await db.rpc(me, 'create_league', { p_name: 'Export crew' });
    const invite = await db.rpc(me, 'create_league_invite');
    await db.rpc(mate, 'join_league', { p_code: invite.code });
    const view = await db.rpc(me, 'get_my_league');
    const idOf = (alias: string) => view.standings.find((s: { alias: string }) => s.alias === alias).member_id as string;

    const shoe = await db.rpc(me, 'save_shoe', { p_name: 'Daily trainer', p_limit_km: 700, p_is_default: true });
    const start = Date.now() - 3 * DAY;
    const uploaded = await uploadRun(db, me, steadyRun(start, 6_000, 1_800));
    await db.rpc(me, 'update_run_details', { p_run_id: uploaded.runId, p_notes: 'Easy by the river' });
    const run = await db.rpc(me, 'get_my_run', { p_run_id: uploaded.runId });
    await db.rpc(me, 'edit_run', { p_run_id: uploaded.runId, p_expected_version: run.version, p_keep_to_ms: start + 28 * MIN });
    await db.rpc(mate, 'cheer_member', { p_member_id: idOf('Export Eve') });
    await db.rpc(me, 'cheer_member', { p_member_id: idOf('Export Mate') });

    const job = await db.rpc(me, 'request_export');
    const data = await db.rpc(me, 'get_export', { p_export_id: job.export_id });
    expect(data.format_version).toBe(2);
    expect(data.account).toMatchObject({ age_signal: 'adult', age_signal_source: 'apple_declared_range', age_checked_at_ms: expect.any(Number) });
    expect(data.shoes).toEqual([expect.objectContaining({ id: shoe.id, name: 'Daily trainer', limit_km: 700, is_default: true, runs: 1 })]);
    expect(data.runs).toEqual([
      expect.objectContaining({ id: uploaded.runId, notes: 'Easy by the river', shoe_id: shoe.id, activity_type: 'run', edited_at_ms: expect.any(Number) }),
    ]);
    expect(data.efforts.map((e: { effort: string }) => e.effort)).toEqual(['1k', '1mi', '5k']);
    expect(data.badges.map((b: { badge: string }) => b.badge)).toEqual(expect.arrayContaining(['first_run', 'first_5k']));
    expect(data.streak_weeks).toEqual([expect.objectContaining({ active_days: 1, met: false })]);
    expect(data.cheers).toEqual({ given: [{ week_start: expect.any(String), count: 1 }], received: [{ week_start: expect.any(String), count: 1 }] });
    expect(data.run_edits).toEqual([
      expect.objectContaining({ run_id: uploaded.runId, original_status: 'accepted', original_activity_type: 'run', original_point_count: 1_801 }),
    ]);
  });

  it('leaves out other runners’ data', async () => {
    const me: TestUser = await db.createRunner('Export Solo');
    const other = await db.createRunner('Export Other');
    await db.rpc(other, 'save_shoe', { p_name: 'Not mine' });
    await uploadRun(db, other, steadyRun(Date.now() - 2 * DAY, 5_000, 1_500));
    const job = await db.rpc(me, 'request_export');
    const data = await db.rpc(me, 'get_export', { p_export_id: job.export_id });
    expect(data).toMatchObject({ runs: [], shoes: [], efforts: [], badges: [], streak_weeks: [], run_edits: [], cheers: { given: [], received: [] } });
  });
});
