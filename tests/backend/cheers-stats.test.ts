import { steadyRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { uploadRun } from './helpers/runs';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

async function league(ownerAlias: string, memberAliases: string[]) {
  const owner = await db.createRunner(ownerAlias);
  await db.rpc(owner, 'create_league', { p_name: `${ownerAlias} crew` });
  const invite = await db.rpc(owner, 'create_league_invite');
  const members: TestUser[] = [];
  for (const alias of memberAliases) {
    const m = await db.createRunner(alias);
    await db.rpc(m, 'join_league', { p_code: invite.code });
    members.push(m);
  }
  const view = await db.rpc(owner, 'get_my_league');
  const idOf = (alias: string) => view.standings.find((s: { alias: string }) => s.alias === alias).member_id as string;
  return { owner, members, idOf };
}

describe('league cheers', () => {
  it('cheers a league-mate once a week and shows who cheered me', async () => {
    const { owner, members, idOf } = await league('Cheer Cleo', ['Mate Max', 'Mate Mo']);
    const [max, mo] = members as [TestUser, TestUser];
    let result = await db.rpc(max, 'cheer_member', { p_member_id: idOf('Cheer Cleo') });
    result = await db.rpc(max, 'cheer_member', { p_member_id: idOf('Cheer Cleo') }); // once per week
    expect(result.mine).toEqual([idOf('Cheer Cleo')]);
    await db.rpc(mo, 'cheer_member', { p_member_id: idOf('Cheer Cleo') });

    const mine = await db.rpc(owner, 'get_league_cheers');
    expect(mine.received).toEqual([{ member_id: idOf('Cheer Cleo'), count: 2 }]);
    expect(mine.cheered_me).toEqual(['Mate Max', 'Mate Mo']);
  });

  it('refuses self-cheers, strangers and blocked members', async () => {
    const { owner, members, idOf } = await league('Guard Gia', ['Block Bea']);
    const [bea] = members as [TestUser];
    await expectCode(db.rpc(owner, 'cheer_member', { p_member_id: idOf('Guard Gia') }), 'invalid_input');
    const stranger = await db.createRunner('Stranger Stu');
    await expectCode(db.rpc(stranger, 'cheer_member', { p_member_id: idOf('Guard Gia') }), 'not_in_league');

    await db.rpc(bea, 'cheer_member', { p_member_id: idOf('Guard Gia') });
    await db.rpc(owner, 'block_member', { p_member_id: idOf('Block Bea') });
    const view = await db.rpc(owner, 'get_league_cheers');
    expect(view.received).toEqual([]);
    expect(view.cheered_me).toEqual([]);
    await expectCode(db.rpc(owner, 'cheer_member', { p_member_id: idOf('Block Bea') }), 'not_found');
  });

  it('shows nothing to runners without a league', async () => {
    const solo = await db.createRunner('Solo Sam');
    const view = await db.rpc(solo, 'get_league_cheers');
    expect(view).toMatchObject({ league_id: null, received: [], mine: [] });
  });
});

describe('stats', () => {
  it('totals runs by month with the same range a year earlier, skipping deleted runs', async () => {
    const runner = await db.createRunner('Stats Sid');
    const march = Date.UTC(2026, 2, 10, 14);
    await uploadRun(db, runner, steadyRun(march, 5_000, 1_500), { receivedAfterMs: 5_000 });
    await uploadRun(db, runner, steadyRun(march + 86_400_000, 3_000, 900));
    const april = await uploadRun(db, runner, steadyRun(Date.UTC(2026, 3, 2, 14), 4_000, 1_200));
    await uploadRun(db, runner, steadyRun(Date.UTC(2025, 2, 12, 14), 2_000, 700));
    await db.rpc(runner, 'delete_run', { p_run_id: april.runId });

    const stats = await db.rpc(runner, 'get_stats', { p_from: '2026-03-01', p_to: '2026-04-30', p_bucket: 'month' });
    expect(stats.buckets.map((b: { start: string; runs: number }) => [b.start, b.runs])).toEqual([
      ['2026-03-01', 2],
      ['2026-04-01', 0],
    ]);
    expect(stats.total.runs).toBe(2);
    expect(stats.total.days).toBe(2);
    expect(Number(stats.total.distance_m)).toBeGreaterThan(7_900);
    expect(Number(stats.total.longest_m)).toBeGreaterThan(4_900);
    expect(stats.previous_year.runs).toBe(1);
  });

  it('rejects oversized ranges and unknown buckets, and is private', async () => {
    const runner = await db.createRunner('Range Ren');
    await expectCode(db.rpc(runner, 'get_stats', { p_from: '2010-01-01', p_to: '2026-01-01' }), 'invalid_input');
    await expectCode(db.rpc(runner, 'get_stats', { p_from: '2026-01-01', p_to: '2026-02-01', p_bucket: 'day' }), 'invalid_input');
    const other = await db.createRunner('Other Oz');
    await uploadRun(db, runner, steadyRun(Date.UTC(2026, 5, 1, 14), 5_000, 1_500));
    const theirs = await db.rpc(other, 'get_stats', { p_from: '2026-06-01', p_to: '2026-06-30', p_bucket: 'week' });
    expect(theirs.total.runs).toBe(0);
  });
});
