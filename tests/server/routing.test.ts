import { ConfigError, loadConfig } from '../../server/src/config';
import { createLogger } from '../../server/src/log';
import { createGraphHopperApi, parseGraphHopperPath, planLoop, RoutingError, type LatLon, type RoutedPath, type RoutingApi } from '../../server/src/routing';
import { signIn, startTestApi, type TestApi } from './harness';

/**
 * Route planning (docs/ROADMAP.md 5.1): the API service plans legs and loops through a routing
 * service, after the database checks the runner and their limits.
 */

/** A square route of about `m` metres from `start`, as the routing service would draw it. */
function square(start: LatLon, m: number): [number, number][] {
  const side = m / 4 / 111_320;
  const dLon = side / Math.cos((start.lat * Math.PI) / 180);
  return [
    [start.lat, start.lon],
    [start.lat + side, start.lon],
    [start.lat + side, start.lon + dLon],
    [start.lat, start.lon + dLon],
    [start.lat, start.lon],
  ];
}

/** Deterministic noise in [-1, 1]. */
function noise(...xs: number[]): number {
  let h = 2166136261;
  for (const x of xs) {
    h ^= Math.round(x * 1000);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 20001) / 10000 - 1;
}

/**
 * Behaves like a real network (measured against GraphHopper 11 on OpenStreetMap data): each seed's
 * loops come out 20 % short to 15 % long, and the length jumps around as the distance asked for
 * moves between blocks of streets.
 */
class FakeRouter implements RoutingApi {
  calls = 0;
  legs: [LatLon, LatLon][] = [];
  failAll: RoutingError | null = null;
  fixedLoopM: number | null = null;

  async route(from: LatLon, to: LatLon): Promise<RoutedPath> {
    this.calls += 1;
    if (this.failAll) throw this.failAll;
    this.legs.push([from, to]);
    return {
      distanceM: 812,
      ascentM: null,
      points: [
        [from.lat, from.lon],
        [from.lat, to.lon],
        [to.lat, to.lon],
      ],
      cues: [{ i: 1, turn: 'left', street: 'Mill Lane', exit: null }],
    };
  }

  async roundTrip(start: LatLon, askM: number, seed: number): Promise<RoutedPath> {
    this.calls += 1;
    if (this.failAll) throw this.failAll;
    const ratio = 0.97 + 0.17 * noise(seed, start.lat, start.lon);
    const block = Math.floor(askM / 180);
    const distanceM = this.fixedLoopM ?? Math.round(askM * ratio * (1 + 0.05 * noise(seed, block, start.lon)));
    return { distanceM, ascentM: 40, points: square(start, distanceM), cues: [{ i: 1, turn: 'right', street: null, exit: null }] };
  }
}

describe('planning loops', () => {
  it('finds loops within 2 % of the distance asked for, in at most 16 calls', async () => {
    const router = new FakeRouter();
    let within = 0;
    let plans = 0;
    for (let k = 0; k < 12; k += 1) {
      const start = { lat: 41.88 + k * 0.013, lon: -87.63 - k * 0.007 };
      for (const target of [3_000, 5_000, 10_000, 21_100]) {
        const before = router.calls;
        const loop = await planLoop(router, start, target);
        plans += 1;
        expect(router.calls - before).toBe(loop.calls);
        expect(loop.calls).toBeLessThanOrEqual(16);
        const off = Math.abs(loop.path.distanceM - target) / target;
        expect(loop.withinTolerance).toBe(off <= 0.02);
        if (loop.withinTolerance) within += 1;
        // Never a loop further off than the first round's best guess would have been.
        expect(off).toBeLessThan(0.1);
      }
    }
    expect(within / plans).toBeGreaterThanOrEqual(0.9);
  });

  it('gives the closest loop, labelled, when none is within 2 %; and another one on request', async () => {
    const router = new FakeRouter();
    router.fixedLoopM = 4_200;
    const loop = await planLoop(router, { lat: 41.9, lon: -87.6 }, 5_000);
    expect(loop).toMatchObject({ withinTolerance: false, calls: 16 });
    expect(loop.path.distanceM).toBe(4_200);

    router.fixedLoopM = null;
    const first = await planLoop(router, { lat: 41.9, lon: -87.6 }, 10_000);
    const other = await planLoop(router, { lat: 41.9, lon: -87.6 }, 10_000, { variant: 1 });
    expect(other.path.points).not.toEqual(first.path.points);
  });

  it('stops after the first round when there is no path near the start', async () => {
    const router = new FakeRouter();
    router.failAll = new RoutingError('no_route', 'PointNotFoundException');
    await expect(planLoop(router, { lat: 0, lon: -140 }, 5_000)).rejects.toMatchObject({ code: 'no_route' });
    expect(router.calls).toBe(4);
  });
});

describe('the plan_route call', () => {
  let api: TestApi;
  const router = new FakeRouter();
  const lines: string[] = [];

  beforeAll(async () => {
    api = await startTestApi({ ROUTING_URL: 'https://graphhopper.example/api/1', ROUTING_API_KEY: 'gh-test-key' }, { routingApi: router, log: createLogger('debug', (line) => lines.push(line)) });
  });
  afterAll(async () => {
    await api.close();
  });

  async function runner(alias: string) {
    const { client, session } = await signIn(api);
    const saved = await client.rpc('save_profile', { p_alias: alias, p_units: 'metric', p_goal_days: 3, p_notification_tz: 'America/Chicago', p_ack_eligibility: true });
    expect(saved.error).toBeNull();
    return { client, id: session.user.id };
  }

  it('plans legs and loops for a signed-in runner, and says when routing is available', async () => {
    const { client } = await runner('Route Rita');
    expect((await client.rpc('list_routes')).data).toMatchObject({ planning_available: true, routes: [] });

    const leg = await client.rpc('plan_route', { p_mode: 'leg', p_from: { lat: 41.8801, lon: -87.6301 }, p_to: { lat: 41.8841, lon: -87.6251 } });
    expect(leg.error).toBeNull();
    expect(leg.data).toEqual({
      distance_m: 812,
      ascent_m: null,
      points: [
        [41.8801, -87.6301],
        [41.8801, -87.6251],
        [41.8841, -87.6251],
      ],
      cues: [{ i: 1, turn: 'left', street: 'Mill Lane', exit: null }],
      within_tolerance: null,
    });

    const loop = await client.rpc('plan_route', { p_mode: 'loop', p_start: { lat: 41.8801, lon: -87.6301 }, p_distance_m: 8_000 });
    expect(loop.error).toBeNull();
    expect(loop.data.within_tolerance).toBe(true);
    expect(Math.abs(loop.data.distance_m - 8_000)).toBeLessThanOrEqual(160);
    expect(loop.data.ascent_m).toBe(40);

    // Nothing about where anyone planned reaches the logs.
    const logged = lines.join('\n');
    expect(logged).toContain('route planned');
    expect(logged).not.toMatch(/41\.88|87\.6[23]|gh-test-key/);
  });

  it('checks the caller and what they send', async () => {
    const anon = await api.client().rpc('plan_route', { p_mode: 'leg', p_from: { lat: 1, lon: 1 }, p_to: { lat: 1.001, lon: 1 } });
    expect(anon.error?.message).toBe('not_authenticated');
    const { client: noProfile } = await signIn(api);
    const refused = await noProfile.rpc('plan_route', { p_mode: 'leg', p_from: { lat: 1, lon: 1 }, p_to: { lat: 1.001, lon: 1 } });
    expect(refused.error?.message).toBe('profile_required');

    const { client } = await runner('Route Rex');
    const bad = async (body: Record<string, unknown>) => (await client.rpc('plan_route', body)).error?.message;
    expect(await bad({ p_mode: 'fly' })).toBe('invalid_input');
    expect(await bad({ p_mode: 'leg', p_from: { lat: 91, lon: 0 }, p_to: { lat: 1, lon: 1 } })).toBe('invalid_input');
    expect(await bad({ p_mode: 'leg', p_from: { lat: 1, lon: 1 } })).toBe('invalid_input');
    expect(await bad({ p_mode: 'leg', p_from: { lat: 41, lon: -87 }, p_to: { lat: 41.4, lon: -87 } })).toBe('too_far');
    expect(await bad({ p_mode: 'loop', p_start: { lat: 41, lon: -87 }, p_distance_m: 500 })).toBe('invalid_input');
    expect(await bad({ p_mode: 'loop', p_start: { lat: 41, lon: -87 }, p_distance_m: 60_000 })).toBe('invalid_input');

    router.failAll = new RoutingError('no_route', 'PointNotFoundException');
    expect(await bad({ p_mode: 'loop', p_start: { lat: 0, lon: -140 }, p_distance_m: 5_000 })).toBe('no_route');
    router.failAll = new RoutingError('routing_failed', 'HTTP 503');
    const down = await client.rpc('plan_route', { p_mode: 'leg', p_from: { lat: 41, lon: -87 }, p_to: { lat: 41.001, lon: -87 } });
    expect(down.error?.message).toBe('routing_failed');
    expect(down.status).toBe(502);
    router.failAll = null;
  });

  it('limits how often a runner can plan, and lets teens plan while keeping minors out', async () => {
    const { client, id } = await runner('Route Rae');
    const loop = () => client.rpc('plan_route', { p_mode: 'loop', p_start: { lat: 41.9, lon: -87.7 }, p_distance_m: 5_000 });
    for (let k = 0; k < 12; k += 1) expect((await loop()).error).toBeNull();
    expect((await loop()).error?.message).toBe('rate_limited');

    await api.db.sql(`select private.set_flag('teen_accounts_enabled', true, 'route planning tests', 'ops-test')`);
    await api.db.sql(`update public.profiles set age_signal = 'teen_16_17' where user_id = $1`, [id]);
    const leg = await client.rpc('plan_route', { p_mode: 'leg', p_from: { lat: 41, lon: -87 }, p_to: { lat: 41.001, lon: -87 } });
    expect(leg.error).toBeNull();
    await api.db.sql(`update public.profiles set age_signal = 'minor' where user_id = $1`, [id]);
    const minor = await client.rpc('plan_route', { p_mode: 'leg', p_from: { lat: 41, lon: -87 }, p_to: { lat: 41.001, lon: -87 } });
    expect(minor.error?.message).toBe('age_restricted');
  });
});

describe('without a routing service', () => {
  it('says planning isn’t available, and drawing still saves', async () => {
    const api = await startTestApi();
    try {
      const { client } = await signIn(api);
      await client.rpc('save_profile', { p_alias: 'Draw Dee', p_units: 'metric', p_goal_days: 3, p_notification_tz: 'America/Chicago', p_ack_eligibility: true });
      expect((await client.rpc('list_routes')).data).toMatchObject({ planning_available: false });
      const planned = await client.rpc('plan_route', { p_mode: 'leg', p_from: { lat: 41, lon: -87 }, p_to: { lat: 41.001, lon: -87 } });
      expect(planned.error?.message).toBe('not_available');
      const saved = await client.rpc('save_route', {
        p_route_id: null,
        p_name: 'Lakefront',
        p_kind: 'drawn',
        p_points: [
          [41.9, -87.62],
          [41.91, -87.62],
        ],
      });
      expect(saved.error).toBeNull();
      expect(saved.data).toMatchObject({ name: 'Lakefront', kind: 'drawn', distance_m: 1112 });
    } finally {
      await api.close();
    }
  });
});

describe('GraphHopper client', () => {
  const config = { url: 'https://graphhopper.example/api/1', key: 'k 1', profile: 'foot', elevation: true, maxLoopCalls: 16 };

  it('asks for paths with walking rules and reads points, turns and climb', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          paths: [
            {
              distance: 1234.56,
              ascend: 21.4,
              points: { type: 'LineString', coordinates: [[-87.6, 41.9, 180], [-87.6, 41.905, 181], [-87.595, 41.905, 182], [-87.595, 41.91, 183]] },
              instructions: [
                { sign: 0, interval: [0, 1], street_name: 'State Street', text: 'Continue onto State Street' },
                { sign: -2, interval: [1, 2], street_name: 'Elm Street', text: 'Turn left onto Elm Street' },
                { sign: 6, interval: [2, 3], street_name: '', exit_number: 2, text: 'At roundabout, take exit 2' },
                { sign: -6, interval: [3, 3], street_name: '' },
                { sign: 4, interval: [3, 3], street_name: '', text: 'Arrive at destination' },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const gh = createGraphHopperApi(config, fetchImpl);
    const path = await gh.route({ lat: 41.9, lon: -87.6 }, { lat: 41.91, lon: -87.595 });
    expect(path).toEqual({
      distanceM: 1235,
      ascentM: 21,
      points: [
        [41.9, -87.6],
        [41.905, -87.6],
        [41.905, -87.595],
        [41.91, -87.595],
      ],
      cues: [
        { i: 1, turn: 'left', street: 'Elm Street', exit: null },
        { i: 2, turn: 'roundabout', street: null, exit: 2 },
      ],
    });
    expect(requests[0]!.url).toBe('https://graphhopper.example/api/1/route?key=k%201');
    expect(requests[0]!.body).toMatchObject({ profile: 'foot', points: [[-87.6, 41.9], [-87.595, 41.91]], points_encoded: false, instructions: true, elevation: true });

    await gh.roundTrip({ lat: 41.9, lon: -87.6 }, 5_555.5, 7);
    expect(requests[1]!.body).toMatchObject({ points: [[-87.6, 41.9]], algorithm: 'round_trip', 'round_trip.distance': 5556, 'round_trip.seed': 7 });
  });

  it('tells "nowhere to go from there" apart from the service failing', async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const noPoint = createGraphHopperApi(config, answer(400, { message: 'Cannot find point 0: 0.0,-140.0', hints: [{ message: 'x', details: 'com.graphhopper.util.exceptions.PointNotFoundException' }] }));
    await expect(noPoint.route({ lat: 0, lon: -140 }, { lat: 0, lon: -139.99 })).rejects.toMatchObject({ code: 'no_route' });
    const broken = createGraphHopperApi(config, answer(500, { message: 'boom' }));
    await expect(broken.route({ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 })).rejects.toMatchObject({ code: 'routing_failed', message: 'HTTP 500' });
    const offline = createGraphHopperApi(config, (async () => {
      throw new TypeError('fetch failed for https://graphhopper.example/api/1/route?key=k%201');
    }) as unknown as typeof fetch);
    await expect(offline.route({ lat: 0, lon: 0 }, { lat: 0, lon: 0.01 })).rejects.toMatchObject({ code: 'routing_failed', message: 'network error' });
    expect(() => parseGraphHopperPath({ distance: 5, points: { coordinates: [[1, 2]] } }, false)).toThrow(RoutingError);
  });

  it('is off until ROUTING_URL is set, and uses https outside the private network', () => {
    const base = { APP_ENV: 'staging', DATABASE_URL: 'postgres://x', PUBLIC_API_KEY: 'pl_staging_public_key_x', EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.c' };
    expect(loadConfig(base).routing).toBeNull();
    expect(() => loadConfig({ ...base, ROUTING_API_KEY: 'k' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ROUTING_URL: 'http://graphhopper.example' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ROUTING_URL: 'http://127.0.0.1:8989' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, ROUTING_URL: 'http://graphhopper.railway.internal:8989/' }).routing).toEqual({
      url: 'http://graphhopper.railway.internal:8989',
      key: null,
      profile: 'foot',
      elevation: false,
      maxLoopCalls: 16,
    });
    expect(loadConfig({ ...base, ROUTING_URL: 'https://graphhopper.com/api/1', ROUTING_API_KEY: 'key', ROUTING_ELEVATION: 'true', ROUTING_MAX_LOOP_CALLS: '8' }).routing).toMatchObject({
      key: 'key',
      elevation: true,
      maxLoopCalls: 8,
    });
    expect(() => loadConfig({ ...base, ROUTING_URL: 'https://graphhopper.com/api/1', ROUTING_PROFILE: 'foot; drop' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, APP_ENV: 'development', ROUTING_URL: 'http://127.0.0.1:8989' }).routing?.url).toBe('http://127.0.0.1:8989');
  });
});
