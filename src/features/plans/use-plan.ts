import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { ApiError, toApiError } from '@/api/errors';
import type { PaceApi } from '@/api/pace-api';
import type { PlanFeedback, ServerPlan } from '@/api/schemas';
import { checkInAdjustments, feedbackAdjustments } from '@/domain/plans/adapt';
import type { PlanAdjustment, PlanInput } from '@/domain/plans/types';
import { useAccount } from '@/features/account/account-provider';
import { cacheKey, useCachedQuery, type Cached } from '@/features/data/hooks';
import { newId } from '@/lib/crypto';

import { currentPause, planSave, readPlan, todaysSessions, type PlanState, type SessionView } from './plan-client';

/** The runner's plan, as the server has it (docs/ROADMAP.md 3.1). */
export const usePlan = () => useCachedQuery('plan', [], (api) => api.getPlan(), { staleTime: 15_000 });

export function usePlanState() {
  const query = usePlan();
  const state = useMemo(() => (query.data?.data ? readPlan(query.data.data) : null), [query.data]);
  return { state, query, offline: query.data?.source === 'cache' };
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function describe(error: unknown): string {
  const code = toApiError(error).code;
  if (code === 'network' || code === 'timeout') return 'You’re offline. Plan changes need a connection.';
  if (code === 'conflict') return 'Your plan changed on another device. Try again.';
  if (code === 'plan_ended') return 'This plan has ended.';
  if (code === 'rate_limited') return 'That’s a lot of changes at once. Try again in a little while.';
  return 'Something went wrong. Try again.';
}

type Change = (state: PlanState) => { input?: PlanInput; adjustments: PlanAdjustment[] } | null;

/**
 * Changing a plan: every edit becomes a new version, made by the engine here and saved whole. A
 * save over a copy another device changed is retried once on the newer copy.
 */
export function usePlanActions() {
  const { state: account, api } = useAccount();
  const queryClient = useQueryClient();
  const accountId = account.status === 'ready' ? account.accountId : null;
  const journal = account.status === 'ready' ? account.runtime.journal : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const store = useCallback(
    async (plan: ServerPlan | null) => {
      const value: Cached<ServerPlan | null> = { data: plan, source: 'network', updatedAt: Date.now() };
      queryClient.setQueryData([accountId, 'plan'], value);
      await journal?.setKv(cacheKey('plan'), plan).catch(() => undefined);
    },
    [queryClient, accountId, journal],
  );

  const cached = useCallback(
    () => queryClient.getQueryData<Cached<ServerPlan | null>>([accountId, 'plan'])?.data ?? null,
    [queryClient, accountId],
  );

  const run = useCallback(
    async <T>(task: (client: PaceApi) => Promise<T>): Promise<T | null> => {
      if (!api) {
        setError('You’re signed out. Sign in again to change your plan.');
        return null;
      }
      setBusy(true);
      setError(null);
      try {
        return await task(api);
      } catch (e) {
        setError(describe(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const saveChange = useCallback(
    async (client: PaceApi, change: Change): Promise<ServerPlan | null> => {
      let server = cached();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!server || attempt > 0) {
          server = await client.getPlan();
          await store(server);
        }
        if (!server) return null;
        const state = readPlan(server);
        if (state.readOnly || !state.input || !state.adjustments) throw new ApiError('plan_ended');
        const next = change(state);
        if (!next) return server;
        const { save } = planSave({
          planId: server.id,
          baseVersion: server.version,
          input: next.input ?? state.input,
          adjustments: next.adjustments,
          timeZone: server.time_zone,
        });
        try {
          const saved = await client.savePlan(save);
          await store(saved);
          return saved;
        } catch (e) {
          if (toApiError(e).code !== 'conflict' || attempt > 0) throw e;
        }
      }
      return null;
    },
    [cached, store],
  );

  const edit = useCallback((change: Change) => run((client) => saveChange(client, change)), [run, saveChange]);

  return {
    busy,
    error,
    clearError: () => setError(null),

    /** Starts a plan, ending the one before. */
    create: (input: PlanInput) =>
      run(async (client) => {
        const { save } = planSave({ planId: newId(), baseVersion: null, input, adjustments: [], timeZone: deviceTimeZone() });
        const saved = await client.savePlan(save);
        await store(saved);
        return saved;
      }),

    addAdjustments: (adjustments: PlanAdjustment[]) =>
      adjustments.length === 0 ? Promise.resolve(cached()) : edit((s) => ({ adjustments: [...(s.adjustments ?? []), ...adjustments] })),

    /** Rewrites the edits (ending a pause early). */
    rewriteAdjustments: (rewrite: (adjustments: PlanAdjustment[], today: string) => PlanAdjustment[]) =>
      edit((s) => ({ adjustments: rewrite(s.adjustments ?? [], s.today) })),

    /** Changes answers that keep the plan's shape: the goal time, the longest session. */
    updateInput: (patch: Pick<Partial<PlanInput>, 'goalTimeS' | 'maxSessionMin'>) =>
      edit((s) => (s.input ? { input: { ...s.input, ...patch }, adjustments: s.adjustments ?? [] } : null)),

    end: (planId: string) =>
      run(async (client) => {
        const ended = await client.endPlan(planId);
        await store(ended);
        return ended;
      }),

    /** How a session felt. Two "too hard" answers in a week lighten the next one. */
    feedback: (planId: string, sessionId: string, feedback: PlanFeedback | null, pain: boolean) =>
      run(async (client) => {
        let saved = await client.setSessionFeedback(planId, sessionId, feedback, pain);
        await store(saved);
        const state = readPlan(saved);
        const lighten = state.plan && !state.readOnly ? feedbackAdjustments(state.plan, state.records) : [];
        if (lighten.length > 0) {
          saved = (await saveChange(client, (s) => ({ adjustments: [...(s.adjustments ?? []), ...lighten] }))) ?? saved;
        }
        return { plan: saved, lightened: lighten.length > 0 };
      }),

    match: (planId: string, sessionId: string, runId: string | null) =>
      run(async (client) => {
        const saved = await client.matchPlanSession(planId, sessionId, runId);
        await store(saved);
        return saved;
      }),

    /** "Not feeling 100%": today's sessions become an easy run, or rest. */
    checkIn: (choice: 'easy' | 'rest') =>
      edit((s) => {
        const adjustments = s.plan ? checkInAdjustments(s.plan, s.today, choice, s.records) : [];
        return adjustments.length > 0 ? { adjustments: [...(s.adjustments ?? []), ...adjustments] } : null;
      }),
  };
}

export interface TodaysPlan {
  views: SessionView[];
  /** Today's session still to do. */
  open: SessionView | null;
  planType: PlanState['server']['type'];
  /** The first session, while the plan hasn't begun. */
  startsOn: string | null;
  pausedUntil: string | null;
}

/** Home's view of the plan: today's sessions, if a plan is running. */
export function useTodaysPlan(): TodaysPlan | null {
  const { state } = usePlanState();
  if (!state || state.server.status !== 'active') return null;
  const views = todaysSessions(state);
  const first = state.server.sessions[0]?.date ?? state.server.start_date;
  return {
    views,
    open: views.find((v) => v.status === 'today') ?? null,
    planType: state.server.type,
    startsOn: state.today < first ? first : null,
    pausedUntil: currentPause(state)?.to ?? null,
  };
}
