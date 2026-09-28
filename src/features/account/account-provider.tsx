import { useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { api } from '@/api/client';
import type { PaceApi } from '@/api/pace-api';
import { env } from '@/config/env';
import { cancelReminder, restoreReminder } from '@/features/reminders/reminders';
import { createRunActions, type RunActions } from '@/features/sync/run-actions';
import { writeWidgetWeek } from '@/features/widgets/widget-data';
import { SyncEngine } from '@/features/sync/sync-engine';
import { sha256Hex } from '@/lib/crypto';

import { signOutEverywhere } from './auth-actions';
import { useAuth } from './auth-provider';
import { closeAccountRuntime, openAccountRuntime, recordingAccountId, RunInProgressError, type AccountRuntime } from './runtime';

export type AccountState =
  | { status: 'none' }
  | { status: 'opening'; accountId: string }
  | { status: 'error'; accountId: string; error: Error }
  | { status: 'ready'; accountId: string; runtime: AccountRuntime; engine: SyncEngine | null; actions: RunActions | null };

interface AccountContextValue {
  state: AccountState;
  api: PaceApi | null;
  /** True while signed out but a run recorded by this account is still in progress. */
  sessionLapsed: boolean;
  retryOpen: () => void;
  signOut: () => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

/**
 * Opens the signed-in account's encrypted journal and starts its services. If the session
 * lapses mid-run, the recording account stays open so the run can be finished; its sync
 * resumes after the same account signs in again.
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [recordingAccount, setRecordingAccount] = useState<string | null | undefined>(undefined);
  const [opened, setOpened] = useState<{ accountId: string; attempt: number; state: AccountState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    recordingAccountId().then((id) => setRecordingAccount(id));
  }, []);

  const signedInId = auth.status === 'signed_in' ? auth.userId : null;
  const accountId = signedInId ?? (auth.status === 'signed_out' ? (recordingAccount ?? null) : null);
  const sessionLapsed = auth.status === 'signed_out' && accountId !== null;

  // Derived: the opened account only counts while it is still the one we want.
  const state = useMemo<AccountState>(
    () =>
      !accountId
        ? { status: 'none' }
        : opened && opened.accountId === accountId && opened.attempt === attempt
          ? opened.state
          : { status: 'opening', accountId },
    [accountId, opened, attempt],
  );

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    let engine: SyncEngine | null = null;
    openAccountRuntime(accountId).then(
      (runtime) => {
        if (cancelled) return;
        engine = api
          ? new SyncEngine({
              journal: runtime.journal,
              api,
              sha256: sha256Hex,
              environment: env.appEnv,
              onRunSynced: () => void queryClient.invalidateQueries({ queryKey: [accountId] }),
              onEvent: (name, props) => runtime.telemetry.track(name, props),
            })
          : null;
        setOpened({
          accountId,
          attempt,
          state: {
            status: 'ready',
            accountId,
            runtime,
            engine,
            // A deleted run also leaves Apple Health or Health Connect (docs/ROADMAP.md 1.6).
            actions: engine ? createRunActions(runtime.journal, engine, { onRemoved: (runId) => void runtime.health.remove(runId).catch(() => undefined) }) : null,
          },
        });
        void restoreReminder(runtime.journal).catch(() => undefined);
      },
      (error: Error) => {
        if (!cancelled) setOpened({ accountId, attempt, state: { status: 'error', accountId, error } });
      },
    );
    return () => {
      cancelled = true;
      engine?.stop();
    };
  }, [accountId, attempt, queryClient]);

  const engine = state.status === 'ready' ? state.engine : null;
  const accessToken = auth.status === 'signed_in' ? auth.session.access_token : null;

  // Sync whenever we (re)gain a session, connectivity, or the foreground.
  useEffect(() => {
    if (engine && accessToken) void engine.resumeAfterAuth();
  }, [engine, accessToken]);

  // Health import (docs/ROADMAP.md 2.1; Health Connect on Android, P.1): on open, on returning to
  // the app and, on iPhone, when Health wakes us for a new workout. Imported runs then sync like
  // recorded ones.
  const runtime = state.status === 'ready' ? state.runtime : null;
  useEffect(() => {
    if (!runtime || !engine) return;
    const importer = runtime.healthImport;
    const pass = () => void importer.importNew().catch(() => 0);
    const offImported = importer.imported.subscribe(() => {
      void engine.run();
      void queryClient.invalidateQueries({ queryKey: [runtime.accountId] });
    });
    let stopWatching: (() => void) | null = null;
    const syncWatch = () => {
      const on = runtime.runSettings.get().healthImport && importer.available;
      if (on && !stopWatching) stopWatching = runtime.healthImport.watch(pass);
      if (!on && stopWatching) {
        stopWatching();
        stopWatching = null;
      }
    };
    syncWatch();
    const offSettings = runtime.runSettings.subscribe(syncWatch);
    pass();
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') pass();
    });
    return () => {
      offImported();
      offSettings();
      stopWatching?.();
      appState.remove();
    };
  }, [runtime, engine, queryClient]);

  // Runs from the PaceLeague Apple Watch app (docs/ROADMAP.md 2.2): saved as they arrive, and on
  // open and on returning to the app, then synced like recorded runs.
  useEffect(() => {
    if (!runtime || !engine) return;
    const inbox = runtime.watchRuns;
    const pass = () => void inbox.drain().catch(() => 0);
    const offReceived = inbox.received.subscribe(() => {
      void engine.run();
      void queryClient.invalidateQueries({ queryKey: [runtime.accountId] });
    });
    const stopWatching = inbox.watch();
    pass();
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') pass();
    });
    return () => {
      offReceived();
      stopWatching?.();
      appState.remove();
    };
  }, [runtime, engine, queryClient]);

  useEffect(() => {
    if (!engine || !accessToken) return;
    const network = Network.addNetworkStateListener((s) => {
      if (s.isConnected) void engine.run();
    });
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') void engine.run();
    });
    return () => {
      network.remove();
      appState.remove();
    };
  }, [engine, accessToken]);

  const signOut = useCallback(async () => {
    if (state.status === 'ready' && (await state.runtime.journal.getSession())) throw new RunInProgressError();
    await cancelReminder().catch(() => undefined);
    writeWidgetWeek(null);
    if (state.status === 'ready') state.engine?.stop();
    await closeAccountRuntime();
    queryClient.clear();
    setRecordingAccount(null);
    await signOutEverywhere();
  }, [state, queryClient]);

  const value = useMemo<AccountContextValue>(
    () => ({ state, api, sessionLapsed, retryOpen: () => setAttempt((n) => n + 1), signOut }),
    [state, sessionLapsed, signOut],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount must be used inside AccountProvider');
  return value;
}

/** Services of the open account; only call below a screen that requires a ready account. */
export function useAccountServices() {
  const { state, api: client } = useAccount();
  if (state.status !== 'ready') throw new Error('Account is not ready');
  return { ...state, api: client };
}
