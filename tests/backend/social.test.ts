import { destinationPoint, haversineM } from '@/domain/geo';
import { CHICAGO_LAKEFRONT } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { inCurrentWeek, runAt, uploadRun } from './helpers/runs';

/**
 * Privacy zones, per-run visibility and follows (docs/ROADMAP.md 4.2 and 4.3), through the RPCs
 * the app calls.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

const publicId = async (user: TestUser) => (await db.rpc(user, 'get_social_settings')).public_id as string;

describe('privacy zones and shared maps', () => {
  it('never shows a point inside a privacy zone or within 200 m of either end', async () => {
    const owner = await db.createRunner('Zoe Zones');
    const viewer = await db.createRunner('Val Viewer');
    // 5 km due east from the lakefront in 25 minutes (a point every second, ~3.3 m apart).
    const { runId } = await uploadRun(db, owner, runAt(inCurrentWeek(0), 5000, 1500));
    const home = CHICAGO_LAKEFRONT;
    const middle = destinationPoint(CHICAGO_LAKEFRONT, 90, 2500);
    const finish = destinationPoint(CHICAGO_LAKEFRONT, 90, 5000);
    await db.rpc(owner, 'save_privacy_zone', { p_label: 'Home', p_lat: home.lat, p_lon: home.lon, p_radius_m: 400 });
    await db.rpc(owner, 'save_privacy_zone', { p_label: 'Work', p_lat: middle.lat, p_lon: middle.lon, p_radius_m: 150 });

    // Hidden until the runner shares it, and then only its stats until the map is turned on.
    await expectCode(db.rpc(viewer, 'get_shared_run', { p_run_id: runId }), 'not_found');
    await db.rpc(owner, 'set_run_sharing', { p_run_id: runId, p_visibility: 'everyone', p_map_shared: false });
    expect((await db.rpc(viewer, 'get_shared_run', { p_run_id: runId })).route).toBeNull();
    await db.rpc(owner, 'set_run_sharing', { p_run_id: runId, p_visibility: 'everyone', p_map_shared: true });

    const shared = await db.rpc(viewer, 'get_shared_run', { p_run_id: runId });
    const lines = shared.route as [number, number][][];
    // The zone in the middle splits the route in two.
    expect(lines).toHaveLength(2);
    const points = lines.flat().map(([lat, lon]) => ({ lat, lon }));
    expect(points.length).toBeGreaterThan(50);
    expect(points.length).toBeLessThanOrEqual(420);

    // Checked against the stored route: every shown point is a stored point outside every zone
    // and at least 200 m along the route from the start and the finish.
    const stored = (await db.one<{ points: [number, number, number, number][] }>('select points from private.run_routes where run_id = $1', [runId])).points;
    const along: number[] = [];
    stored.forEach((p, i) => along.push(i === 0 ? 0 : along[i - 1]! + haversineM({ lat: stored[i - 1]![2], lon: stored[i - 1]![3] }, { lat: p[2], lon: p[3] })));
    const total = along[along.length - 1]!;
    for (const point of points) {
      expect(haversineM(point, home)).toBeGreaterThan(400);
      expect(haversineM(point, middle)).toBeGreaterThan(150);
      const i = stored.findIndex((p) => Math.abs(p[2] - point.lat) < 1e-5 && Math.abs(p[3] - point.lon) < 1e-5);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(along[i]).toBeGreaterThanOrEqual(200);
      expect(along[i]).toBeLessThanOrEqual(total - 200);
    }
    // The finish, outside any zone, is still trimmed.
    expect(Math.min(...points.map((p) => haversineM(p, finish)))).toBeGreaterThanOrEqual(195);

    // The owner's own view of the shared run is the same trimmed map.
    expect((await db.rpc(owner, 'get_shared_run', { p_run_id: runId })).route).toEqual(lines);
  });

  it('checks zones and starts new runs with the runner’s defaults', async () => {
    const runner = await db.createRunner('Dee Defaults');
    for (let i = 0; i < 5; i++) await db.rpc(runner, 'save_privacy_zone', { p_label: `Zone ${i}`, p_lat: 41.9, p_lon: -87.6 + i / 100, p_radius_m: 200 });
    await expectCode(db.rpc(runner, 'save_privacy_zone', { p_label: 'Sixth', p_lat: 41.9, p_lon: -87.5, p_radius_m: 200 }), 'too_many_zones');
    await expectCode(db.rpc(runner, 'save_privacy_zone', { p_label: 'Tiny', p_lat: 41.9, p_lon: -87.5, p_radius_m: 50 }), 'invalid_input');
    const zones = (await db.rpc(runner, 'get_social_settings')).zones as { id: string }[];
    await db.rpc(runner, 'delete_privacy_zone', { p_zone_id: zones[0]!.id });
    expect((await db.rpc(runner, 'get_social_settings')).zones).toHaveLength(4);

    const { runId: before } = await uploadRun(db, runner, runAt(inCurrentWeek(0), 3000, 1000));
    await db.rpc(runner, 'set_social_settings', { p_default_visibility: 'followers', p_default_map_shared: true });
    const { runId: after } = await uploadRun(db, runner, runAt(inCurrentWeek(1), 3000, 1000));
    const runs = await db.sql<{ id: string; visibility: string; map_shared: boolean }>('select id, visibility, map_shared from public.runs where id = any($1)', [[before, after]]);
    expect(runs.find((r) => r.id === before)).toMatchObject({ visibility: 'only_me', map_shared: false });
    expect(runs.find((r) => r.id === after)).toMatchObject({ visibility: 'followers', map_shared: true });
    expect((await db.rpc(runner, 'get_my_run', { p_run_id: after })).visibility).toBe('followers');
  });
});

describe('follows', () => {
  it('needs approval by default, and shows followers-only runs once approved', async () => {
    const ana = await db.createRunner('Ana Approves');
    const ben = await db.createRunner('Ben Follows');
    const { runId } = await uploadRun(db, ana, runAt(inCurrentWeek(0), 4000, 1400));
    await db.rpc(ana, 'set_run_sharing', { p_run_id: runId, p_visibility: 'followers', p_map_shared: false });

    const requested = await db.rpc(ben, 'follow_runner', { p_public_id: await publicId(ana) });
    expect(requested.follow.following).toBe('pending');
    await expectCode(db.rpc(ben, 'get_shared_run', { p_run_id: runId }), 'not_found');
    expect(await db.rpc(ana, 'list_follows', { p_kind: 'requests' })).toEqual([expect.objectContaining({ alias: 'Ben Follows', status: 'pending' })]);

    await db.rpc(ana, 'respond_follow', { p_public_id: await publicId(ben), p_accept: true });
    expect((await db.rpc(ben, 'get_shared_run', { p_run_id: runId })).title).toBe('Test run');
    const profile = await db.rpc(ben, 'get_runner_profile', { p_public_id: await publicId(ana) });
    expect(profile).toMatchObject({ alias: 'Ana Approves', followers: 1, follow: { following: 'accepted' } });
    expect(profile.runs).toHaveLength(1);

    // Removing a follower takes their access away.
    await db.rpc(ana, 'remove_follower', { p_public_id: await publicId(ben) });
    await expectCode(db.rpc(ben, 'get_shared_run', { p_run_id: runId }), 'not_found');
  });

  it('follows through a link, which the runner can replace; search finds only runners who opt in', async () => {
    const cat = await db.createRunner('Cat Codes');
    const dan = await db.createRunner('Dan Dials');
    await db.rpc(cat, 'set_social_settings', { p_follow_approval: false });
    const { code } = await db.rpc(cat, 'get_follow_code');
    expect(await db.rpc(dan, 'get_follow_link', { p_code: code.toLowerCase() })).toMatchObject({ alias: 'Cat Codes', follow: { following: 'none' } });
    expect((await db.rpc(dan, 'follow_by_code', { p_code: code })).follow.following).toBe('accepted');

    const { code: fresh } = await db.rpc(cat, 'get_follow_code', { p_rotate: true });
    expect(fresh).not.toBe(code);
    await expectCode(db.rpc(dan, 'get_follow_link', { p_code: code }), 'not_found');

    expect(await db.rpc(dan, 'search_runners', { p_query: 'cat co' })).toEqual([]);
    await db.rpc(cat, 'set_social_settings', { p_discoverable: true });
    expect(await db.rpc(dan, 'search_runners', { p_query: 'cat co' })).toEqual([expect.objectContaining({ alias: 'Cat Codes' })]);
    await expectCode(db.rpc(dan, 'search_runners', { p_query: 'ca' }), 'invalid_input');
  });

  it('shows league-mates the runs shared with leagues', async () => {
    const eve = await db.createRunner('Eve League');
    const fin = await db.createRunner('Fin League');
    const gus = await db.createRunner('Gus Outside');
    await db.rpc(eve, 'create_league', { p_name: 'Sharing Crew' });
    const invite = await db.rpc(eve, 'create_league_invite');
    await db.rpc(fin, 'join_league', { p_code: invite.code });
    const { runId } = await uploadRun(db, eve, runAt(inCurrentWeek(0), 4000, 1400));
    await db.rpc(eve, 'set_run_sharing', { p_run_id: runId, p_visibility: 'leagues', p_map_shared: false });
    expect((await db.rpc(fin, 'get_shared_run', { p_run_id: runId })).owner.alias).toBe('Eve League');
    await expectCode(db.rpc(gus, 'get_shared_run', { p_run_id: runId }), 'not_found');
  });
});

describe('blocks', () => {
  it('hide both runners from each other everywhere, including through an old link', async () => {
    const hal = await db.createRunner('Hal Blocks');
    const ivy = await db.createRunner('Ivy Blocked');
    await db.rpc(hal, 'set_social_settings', { p_follow_approval: false, p_discoverable: true });
    await db.rpc(ivy, 'set_social_settings', { p_follow_approval: false, p_discoverable: true });
    const { code } = await db.rpc(hal, 'get_follow_code');
    const halId = await publicId(hal);
    const ivyId = await publicId(ivy);
    await db.rpc(ivy, 'follow_runner', { p_public_id: halId });
    await db.rpc(hal, 'follow_runner', { p_public_id: ivyId });
    const { runId } = await uploadRun(db, hal, runAt(inCurrentWeek(0), 4000, 1400));
    await db.rpc(hal, 'set_run_sharing', { p_run_id: runId, p_visibility: 'everyone', p_map_shared: true });
    expect((await db.rpc(ivy, 'get_shared_run', { p_run_id: runId })).run_id).toBe(runId);

    await db.rpc(hal, 'block_runner', { p_public_id: ivyId });

    // Follows both ways are gone, and neither can find, follow or see the other.
    expect(await db.rpc(hal, 'list_follows', { p_kind: 'following' })).toEqual([]);
    expect(await db.rpc(ivy, 'list_follows', { p_kind: 'following' })).toEqual([]);
    expect(await db.rpc(ivy, 'search_runners', { p_query: 'hal bl' })).toEqual([]);
    await expectCode(db.rpc(ivy, 'get_runner_profile', { p_public_id: halId }), 'not_found');
    await expectCode(db.rpc(ivy, 'follow_runner', { p_public_id: halId }), 'not_found');
    await expectCode(db.rpc(ivy, 'get_follow_link', { p_code: code }), 'not_found');
    await expectCode(db.rpc(ivy, 'follow_by_code', { p_code: code }), 'not_found');
    await expectCode(db.rpc(ivy, 'get_shared_run', { p_run_id: runId }), 'not_found');
    // …and the same from the blocker's side.
    await expectCode(db.rpc(hal, 'get_runner_profile', { p_public_id: ivyId }), 'not_found');
    expect(await db.rpc(hal, 'search_runners', { p_query: 'ivy bl' })).toEqual([]);

    // Unblocking restores finding, not the old follows.
    const [block] = await db.rpc(hal, 'list_blocks');
    await db.rpc(hal, 'unblock', { p_block_id: block.block_id });
    expect(await db.rpc(ivy, 'search_runners', { p_query: 'hal bl' })).toHaveLength(1);
    expect(await db.rpc(ivy, 'list_follows', { p_kind: 'following' })).toEqual([]);
  });

  it('mutes quietly, and a block from the league screen ends follows too', async () => {
    const jo = await db.createRunner('Jo Mutes');
    const kai = await db.createRunner('Kai Muted');
    await db.rpc(kai, 'set_social_settings', { p_follow_approval: false });
    await db.rpc(jo, 'follow_runner', { p_public_id: await publicId(kai) });
    expect((await db.rpc(jo, 'mute_runner', { p_public_id: await publicId(kai), p_muted: true })).muted).toBe(true);
    expect(await db.rpc(jo, 'list_follows', { p_kind: 'muted' })).toEqual([expect.objectContaining({ alias: 'Kai Muted' })]);

    await db.rpc(jo, 'create_league', { p_name: 'Mute Crew' });
    const invite = await db.rpc(jo, 'create_league_invite');
    await db.rpc(kai, 'join_league', { p_code: invite.code });
    const league = await db.rpc(jo, 'get_my_league');
    const member = league.standings.find((s: { alias: string }) => s.alias === 'Kai Muted');
    await db.rpc(jo, 'block_member', { p_member_id: member.member_id });
    expect(await db.rpc(jo, 'list_follows', { p_kind: 'following' })).toEqual([]);
    expect(await db.rpc(jo, 'list_follows', { p_kind: 'muted' })).toEqual([]);
  });
});
