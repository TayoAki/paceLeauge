import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Clubs (docs/ROADMAP.md 4.5). */
export const useMyClubs = () => useCachedQuery('clubs', [], (api) => api.listMyClubs(), { staleTime: 30_000 });
export const useClub = (clubId: string | null) =>
  useCachedQuery('club', [clubId ?? ''], (api) => api.getClub(clubId ?? ''), { enabled: !!clubId, staleTime: 15_000 });
export const useClubBoard = (clubId: string | null, weekOffset: 0 | -1, enabled: boolean) =>
  useCachedQuery('club-board', [clubId ?? '', weekOffset], (api) => api.getClubBoard(clubId ?? '', weekOffset), {
    enabled: !!clubId && enabled,
    staleTime: 30_000,
  });
export const useClubMembers = (clubId: string | null, enabled: boolean) =>
  useCachedQuery('club-members', [clubId ?? ''], (api) => api.listClubMembers(clubId ?? ''), { enabled: !!clubId && enabled, staleTime: 15_000 });

export function describeClubError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'club_invalid') return 'Use 3–40 letters, numbers or spaces for the name, and up to 280 characters for the description.';
  if (e.code === 'club_not_allowed') return 'That name or description isn’t allowed. Links and some words can’t be used.';
  if (e.code === 'club_limit') return 'You’re in 10 clubs, the most at once. Leave one first.';
  if (e.code === 'club_full') return 'This club is full.';
  if (e.code === 'club_unavailable') return 'You can’t join this club.';
  if (e.code === 'club_invite_invalid') return 'That code doesn’t work. Check it, or ask for a new one.';
  if (e.code === 'owner_must_transfer') return 'Make someone else the owner before you leave.';
  if (e.code === 'not_club_owner') return 'Only the club’s owner can do that.';
  if (e.code === 'not_club_admin') return 'Only the club’s owner and admins can do that.';
  if (e.code === 'invalid_input' && e.detail === 'chat_url')
    return 'Use an invite link from WhatsApp, Discord, Signal, Telegram, GroupMe or Messenger, starting with https://.';
  if (e.code === 'not_found') return 'That club isn’t available.';
  if (e.code === 'rate_limited') return 'That’s a lot at once. Try again later.';
  return 'Something went wrong. Try again.';
}

/** Club changes, each refreshing what it touches. */
export function useClubActions() {
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
        setError(describeClubError(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, accountId, queryClient],
  );

  const all = ['clubs', 'club', 'club-board', 'club-members'];
  return {
    busy,
    error,
    clearError: () => setError(null),
    create: (input: Parameters<PaceApi['createClub']>[0]) => run((a) => a.createClub(input), ['clubs']),
    update: (clubId: string, input: Parameters<PaceApi['updateClub']>[1]) => run((a) => a.updateClub(clubId, input), ['clubs', 'club']),
    setChatLink: (clubId: string, url: string | null) => run((a) => a.setClubChatLink(clubId, url), ['club']),
    join: (clubId: string) => run((a) => a.joinClub(clubId), all),
    joinByCode: (code: string) => run((a) => a.joinClubByCode(code), all),
    invite: (clubId: string) => run((a) => a.createClubInvite(clubId), []),
    leave: (clubId: string) => run((a) => a.leaveClub(clubId), all),
    promote: (clubId: string, memberId: string) => run((a) => a.promoteClubAdmin(clubId, memberId), ['club', 'club-members']),
    demote: (clubId: string, memberId: string) => run((a) => a.demoteClubAdmin(clubId, memberId), ['club', 'club-members']),
    transfer: (clubId: string, memberId: string) => run((a) => a.transferClubOwnership(clubId, memberId), ['club', 'club-members', 'clubs']),
    remove: (clubId: string, memberId: string) => run((a) => a.removeClubMember(clubId, memberId), ['club', 'club-members', 'club-board']),
  };
}
