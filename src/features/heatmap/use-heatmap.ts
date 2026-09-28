import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** The heatmap (docs/ROADMAP.md 5.4): what the runner contributes, and the current build. */
export const useHeatmap = (enabled = true) => useCachedQuery('heatmap', [], (api) => api.getHeatmap(), { enabled, staleTime: 60_000 });

/** Signed tile links for a build; they work for a day. */
export const useHeatmapTiles = (buildId: number | null) =>
  useCachedQuery('heatmap-tiles', [buildId ?? 0], (api) => api.getHeatmapTiles(), { enabled: buildId !== null, staleTime: 6 * 3_600_000 });

/** Busy places near a point (rounded to about 100 m, so small moves don't ask again). */
export function useHotspots(point: { lat: number; lon: number } | null) {
  const lat = point ? Number(point.lat.toFixed(3)) : null;
  const lon = point ? Number(point.lon.toFixed(3)) : null;
  return useCachedQuery('heatmap-hotspots', [lat ?? '', lon ?? ''], (api) => api.getHeatmapHotspots(lat ?? 0, lon ?? 0), {
    enabled: lat !== null && lon !== null,
    staleTime: 3_600_000,
  });
}

export function describeHeatmapError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'rate_limited') return 'That’s a lot of changes today. Try again tomorrow.';
  if (e.code === 'teen_restricted') return 'Your account can’t use this.';
  return 'Something went wrong. Try again.';
}

/** Contributing, or stopping. */
export function useHeatmapActions() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setContribution = useCallback(
    async (on: boolean) => {
      if (!api) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await api.setHeatmapContribution(on);
        await queryClient.invalidateQueries({ queryKey: [accountId, 'heatmap'] });
        return result;
      } catch (e) {
        setError(describeHeatmapError(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, accountId, queryClient],
  );

  return { busy, error, setContribution };
}
