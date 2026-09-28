import type { RoutingConfig } from './config';
import type { Pool } from './db';
import type { Logger } from './log';

/**
 * Route planning (docs/ROADMAP.md 5.1) through a routing service with a walking profile:
 * GraphHopper's Routing API, hosted (graphhopper.com, with a key) or self-hosted (the same API,
 * open source). The service calls it so the key never reaches the app, and the database limits
 * how often each runner can plan (db/migrations/…_routes.sql).
 *
 *  - A leg: the path between two points the runner tapped, following paths and streets.
 *  - A loop: a round trip of a chosen distance from a start. The routing service's round trips
 *    come out 10–20 % off the distance asked for, so planLoop asks for several at once and
 *    corrects the distance it asks for until one is within 2 % (checked against GraphHopper 11
 *    with OpenStreetMap data: 135 of 150 loops of 3–21 km around Cambridge, UK, averaging eight
 *    calls). Otherwise the runner gets the closest, labelled with its real distance.
 *
 * Nothing about where a runner plans is logged.
 */
export interface LatLon {
  lat: number;
  lon: number;
}

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

/** A turn at point `i` of the path (db: private.route_cues). */
export interface RouteCue {
  i: number;
  turn: TurnKind;
  street: string | null;
  exit: number | null;
}

export interface RoutedPath {
  distanceM: number;
  ascentM: number | null;
  /** [lat, lon] with 6 decimals. */
  points: [number, number][];
  cues: RouteCue[];
}

export class RoutingError extends Error {
  constructor(
    /** no_route: nothing to follow from or to there; routing_failed: the service didn't answer. */
    readonly code: 'no_route' | 'routing_failed',
    message: string,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

export interface RoutingApi {
  route(from: LatLon, to: LatLon): Promise<RoutedPath>;
  roundTrip(start: LatLon, distanceM: number, seed: number): Promise<RoutedPath>;
}

/** GraphHopper's instruction signs (com.graphhopper.util.Instruction). Straight on, arriving and leaving a roundabout say nothing. */
const SIGNS: Record<number, TurnKind> = {
  [-98]: 'u_turn',
  [-8]: 'u_turn',
  [-7]: 'keep_left',
  [-3]: 'sharp_left',
  [-2]: 'left',
  [-1]: 'slight_left',
  1: 'slight_right',
  2: 'right',
  3: 'sharp_right',
  6: 'roundabout',
  7: 'keep_right',
  8: 'u_turn',
};

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface GraphHopperPath {
  distance?: unknown;
  ascend?: unknown;
  points?: { coordinates?: unknown };
  instructions?: { sign?: unknown; interval?: unknown; street_name?: unknown; exit_number?: unknown }[];
}

/** Reads one path from GraphHopper's answer (points_encoded=false). */
export function parseGraphHopperPath(path: GraphHopperPath, withElevation: boolean): RoutedPath {
  const coordinates = Array.isArray(path.points?.coordinates) ? (path.points.coordinates as unknown[]) : [];
  const points: [number, number][] = [];
  for (const c of coordinates) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    points.push([round6(c[1]), round6(c[0])]);
  }
  if (points.length < 2 || typeof path.distance !== 'number' || !Number.isFinite(path.distance)) {
    throw new RoutingError('routing_failed', 'malformed path');
  }
  const cues: RouteCue[] = [];
  for (const instruction of path.instructions ?? []) {
    const turn = typeof instruction.sign === 'number' ? SIGNS[instruction.sign] : undefined;
    const interval = instruction.interval;
    if (!turn || !Array.isArray(interval) || typeof interval[0] !== 'number') continue;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(interval[0])));
    const street = typeof instruction.street_name === 'string' && instruction.street_name.trim() ? instruction.street_name.trim().slice(0, 80) : null;
    const exit = typeof instruction.exit_number === 'number' && instruction.exit_number >= 1 && instruction.exit_number <= 12 ? instruction.exit_number : null;
    cues.push({ i, turn, street, exit: turn === 'roundabout' ? exit : null });
  }
  const ascent = withElevation && typeof path.ascend === 'number' && Number.isFinite(path.ascend) ? Math.round(path.ascend) : null;
  return { distanceM: Math.round(path.distance), ascentM: ascent, points, cues };
}

export function createGraphHopperApi(config: RoutingConfig, fetchImpl: typeof fetch = fetch): RoutingApi {
  const endpoint = `${config.url}/route${config.key ? `?key=${encodeURIComponent(config.key)}` : ''}`;
  const request = async (body: Record<string, unknown>): Promise<RoutedPath> => {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: config.profile,
          points_encoded: false,
          instructions: true,
          elevation: config.elevation,
          locale: 'en',
          ...body,
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      // Not the error's own text, which could carry the URL and its key into the logs.
      throw new RoutingError('routing_failed', error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error');
    }
    const text = await res.text();
    let json: { paths?: GraphHopperPath[]; message?: unknown; hints?: { details?: unknown }[] } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      // GraphHopper answers 400 when a point is nowhere near a path, or two points aren't connected.
      const details = (json.hints ?? []).map((h) => String(h.details ?? '')).join(' ');
      if (res.status === 400 && /PointNotFound|ConnectionNotFound|PointOutOfBounds|MaximumNodesExceeded/.test(details)) {
        throw new RoutingError('no_route', details);
      }
      throw new RoutingError('routing_failed', `HTTP ${res.status}`);
    }
    const path = json.paths?.[0];
    if (!path) throw new RoutingError('no_route', 'no path');
    return parseGraphHopperPath(path, config.elevation);
  };
  return {
    route: (from, to) =>
      request({
        points: [
          [from.lon, from.lat],
          [to.lon, to.lat],
        ],
      }),
    roundTrip: (start, distanceM, seed) =>
      request({
        points: [[start.lon, start.lat]],
        algorithm: 'round_trip',
        'round_trip.distance': Math.round(distanceM),
        'round_trip.seed': seed,
      }),
  };
}

/** How close a planned loop must be to the distance asked for (docs/ROADMAP.md 5.1). */
export const LOOP_TOLERANCE = 0.02;
const LOOP_BATCH = 4;
/** Round trips come out shorter than asked on most networks; the first guess allows for that. */
const LOOP_PRIOR_RATIO = 0.9;

export interface PlannedLoop {
  path: RoutedPath;
  calls: number;
  withinTolerance: boolean;
}

/**
 * A round trip of about `targetM`: four candidates at a time, each later round correcting the
 * distance asked of the two closest (by how far off each came out) and trying two new ones with
 * the median correction, until one is within the tolerance or the calls run out. `variant`
 * starts from other candidates, for "Try another".
 */
export async function planLoop(
  api: RoutingApi,
  start: LatLon,
  targetM: number,
  options: { variant?: number; maxCalls?: number; tolerance?: number } = {},
): Promise<PlannedLoop> {
  const tolerance = options.tolerance ?? LOOP_TOLERANCE;
  const maxCalls = Math.max(1, options.maxCalls ?? 16);
  const off = (path: RoutedPath) => Math.abs(path.distanceM - targetM);
  const clampAsk = (m: number) => Math.min(targetM * 2, Math.max(targetM * 0.5, m));
  let nextSeed = (options.variant ?? 0) * 1000;
  let best: RoutedPath | null = null;
  let lastError: unknown = null;
  let calls = 0;
  const ratios: number[] = [];
  const asked = new Set<string>();
  let requests = Array.from({ length: LOOP_BATCH }, () => ({ seed: nextSeed++, askM: clampAsk(targetM / LOOP_PRIOR_RATIO) }));

  while (requests.length > 0 && calls < maxCalls) {
    requests = requests.slice(0, maxCalls - calls);
    for (const r of requests) asked.add(`${r.seed}:${Math.round(r.askM / 10)}`);
    const settled = await Promise.allSettled(requests.map((r) => api.roundTrip(start, r.askM, r.seed)));
    calls += requests.length;
    const results: { seed: number; askM: number; path: RoutedPath }[] = [];
    for (let k = 0; k < settled.length; k += 1) {
      const s = settled[k]!;
      const r = requests[k]!;
      if (s.status === 'fulfilled') {
        results.push({ ...r, path: s.value });
        if (s.value.distanceM > 0) ratios.push(s.value.distanceM / r.askM);
        if (!best || off(s.value) < off(best)) best = s.value;
      } else {
        lastError = s.reason;
      }
    }
    if (best && off(best) <= tolerance * targetM) break;
    // Nothing at all from the start: there's no path near it, so more tries won't help.
    if (!best && lastError instanceof RoutingError && lastError.code === 'no_route') break;

    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : LOOP_PRIOR_RATIO;
    const next: { seed: number; askM: number }[] = [];
    for (const r of results.sort((a, b) => off(a.path) - off(b.path)).slice(0, LOOP_BATCH / 2)) {
      if (r.path.distanceM <= 0) continue;
      const askM = clampAsk(targetM / (r.path.distanceM / r.askM));
      if (!asked.has(`${r.seed}:${Math.round(askM / 10)}`)) next.push({ seed: r.seed, askM });
    }
    while (next.length < LOOP_BATCH) next.push({ seed: nextSeed++, askM: clampAsk(targetM / median) });
    requests = next;
  }
  if (!best) throw lastError instanceof RoutingError ? lastError : new RoutingError('routing_failed', 'no loop');
  return { path: best, calls, withinTolerance: off(best) <= tolerance * targetM };
}

export class PlanInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PlanInputError';
  }
}

const LOOP_MIN_M = 1_000;
const LOOP_MAX_M = 50_000;
/** Farther apart than this, two tapped points aren't one leg of a run. */
const LEG_MAX_M = 30_000;

function point(value: unknown): LatLon {
  const v = value as { lat?: unknown; lon?: unknown } | null;
  if (!v || typeof v.lat !== 'number' || typeof v.lon !== 'number' || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) {
    throw new PlanInputError('invalid_input');
  }
  if (v.lat < -90 || v.lat > 90 || v.lon < -180 || v.lon > 180) throw new PlanInputError('invalid_input');
  return { lat: v.lat, lon: v.lon };
}

function straightM(a: LatLon, b: LatLon): number {
  const k = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * k) / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(((b.lon - a.lon) * k) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface PlanResult {
  distance_m: number;
  ascent_m: number | null;
  points: [number, number][];
  cues: RouteCue[];
  /** Loops: whether it's within 2 % of the distance asked for. */
  within_tolerance: boolean | null;
}

/** The `plan_route` call: body { p_mode: 'leg', p_from, p_to } or { p_mode: 'loop', p_start, p_distance_m, p_variant }. */
export async function planRoute(
  deps: { pool: Pool; api: RoutingApi; config: RoutingConfig; log: Logger },
  userId: string,
  body: Record<string, unknown>,
): Promise<PlanResult> {
  const mode = body.p_mode;
  if (mode !== 'leg' && mode !== 'loop') throw new PlanInputError('invalid_input');
  let from: LatLon | null = null;
  let to: LatLon | null = null;
  let start: LatLon | null = null;
  let distanceM = 0;
  let variant = 0;
  if (mode === 'leg') {
    from = point(body.p_from);
    to = point(body.p_to);
    if (straightM(from, to) > LEG_MAX_M) throw new PlanInputError('too_far');
  } else {
    start = point(body.p_start);
    distanceM = typeof body.p_distance_m === 'number' ? Math.round(body.p_distance_m) : NaN;
    if (!Number.isFinite(distanceM) || distanceM < LOOP_MIN_M || distanceM > LOOP_MAX_M) throw new PlanInputError('invalid_input');
    variant = typeof body.p_variant === 'number' && Number.isInteger(body.p_variant) && body.p_variant >= 0 && body.p_variant <= 99 ? body.p_variant : 0;
  }
  try {
    await deps.pool.query('select private.route_plan_check($1, $2)', [userId, mode]);
  } catch (error) {
    throw new PlanInputError((error as { message?: string }).message ?? 'server_error');
  }
  const started = Date.now();
  if (mode === 'leg') {
    const path = await deps.api.route(from!, to!);
    deps.log.info('route planned', { mode, calls: 1, ms: Date.now() - started });
    return { distance_m: path.distanceM, ascent_m: path.ascentM, points: path.points, cues: path.cues, within_tolerance: null };
  }
  const loop = await planLoop(deps.api, start!, distanceM, { variant, maxCalls: deps.config.maxLoopCalls });
  deps.log.info('route planned', { mode, calls: loop.calls, within: loop.withinTolerance, ms: Date.now() - started });
  return {
    distance_m: loop.path.distanceM,
    ascent_m: loop.path.ascentM,
    points: loop.path.points,
    cues: loop.path.cues,
    within_tolerance: loop.withinTolerance,
  };
}

/** Tells the database whether route planning is available. */
export async function publishRoutingSettings(pool: Pool, config: RoutingConfig | null): Promise<void> {
  await pool.query('select private.set_routing_integration($1)', [config !== null]);
}
