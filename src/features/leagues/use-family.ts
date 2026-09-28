import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Teen accounts in family leagues (docs/ROADMAP.md 4.10). */
export const useMyFamilyRequests = (enabled: boolean) =>
  useCachedQuery('family-mine', [], (api) => api.listMyFamilyRequests(), { enabled, staleTime: 15_000 });
export const useFamilyRequests = (leagueId: string | null, enabled: boolean) =>
  useCachedQuery('family-requests', [leagueId ?? ''], (api) => api.listFamilyRequests(leagueId), { enabled: enabled && !!leagueId, staleTime: 15_000 });
export const useFamilyTeens = (leagueId: string | null, enabled: boolean) =>
  useCachedQuery('family-teens', [leagueId ?? ''], (api) => api.listFamilyTeens(leagueId ?? ''), { enabled: enabled && !!leagueId, staleTime: 30_000 });

export function describeFamilyError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'invite_not_found') return 'That code doesn’t work. Ask for a new one.';
  if (e.code === 'family_only') return 'That code is for a league that isn’t a family league. Teen accounts can join family leagues only.';
  if (e.code === 'invite_unavailable') return 'You can’t join that league.';
  if (e.code === 'already_member') return 'You’re already in that family league.';
  if (e.code === 'league_full') return 'That league is full.';
  if (e.code === 'league_limit') return 'They’re already in five leagues, the most at once.';
  if (e.code === 'rate_limited') return 'That’s a lot of tries today. Try again tomorrow.';
  return 'Something went wrong. Try again.';
}

/** Asking to join, and deciding, each refreshing what it touches. */
export function useFamilyActions() {
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
        await Promise.all(
          ['family-mine', 'family-requests', 'family-teens', 'league'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })),
        );
        return result;
      } catch (e) {
        setError(describeFamilyError(e));
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
    request: (code: string) => run((a) => a.requestFamilyJoin(code)),
    cancel: (requestId: string) => run((a) => a.cancelFamilyRequest(requestId)),
    decide: (requestId: string, approve: boolean) => run((a) => a.decideFamilyRequest(requestId, approve)),
  };
}
