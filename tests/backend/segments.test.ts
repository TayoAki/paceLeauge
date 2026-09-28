import { destinationPoint, haversineM, type LatLon } from '@/domain/geo';
import { normalizeCoordinate } from '@/domain/route-codec';
import type { SyntheticRun } from '@/domain/synthetic';
import type { TrackPoint } from '@/domain/types';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { uploadRun } from './helpers/runs';

/**
 * Segments (docs/ROADMAP.md 5.3): a golden set of runs whose efforts are known by construction
 * (where and when they cross the segment's start and end lines), matched on the server; then the
 * boards, the local legend, privacy, moderation and the export.
 */
let db: TestDb;
let staff: TestUser;
let segmentId: string;

/** The segment: 800 m due north along a path from here. */
const O: LatLon = { lat: 41.9150, lon: -87.6340 };
const TOP = destinationPoint(O, 0, 800);
const DAY = 86_400_000;
const BASE = Date.now() - 20 * DAY;

interface Leg {
  to: LatLon;
  speed: number;
}

/**
 * A run through waypoints at the legs' speeds, one fix a second, in one stretch (or two, split by
 * a pause at `pauseAtS`), wandering off the line by up to `jitterM`.
 */
function pathRun(startAt: number, from: LatLon, legs: Leg[], options: { jitterM?: number; pauseAtS?: number } = {}): SyntheticRun {
  const points: TrackPoint[] = [];
  let t = startAt;
  let at = from;
  let seq = 0;
  let segmentIndex = 0;
  let k = 0;
  let truth = 0;
  const segments = [{ index: 0, startAt, endAt: startAt }];
  const push = (p: LatLon) => {
    // GPS noise wanders slowly (fix to fix it moves a metre or two), up to `jitterM` either side.
    const q = options.jitterM
      ? destinationPoint(destinationPoint(p, 90, Math.sin(k / 9) * options.jitterM), 0, Math.cos(k / 13) * (options.jitterM / 2))
      : p;
    points.push({ seq: seq++, t, lat: normalizeCoordinate(q.lat), lon: normalizeCoordinate(q.lon), accuracyM: 5, segmentIndex });
    k += 1;
  };
  push(at);
  for (const leg of legs) {
    const length = haversineM(at, leg.to);
    const seconds = Math.max(1, Math.round(length / leg.speed));
    for (let s = 1; s <= seconds; s++) {
      t += 1000;
      if (options.pauseAtS !== undefined && Math.round((t - startAt) / 1000) === options.pauseAtS) {
        // A 30-second pause: the stretch ends here and a new one starts.
        segments[segmentIndex]!.endAt = t;
        t += 30_000;
        segmentIndex += 1;
        segments.push({ index: segmentIndex, startAt: t, endAt: t });
      }
      const f = s / seconds;
      push({ lat: at.lat + (leg.to.lat - at.lat) * f, lon: at.lon + (leg.to.lon - at.lon) * f });
    }
    truth += length;
    at = leg.to;
  }
  segments[segmentIndex]!.endAt = t;
  return { startedAt: startAt, endedAt: t, segments, points, truthDistanceM: truth };
}

const south = (m: number, of: LatLon = O) => destinationPoint(of, 180, m);
const north = (m: number, of: LatLon = O) => destinationPoint(of, 0, m);
const east = (m: number, of: LatLon) => destinationPoint(of, 90, m);
const west = (m: number, of: LatLon) => destinationPoint(of, 270, m);

async function runner(alias: string, join = true): Promise<TestUser> {
  const user = await db.createRunner(alias);
  if (join) await db.rpc(user, 'join_segments');
  return user;
}

/** Uploads a run, shares it with everyone with its map, and matches the queue. */
async function run(user: TestUser, synthetic: SyntheticRun, share = true): Promise<string> {
  const uploaded = await uploadRun(db, user, synthetic);
  expect(uploaded.result.run.status).toBe('accepted');
  if (share) await db.rpc(user, 'set_run_sharing', { p_run_id: uploaded.runId, p_visibility: 'everyone', p_map_shared: true });
  await match();
  return uploaded.runId;
}

const match = () => db.sql('select private.process_segment_matches(1000)');
const efforts = (runId: string) =>
  db.sql<{ started_at: Date; elapsed_ms: number; status: string }>(
    'select started_at, elapsed_ms, status from private.segment_efforts where run_id = $1 order by started_at',
    [runId],
  );

beforeAll(async () => {
  db = await TestDb.create();
  staff = await db.createRunner('Segment Staff');
  await db.sql(`select private.grant_staff_role($1, 'moderator', 'segments', 'ops-test')`, [staff.id]);
  const route = await db.rpc(staff, 'save_route', {
    p_route_id: null,
    p_name: 'Lakefront straight',
    p_kind: 'drawn',
    p_points: [
      [O.lat, O.lon],
      [TOP.lat, TOP.lon],
    ],
    p_cues: [],
    p_ascent_m: null,
  });
  const segment = await db.rpc(staff, 'mod_create_segment', { p_route_id: route.id, p_name: 'Lakefront Straight', p_surface: 'path' });
  segmentId = segment.id;
  expect(segment).toMatchObject({ name: 'Lakefront Straight', surface: 'path', distance_m: 800, board: [] });
});

afterAll(async () => {
  await db.close();
});

describe('matching runs to a segment (the golden set)', () => {
  it('times a run through the whole segment between its start and end lines', async () => {
    const r = await runner('Golden Gus');
    const start = BASE;
    // 400 m before the segment, through it, and 400 m after, at 4 m/s.
    const id = await run(r, pathRun(start, south(400), [{ to: north(1200), speed: 4 }]));
    const [effort, ...more] = await efforts(id);
    expect(more).toEqual([]);
    expect(effort!.status).toBe('counted');
    expect(Math.abs(effort!.elapsed_ms - 200_000)).toBeLessThanOrEqual(1_000);
    expect(Math.abs(effort!.started_at.getTime() - (start + 100_000))).toBeLessThanOrEqual(1_000);
  });

  it('ignores the same path run the other way', async () => {
    const r = await runner('Golden Ola');
    const id = await run(r, pathRun(BASE + DAY, north(1200), [{ to: south(400), speed: 4 }]));
    expect(await efforts(id)).toEqual([]);
  });

  it('ignores runs that leave or join the segment part way', async () => {
    const r = await runner('Golden Pat');
    // In at the start, off to the east halfway.
    const partial = await run(r, pathRun(BASE + 2 * DAY, south(400), [{ to: north(500), speed: 4 }, { to: east(900, north(500)), speed: 4 }]));
    expect(await efforts(partial)).toEqual([]);
    // Joining from the side halfway, then to the end.
    const joined = await run(r, pathRun(BASE + 3 * DAY, west(900, north(300)), [{ to: north(300), speed: 4 }, { to: north(1200), speed: 4 }]));
    expect(await efforts(joined)).toEqual([]);
  });

  it('ignores a detour of 100 m off the segment, but not GPS noise of 10 m', async () => {
    const r = await runner('Golden Dee');
    const detour = await run(
      r,
      pathRun(BASE + 4 * DAY, south(400), [
        { to: north(300), speed: 4 },
        { to: east(100, north(350)), speed: 4 },
        { to: east(100, north(550)), speed: 4 },
        { to: north(600), speed: 4 },
        { to: north(1200), speed: 4 },
      ]),
    );
    expect(await efforts(detour)).toEqual([]);
    const noisy = await run(r, pathRun(BASE + 5 * DAY, south(400), [{ to: north(1200), speed: 4 }], { jitterM: 10 }));
    const [effort] = await efforts(noisy);
    expect(effort).toBeDefined();
    expect(Math.abs(effort!.elapsed_ms - 200_000)).toBeLessThanOrEqual(3_000);
  });

  it('counts each lap, and nothing across a pause', async () => {
    const r = await runner('Golden Lap');
    // Up the segment, back down a street 150 m west, and up the segment again (finishing well past
    // its end, as the last 200 m of a run are never shared).
    const laps = await run(
      r,
      pathRun(BASE + 6 * DAY, south(300), [
        { to: north(1000), speed: 4 },
        { to: west(150, north(1000)), speed: 4 },
        { to: west(150, south(300)), speed: 4 },
        { to: south(300), speed: 4 },
        { to: north(1200), speed: 4 },
      ]),
    );
    expect((await efforts(laps)).map((e) => Math.round(e.elapsed_ms / 1000))).toEqual([200, 200]);
    const paused = await run(r, pathRun(BASE + 7 * DAY, south(400), [{ to: north(1200), speed: 4 }], { pauseAtS: 200 }));
    expect(await efforts(paused)).toEqual([]);
  });

  it('uses only what a shared map shows: not the first 200 m, nothing across a privacy zone', async () => {
    const r = await runner('Golden Zed');
    // Starting on the segment's start line: that part of the run is never shared.
    const fromStart = await run(r, pathRun(BASE + 8 * DAY, O, [{ to: north(1500), speed: 4 }]));
    expect(await efforts(fromStart)).toEqual([]);
    // A privacy zone halfway along.
    const through = await run(r, pathRun(BASE + 9 * DAY, south(400), [{ to: north(1200), speed: 4 }]));
    expect(await efforts(through)).toHaveLength(1);
    const zone = north(400);
    await db.rpc(r, 'save_privacy_zone', { p_label: 'Friend', p_lat: zone.lat, p_lon: zone.lon, p_radius_m: 100 });
    await match();
    expect(await efforts(through)).toEqual([]);
  });

  it('matches only runs shared with everyone, map included, by runners on the boards', async () => {
    const r = await runner('Golden Sam');
    const id = await run(r, pathRun(BASE + 10 * DAY, south(400), [{ to: north(1200), speed: 4 }]), false);
    expect(await efforts(id)).toEqual([]);
    await db.rpc(r, 'set_run_sharing', { p_run_id: id, p_visibility: 'everyone', p_map_shared: false });
    await match();
    expect(await efforts(id)).toEqual([]);
    await db.rpc(r, 'set_run_sharing', { p_run_id: id, p_visibility: 'everyone', p_map_shared: true });
    await match();
    expect(await efforts(id)).toHaveLength(1);
    await db.rpc(r, 'set_run_sharing', { p_run_id: id, p_visibility: 'leagues', p_map_shared: true });
    await match();
    expect(await efforts(id)).toEqual([]);

    // Not on the boards: nothing matched, until they join.
    const outsider = await runner('Golden Out', false);
    const theirs = await run(outsider, pathRun(BASE + 11 * DAY, south(400), [{ to: north(1200), speed: 4 }]));
    expect(await efforts(theirs)).toEqual([]);
    expect((await db.rpc(outsider, 'join_segments')).queued).toBeGreaterThanOrEqual(1);
    await match();
    expect(await efforts(theirs)).toHaveLength(1);
  });
});

describe('boards and the local legend', () => {
  it('shows each runner’s best time and the legend by distinct days, and hides blocked runners', async () => {
    const quick = await runner('Board Quick');
    const steady = await runner('Board Steady');
    const viewer = await runner('Board Viewer');
    // Quick: two efforts on one day (the faster counts). Steady: three different days.
    const slower = await run(quick, pathRun(BASE + 12 * DAY, south(400), [{ to: north(1200), speed: 5 }]));
    const faster = await run(quick, pathRun(BASE + 12 * DAY + 3_600_000, south(400), [{ to: north(1200), speed: 5.5 }]));
    for (const d of [13, 14, 15]) await run(steady, pathRun(BASE + d * DAY, south(400), [{ to: north(1200), speed: 3.5 }]));

    const segment = await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId });
    const places = segment.board.map((b: any) => b.alias);
    expect(places.indexOf('Board Quick')).toBeLessThan(places.indexOf('Board Steady'));
    const quickRow = segment.board.find((b: any) => b.alias === 'Board Quick');
    expect(Math.abs(quickRow.elapsed_ms - 800 / 5.5 * 1000)).toBeLessThanOrEqual(1_000);
    expect(segment.board.filter((b: any) => b.alias === 'Board Quick')).toHaveLength(1);
    expect(segment.legend).toMatchObject({ alias: 'Board Steady', days: 3, is_me: false });
    expect(segment.runners).toBeGreaterThanOrEqual(2);
    // Each run's page lists its segments, marking the runner's best; nobody else's runs.
    expect(await db.rpc(quick, 'get_run_segments', { p_run_id: slower })).toMatchObject([{ name: 'Lakefront Straight', status: 'counted', is_best: false }]);
    expect(await db.rpc(quick, 'get_run_segments', { p_run_id: faster })).toMatchObject([{ segment_id: segmentId, distance_m: 800, is_best: true }]);
    await expectCode(db.rpc(viewer, 'get_run_segments', { p_run_id: faster }), 'not_found');

    await db.rpc(viewer, 'block_runner', { p_public_id: (await db.rpc(steady, 'get_social_settings')).public_id });
    const blocked = await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId });
    expect(blocked.board.map((b: any) => b.alias)).not.toContain('Board Steady');
    expect(blocked.legend?.alias).not.toBe('Board Steady');

    // Their own page: best, days and efforts.
    const mine = await db.rpc(steady, 'get_segment', { p_segment_id: segmentId });
    expect(mine).toMatchObject({ joined: true, my_days: 3 });
    expect(mine.my_efforts).toHaveLength(3);
    expect(mine.legend).toMatchObject({ is_me: true });
    const list = await db.rpc(steady, 'list_segments');
    expect(list).toMatchObject({ joined: true });
    expect(list.segments.find((s: any) => s.id === segmentId)).toMatchObject({ name: 'Lakefront Straight', my_best_ms: expect.any(Number) });

    // Leaving takes every time off at once.
    await db.rpc(steady, 'leave_segments');
    const after = await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId });
    expect(after.board.map((b: any) => b.alias)).not.toContain('Board Steady');
    expect(await db.sql('select 1 from private.segment_efforts where user_id = $1', [steady.id])).toEqual([]);
  });
});

describe('fair play', () => {
  it('holds an effort faster than 7 m/s for a moderator, who can release it or take the runner off the boards', async () => {
    const flyer = await runner('Fast Flo');
    // Easy running either side, the segment at 7.5 m/s: the run is accepted, the effort held.
    const id = await run(flyer, pathRun(BASE + 16 * DAY, south(1500), [
      { to: south(0), speed: 3 },
      { to: north(800), speed: 7.5 },
      { to: north(2300), speed: 3 },
    ]));
    const [effort] = await efforts(id);
    expect(effort!.status).toBe('held');
    const viewer = await runner('Fair Viewer');
    expect((await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId })).board.map((b: any) => b.alias)).not.toContain('Fast Flo');
    // Held efforts go to the moderation queue on their own.
    const held = (await db.rpc(staff, 'mod_list_reports')).find((r: any) => r.target_kind === 'segment' && r.content_snapshot.alias === 'Fast Flo');
    expect(held).toMatchObject({ reason_code: 'cheating', target_state: { effort_status: 'held' } });
    expect(held.actions).toEqual(['dismiss', 'release_effort', 'remove_effort', 'remove_from_segments', 'reset_alias']);
    await db.rpc(staff, 'mod_resolve_report', { p_report_id: held.report_id, p_action: 'release_effort', p_reason: 'Checked the splits' });
    expect((await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId })).board.map((b: any) => b.alias)).toContain('Fast Flo');
    // Matched again (the run is shared again), a released effort stays released.
    await db.rpc(flyer, 'set_run_sharing', { p_run_id: id, p_visibility: 'everyone', p_map_shared: false });
    await db.rpc(flyer, 'set_run_sharing', { p_run_id: id, p_visibility: 'everyone', p_map_shared: true });
    await match();
    expect((await efforts(id)).map((e) => e.status)).toEqual(['counted']);

    // A runner reports a time; the moderator takes the runner off the boards for good.
    const [row] = (await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId })).board.filter((b: any) => b.alias === 'Fast Flo');
    const report = await db.rpc(viewer, 'report_content', { p_kind: 'segment', p_id: row.effort_id, p_reason: 'cheating' });
    await db.rpc(staff, 'mod_resolve_report', { p_report_id: report.report_id, p_action: 'remove_from_segments', p_reason: 'Rode a bike' });
    expect((await db.rpc(viewer, 'get_segment', { p_segment_id: segmentId })).board.map((b: any) => b.alias)).not.toContain('Fast Flo');
    await expectCode(db.rpc(flyer, 'join_segments'), 'not_allowed');
    expect((await db.rpc(flyer, 'list_segments')).banned).toBe(true);
  });

  it('lets only staff make and retire segments, from their own routes on paths', async () => {
    const someone = await runner('Plain Pia');
    const route = await db.rpc(someone, 'save_route', {
      p_route_id: null, p_name: 'Mine', p_kind: 'drawn', p_points: [[O.lat, O.lon], [TOP.lat, TOP.lon]], p_cues: [], p_ascent_m: null,
    });
    await expect(db.rpc(someone, 'mod_create_segment', { p_route_id: route.id, p_name: 'Sneaky', p_surface: 'path' })).rejects.toBeTruthy();
    await expectCode(db.rpc(staff, 'mod_create_segment', { p_route_id: route.id, p_name: 'Not mine', p_surface: 'path' }), 'not_found');
    const own = await db.rpc(staff, 'save_route', {
      p_route_id: null, p_name: 'Short', p_kind: 'drawn', p_points: [[O.lat, O.lon], [north(100).lat, north(100).lon]], p_cues: [], p_ascent_m: null,
    });
    await expectCode(db.rpc(staff, 'mod_create_segment', { p_route_id: own.id, p_name: 'Too short', p_surface: 'path' }), 'invalid_input');
    await expectCode(db.rpc(staff, 'mod_create_segment', { p_route_id: own.id, p_name: 'Road', p_surface: 'road' }), 'invalid_input');

    const temp = await db.rpc(staff, 'save_route', {
      p_route_id: null, p_name: 'Temp', p_kind: 'drawn', p_points: [[O.lat, O.lon + 0.01], [north(900, { lat: O.lat, lon: O.lon + 0.01 }).lat, O.lon + 0.01]], p_cues: [], p_ascent_m: null,
    });
    const segment = await db.rpc(staff, 'mod_create_segment', { p_route_id: temp.id, p_name: 'Park Edge', p_surface: 'park' });
    await db.rpc(staff, 'mod_retire_segment', { p_segment_id: segment.id, p_reason: 'Path closed for works' });
    await expectCode(db.rpc(someone, 'get_segment', { p_segment_id: segment.id }), 'not_found');
    expect((await db.rpc(someone, 'list_segments')).segments.map((s: any) => s.name)).not.toContain('Park Edge');
    const audit = await db.sql<{ action: string }>(`select action from private.moderation_actions where moderator_id = $1 order by id`, [staff.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['segment_created', 'segment_retired']));
  });

  it('puts a runner’s efforts in their export, and deletes them with the account', async () => {
    const r = await runner('Export Eve');
    await run(r, pathRun(BASE + 17 * DAY, south(400), [{ to: north(1200), speed: 4 }]));
    const extras = (await db.one<{ x: any }>('select private.export_extras($1) as x', [r.id])).x;
    expect(extras.segments).toMatchObject({ joined: true, efforts: [expect.objectContaining({ segment: 'Lakefront Straight', status: 'counted' })] });
    await db.rpc(r, 'request_account_deletion');
    await db.sql('select private.process_deletion_jobs()');
    expect(await db.sql('select 1 from private.segment_efforts where user_id = $1', [r.id])).toEqual([]);
    expect(await db.sql('select 1 from private.segment_members where user_id = $1', [r.id])).toEqual([]);
  });
});
