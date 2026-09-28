import type { Planned, RouteInput } from '@/api/routes-api';
import { joinLegs, simplifyRoute, straightLeg, type JoinedRoute, type RouteKind, type RouteLeg, type RoutePoint } from '@/domain/routes';

/**
 * The route planner's state (docs/ROADMAP.md 5.1). Drawing: the runner taps points, and each
 * stretch between two follows paths when the routing service is on (snapped), or is a straight
 * line. Undo takes the last point off; closing the loop adds a stretch back to the start.
 */
export interface DrawState {
  /** The points the runner placed; the first is the start. */
  points: RoutePoint[];
  /** legs[k] runs from points[k] to points[k + 1]. */
  legs: RouteLeg[];
}

export const EMPTY_DRAW: DrawState = { points: [], legs: [] };

/** Where the next stretch starts: the end of the last one (a snapped point), or the start. */
export function nextFrom(state: DrawState): RoutePoint | null {
  const last = state.legs[state.legs.length - 1];
  return last ? last.points[last.points.length - 1]! : (state.points[0] ?? null);
}

export function addPoint(state: DrawState, point: RoutePoint, leg: RouteLeg | null): DrawState {
  if (state.points.length === 0) return { points: [point], legs: [] };
  const from = nextFrom(state)!;
  return { points: [...state.points, point], legs: [...state.legs, leg ?? straightLeg(from, point)] };
}

export function undo(state: DrawState): DrawState {
  if (state.points.length <= 1) return EMPTY_DRAW;
  return { points: state.points.slice(0, -1), legs: state.legs.slice(0, -1) };
}

export function drawn(state: DrawState): JoinedRoute | null {
  if (state.legs.length === 0) return null;
  return joinLegs(state.legs);
}

/** A leg from the routing service's answer. */
export function plannedLeg(planned: Planned): RouteLeg {
  return { points: planned.points as RoutePoint[], cues: planned.cues, ascentM: planned.ascent_m, routed: true };
}

/** What to save: fewer points, the same route to within 2 m, every turn kept. */
export function toRouteInput(name: string, kind: RouteKind, route: JoinedRoute): RouteInput {
  const small = simplifyRoute(route.points, route.cues, 2);
  return { name: name.trim(), kind, points: small.points, cues: small.cues, ascentM: route.ascentM };
}

/** What a drawn route is: along paths if any stretch was planned, otherwise drawn. */
export function drawnKind(state: DrawState): RouteKind {
  return state.legs.some((l) => l.routed) ? 'path' : 'drawn';
}

/** The loop the service planned, as a route. */
export function loopRoute(planned: Planned): JoinedRoute {
  return { points: planned.points as RoutePoint[], cues: planned.cues, distanceM: planned.distance_m, ascentM: planned.ascent_m };
}
