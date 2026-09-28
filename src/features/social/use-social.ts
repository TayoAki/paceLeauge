import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import type { FollowListKind } from '@/api/social-api';
import type { Visibility } from '@/api/social-schemas';
import { env } from '@/config/env';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';

/** Privacy zones, sharing and follows (docs/ROADMAP.md 4.2 and 4.3). */
export const useSocialSettings = () => useCachedQuery('social-settings', [], (api) => api.getSocialSettings(), { staleTime: 60_000 });
export const useFollows = (kind: FollowListKind) => useCachedQuery('follows', [kind], (api) => api.listFollows(kind), { staleTime: 10_000 });
export const useRunnerProfile = (publicId: string | null) =>
  useCachedQuery('runner', [publicId ?? ''], (api) => api.getRunnerProfile(publicId ?? ''), { enabled: !!publicId, staleTime: 15_000 });
export const useSharedRun = (runId: string | null) =>
  useCachedQuery('shared-run', [runId ?? ''], (api) => api.getSharedRun(runId ?? ''), { enabled: !!runId, staleTime: 30_000 });

export const VISIBILITY_NAMES: Record<Visibility, string> = {
  only_me: 'Only me',
  leagues: 'My leagues',
  followers: 'Followers',
  everyone: 'Everyone',
};

export const VISIBILITY_HINTS: Record<Visibility, string> = {
  only_me: 'Nobody else sees the run.',
  leagues: 'Runners in your leagues see it.',
  followers: 'Your approved followers and your leagues see it.',
  everyone: 'Anyone signed in to PaceLeague can see it.',
};

/** A follow link to share: the web app's page when there is one, else the app's own link. */
export function followLink(code: string): string {
  return env.webUrl ? `${env.webUrl.replace(/\/$/, '')}/follow/${code}` : `paceleague://follow/${code}`;
}

export function describeSocialError(error: unknown): string {
  const code = toApiError(error).code;
  if (code === 'network' || code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (code === 'not_found') return 'That runner isn’t available.';
  if (code === 'rate_limited') return 'That’s a lot at once. Try again in a little while.';
  if (code === 'too_many_zones') return 'You can have up to 5 privacy zones.';
  return 'Something went wrong. Try again.';
}

/** Social changes, each refreshing what it touches. */
export function useSocialActions() {
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
        setError(describeSocialError(e));
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
    follow: (publicId: string) => run((a) => a.followRunner(publicId), ['follows', 'runner', 'feed']),
    unfollow: (publicId: string) => run((a) => a.unfollow(publicId), ['follows', 'runner', 'feed']),
    respond: (publicId: string, accept: boolean) => run((a) => a.respondFollow(publicId, accept), ['follows', 'runner']),
    removeFollower: (publicId: string) => run((a) => a.removeFollower(publicId), ['follows', 'runner']),
    mute: (publicId: string, muted: boolean) => run((a) => a.muteRunner(publicId, muted), ['follows', 'runner', 'feed']),
    block: (publicId: string) => run((a) => a.blockRunner(publicId), ['follows', 'runner', 'feed', 'blocks']),
    followByCode: (code: string) => run((a) => a.followByCode(code), ['follows', 'runner', 'feed']),
    setSettings: (input: Parameters<PaceApi['setSocialSettings']>[0]) => run((a) => a.setSocialSettings(input), ['social-settings']),
    saveZone: (zone: Parameters<PaceApi['savePrivacyZone']>[0]) => run((a) => a.savePrivacyZone(zone), ['social-settings', 'shared-run']),
    deleteZone: (zoneId: string) => run((a) => a.deletePrivacyZone(zoneId), ['social-settings', 'shared-run']),
    setRunSharing: (runId: string, visibility: Visibility, mapShared: boolean) =>
      run((a) => a.setRunSharing(runId, visibility, mapShared), ['shared-run', 'run', 'history', 'feed']),
  };
}
