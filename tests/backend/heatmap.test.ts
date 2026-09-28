import { destinationPoint, haversineM, type LatLon } from '@/domain/geo';
import { routeRun, type SyntheticRun } from '@/domain/synthetic';

import { expectCode, TestDb, type TestUser } from './helpers/db';
import { uploadRun } from './helpers/runs';

/**
 * The heatmap (docs/ROADMAP.md 5.4) must never let anyone reconstruct one runner's route. Tested
 * with synthetic runs: a path shows only once 5 different runners have run it, however often one
 * runner does; the first and last 200 m of every run and everything inside a runner's privacy
 * zones never count; only contributors' runs shared with everyone, map included, count; and in a
 * synthetic town of 40 runners, nobody's own streets show, only the ones 5 or more share.
 */
let db: TestDb;
const DAY = 86_400_000;
let clock = Date.now() - 200 * DAY;

/** One fix a second through the waypoints at `speed`, a few hours after the last run. */
function walk(waypoints: LatLon[], speed = 4): SyntheticRun {
  return routeRun((clock += 3 * 3_600_000), waypoints, speed);
}

async function contributor(alias: string, contribute = true): Promise<TestUser> {
  const user = await db.createRunner(alias);
  if (contribute) await db.rpc(user, 'set_heatmap_contribution', { p_on: true });
  return user;
}

async function share(user: TestUser, run: SyntheticRun, visibility = 'everyone', map = true): Promise<string> {
  const uploaded = await uploadRun(db, user, run);
  expect(uploaded.result.run.status).toBe('accepted');
  await db.rpc(user, 'set_run_sharing', { p_run_id: uploaded.runId, p_visibility: visibility, p_map_shared: map });
  return uploaded.runId;
}

async function build(): Promise<Set<string>> {
  await db.sql('select private.process_heatmap_queue(100000)');
  await db.sql('select private.build_heatmap()');
  const rows = await db.sql<{ x: number; y: number; runners: number }>('select x, y, runners from private.heatmap_cells');
  for (const r of rows) expect(r.runners).toBeGreaterThanOrEqual(5);
  return new Set(rows.map((r) => `${r.x}:${r.y}`));
}

/** Cells along a straight stretch, a point every 3 m. */
async function cellsAlong(a: LatLon, b: LatLon): Promise<Set<string>> {
  const n = Math.ceil(haversineM(a, b) / 3);
  const rows = await db.sql<{ x: number; y: number }>(
    `select distinct c.x, c.y from generate_series(0, $5::integer) k,
       lateral private.heatmap_cell($1::double precision + ($3::double precision - $1::double precision) * k / $5::double precision,
                                    $2::double precision + ($4::double precision - $2::double precision) * k / $5::double precision) c`,
    [a.lat, a.lon, b.lat, b.lon, n],
  );
  return new Set(rows.map((r) => `${r.x}:${r.y}`));
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((c) => b.has(c));

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

describe('who a path shows for', () => {
  const A: LatLon = { lat: 45.07, lon: 7.66 };
  const B = destinationPoint(A, 90, 1500);
  // 400 m before and after the path, so the trimmed ends are off it.
  const lap = [destinationPoint(A, 270, 400), A, B, destinationPoint(B, 90, 400)];

  it('never shows a route one runner runs alone, however often, and shows a path once 5 different runners have run it', async () => {
    const path = await cellsAlong(A, B);
    const solo = await contributor('Solo Sal');
    for (let k = 0; k < 12; k++) await share(solo, walk(lap));
    expect(await build()).toEqual(new Set());
    const others = [await contributor('Heat Two'), await contributor('Heat Three'), await contributor('Heat Four')];
    for (const r of others) await share(r, walk(lap));
    // Four runners: still nothing.
    expect(overlap(await build(), path)).toEqual([]);
    const fifth = await contributor('Heat Five');
    await share(fifth, walk(lap));
    const shown = await build();
    expect(overlap(shown, path).length).toBe(path.size);

    // Brightness is a level, never a count.
    const tile = await db.sql<{ level: number }>(
      `select level from private.heatmap_tile_cells(15, floor(($1::double precision + 180) / 360 * 32768)::integer,
         floor((1 - ln(tan(radians($2::double precision)) + 1 / cos(radians($2::double precision))) / pi()) / 2 * 32768)::integer)`,
      [A.lon, A.lat],
    );
    expect(tile.length).toBeGreaterThan(0);
    expect(new Set(tile.map((t) => t.level))).toEqual(new Set([1]));

    // A runner who stops contributing is out of the next build.
    await db.rpc(fifth, 'set_heatmap_contribution', { p_on: false });
    expect(overlap(await build(), path)).toEqual([]);
    await db.rpc(fifth, 'set_heatmap_contribution', { p_on: true });
    expect(overlap(await build(), path).length).toBe(path.size);
  });

  it('never counts the first and last 200 m of a run, or anything in a privacy zone, even where 5 runners share it', async () => {
    // Five runners from the same front door, the same way.
    const door: LatLon = { lat: 45.09, lon: 7.7 };
    const far = destinationPoint(door, 0, 2000);
    const runners = [];
    for (let k = 0; k < 5; k++) runners.push(await contributor(`Door ${k + 1}`));
    for (const r of runners) await share(r, walk([door, far]));
    const shown = await build();
    const nearDoor = await cellsAlong(door, destinationPoint(door, 0, 180));
    const nearEnd = await cellsAlong(destinationPoint(far, 180, 180), far);
    const middle = await cellsAlong(destinationPoint(door, 0, 300), destinationPoint(door, 0, 1700));
    expect(overlap(shown, nearDoor)).toEqual([]);
    expect(overlap(shown, nearEnd)).toEqual([]);
    expect(overlap(shown, middle).length).toBe(middle.size);

    // One of them has a privacy zone halfway: there, only four runners count.
    const zone = destinationPoint(door, 0, 1000);
    await db.rpc(runners[0]!, 'save_privacy_zone', { p_label: 'Work', p_lat: zone.lat, p_lon: zone.lon, p_radius_m: 150 });
    const after = await build();
    const inZone = await cellsAlong(destinationPoint(zone, 180, 140), destinationPoint(zone, 0, 140));
    expect(overlap(after, inZone)).toEqual([]);
    expect(overlap(after, await cellsAlong(destinationPoint(door, 0, 300), destinationPoint(door, 0, 800))).length).toBeGreaterThan(0);
  });

  it('counts only contributors’ runs shared with everyone, map included, and never teens’', async () => {
    const C: LatLon = { lat: 45.11, lon: 7.62 };
    const D = destinationPoint(C, 45, 1500);
    const route = [destinationPoint(C, 225, 400), C, D, destinationPoint(D, 45, 400)];
    const path = await cellsAlong(C, D);
    const four = [];
    for (let k = 0; k < 4; k++) four.push(await contributor(`Share ${k + 1}`));
    for (const r of four) await share(r, walk(route));
    // A fifth runner, but: shared with followers only, then everyone without the map, then not a contributor.
    const fifth = await contributor('Share Five');
    const run = await share(fifth, walk(route), 'followers', true);
    expect(overlap(await build(), path)).toEqual([]);
    await db.rpc(fifth, 'set_run_sharing', { p_run_id: run, p_visibility: 'everyone', p_map_shared: false });
    expect(overlap(await build(), path)).toEqual([]);
    const outsider = await contributor('Not Contributing', false);
    await share(outsider, walk(route));
    expect(overlap(await build(), path)).toEqual([]);
    await db.rpc(fifth, 'set_run_sharing', { p_run_id: run, p_visibility: 'everyone', p_map_shared: true });
    expect(overlap(await build(), path).length).toBe(path.size);
    // Deleting the run takes it out again.
    await db.rpc(fifth, 'delete_run', { p_run_id: run });
    expect(overlap(await build(), path)).toEqual([]);

    // Teens can't contribute.
    await db.sql(`select private.set_flag('teen_accounts_enabled', true, 'heatmap test', 'test')`);
    const teen = await db.createRunner('Heat Teen');
    await db.sql(`update public.profiles set age_signal = 'teen_16_17' where user_id = $1`, [teen.id]);
    await expectCode(db.rpc(teen, 'set_heatmap_contribution', { p_on: true }), 'teen_restricted');
    await expectCode(db.rpc(teen, 'get_heatmap'), 'teen_restricted');
  });
});

describe('a synthetic town', () => {
  it('shows only streets 5 or more runners share, so nobody’s own route can be pieced together', async () => {
    // Streets every 200 m; 40 runners each run three rectangles from their front door, and 12 of
    // them also run a loop round the park in the middle.
    const corner: LatLon = { lat: 45.2, lon: 7.5 };
    const node = (i: number, j: number) => destinationPoint(destinationPoint(corner, 90, i * 200), 0, j * 200);
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((seed / 2_147_483_648) * n);
    };
    const runners: { runs: { id: string; start: LatLon }[] }[] = [];
    for (let k = 0; k < 40; k++) {
      const user = await contributor(`Town ${k + 1}`);
      const [i, j] = [3 + rand(10), 3 + rand(10)];
      const runs: { id: string; start: LatLon }[] = [];
      for (let lap = 0; lap < 3; lap++) {
        const w = (2 + rand(4)) * (rand(2) ? 1 : -1);
        const h = 2 + rand(4);
        // North first, then across, back down, and home along the last street.
        runs.push({ id: await share(user, walk([node(i, j), node(i, j + h), node(i + w, j + h), node(i + w, j), node(i, j)])), start: node(i, j) });
      }
      if (k < 12) runs.push({ id: await share(user, walk([node(6, 6), node(6, 10), node(10, 10), node(10, 6), node(6, 6)])), start: node(6, 6) });
      runners.push({ runs });
    }
    const shown = await build();
    expect(shown.size).toBeGreaterThan(100);

    // How many different runners went through each cell, from the cells each run contributed.
    const owners = await db.sql<{ cell: string; owners: number }>(
      `select c.x || ':' || c.y as cell, count(distinct r.owner_id)::integer as owners
       from private.heatmap_run_cells c join public.runs r on r.id = c.run_id group by c.x, c.y`,
    );
    const counts = new Map(owners.map((o) => [o.cell, o.owners]));
    // What shows is exactly the cells 5 or more runners share.
    expect(shown).toEqual(new Set(owners.filter((o) => o.owners >= 5).map((o) => o.cell)));

    let withOwnStreets = 0;
    for (const { runs } of runners) {
      const mine = new Map<string, number>();
      for (const run of runs) {
        const cells = await db.sql<{ cell: string; lat: number; lon: number }>(
          `select c.x || ':' || c.y as cell, m.lat, m.lon from private.heatmap_run_cells c
           cross join lateral private.heatmap_cell_center(c.x, c.y) m where c.run_id = $1`,
          [run.id],
        );
        // Where each run starts and ends (their door) never counts at all…
        expect(cells.filter((c) => haversineM(run.start, c) < 150)).toEqual([]);
        for (const c of cells) mine.set(c.cell, counts.get(c.cell) ?? 0);
      }
      // …and the streets only a few of them run never show.
      const own = [...mine].filter(([, n]) => n < 5).map(([cell]) => cell);
      expect(own.filter((cell) => shown.has(cell))).toEqual([]);
      if (own.length > 0) withOwnStreets += 1;
    }
    // Most runners have streets of their own, which is what a reconstruction would need.
    expect(withOwnStreets).toBeGreaterThan(20);
  });
});

// These use the paths and builds made above.
describe('the calls', () => {
  it('says what the runner contributes, finds busy places nearby, and exports and deletes', async () => {
    const r = await db.createRunner('Heat Caller');
    const before = await db.rpc(r, 'get_heatmap');
    expect(before).toMatchObject({ contributing: false, min_runners: 5, window_days: 365, build: { id: expect.any(Number) } });
    expect((await db.rpc(r, 'set_heatmap_contribution', { p_on: true })).contributing).toBe(true);

    // Busy places near the first path, spread at least 400 m apart, with a level, never a count.
    const spots = await db.rpc(r, 'get_heatmap_hotspots', { p_lat: 45.07, p_lon: 7.655 });
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) expect(Object.keys(s).sort()).toEqual(['distance_m', 'lat', 'level', 'lon']);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) expect(haversineM(spots[i], spots[j])).toBeGreaterThanOrEqual(400);
    }
    await expectCode(db.rpc(r, 'get_heatmap_hotspots', { p_lat: 95, p_lon: 0 }), 'invalid_input');

    const own = await share(r, walk([{ lat: 45.3, lon: 7.3 }, { lat: 45.31, lon: 7.3 }]));
    await db.sql('select private.process_heatmap_queue(1000)');
    expect((await db.sql('select 1 from private.heatmap_run_cells where run_id = $1', [own])).length).toBeGreaterThan(0);
    const extras = (await db.one<{ x: any }>('select private.export_extras($1) as x', [r.id])).x;
    expect(extras.heatmap).toMatchObject({ contributing: true, runs_contributed: 1 });
    await db.rpc(r, 'request_account_deletion');
    await db.sql('select private.process_deletion_jobs()');
    expect(await db.sql('select 1 from private.heatmap_contributors where user_id = $1', [r.id])).toEqual([]);
    expect(await db.sql('select 1 from private.heatmap_run_cells where run_id = $1', [own])).toEqual([]);
  });

  it('builds once a week', async () => {
    expect((await db.one<{ r: any }>('select private.build_heatmap_if_due() as r')).r).toBeNull();
    await db.sql(`update private.heatmap_builds set built_at = now() - interval '8 days'`);
    expect((await db.one<{ r: any }>('select private.build_heatmap_if_due() as r')).r).toMatchObject({ cells: expect.any(Number) });
  });
});
