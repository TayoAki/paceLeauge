import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

import { useAccount } from '@/features/account/account-provider';
import { useCachedQuery } from '@/features/data/hooks';
import { Emitter } from '@/lib/emitter';

import { configurePurchases } from './purchases';

/** The server's word on Pro (webhook-fed), plus a purchase made on this phone just now. */
export const useEntitlements = () => useCachedQuery('entitlements', [], (api) => api.getEntitlements(), { staleTime: 60_000 });

const justBought = new Emitter<boolean>();
let bought = false;
justBought.subscribe((value) => {
  bought = value;
});

/** A purchase unlocks Pro here at once; the server catches up when RevenueCat's webhook arrives. */
export function markPurchased(): void {
  justBought.emit(true);
}

export function usePro(): { pro: boolean; loading: boolean } {
  const entitlements = useEntitlements();
  const local = useSyncExternalStore(
    (listener) => justBought.subscribe(() => listener()),
    () => bought,
  );
  return { pro: local || !!entitlements.data?.data.pro, loading: entitlements.isPending };
}

/** Signs the store SDK in as the runner, so purchases belong to their account. */
export function usePurchasesSetup(): void {
  const { state } = useAccount();
  const queryClient = useQueryClient();
  const accountId = state.status === 'ready' ? state.accountId : null;
  useEffect(() => {
    if (!accountId) return;
    void configurePurchases(accountId).catch(() => undefined);
    // A new account starts without the last account's purchase.
    justBought.emit(false);
    void queryClient.invalidateQueries({ queryKey: [accountId, 'entitlements'] });
  }, [accountId, queryClient]);
}
