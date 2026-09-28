import { destinationPoint, haversineM, type LatLon } from '@/domain/geo';
import { Navigator, navCueText, spokenShortDistance, turnLabel, type NavEvent, type NavFix } from '@/domain/navigation';
import { deriveCues, toRoutePoint, type RouteCue, type RoutePoint } from '@/domain/routes';

/**
 * Following a planned route (docs/ROADMAP.md 5.1 and 5.2) with synthetic runs: GPS noise, detours,
 * an out-and-back, a loop, running it backwards and cutting a corner.
 */
const START: LatLon = { lat: 41.8781, lon: -87.6298 };

/** A route from legs of [bearing, metres], with its turns read from its shape. */
function route(legs: [number, number][], from: LatLon = START): { points: RoutePoint[]; cues: RouteCue[] } {
  const points: RoutePoint[] = [toRoutePoint(from)];
  let at = from;
  for (const [bearing, m] of legs) {
    at = destinationPoint(at, bearing, m);
    points.push(toRoutePoint(at));
  }
  return { points, cues: deriveCues(points) };
}

/** Deterministic noise in [-1, 1]. */
const noise = (k: number) => Math.sin(k * 12.9898) * 0.5 + Math.sin(k * 4.1414) * 0.5;

/**
 * A runner along waypoints at 3 m/s, a fix every 2 seconds, pushed sideways by up to `jitterM`.
 */
function run(waypoints: LatLon[], options: { jitterM?: number; startAt?: number; accuracyM?: number } = {}): NavFix[] {
  const fixes: NavFix[] = [];
  let t = options.startAt ?? 1_000_000;
  let k = 0;
  for (let w = 0; w < waypoints.length - 1; w++) {
    const a = waypoints[w]!;
    const b = waypoints[w + 1]!;
    const length = haversineM(a, b);
    const steps = Math.max(1, Math.round(length / 6));
    for (let s = w === 0 ? 0 : 1; s <= steps; s++) {
      const f = s / steps;
      let p = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
      if (options.jitterM) p = destinationPoint(p, (k * 97) % 360, Math.abs(noise(k)) * options.jitterM);
      fixes.push({ lat: p.lat, lon: p.lon, accuracyM: options.accuracyM ?? 8, at: t });
      t += 2_000;
      k += 1;
    }
  }
  return fixes;
}

const along = (legs: [number, number][], from: LatLon = START): LatLon[] => {
  const out = [from];
  for (const [bearing, m] of legs) out.push(destinationPoint(out[out.length - 1]!, bearing, m));
  return out;
};

function follow(nav: Navigator, fixes: NavFix[]): { events: NavEvent[]; at: number[] } {
  const events: NavEvent[] = [];
  const at: number[] = [];
  for (const fix of fixes) {
    for (const e of nav.update(fix)) {
      events.push(e);
      at.push(nav.view().progressM);
    }
  }
  return { events, at };
}

const kinds = (events: NavEvent[]) => events.map((e) => (e.kind === 'turn' ? `turn:${e.cue.turn}` : e.kind));

describe('following a route', () => {
  const L: [number, number][] = [
    [0, 500],
    [90, 500],
    [180, 300],
  ];

  it('announces each turn once, about 60 m before it, and the end', () => {
    const r = route(L);
    expect(r.cues.map((c) => c.turn)).toEqual(['right', 'right']);
    const nav = new Navigator(r);
    const { events, at } = follow(nav, run(along(L)));
    expect(kinds(events)).toEqual(['turn:right', 'turn:right', 'finished']);
    // The first fix inside 60 m of the turn (fixes are about 6 m apart).
    expect(at[0]).toBeGreaterThanOrEqual(439);
    expect(at[0]).toBeLessThan(447);
    expect((events[0] as { inM: number }).inM).toBeLessThanOrEqual(60);
    expect(nav.view()).toMatchObject({ finished: true, offRoute: false, remainingM: expect.any(Number) });
    expect(nav.view().remainingM).toBeLessThanOrEqual(30);
  });

  it('isn’t fooled by GPS noise of 15 m', () => {
    const nav = new Navigator(route(L));
    const { events } = follow(nav, run(along(L), { jitterM: 15, accuracyM: 12 }));
    expect(kinds(events)).toEqual(['turn:right', 'turn:right', 'finished']);
  });

  it('says when the runner is off the route and which way it is, and when they’re back', () => {
    const r = route([
      [0, 1200],
      [90, 300],
    ]);
    const nav = new Navigator(r);
    // 300 m up the route, 150 m west, 200 m north alongside it, then back to it.
    const path = along([
      [0, 300],
      [270, 150],
      [0, 200],
      [90, 150],
      [0, 700],
      [90, 300],
    ]);
    const { events } = follow(nav, run(path));
    // Said when it happens, then once a minute until the runner is back.
    expect(kinds(events)).toEqual(['off_route', 'off_route', 'off_route', 'back_on_route', 'turn:right', 'finished']);
    const sides = events.slice(0, 3).map((e) => (e as Extract<NavEvent, { kind: 'off_route' }>).side);
    // Heading west, away from it: behind. Running north beside it: to the right. Heading back: ahead.
    expect(sides).toEqual(['behind', 'right', 'ahead']);
    expect((events[0] as Extract<NavEvent, { kind: 'off_route' }>).distanceM).toBeGreaterThan(45);
    expect(navCueText(events[1]!, 'metric')).toBe("You're off the route. It's about 150 meters to your right.");
  });

  it('follows an out-and-back in order, finishing at the end and not the turnaround', () => {
    const outAndBack = route([
      [0, 600],
      [180, 600],
    ]);
    expect(outAndBack.cues.map((c) => c.turn)).toEqual(['u_turn']);
    const nav = new Navigator(outAndBack);
    const fixes = run(along([
      [0, 600],
      [180, 600],
    ]));
    const { events, at } = follow(nav, fixes);
    expect(kinds(events)).toEqual(['turn:u_turn', 'finished']);
    expect(at[1]).toBeGreaterThan(1170);
  });

  it('starts a loop at its start, not its end, and finishes after the whole loop', () => {
    const square: [number, number][] = [
      [0, 400],
      [90, 400],
      [180, 400],
      [270, 400],
    ];
    const nav = new Navigator(route(square));
    const fixes = run(along(square));
    nav.update(fixes[0]!);
    expect(nav.view()).toMatchObject({ joined: true, progressM: 0, finished: false });
    const { events } = follow(nav, fixes.slice(1));
    expect(kinds(events)).toEqual(['turn:right', 'turn:right', 'turn:right', 'finished']);
  });

  it('shows how far the start is until the runner joins, and joins wherever they reach it', () => {
    const r = route([
      [0, 1000],
      [90, 500],
    ]);
    const nav = new Navigator(r);
    // From 300 m east of the route's middle, to it, then along it.
    const from = destinationPoint(destinationPoint(START, 0, 500), 90, 300);
    const fixes = run([from, destinationPoint(START, 0, 500), destinationPoint(START, 0, 1000), destinationPoint(destinationPoint(START, 0, 1000), 90, 500)]);
    nav.update(fixes[0]!);
    expect(nav.view()).toMatchObject({ joined: false });
    expect(nav.view().toStartM).toBeGreaterThan(550);
    const { events } = follow(nav, fixes.slice(1));
    expect(kinds(events)).toEqual(['turn:right', 'finished']);
  });

  it('says once when the runner is going the wrong way along it', () => {
    const r = route([[0, 1000]]);
    const nav = new Navigator(r);
    const fixes = run(along([
      [0, 400],
      [180, 300],
    ]));
    const { events } = follow(nav, fixes);
    expect(kinds(events)).toEqual(['wrong_way']);
    expect(navCueText(events[0]!, 'metric')).toBe("You're going the wrong way on the route. Turn around.");
  });

  it('picks up a runner who cuts a corner, without announcing the turns they skipped', () => {
    const r = route([
      [0, 500],
      [90, 60],
      [0, 60],
      [90, 500],
    ]);
    expect(r.cues.map((c) => c.turn)).toEqual(['right', 'left', 'right']);
    const nav = new Navigator(r);
    // Diagonally across the little jog instead of round it.
    const fixes = run([START, destinationPoint(START, 0, 470), destinationPoint(destinationPoint(START, 0, 560), 90, 90), destinationPoint(destinationPoint(START, 0, 560), 90, 560)]);
    const { events } = follow(nav, fixes);
    expect(kinds(events).filter((k) => k === 'off_route')).toEqual([]);
    expect(kinds(events)[kinds(events).length - 1]).toBe('finished');
    // Each turn at most once.
    expect(new Set(events.filter((e) => e.kind === 'turn').map((e) => (e as { cue: RouteCue }).cue.i)).size).toBe(events.filter((e) => e.kind === 'turn').length);
  });

  it('carries on after a relaunch without repeating what it said', () => {
    const r = route(L);
    const fixes = run(along(L));
    const first = new Navigator(r);
    const half = Math.floor(fixes.length * 0.6);
    const before = follow(first, fixes.slice(0, half)).events;
    const resumed = new Navigator(r, first.saved());
    const after = follow(resumed, fixes.slice(half)).events;
    expect([...kinds(before), ...kinds(after)]).toEqual(['turn:right', 'turn:right', 'finished']);
  });

  it('ignores poor fixes', () => {
    const nav = new Navigator(route(L));
    const fixes = run(along(L)).slice(0, 20);
    follow(nav, fixes.slice(0, 10));
    const progress = nav.view().progressM;
    const far = destinationPoint(fixes[10]!, 270, 400);
    expect(nav.update({ ...far, accuracyM: 80, at: fixes[10]!.at })).toEqual([]);
    expect(nav.view().progressM).toBe(progress);
  });
});

describe('what the voice says', () => {
  const cue = (turn: RouteCue['turn'], street: string | null = null, exit: number | null = null): RouteCue => ({ i: 3, turn, street, exit });

  it('says turns in the runner’s units, with the street and what comes next', () => {
    expect(navCueText({ kind: 'turn', cue: cue('left', 'Elm Street'), inM: 58, then: null }, 'metric')).toBe('In 60 meters, turn left onto Elm Street.');
    expect(navCueText({ kind: 'turn', cue: cue('slight_right'), inM: 57, then: cue('left') }, 'imperial')).toBe('In 200 feet, bear right, then turn left.');
    expect(navCueText({ kind: 'turn', cue: cue('right'), inM: 12, then: null }, 'metric')).toBe('Turn right now.');
    expect(navCueText({ kind: 'turn', cue: cue('roundabout', null, 2), inM: 40, then: null }, 'metric')).toBe('In 40 meters, at the roundabout, take the second exit.');
    expect(navCueText({ kind: 'back_on_route' }, 'metric')).toBe('Back on the route.');
    expect(navCueText({ kind: 'finished' }, 'imperial')).toBe("You've reached the end of the route.");
    expect(navCueText({ kind: 'off_route', distanceM: 1500, side: null }, 'imperial')).toBe("You're off the route. It's about 0.9 miles.");
    expect(spokenShortDistance(3, 'metric')).toBe('10 meters');
    expect(turnLabel(cue('left', 'Elm Street'))).toBe('Left onto Elm Street');
    expect(turnLabel(cue('keep_right'))).toBe('Keep right');
  });
});
