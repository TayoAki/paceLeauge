import { expectCode, TestDb } from './helpers/db';

/**
 * Saved routes (docs/ROADMAP.md 5.1): private to the runner, measured by the server from their
 * points, and checked so that nothing implausible is kept.
 */
let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

/** A walk north then east from the lakefront: about 1,112 m, then 827 m. */
const LAKEFRONT: [number, number][] = [
  [41.9, -87.62],
  [41.91, -87.62],
  [41.91, -87.61],
];

const save = (user: Parameters<TestDb['rpc']>[0], args: Record<string, unknown>) =>
  db.rpc(user, 'save_route', { p_route_id: null, p_name: 'Lakefront', p_kind: 'drawn', p_points: LAKEFRONT, p_cues: [], ...args });

describe('saved routes', () => {
  it('saves, lists, opens, renames, replaces and deletes a runner’s routes', async () => {
    const runner = await db.createRunner('Route Rosa');
    const saved = await save(runner, {
      p_kind: 'path',
      // More decimals than kept; the phone's distance is never asked for.
      p_points: [
        [41.900000049, -87.620000001],
        [41.91, -87.62],
        [41.91, -87.61],
      ],
      p_cues: [
        { i: 2, turn: 'left', street: '  N Lake Shore Dr ', exit: null },
        { i: 1, turn: 'right', street: null },
      ],
      p_ascent_m: 12,
    });
    expect(saved).toMatchObject({
      name: 'Lakefront',
      kind: 'path',
      distance_m: 1939,
      ascent_m: 12,
      start: { lat: 41.9, lon: -87.62 },
      bbox: [41.9, -87.62, 41.91, -87.61],
      turns: 2,
      points: LAKEFRONT,
      // Sorted along the route, each with how far along it comes.
      cues: [
        { i: 1, turn: 'right', street: null, exit: null, at_m: 1112 },
        { i: 2, turn: 'left', street: 'N Lake Shore Dr', exit: null, at_m: 1939 },
      ],
    });

    const listed = await db.rpc(runner, 'list_routes');
    expect(listed).toMatchObject({ planning_available: false, limit: 100 });
    expect(listed.routes).toEqual([expect.objectContaining({ id: saved.id, name: 'Lakefront', distance_m: 1939, preview: LAKEFRONT })]);
    expect(listed.routes[0].points).toBeUndefined();
    expect(await db.rpc(runner, 'get_route', { p_route_id: saved.id })).toMatchObject({ id: saved.id, points: LAKEFRONT });

    expect(await db.rpc(runner, 'rename_route', { p_route_id: saved.id, p_name: '  Sunday   loop ' })).toMatchObject({ name: 'Sunday loop' });

    const longer = await db.rpc(runner, 'save_route', {
      p_route_id: saved.id,
      p_name: 'Sunday loop',
      p_kind: 'drawn',
      p_points: [...LAKEFRONT, [41.9, -87.61], [41.9, -87.62]],
      p_cues: [],
      p_ascent_m: null,
    });
    expect(longer).toMatchObject({ id: saved.id, kind: 'drawn', distance_m: 3879, cues: [], turns: 0, ascent_m: null });
    expect((await db.rpc(runner, 'list_routes')).routes).toHaveLength(1);

    expect(await db.rpc(runner, 'delete_route', { p_route_id: saved.id })).toEqual({ deleted: 1 });
    await expectCode(db.rpc(runner, 'get_route', { p_route_id: saved.id }), 'not_found');
  });

  it('keeps each runner’s routes to themselves', async () => {
    const owner = await db.createRunner('Route Owner');
    const other = await db.createRunner('Route Snoop');
    const saved = await save(owner, {});
    await expectCode(db.rpc(other, 'get_route', { p_route_id: saved.id }), 'not_found');
    await expectCode(db.rpc(other, 'rename_route', { p_route_id: saved.id, p_name: 'Mine now' }), 'not_found');
    await expectCode(db.rpc(other, 'save_route', { p_route_id: saved.id, p_name: 'Mine', p_kind: 'drawn', p_points: LAKEFRONT, p_cues: [], p_ascent_m: null }), 'not_found');
    expect(await db.rpc(other, 'delete_route', { p_route_id: saved.id })).toEqual({ deleted: 0 });
    expect((await db.rpc(other, 'list_routes')).routes).toEqual([]);
    await expect(db.rpc('anon', 'list_routes')).rejects.toMatchObject({ code: 'permission denied for function list_routes' });
    expect(await db.rpc(owner, 'get_route', { p_route_id: saved.id })).toMatchObject({ name: 'Lakefront' });
  });

  it('refuses anything that isn’t a plausible route', async () => {
    const runner = await db.createRunner('Route Rules');
    const refused = async (args: Record<string, unknown>) => expectCode(save(runner, args), 'invalid_input');
    await refused({ p_points: [[41.9, -87.62]] });
    await refused({ p_points: { lat: 41.9, lon: -87.62 } });
    await refused({ p_points: [[41.9, -87.62], [91, -87.62]] });
    await refused({ p_points: [[41.9, -87.62], ['41.91', -87.62]] });
    await refused({ p_points: [[41.9, -87.62], [41.91]] });
    await refused({ p_points: [[41.9, -87.62], { lat: 41.91, lon: -87.62 }] });
    // Too short, a jump of more than 25 km between points, and too many points.
    await refused({ p_points: [[41.9, -87.62], [41.9001, -87.62]] });
    await refused({ p_points: [[41.9, -87.62], [42.2, -87.62]] });
    await refused({ p_points: Array.from({ length: 5001 }, (_, k) => [41.9 + k * 0.0001, -87.62]) });
    await refused({ p_name: '   ' });
    await refused({ p_name: 'x'.repeat(41) });
    await refused({ p_kind: 'teleport' });
    await refused({ p_ascent_m: -5 });
    await refused({ p_cues: [{ i: 3, turn: 'left' }] });
    await refused({ p_cues: [{ i: 1, turn: 'moonwalk' }] });
    await refused({ p_cues: { i: 1, turn: 'left' } });

    // A long route with many points is fine, and measured by the server.
    const long = await save(runner, { p_points: Array.from({ length: 5000 }, (_, k) => [41.8 + k * 0.00005, -87.62]) });
    expect(long.distance_m).toBe(27_793);
    expect((await db.rpc(runner, 'list_routes')).routes[0].preview.length).toBeLessThanOrEqual(61);
  });

  it('keeps at most 100 routes per runner', async () => {
    const runner = await db.createRunner('Route Hoarder');
    await db.sql(
      `insert into private.saved_routes (user_id, name, kind, points, distance_m, start_lat, start_lon, min_lat, max_lat, min_lon, max_lon)
       select $1, 'Route ' || k, 'drawn', '[[41.9,-87.62],[41.91,-87.62]]'::jsonb, 1112, 41.9, -87.62, 41.9, 41.91, -87.62, -87.62
       from generate_series(1, 100) k`,
      [runner.id],
    );
    await expectCode(save(runner, {}), 'route_limit');
    const [one] = (await db.rpc(runner, 'list_routes')).routes;
    expect(await db.rpc(runner, 'save_route', { p_route_id: one.id, p_name: 'Still editable', p_kind: 'drawn', p_points: LAKEFRONT, p_cues: [], p_ascent_m: null })).toMatchObject({
      name: 'Still editable',
    });
  });

  it('checks the runner and their limits before planning, when a routing service is set up', async () => {
    const expectCode = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ message: code });
    const runner = await db.createRunner('Route Planner');
    await expectCode(db.sql('select private.route_plan_check($1, $2)', [runner.id, 'loop']), 'not_available');
    await db.sql('select private.set_routing_integration(true)');
    try {
      expect((await db.rpc(runner, 'list_routes')).planning_available).toBe(true);
      await db.sql('select private.route_plan_check($1, $2)', [runner.id, 'loop']);
      await expectCode(db.sql('select private.route_plan_check($1, $2)', [runner.id, 'walk']), 'invalid_input');
      const nobody = '00000000-0000-4000-8000-000000000000';
      await expectCode(db.sql('select private.route_plan_check($1, $2)', [nobody, 'leg']), 'profile_required');
      await db.rpc(runner, 'request_account_deletion');
      await expectCode(db.sql('select private.route_plan_check($1, $2)', [runner.id, 'leg']), 'account_deleting');
    } finally {
      await db.sql('select private.set_routing_integration(false)');
    }
  });

  it('puts routes in the export, and deletes them with the account', async () => {
    const runner = await db.createRunner('Route Leaver');
    await save(runner, { p_name: 'Canal path', p_cues: [{ i: 1, turn: 'right' }] });
    const extras = (await db.one<{ x: { routes: unknown[] } }>('select private.export_extras($1) as x', [runner.id])).x;
    expect(extras.routes).toEqual([expect.objectContaining({ name: 'Canal path', kind: 'drawn', distance_m: 1939, points: LAKEFRONT, cues: [expect.objectContaining({ turn: 'right', at_m: 1112 })] })]);

    await db.rpc(runner, 'request_account_deletion');
    await db.sql('select private.process_deletion_jobs()');
    expect(await db.sql('select 1 from private.saved_routes where user_id = $1', [runner.id])).toEqual([]);
  });
});
