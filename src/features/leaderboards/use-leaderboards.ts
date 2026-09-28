import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import type { LeaderboardKind } from '@/api/leaderboard-schemas';
import type { PaceApi } from '@/api/pace-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Opt-in leaderboards (docs/ROADMAP.md 4.7). */
export const useLeaderboardStatus = () => useCachedQuery('leaderboard-status', [], (api) => api.getLeaderboardStatus(), { staleTime: 60_000 });
export const useLeaderboard = (board: LeaderboardKind, key: string | null, weekOffset: number, enabled = true) =>
  useCachedQuery('leaderboard', [board, key ?? '', weekOffset], (api) => api.getLeaderboard(board, key, weekOffset), { enabled, staleTime: 30_000 });

export function describeLeaderboardError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'leaderboards_removed') return 'A moderator took you off the leaderboards, so you can’t join again.';
  if (e.code === 'invalid_input' && e.detail === 'country') return 'Pick a country from the list.';
  if (e.code === 'rate_limited') return 'That’s a lot of changes today. Try again tomorrow.';
  return 'Something went wrong. Try again.';
}

/** Joining, leaving and "Not now", each refreshing the status and the boards. */
export function useLeaderboardActions() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(task: (api: PaceApi) => Promise<T>): Promise<T | null> => {
      if (!api) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await task(api);
        await Promise.all(['leaderboard-status', 'leaderboard'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })));
        return result;
      } catch (e) {
        setError(describeLeaderboardError(e));
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
    join: (country: string) => run((a) => a.joinLeaderboards(country)),
    leave: () => run((a) => a.leaveLeaderboards()),
    dismiss: () => run((a) => a.dismissLeaderboardInvite()),
  };
}
