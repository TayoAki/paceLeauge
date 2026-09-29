import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import type { RouteInput, SavedRoute } from '@/api/routes-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

import type { FollowedRoute, RouteFollowSnapshot } from './route-controller';

/**
 * Planned routes (docs/ROADMAP.md 5.1). A route opened once is kept on the phone (the query
 * cache lives in the account's journal), so it can be followed without a connection.
 */
export const useRoutes = () => useCachedQuery('routes', [], (api) => api.listRoutes(), { staleTime: 30_000 });
export const useRoute = (routeId: string | null) =>
  useCachedQuery('route', [routeId ?? ''], (api) => api.getRoute(routeId ?? ''), { enabled: !!routeId, staleTime: 60_000 });

/**
 * Whether the API has a routing service (docs/OPERATIONS.md, "Route planning"). Until it does, what
 * is built on planned routes stays hidden: Train › Routes with popular paths and suggested loops,
 * adding runs to the heatmap, and segments, which staff make from saved routes.
 */
export const useRoutePlanning = (): boolean => useRoutes().data?.data.planning_available ?? false;

export function describeRouteError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Planning and saving routes need a connection.';
  switch (e.code) {
    case 'not_available':
      return 'Planning along paths isn’t available yet. You can still draw a route point to point.';
    case 'no_route':
      return 'There’s no path to follow from there. Try a start on a street or path.';
    case 'too_far':
      return 'That point is too far from the last one. Add points closer together.';
    case 'routing_failed':
      return 'The route planner didn’t answer. Try again in a moment.';
    case 'rate_limited':
      return 'That’s a lot of planning for now. Try again in a few minutes.';
    case 'route_limit':
      return 'You have 100 saved routes, the most there can be. Delete one to save another.';
    case 'not_found':
      return 'That route isn’t there any more.';
    case 'age_restricted':
      return 'Your account can’t use this.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Saving, renaming and deleting, each refreshing the list. */
export function useRouteActions() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(task: (api: PaceApi) => Promise<T>, gone: string | null = null): Promise<T | null> => {
      if (!api) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await task(api);
        // A deleted route is dropped rather than fetched again.
        if (gone) queryClient.removeQueries({ queryKey: [accountId, 'route', gone] });
        await Promise.all(['routes', 'route'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })));
        return result;
      } catch (e) {
        setError(describeRouteError(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, accountId, queryClient],
  );

  return {
    busy,
    error,
    clearError: () => setError(null),
    save: (routeId: string | null, input: RouteInput) => run((a) => a.saveRoute(routeId, input)),
    rename: (routeId: string, name: string) => run((a) => a.renameRoute(routeId, name)),
    remove: (routeId: string) => run((a) => a.deleteRoute(routeId), routeId),
  };
}

export function followedRoute(route: SavedRoute): FollowedRoute {
  return { id: route.id, name: route.name, points: route.points, cues: route.cues.map(({ i, turn, street, exit }) => ({ i, turn, street, exit })), distanceM: route.distance_m };
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => null;

/** The route the current (or next) run follows. */
export function useFollowedRoute(): RouteFollowSnapshot | null {
  const { state } = useAccount();
  const route = state.status === 'ready' ? state.runtime.route : null;
  return useSyncExternalStore(route?.subscribe ?? noSubscribe, route?.getSnapshot ?? noSnapshot);
}
