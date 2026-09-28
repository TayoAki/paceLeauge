import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useAccount } from '@/features/account/account-provider';

/** The account journal key holding the league the League tab shows. */
export const SELECTED_LEAGUE_KEY = 'league:selected';

let selected: { accountId: string; leagueId: string | null } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Which of the runner's leagues the League tab shows (docs/ROADMAP.md 4.1), remembered per account
 * on this phone. Null means their first league, which is also what the server picks.
 */
export function useSelectedLeague(): [string | null, (leagueId: string | null) => void] {
  const { state } = useAccount();
  const accountId = state.status === 'ready' ? state.accountId : null;
  const journal = state.status === 'ready' ? state.runtime.journal : null;
  const leagueId = useSyncExternalStore(
    subscribe,
    () => (selected && selected.accountId === accountId ? selected.leagueId : null),
    () => null,
  );

  useEffect(() => {
    if (!accountId || !journal || selected?.accountId === accountId) return;
    selected = { accountId, leagueId: null };
    journal
      .getKv<string | null>(SELECTED_LEAGUE_KEY)
      .then((saved) => {
        if (selected?.accountId !== accountId || selected.leagueId !== null || !saved?.value) return;
        selected = { accountId, leagueId: saved.value };
        emit();
      })
      .catch(() => undefined);
  }, [accountId, journal]);

  const select = useCallback(
    (next: string | null) => {
      if (!accountId) return;
      selected = { accountId, leagueId: next };
      emit();
      journal?.setKv(SELECTED_LEAGUE_KEY, next).catch(() => undefined);
    },
    [accountId, journal],
  );
  return [leagueId, select];
}
