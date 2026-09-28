import type { SavedRoute } from '@/api/routes-api';
import { destinationPoint, haversineM } from '@/domain/geo';
import {
  cumulativeM,
  defaultRouteName,
  deriveCues,
  joinLegs,
  pathLengthM,
  routeFileName,
  routeToGpx,
  simplifyRoute,
  straightLeg,
  toRoutePoint,
  turnFor,
  type RouteLeg,
  type RoutePoint,
} from '@/domain/routes';
import { addPoint, drawn, drawnKind, EMPTY_DRAW, nextFrom, toRouteInput, undo } from '@/features/routes/planner';
import { RouteController, ROUTE_FOLLOW_KEY } from '@/features/routes/route-controller';
import { routeSummary, shortDistance } from '@/features/routes/route-text';
import type { WatchLinkPort } from '@/features/watch/watch-link';
import { sendRouteToWatch, watchRouteFile, WATCH_ROUTE_MAX_POINTS } from '@/features/watch/watch-routes';

/** Planned routes (docs/ROADMAP.md 5.1): the geometry, the planner, following one, and the watch. */
const START = { lat: 41.8781, lon: -87.6298 };
const at = (legs: [number, number][]): RoutePoint[] => {
  const out: RoutePoint[] = [toRoutePoint(START)];
  let p = START;
  for (const [bearing, m] of legs) {
    p = destinationPoint(p, bearing, m);
    out.push(toRoutePoint(p));
  }
  return out;
};

describe('route geometry', () => {
  it('measures a route the way the server does', () => {
    const points = at([
      [0, 1000],
      [90, 500],
    ]);
    expect(cumulativeM(points)[1]).toBeCloseTo(1000, 0);
    expect(pathLengthM(points)).toBeCloseTo(1500, 0);
    expect(pathLengthM([])).toBe(0);
  });

  it('reads turns from a drawn route’s shape', () => {
    expect(turnFor(10)).toBeNull();
    expect(turnFor(-45)).toBe('slight_left');
    expect(turnFor(90)).toBe('right');
    expect(turnFor(-150)).toBe('sharp_left');
    expect(turnFor(178)).toBe('u_turn');
    const zigzag = at([
      [0, 300],
      [45, 300],
      [315, 300],
      [0, 5],
      [270, 300],
    ]);
    // North-east, then north-west (a left), then a 5 m jog north and west: one bend, a slight left.
    expect(deriveCues(zigzag).map((c) => c.turn)).toEqual(['slight_right', 'left', 'slight_left']);
    // A straight path with a wobble of a metre or two has no turns.
    const straight: RoutePoint[] = Array.from({ length: 40 }, (_, k) => toRoutePoint(destinationPoint(destinationPoint(START, 0, k * 25), 90, k % 2)));
    expect(deriveCues(straight)).toEqual([]);
  });

  it('joins planned legs into one route, keeping their turns in place and adding bends where they meet', () => {
    const a = at([[0, 400]]);
    const b0 = a[1]!;
    const bEnd = toRoutePoint(destinationPoint({ lat: b0[0], lon: b0[1] }, 90, 400));
    const bMid = toRoutePoint(destinationPoint({ lat: b0[0], lon: b0[1] }, 90, 200));
    const first: RouteLeg = { points: a, cues: [], ascentM: 5, routed: true };
    const second: RouteLeg = { points: [b0, bMid, bEnd], cues: [{ i: 1, turn: 'keep_left', street: 'Elm Street', exit: null }], ascentM: 7, routed: true };
    const joined = joinLegs([first, second]);
    expect(joined.points).toHaveLength(4);
    expect(joined.cues).toEqual([
      { i: 1, turn: 'right', street: null, exit: null },
      { i: 2, turn: 'keep_left', street: 'Elm Street', exit: null },
    ]);
    expect(joined.ascentM).toBe(12);
    expect(joined.distanceM).toBeCloseTo(800, 0);
    // Any stretch without a known climb makes the whole climb unknown.
    expect(joinLegs([first, straightLeg(b0, bEnd)]).ascentM).toBeNull();
  });

  it('keeps saved routes small without moving them or losing a turn', () => {
    const dense: RoutePoint[] = [];
    for (let k = 0; k <= 1000; k++) dense.push(toRoutePoint(destinationPoint(START, 0, k)));
    for (let k = 1; k <= 500; k++) dense.push(toRoutePoint(destinationPoint({ lat: dense[1000]![0], lon: dense[1000]![1] }, 90, k)));
    const cues = [{ i: 1000, turn: 'right' as const, street: null, exit: null }];
    const small = simplifyRoute(dense, cues, 2);
    expect(small.points.length).toBeLessThanOrEqual(4);
    expect(small.cues).toEqual([{ i: small.points.findIndex((p) => p === dense[1000]), turn: 'right', street: null, exit: null }]);
    expect(Math.abs(pathLengthM(small.points) - pathLengthM(dense))).toBeLessThan(1);
  });

  it('writes GPX that other apps read, with a safe file name and a default name', () => {
    const gpx = routeToGpx('Tom & Jerry’s <loop>', at([[0, 100]]));
    expect(gpx).toContain('<name>Tom &amp; Jerry’s &lt;loop&gt;</name>');
    expect(gpx).toContain('<trkpt lat="41.8781" lon="-87.6298"></trkpt>');
    expect(routeFileName('Tom & Jerry’s <loop>')).toBe('tom-jerrys-loop.gpx');
    expect(routeFileName('!!!')).toBe('route.gpx');
    expect(defaultRouteName('loop', 10_040, 'metric')).toBe('10 km loop');
    expect(defaultRouteName('path', 8_400, 'imperial')).toBe('5.2 mi route');
    expect(routeSummary({ distance_m: 10_040, kind: 'loop', turns: 1, ascent_m: 85 }, 'metric')).toBe('10.0 km · Loop · 1 turn · 85 m climb');
    expect(shortDistance(345, 'metric')).toBe('350 m');
    expect(shortDistance(250, 'imperial')).toBe('820 ft');
    expect(shortDistance(345, 'imperial')).toBe('0.2 mi');
  });
});

describe('the planner', () => {
  it('adds stretches from the end of the last one, undoes them, and says what kind of route it is', () => {
    const [a, b, c] = at([
      [0, 300],
      [90, 300],
    ]);
    let state = addPoint(EMPTY_DRAW, a!, null);
    expect(drawn(state)).toBeNull();
    state = addPoint(state, b!, null);
    // A planned stretch ends where the paths do, a little off the tapped point.
    const snappedEnd = toRoutePoint(destinationPoint({ lat: c![0], lon: c![1] }, 180, 8));
    state = addPoint(state, c!, { points: [b!, snappedEnd], cues: [], ascentM: null, routed: true });
    expect(nextFrom(state)).toEqual(snappedEnd);
    expect(drawnKind(state)).toBe('path');
    expect(drawn(state)!.cues.map((x) => x.turn)).toEqual(['right']);
    const input = toRouteInput('  Lunch loop ', 'path', drawn(state)!);
    expect(input).toMatchObject({ name: 'Lunch loop', kind: 'path', ascentM: null });
    state = undo(state);
    expect(drawnKind(state)).toBe('drawn');
    expect(state.points).toHaveLength(2);
    expect(undo(undo(state))).toEqual(EMPTY_DRAW);
  });
});

class MemoryKv {
  values = new Map<string, unknown>();
  async getKv<T>(key: string) {
    return this.values.has(key) ? { value: this.values.get(key) as T } : null;
  }
  async setKv(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

describe('following a route on a run', () => {
  const points = at([
    [0, 500],
    [90, 400],
  ]);
  const route = { id: 'r1', name: 'Around the block', points, cues: deriveCues(points), distanceM: pathLengthM(points) };
  const fixes = (from: number, to: number) => {
    const out = [];
    for (let m = from; m <= to; m += 6) {
      const p = m <= 500 ? destinationPoint(START, 0, m) : destinationPoint(destinationPoint(START, 0, 500), 90, m - 500);
      out.push({ lat: p.lat, lon: p.lon, accuracyM: 6, at: 1_000_000 + m * 400 });
    }
    return out;
  };

  it('binds the chosen route to the run, speaks its turns, and carries on after a relaunch', async () => {
    const kv = new MemoryKv();
    const controller = new RouteController(kv);
    controller.prepare(route);
    expect(controller.getSnapshot()).toMatchObject({ route: { name: 'Around the block' }, view: null });
    controller.runStarted('run-1');
    const said: string[] = [];
    for (const fix of fixes(0, 480)) {
      const text = controller.update('run-1', fix, 'metric');
      if (text) said.push(text);
    }
    expect(said).toEqual(['In 60 meters, turn right.']);
    expect(controller.getSnapshot()!.view!.remainingM).toBeLessThan(430);
    expect(kv.values.get(ROUTE_FOLLOW_KEY)).toMatchObject({ runId: 'run-1', route: { id: 'r1' } });

    // The app is closed and opened again mid-run: no turn is said twice.
    const reopened = new RouteController(kv);
    await reopened.restore();
    const later: string[] = [];
    for (const fix of fixes(486, 900)) {
      const text = reopened.update('run-1', fix, 'metric');
      if (text) later.push(text);
    }
    expect(later).toEqual(["You've reached the end of the route."]);
    reopened.runEnded('run-1');
    expect(reopened.getSnapshot()).toBeNull();
    expect(kv.values.get(ROUTE_FOLLOW_KEY)).toBeNull();
  });

  it('keeps the screen’s distance from the route current while the runner is off it', () => {
    const controller = new RouteController(new MemoryKv());
    controller.prepare(route);
    controller.runStarted('run-3');
    let t = 1_000_000;
    for (const fix of fixes(0, 200)) controller.update('run-3', { ...fix, at: (t += 2_000) }, 'metric');
    // Off to the west, further and further.
    const shown: number[] = [];
    for (let m = 10; m <= 200; m += 10) {
      const p = destinationPoint(destinationPoint(START, 0, 200), 270, m);
      controller.update('run-3', { lat: p.lat, lon: p.lon, accuracyM: 6, at: (t += 3_000) }, 'metric');
      const view = controller.getSnapshot()!.view!;
      if (view.offRoute) shown.push(Math.round(view.fromRouteM!));
    }
    expect(shown.length).toBeGreaterThan(5);
    expect(shown[shown.length - 1]).toBeCloseTo(200, -1);
    expect(shown[shown.length - 1]).toBeGreaterThan(shown[0]!);
  });

  it('forgets a route the runner didn’t start, and a run without a route follows none', () => {
    const controller = new RouteController(new MemoryKv());
    controller.prepare(route);
    controller.cancel();
    expect(controller.getSnapshot()).toBeNull();
    controller.runStarted('run-2');
    expect(controller.update('run-2', fixes(0, 0)[0]!, 'metric')).toBeNull();
    expect(controller.getSnapshot()).toBeNull();
  });
});

describe('sending a route to the Apple Watch', () => {
  const dense: RoutePoint[] = Array.from({ length: 4000 }, (_, k) => toRoutePoint(destinationPoint(destinationPoint(START, 0, k * 5), 90, 30 * Math.sin(k / 20))));
  const saved: SavedRoute = {
    id: 'r9',
    name: 'River wiggle',
    kind: 'path',
    distance_m: Math.round(pathLengthM(dense)),
    ascent_m: null,
    start: { lat: dense[0]![0], lon: dense[0]![1] },
    bbox: [0, 0, 0, 0],
    turns: 1,
    created_at_ms: 0,
    updated_at_ms: 0,
    points: dense,
    cues: [{ i: 2000, turn: 'left', street: 'River Walk', exit: null, at_m: 10_000 }],
  };

  it('sends fewer points, the same route to within a few metres, with its turns', () => {
    const file = watchRouteFile(saved, 'imperial');
    expect(file.points.length).toBeLessThanOrEqual(WATCH_ROUTE_MAX_POINTS);
    expect(file).toMatchObject({ version: 1, id: 'r9', name: 'River wiggle', units: 'imperial', cues: [{ turn: 'left', street: 'River Walk' }] });
    expect(file.points[file.cues[0]!.i]).toEqual(dense[2000]);
    expect(Math.abs(pathLengthM(file.points) - saved.distance_m) / saved.distance_m).toBeLessThan(0.01);
    expect(haversineM({ lat: file.points[0]![0], lon: file.points[0]![1] }, saved.start)).toBe(0);
  });

  it('says why it couldn’t send', () => {
    const sent: string[] = [];
    const link = (installed: boolean, ok = true): WatchLinkPort => ({
      status: () => ({ supported: true, paired: true, installed, reachable: false }),
      updateContext: () => true,
      pendingRuns: () => [],
      ackRun: () => undefined,
      onRun: () => () => undefined,
      onWorkout: () => () => undefined,
      sendRoute: (json) => {
        sent.push(json);
        return ok;
      },
    });
    expect(sendRouteToWatch(null, saved, 'metric')).toBe('no_watch');
    expect(sendRouteToWatch(link(false), saved, 'metric')).toBe('not_installed');
    expect(sendRouteToWatch(link(true, false), saved, 'metric')).toBe('failed');
    expect(sendRouteToWatch(link(true), saved, 'metric')).toBe('sent');
    expect(JSON.parse(sent[sent.length - 1]!)).toMatchObject({ id: 'r9', units: 'metric' });
  });
});
