import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import type { ChallengeInput } from '@/api/challenges-api';
import { toApiError } from '@/api/errors';
import type { GroupTarget } from '@/api/leagues-api';
import type { PaceApi } from '@/api/pace-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Challenges (docs/ROADMAP.md 4.6). */
export const useChallenges = () => useCachedQuery('challenges', [], (api) => api.listChallenges(), { staleTime: 30_000 });
export const useChallenge = (challengeId: string | null) =>
  useCachedQuery('challenge', [challengeId ?? ''], (api) => api.getChallenge(challengeId ?? ''), { enabled: !!challengeId, staleTime: 15_000 });

export function describeChallengeError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'challenge_closed') return 'This challenge is over.';
  if (e.code === 'challenge_limit') return 'A group can run three challenges at a time. Wait for one to end, or remove one.';
  if (e.code === 'challenge_invalid') return 'Use 3–40 letters, numbers or spaces for the name.';
  if (e.code === 'challenge_not_allowed') return 'That name isn’t allowed. Links and some words can’t be used.';
  if (e.code === 'invalid_input' && e.detail === 'target') return 'Pick a goal the month allows.';
  if (e.code === 'not_league_owner') return 'Only the league’s owner can set challenges.';
  if (e.code === 'not_club_admin') return 'Only the club’s owner and admins can set challenges.';
  if (e.code === 'not_in_league' || e.code === 'not_in_club' || e.code === 'not_found') return 'That challenge isn’t available.';
  if (e.code === 'not_allowed') return 'Only the group’s owner or admins can do that.';
  if (e.code === 'rate_limited') return 'That’s a lot at once. Try again later.';
  return 'Something went wrong. Try again.';
}

/** Joining, leaving, setting and removing challenges, each refreshing what it touches. */
export function useChallengeActions() {
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
        await Promise.all(['challenges', 'challenge', 'badges'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })));
        return result;
      } catch (e) {
        setError(describeChallengeError(e));
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
    join: (challengeId: string) => run((a) => a.joinChallenge(challengeId)),
    leave: (challengeId: string) => run((a) => a.leaveChallenge(challengeId).then(() => true)),
    create: (target: GroupTarget, input: ChallengeInput) => run((a) => a.createChallenge(target, input)),
    remove: (challengeId: string) => run((a) => a.removeChallenge(challengeId).then(() => true)),
  };
}
