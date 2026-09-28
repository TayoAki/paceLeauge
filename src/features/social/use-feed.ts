import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { toApiError, type ApiError } from '@/api/errors';
import type { Comment, ContentReportReason, FeedItem, FeedPage, ReportKind } from '@/api/feed-schemas';
import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery, type Cached } from '@/features/data/hooks';

/** The feed, kudos and comments (docs/ROADMAP.md 4.4). */
export function useFeed() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  return useInfiniteQuery<FeedPage, ApiError, InfiniteData<FeedPage>, (string | null)[], FeedPage['next']>({
    queryKey: [accountId, 'feed'],
    enabled: api !== null && accountId !== null,
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
    staleTime: 30_000,
    queryFn: async ({ pageParam }) => {
      try {
        return await api!.getFeed(pageParam, 15);
      } catch (error) {
        throw toApiError(error);
      }
    },
  });
}

export const useComments = (runId: string | null) =>
  useCachedQuery('comments', [runId ?? ''], (api) => api.listComments(runId ?? ''), { enabled: !!runId, staleTime: 15_000 });
export const useKudosList = (runId: string | null, enabled: boolean) =>
  useCachedQuery('kudos', [runId ?? ''], (api) => api.listKudos(runId ?? ''), { enabled: !!runId && enabled, staleTime: 15_000 });

/** "just now", "5 min", "3 h", "2 d", then the date. */
export function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** How many comments the viewer sees, counted the way the server counts them. */
export function countComments(threads: Comment[]): number {
  return threads.reduce((n, t) => n + (t.removed ? 0 : 1) + t.replies.length, 0);
}

export const REPORT_REASONS: Record<ReportKind, { value: ContentReportReason; label: string }[]> = {
  comment: [
    { value: 'harassment', label: 'Harassment or bullying' },
    { value: 'offensive_content', label: 'Hateful or offensive' },
    { value: 'spam', label: 'Spam' },
    { value: 'private_info', label: 'Shares someone’s private information' },
    { value: 'other', label: 'Something else' },
  ],
  run: [
    { value: 'cheating', label: 'Not a real run (car, bike or made up)' },
    { value: 'offensive_content', label: 'Offensive title' },
    { value: 'private_info', label: 'Shares someone’s private information' },
    { value: 'spam', label: 'Spam' },
    { value: 'other', label: 'Something else' },
  ],
  club: [
    { value: 'offensive_name', label: 'Offensive name or description' },
    { value: 'harassment', label: 'Harassment or bullying' },
    { value: 'spam', label: 'Spam' },
    { value: 'other', label: 'Something else' },
  ],
  challenge: [
    { value: 'offensive_name', label: 'Offensive name' },
    { value: 'harassment', label: 'Aimed at someone' },
    { value: 'spam', label: 'Spam' },
    { value: 'other', label: 'Something else' },
  ],
  group_run: [
    { value: 'offensive_content', label: 'Offensive or unsafe' },
    { value: 'private_info', label: 'Shares someone’s private information' },
    { value: 'spam', label: 'Spam' },
    { value: 'other', label: 'Something else' },
  ],
  runner: [
    { value: 'impersonation', label: 'Pretending to be someone else' },
    { value: 'offensive_name', label: 'Offensive name' },
    { value: 'harassment', label: 'Harassment or bullying' },
    { value: 'spam', label: 'Spam' },
    { value: 'other', label: 'Something else' },
  ],
};

export function describeFeedError(error: unknown): string {
  const e = toApiError(error);
  if (e.code === 'network' || e.code === 'timeout') return 'You’re offline. Try again when you’re connected.';
  if (e.code === 'comment_not_allowed') return 'That comment can’t be posted. Links and some words aren’t allowed.';
  if (e.code === 'invalid_input' && e.detail === 'body') return 'Comments can be up to 500 characters, without hidden characters.';
  if (e.code === 'rate_limited') return 'That’s a lot at once. Try again in a minute.';
  if (e.code === 'not_found') return 'This isn’t available anymore.';
  return 'Something went wrong. Try again.';
}

type RunPatch = Partial<Pick<FeedItem, 'kudos' | 'kudoed' | 'comments'>>;

/** Kudos, comments and reports, updating the feed and the run screen in place. */
export function useFeedActions() {
  const { api, state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchRun = useCallback(
    (runId: string, patch: RunPatch) => {
      queryClient.setQueryData<InfiniteData<FeedPage>>([accountId, 'feed'], (data) =>
        data
          ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.run_id === runId ? { ...item, ...patch } : item)) })) }
          : data,
      );
      queryClient.setQueryData<Cached<FeedItem>>([accountId, 'shared-run', runId], (cached) => (cached ? { ...cached, data: { ...cached.data, ...patch } } : cached));
    },
    [accountId, queryClient],
  );

  const setThreads = useCallback(
    (runId: string, threads: Comment[]) => {
      queryClient.setQueryData<Cached<Comment[]>>([accountId, 'comments', runId], { data: threads, source: 'network', updatedAt: Date.now() });
      patchRun(runId, { comments: countComments(threads) });
    },
    [accountId, patchRun, queryClient],
  );

  const guarded = useCallback(
    async <T>(task: () => Promise<T>): Promise<T | null> => {
      if (!api) return null;
      setBusy(true);
      setError(null);
      try {
        return await task();
      } catch (e) {
        setError(describeFeedError(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  return {
    busy,
    error,
    clearError: () => setError(null),
    /** Shown straight away; put back if the server says no. */
    toggleKudos: async (item: Pick<FeedItem, 'run_id' | 'kudos' | 'kudoed'>) => {
      if (!api) return;
      const on = !item.kudoed;
      patchRun(item.run_id, { kudoed: on, kudos: Math.max(0, item.kudos + (on ? 1 : -1)) });
      setError(null);
      try {
        const result = await api.setKudos(item.run_id, on);
        patchRun(item.run_id, { kudoed: result.kudoed, kudos: result.kudos });
        void queryClient.invalidateQueries({ queryKey: [accountId, 'kudos', item.run_id] });
      } catch (e) {
        patchRun(item.run_id, { kudoed: item.kudoed, kudos: item.kudos });
        setError(describeFeedError(e));
      }
    },
    addComment: (runId: string, body: string, parentId: string | null) =>
      guarded(async () => {
        const threads = await api!.addComment(runId, body, parentId);
        setThreads(runId, threads);
        return threads;
      }),
    deleteComment: (runId: string, commentId: string) =>
      guarded(async () => {
        const threads = await api!.deleteComment(commentId);
        setThreads(runId, threads);
        return threads;
      }),
    /** The reporter stops seeing a reported run or comment straight away. */
    report: (kind: ReportKind, id: string, reason: ContentReportReason, runId?: string) =>
      guarded(async () => {
        const result = await api!.reportContent(kind, id, reason);
        const touched = kind === 'run' ? ['feed', 'shared-run', 'runner'] : kind === 'comment' ? ['comments', 'feed', 'shared-run'] : [];
        await Promise.all(touched.map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name, ...(runId && name !== 'feed' && name !== 'runner' ? [runId] : [])] })));
        return result;
      }),
    block: (publicId: string) =>
      guarded(async () => {
        await api!.blockRunner(publicId);
        await Promise.all(
          ['feed', 'comments', 'kudos', 'shared-run', 'runner', 'follows', 'blocks'].map((name) => queryClient.invalidateQueries({ queryKey: [accountId, name] })),
        );
      }),
  };
}
