import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import type { SegmentSurface } from '@/api/segments-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Segments (docs/ROADMAP.md 5.3): curated stretches of path with boards for runners who join. */
export const useSegments = () => useCachedQuery('segments', [], (api) => api.listSegments(), { staleTime: 60_000 });
export const useSegment = (segmentId: string | null) =>
  useCachedQuery('segment', [segmentId ?? ''], (api) => api.getSegment(segmentId ?? ''), { enabled: !!segmentId, staleTime: 30_000 });
/** The segments one of the runner's runs went through (never asked for a teen's runs). */
export const useRunSegments = (runId: string | null, enabled = true) =>
  useCachedQuery('run-segments', [runId ?? ''], (api) => api.getRunSegments(runId ?? ''), { enabled: !!runId && enabled, staleTime: 60_000 });

export function describeSegmentError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  switch (e.code) {
    case 'not_allowed':
      return 'A moderator took you off the segment boards, so you can’t join again.';
    case 'not_found':
      return 'That isn’t there any more.';
    case 'rate_limited':
      return 'That’s a lot of changes today. Try again tomorrow.';
    case 'invalid_input':
      if (e.detail === 'name') return 'Give it a name of 3 to 60 characters, without anything offensive.';
      if (e.detail === 'length') return 'A segment is 200 m to 20 km, from a route of up to 1,000 points.';
      if (e.detail === 'reason') return 'Say why, in a few words.';
      return 'Check the details and try again.';
    case 'teen_restricted':
      return 'Your account can’t use this.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Joining and leaving the boards; staff making and retiring segments. Each refreshes what changed. */
export function useSegmentActions() {
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
        // A retired segment is dropped rather than fetched again.
        if (gone) queryClient.removeQueries({ queryKey: [accountId, 'segment', gone] });
        await Promise.all(['segments', 'segment', 'run-segments'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })));
        return result;
      } catch (e) {
        setError(describeSegmentError(e));
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
    join: () => run((a) => a.joinSegments()),
    leave: () => run((a) => a.leaveSegments().then(() => true)),
    create: (routeId: string, name: string, surface: SegmentSurface) => run((a) => a.modCreateSegment(routeId, name, surface)),
    retire: (segmentId: string, reason: string) => run((a) => a.modRetireSegment(segmentId, reason).then(() => true), segmentId),
  };
}
