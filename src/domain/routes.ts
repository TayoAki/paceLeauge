import { EARTH_RADIUS_M, haversineM, type LatLon } from './geo';

/**
 * Planned routes (docs/ROADMAP.md 5.1): the geometry the planner, the route pages and the run
 * screen share. The server (db/migrations/…_routes.sql) measures every saved route itself with
 * the same great-circle formula; these numbers are for the screens.
 */
export type TurnKind =
  | 'left'
  | 'right'
  | 'slight_left'
  | 'slight_right'
  | 'sharp_left'
  | 'sharp_right'
  | 'keep_left'
  | 'keep_right'
  | 'u_turn'
  | 'roundabout';

export const TURN_KINDS: readonly TurnKind[] = ['left', 'right', 'slight_left', 'slight_right', 'sharp_left', 'sharp_right', 'keep_left', 'keep_right', 'u_turn', 'roundabout'];

/** A turn at point `i` of a route. */
export interface RouteCue {
  i: number;
  turn: TurnKind;
  street: string | null;
  exit: number | null;
}

/** [lat, lon], as stored and sent. */
export type RoutePoint = [number, number];

export type RouteKind = 'loop' | 'path' | 'drawn';

/** Mirrors private.route_limits(). */
export const ROUTE_LIMITS = { routes: 100, points: 5000, distanceM: 200_000, gapM: 25_000, nameLength: 40 } as const;
/** Loops the planner offers, in km and in miles. */
export const LOOP_CHOICES_KM = [3, 5, 8, 10, 15, 21.1] as const;
export const LOOP_CHOICES_MI = [2, 3, 5, 6.2, 10, 13.1] as const;
/** The server plans loops of 1 to 50 km (server/src/routing.ts). */
export const LOOP_RANGE_M = { min: 1_000, max: 50_000 } as const;
/** How close a planned loop should be to the distance asked for. */
export const LOOP_TOLERANCE = 0.02;

const DEG = Math.PI / 180;

export const toLatLon = (p: RoutePoint): LatLon => ({ lat: p[0], lon: p[1] });
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
export const toRoutePoint = (p: LatLon): RoutePoint => [round6(p.lat), round6(p.lon)];

/** Distance along the route at each point. */
export function cumulativeM(points: readonly RoutePoint[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (let k = 0; k < points.length; k++) {
    if (k > 0) total += haversineM(toLatLon(points[k - 1]!), toLatLon(points[k]!));
    out.push(total);
  }
  return out;
}

export function pathLengthM(points: readonly RoutePoint[]): number {
  const cum = cumulativeM(points);
  return cum.length ? cum[cum.length - 1]! : 0;
}

/** Initial bearing from a to b, 0–360° clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dLambda = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Signed change of direction from one bearing to another, -180 (hard left) to 180 (hard right). */
export function turnAngle(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/** A change of direction as a turn, or null for straight on (less than 30°). */
export function turnFor(angle: number): TurnKind | null {
  const a = Math.abs(angle);
  if (a < 30) return null;
  const side = angle < 0 ? 'left' : 'right';
  if (a < 60) return side === 'left' ? 'slight_left' : 'slight_right';
  if (a < 135) return side;
  if (a < 170) return side === 'left' ? 'sharp_left' : 'sharp_right';
  return 'u_turn';
}

/** Local metric coordinates around `origin`, good to well under a metre over a few km. */
export function localXY(origin: LatLon, p: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - origin.lon) * DEG * EARTH_RADIUS_M * Math.cos(origin.lat * DEG),
    y: (p.lat - origin.lat) * DEG * EARTH_RADIUS_M,
  };
}

/** The point `m` metres along the route from index `from`, looking back or ahead. */
function pointAlong(points: readonly RoutePoint[], cum: readonly number[], from: number, m: number): LatLon {
  const target = cum[from]! + m;
  if (m >= 0) {
    for (let k = from + 1; k < points.length; k++) if (cum[k]! >= target) return toLatLon(points[k]!);
    return toLatLon(points[points.length - 1]!);
  }
  for (let k = from - 1; k >= 0; k--) if (cum[k]! <= target) return toLatLon(points[k]!);
  return toLatLon(points[0]!);
}

/**
 * Turns read from a route's shape, for routes drawn by hand: at each bend, the direction over
 * the 20 m before it against the 20 m after it. Bends closer than 15 m count once.
 */
export function deriveCues(points: readonly RoutePoint[]): RouteCue[] {
  const cum = cumulativeM(points);
  const cues: RouteCue[] = [];
  let lastAtM = -Infinity;
  for (let k = 1; k < points.length - 1; k++) {
    if (cum[k]! - lastAtM < 15) continue;
    const here = toLatLon(points[k]!);
    const before = pointAlong(points, cum, k, -20);
    const after = pointAlong(points, cum, k, 20);
    if (haversineM(before, here) < 3 || haversineM(here, after) < 3) continue;
    const turn = turnFor(turnAngle(bearingDeg(before, here), bearingDeg(here, after)));
    if (!turn) continue;
    cues.push({ i: k, turn, street: null, exit: null });
    lastAtM = cum[k]!;
  }
  return cues;
}

/** A stretch of a route: planned by the routing service (with its turns) or drawn straight. */
export interface RouteLeg {
  points: RoutePoint[];
  cues: RouteCue[];
  ascentM: number | null;
  /** Routed along paths, or a straight line the runner drew. */
  routed: boolean;
}

export function straightLeg(from: RoutePoint, to: RoutePoint): RouteLeg {
  return { points: [from, to], cues: [], ascentM: null, routed: false };
}

export interface JoinedRoute {
  points: RoutePoint[];
  cues: RouteCue[];
  distanceM: number;
  ascentM: number | null;
}

/**
 * One route from its legs, in order: shared end points once, each leg's turns moved to their
 * place in the whole, and a turn where two legs meet if the route bends there. The climb is
 * known only when every leg's is.
 */
export function joinLegs(legs: readonly RouteLeg[]): JoinedRoute {
  const points: RoutePoint[] = [];
  const cues: RouteCue[] = [];
  let ascent: number | null = legs.length > 0 ? 0 : null;
  for (const leg of legs) {
    if (leg.points.length === 0) continue;
    const joint = points.length > 0 ? points.length - 1 : null;
    const same = joint !== null && samePoint(points[joint]!, leg.points[0]!);
    const offset = joint === null ? 0 : same ? joint : points.length;
    points.push(...(same ? leg.points.slice(1) : leg.points));
    if (joint !== null && joint > 0 && offset + 1 < points.length) {
      // The bend where the legs meet: straight lines' own turns come from their shape.
      const turn = turnFor(turnAngle(bearingDeg(toLatLon(points[joint - 1]!), toLatLon(points[joint]!)), bearingDeg(toLatLon(points[joint]!), toLatLon(points[joint + 1]!))));
      const firstOwn = leg.cues[0];
      if (turn && !(firstOwn && firstOwn.i === 0)) cues.push({ i: joint, turn, street: null, exit: null });
    }
    for (const cue of leg.cues) cues.push({ ...cue, i: cue.i + offset });
    ascent = ascent === null || leg.ascentM === null ? null : ascent + leg.ascentM;
  }
  const sorted = cues.filter((c) => c.i > 0 && c.i < points.length).sort((a, b) => a.i - b.i);
  const unique = sorted.filter((c, k) => k === 0 || c.i !== sorted[k - 1]!.i);
  return { points, cues: unique, distanceM: pathLengthM(points), ascentM: ascent };
}

function samePoint(a: RoutePoint, b: RoutePoint): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/**
 * Fewer points, the same route to within `toleranceM` (Douglas–Peucker), keeping every point a
 * turn is at. Keeps saved routes and what goes to the watch small.
 */
export function simplifyRoute(points: readonly RoutePoint[], cues: readonly RouteCue[], toleranceM = 3): { points: RoutePoint[]; cues: RouteCue[] } {
  if (points.length <= 2) return { points: [...points], cues: [...cues] };
  const origin = toLatLon(points[0]!);
  const xy = points.map((p) => localXY(origin, toLatLon(p)));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  for (const c of cues) if (c.i >= 0 && c.i < points.length) keep[c.i] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = toleranceM;
    for (let k = a + 1; k < b; k++) {
      const d = segmentDistance(xy[k]!, xy[a]!, xy[b]!);
      if (d > worstD) {
        worst = k;
        worstD = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  // Split at points kept for turns too, so a stretch's ends always survive.
  const index = new Map<number, number>();
  const out: RoutePoint[] = [];
  for (let k = 0; k < points.length; k++) {
    if (!keep[k]) continue;
    index.set(k, out.length);
    out.push(points[k]!);
  }
  return { points: out, cues: cues.filter((c) => index.has(c.i)).map((c) => ({ ...c, i: index.get(c.i)! })) };
}

function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);
}

/** A planned route as a GPX 1.1 track, which Garmin Connect, COROS, Suunto and most watches import as a course. */
export function routeToGpx(name: string, points: readonly RoutePoint[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="PaceLeague" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${escapeXml(name)}</name></metadata>`,
    '  <trk>',
    `    <name>${escapeXml(name)}</name>`,
    '    <trkseg>',
    ...points.map((p) => `      <trkpt lat="${p[0]}" lon="${p[1]}"></trkpt>`),
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

/** A file name for a route's GPX. */
export function routeFileName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
  return `${base || 'route'}.gpx`;
}

/** A name for a new route: "10 km loop", "5.2 mi route". */
export function defaultRouteName(kind: RouteKind, distanceM: number, units: 'metric' | 'imperial'): string {
  const value = units === 'imperial' ? distanceM / 1609.344 : distanceM / 1000;
  const shown = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${shown} ${units === 'imperial' ? 'mi' : 'km'} ${kind === 'loop' ? 'loop' : 'route'}`;
}
