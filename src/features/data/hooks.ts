import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { ApiError, toApiError } from '@/api/errors';
import type { PaceApi, StatsInput } from '@/api/pace-api';
import type { ActivityType, EffortKey, HistoryPage, ServerRun } from '@/api/schemas';
import type { JournalChange, SavedRun } from '@/db/journal';
import { useAccount } from '@/features/account/account-provider';
import type { IndoorSession } from '@/features/indoor/indoor-run';
import { EMPTY_METRICS, type RecorderSnapshot } from '@/features/recording/types';
import type { SyncStatus } from '@/features/sync/sync-engine';

/**
 * Server reads with an offline fallback: successful results are copied into the account's
 * journal; when the network fails, the last copy is returned and labelled as cached.
 */
export interface Cached<T> {
  data: T;
  source: 'network' | 'cache';
  updatedAt: number;
}

export function cacheKey(name: string, params: readonly (string | number)[] = []): string {
  return ['q', name, ...params].join(':');
}

function isOffline(error: ApiError): boolean {
  return error.code === 'network' || error.code === 'timeout';
}

export function useCachedQuery<T>(
  name: string,
  params: readonly (string | number)[],
  fetcher: (api: PaceApi) => Promise<T>,
  options: { enabled?: boolean; staleTime?: number } = {},
) {
  const { state, api } = useAccount();
  const runtime = state.status === 'ready' ? state.runtime : null;
  return useQuery<Cached<T>, ApiError>({
    queryKey: [runtime?.accountId, name, ...params],
    enabled: runtime !== null && api !== null && (options.enabled ?? true),
    staleTime: options.staleTime ?? 30_000,
    retry: (count, error) => count < 2 && error.isRetryable && !isOffline(error),
    queryFn: async () => {
      if (!runtime || !api) throw new ApiError('not_configured');
      const key = cacheKey(name, params);
      try {
        const data = await fetcher(api);
        await runtime.journal.setKv(key, data).catch(() => undefined);
        return { data, source: 'network', updatedAt: Date.now() };
      } catch (error) {
        const apiError = toApiError(error);
        if (isOffline(apiError)) {
          const cached = await runtime.journal.getKv<T>(key);
          if (cached) return { data: cached.value, source: 'cache', updatedAt: cached.updatedAt };
        }
        throw apiError;
      }
    },
  });
}

export const useMe = () => useCachedQuery('me', [], (api) => api.getMe());
export const useWeek = () => useCachedQuery('week', [], (api) => api.getWeekSummary(0));
export const useProgress = () => useCachedQuery('progress', [], (api) => api.getProgress(4));
export const useLeague = (weekOffset: 0 | -1 = 0) => useCachedQuery('league', [weekOffset], (api) => api.getMyLeague(weekOffset));
export const useBlocks = () => useCachedQuery('blocks', [], (api) => api.listBlocks(), { staleTime: 0 });
export const useServerRun = (serverRunId: string | null) =>
  useCachedQuery('run', [serverRunId ?? ''], (api) => api.getMyRun(serverRunId ?? ''), { enabled: !!serverRunId });
export const useRunRoute = (serverRunId: string | null) =>
  useCachedQuery('route', [serverRunId ?? ''], (api) => api.getMyRunRoute(serverRunId ?? ''), { enabled: !!serverRunId, staleTime: Infinity });

// Strava export (docs/ROADMAP.md 2.3)
export const useStravaStatus = () => useCachedQuery('strava', [], (api) => api.getStravaStatus(), { staleTime: 10_000 });
// Garmin through an aggregator (docs/ROADMAP.md 2.4)
export const useGarminStatus = () => useCachedQuery('garmin', [], (api) => api.getGarminStatus(), { staleTime: 10_000 });
export const useStravaUpload = (serverRunId: string | null, enabled: boolean) =>
  useCachedQuery('strava-upload', [serverRunId ?? ''], (api) => api.getStravaUpload(serverRunId ?? ''), { enabled: enabled && !!serverRunId });

// Phase 1 (docs/ROADMAP.md 1.4–1.10)
export const useStreak = () => useCachedQuery('streak', [], (api) => api.getStreak());
export const useBadges = () => useCachedQuery('badges', [], (api) => api.getBadges());
export const usePersonalRecords = () => useCachedQuery('records', [], (api) => api.getPersonalRecords());
export const useRecordHistory = (effort: EffortKey | null) =>
  useCachedQuery('record-history', [effort ?? ''], (api) => api.getRecordHistory(effort ?? '5k'), { enabled: effort !== null });
export const useRunEfforts = (serverRunId: string | null) =>
  useCachedQuery('efforts', [serverRunId ?? ''], (api) => api.getRunEfforts(serverRunId ?? ''), { enabled: !!serverRunId });
export const useShoes = () => useCachedQuery('shoes', [], (api) => api.listShoes(), { staleTime: 0 });
export const useStats = (input: StatsInput) =>
  useCachedQuery('stats', [input.from, input.to, input.bucket, input.activity ?? 'run'], (api) => api.getStats(input));
export const useRunsBetween = (fromMs: number, toMs: number, activity: ActivityType | null, enabled = true) =>
  useCachedQuery('runs-between', [fromMs, toMs, activity ?? 'all'], (api) => api.listMyRunsBetween(fromMs, toMs, activity), { enabled });
export const useLeagueCheers = (weekOffset: 0 | -1 = 0) =>
  useCachedQuery('cheers', [weekOffset], (api) => api.getLeagueCheers(weekOffset), { staleTime: 10_000 });

export function useRunHistory() {
  const { state, api } = useAccount();
  const runtime = state.status === 'ready' ? state.runtime : null;
  return useInfiniteQuery<HistoryPage, ApiError>({
    queryKey: [runtime?.accountId, 'history'],
    enabled: runtime !== null && api !== null,
    initialPageParam: null as HistoryPage['next_cursor'],
    getNextPageParam: (last) => last.next_cursor,
    queryFn: async ({ pageParam }) => {
      if (!api) throw new ApiError('not_configured');
      const cursor = pageParam as HistoryPage['next_cursor'];
      return api.listMyRuns(cursor ? { beforeStartedAtMs: cursor.before_started_at_ms, beforeId: cursor.before_id } : null, 20);
    },
    retry: (count, error) => count < 2 && toApiError(error).isRetryable,
  });
}

/** Invalidates every server read of the open account (after a mutation). */
export function useRefreshAccountData() {
  const queryClient = useQueryClient();
  const { state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  return useCallback(() => queryClient.invalidateQueries({ queryKey: [accountId] }), [queryClient, accountId]);
}

// -----------------------------------------------------------------------------------------
// Local journal subscriptions
// -----------------------------------------------------------------------------------------
function useJournalValue<T>(read: () => Promise<T>, changes: JournalChange[], initial: T, deps: unknown[]): T {
  const { state } = useAccount();
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (!journal) return;
    let alive = true;
    const refresh = () =>
      void read()
        .then((v) => alive && setValue(v))
        .catch(() => undefined);
    refresh();
    const unsubscribe = journal.changes.subscribe((change) => {
      if (changes.includes(change)) refresh();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journal, ...deps]);
  return value;
}

/** Saved runs on this device, including ones deleted here but not yet confirmed by the server. */
export function useLocalRuns(): SavedRun[] {
  const { state } = useAccount();
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  return useJournalValue(() => journal?.listSavedRuns({ includeDeleted: true }) ?? Promise.resolve([]), ['saved', 'outbox'], [], [journal]);
}

export function useLocalRun(runId: string | null): SavedRun | null | undefined {
  const { state } = useAccount();
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  return useJournalValue<SavedRun | null | undefined>(
    () => (journal && runId ? journal.getSavedRun(runId) : Promise.resolve(null)),
    ['saved'],
    undefined,
    [journal, runId],
  );
}

const IDLE_SNAPSHOT: RecorderSnapshot = { session: null, metrics: EMPTY_METRICS, lastSaved: null, autoPaused: false };
const noopSubscribe = () => () => undefined;

export function useRecorder(): RecorderSnapshot {
  const { state } = useAccount();
  const recorder = state.status === 'ready' ? state.runtime.recorder : null;
  return useSyncExternalStore(recorder?.subscribe ?? noopSubscribe, recorder?.getSnapshot ?? (() => IDLE_SNAPSHOT));
}

/** The open treadmill or indoor run, if any. */
export function useIndoorSession(): IndoorSession | null {
  const { state } = useAccount();
  const indoor = state.status === 'ready' ? state.runtime.indoor : null;
  const subscribe = useCallback((listener: () => void) => indoor?.changes.subscribe(listener) ?? (() => undefined), [indoor]);
  return useSyncExternalStore(subscribe, () => indoor?.current ?? null);
}

export function useSyncStatus(): SyncStatus | null {
  const { state } = useAccount();
  const engine = state.status === 'ready' ? state.engine : null;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    if (!engine) return;
    void engine.currentStatus().then(setStatus);
    return engine.status.subscribe(setStatus);
  }, [engine]);
  return status;
}

/** A run's best-known representation: the server copy when synced, else the local save. */
export interface RunView {
  key: string;
  localRunId: string | null;
  serverRunId: string | null;
  title: string;
  startedAt: number;
  activeMs: number;
  distanceM: number;
  status: 'saved_local' | 'syncing' | 'needs_attention' | ServerRun['status'];
  server: ServerRun | null;
  local: SavedRun | null;
}
