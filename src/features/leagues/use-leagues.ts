import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import type { GroupTarget } from '@/api/leagues-api';
import type { PaceApi } from '@/api/pace-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Seasons, duels, recaps and group runs for one league (docs/ROADMAP.md 4.1). */
export const useLeagueSeason = (leagueId: string | null) =>
  useCachedQuery('season', [leagueId ?? ''], (api) => api.getLeagueSeason(leagueId ?? ''), { enabled: !!leagueId, staleTime: 60_000 });
export const useDuels = (leagueId: string | null, weekOffset: 0 | -1) =>
  useCachedQuery('duels', [leagueId ?? '', weekOffset], (api) => api.listDuels(leagueId ?? '', weekOffset), { enabled: !!leagueId, staleTime: 15_000 });
export const useWeekRecap = (leagueId: string | null, weekOffset: 0 | -1, enabled: boolean) =>
  useCachedQuery('recap', [leagueId ?? '', weekOffset], (api) => api.getWeekRecap(leagueId ?? '', weekOffset), {
    enabled: !!leagueId && enabled,
    staleTime: 60_000,
  });
/** A league's or a club's group runs (docs/ROADMAP.md 4.1 and 4.5). */
export const groupTargetKey = (target: GroupTarget | null) => (target === null ? '' : 'clubId' in target ? `club:${target.clubId}` : `league:${target.leagueId}`);
export const useGroupRuns = (target: GroupTarget | null) =>
  useCachedQuery('group-runs', [groupTargetKey(target)], (api) => api.listGroupRuns(target!), { enabled: target !== null, staleTime: 15_000 });

export function describeLeagueError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'duel_exists') return 'You already have a duel with them this week.';
  if (e.code === 'duel_limit') return 'You have three duels this week already.';
  if (e.code === 'comment_not_allowed') return 'Links and some words aren’t allowed. Try other wording.';
  if (e.code === 'invalid_input' && e.detail === 'starts_at') return 'Pick a time at least 15 minutes from now and within 90 days.';
  if (e.code === 'invalid_input' && e.detail === 'chat_url')
    return 'Use an invite link from WhatsApp, Discord, Signal, Telegram, GroupMe or Messenger, starting with https://.';
  if (e.code === 'invalid_input' && e.detail === 'finished') return 'That group run has already happened or was cancelled.';
  if (e.code === 'not_found') return 'That isn’t available anymore.';
  if (e.code === 'rate_limited') return 'That’s a lot at once. Try again later.';
  return 'Something went wrong. Try again.';
}

/** League changes, each refreshing what it touches. */
export function useLeagueActions() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(task: (api: PaceApi) => Promise<T>, touched: string[]): Promise<T | null> => {
      if (!api) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await task(api);
        await Promise.all(touched.map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })));
        return result;
      } catch (e) {
        setError(describeLeagueError(e));
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
    challenge: (memberId: string) => run((a) => a.challengeDuel(memberId), ['duels']),
    respond: (duelId: string, accept: boolean) => run((a) => a.respondDuel(duelId, accept), ['duels']),
    cancelDuel: (duelId: string) => run((a) => a.cancelDuel(duelId), ['duels']),
    rsvp: (groupRunId: string, status: Parameters<PaceApi['rsvpGroupRun']>[1]) => run((a) => a.rsvpGroupRun(groupRunId, status), ['group-runs']),
    createGroupRun: (target: GroupTarget, input: Parameters<PaceApi['createGroupRun']>[1]) => run((a) => a.createGroupRun(target, input), ['group-runs']),
    removeGroupRun: (groupRunId: string) => run((a) => a.removeGroupRun(groupRunId), ['group-runs']),
    updateGroupRun: (groupRunId: string, input: Parameters<PaceApi['updateGroupRun']>[1]) =>
      run((a) => a.updateGroupRun(groupRunId, input), ['group-runs']),
    cancelGroupRun: (groupRunId: string) => run((a) => a.cancelGroupRun(groupRunId), ['group-runs']),
    setChatLink: (leagueId: string, url: string | null) => run((a) => a.setLeagueChatLink(url, leagueId), ['league']),
  };
}
