import { z } from 'zod';

import type { RouteCue, RouteKind, RoutePoint } from '@/domain/routes';
import { TURN_KINDS } from '@/domain/routes';

import type { Call } from './social-api';

/**
 * Planned routes (docs/ROADMAP.md 5.1). Field names mirror db/migrations/20261004000100_routes.sql
 * and server/src/routing.ts (plan_route, answered by the API service).
 */
const pointSchema = z.tuple([z.number(), z.number()]);
const cueSchema = z.object({
  i: z.number(),
  turn: z.enum(TURN_KINDS as [RouteCue['turn'], ...RouteCue['turn'][]]),
  street: z.string().nullable().default(null),
  exit: z.number().nullable().default(null),
});

export const plannedSchema = z.object({
  distance_m: z.number(),
  ascent_m: z.number().nullable(),
  points: z.array(pointSchema),
  cues: z.array(cueSchema),
  /** Loops: whether it came within 2 % of the distance asked for. */
  within_tolerance: z.boolean().nullable(),
});
export type Planned = z.infer<typeof plannedSchema>;

const routeBase = {
  id: z.string(),
  name: z.string(),
  kind: z.enum(['loop', 'path', 'drawn']),
  distance_m: z.number(),
  ascent_m: z.number().nullable(),
  start: z.object({ lat: z.number(), lon: z.number() }),
  /** [min lat, min lon, max lat, max lon] */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  turns: z.number(),
  created_at_ms: z.number(),
  updated_at_ms: z.number(),
};

export const routeSummarySchema = z.object({ ...routeBase, preview: z.array(pointSchema).nullable().default([]) });
export type RouteSummary = z.infer<typeof routeSummarySchema>;

export const savedRouteSchema = z.object({
  ...routeBase,
  points: z.array(pointSchema),
  cues: z.array(cueSchema.extend({ at_m: z.number() })),
});
export type SavedRoute = z.infer<typeof savedRouteSchema>;

export const routeListSchema = z.object({
  planning_available: z.boolean(),
  limit: z.number(),
  routes: z.array(routeSummarySchema),
});
export type RouteList = z.infer<typeof routeListSchema>;

export interface RouteInput {
  name: string;
  kind: RouteKind;
  points: RoutePoint[];
  cues: RouteCue[];
  ascentM: number | null;
}

export interface RoutesApi {
  /** One stretch along paths between two points. */
  planLeg(from: { lat: number; lon: number }, to: { lat: number; lon: number }): Promise<Planned>;
  /** A round trip of about this distance; `variant` gives other loops from the same start. */
  planLoop(start: { lat: number; lon: number }, distanceM: number, variant: number): Promise<Planned>;
  listRoutes(): Promise<RouteList>;
  getRoute(routeId: string): Promise<SavedRoute>;
  /** Saves a new route, or replaces one when `routeId` is given. */
  saveRoute(routeId: string | null, input: RouteInput): Promise<SavedRoute>;
  renameRoute(routeId: string, name: string): Promise<RouteSummary>;
  deleteRoute(routeId: string): Promise<void>;
}

/** Planning a loop can take a few rounds of the routing service. */
const PLAN_TIMEOUT_MS = 30_000;

export function routesApi(call: Call): RoutesApi {
  return {
    planLeg: (from, to) => call('plan_route', { p_mode: 'leg', p_from: from, p_to: to }, plannedSchema, PLAN_TIMEOUT_MS),
    planLoop: (start, distanceM, variant) =>
      call('plan_route', { p_mode: 'loop', p_start: start, p_distance_m: Math.round(distanceM), p_variant: variant }, plannedSchema, PLAN_TIMEOUT_MS),
    listRoutes: () => call('list_routes', {}, routeListSchema),
    getRoute: (routeId) => call('get_route', { p_route_id: routeId }, savedRouteSchema),
    saveRoute: (routeId, input) =>
      call(
        'save_route',
        { p_route_id: routeId, p_name: input.name, p_kind: input.kind, p_points: input.points, p_cues: input.cues, p_ascent_m: input.ascentM },
        savedRouteSchema,
      ),
    renameRoute: (routeId, name) => call('rename_route', { p_route_id: routeId, p_name: name }, routeSummarySchema),
    deleteRoute: async (routeId) => {
      await call('delete_route', { p_route_id: routeId }, z.object({ deleted: z.number() }));
    },
  };
}
