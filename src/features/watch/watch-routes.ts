import type { SavedRoute } from '@/api/routes-api';
import { simplifyRoute, type RoutePoint } from '@/domain/routes';
import type { Units } from '@/domain/types';

import type { WatchLinkPort } from './watch-link';

/**
 * A planned route for the PaceLeague Apple Watch app (docs/ROADMAP.md 5.1; the watch's side is
 * targets/watch/RouteStore.swift). The watch keeps the latest one for its next run and shows it
 * as a map, so it can be followed with the phone left at home. Fewer points than the phone uses,
 * the same route to within 5 m.
 */
export interface WatchRouteFile {
  version: 1;
  id: string;
  name: string;
  distance_m: number;
  units: Units;
  points: RoutePoint[];
  cues: { i: number; turn: string; street: string | null }[];
}

export const WATCH_ROUTE_MAX_POINTS = 1500;

export function watchRouteFile(route: SavedRoute, units: Units): WatchRouteFile {
  let tolerance = 5;
  let small = simplifyRoute(route.points, route.cues, tolerance);
  while (small.points.length > WATCH_ROUTE_MAX_POINTS && tolerance < 80) {
    tolerance *= 2;
    small = simplifyRoute(route.points, route.cues, tolerance);
  }
  return {
    version: 1,
    id: route.id,
    name: route.name,
    distance_m: route.distance_m,
    units,
    points: small.points,
    cues: small.cues.map((c) => ({ i: c.i, turn: c.turn, street: c.street })),
  };
}

export type SendToWatch = 'sent' | 'no_watch' | 'not_installed' | 'failed';

export function sendRouteToWatch(link: WatchLinkPort | null, route: SavedRoute, units: Units): SendToWatch {
  const status = link?.status();
  if (!link || !status?.supported || !status.paired) return 'no_watch';
  if (!status.installed) return 'not_installed';
  return link.sendRoute(JSON.stringify(watchRouteFile(route, units))) ? 'sent' : 'failed';
}
