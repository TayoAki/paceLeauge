import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { HeatReading } from '@/domain/heat';
import type { IsoDate } from '@/domain/types';
import { useAccount } from '@/features/account/account-provider';

/** The heat the runner gave for a day (Pro), kept on this phone until they change it. */
export interface HeatEntry extends HeatReading {
  date: IsoDate;
}

export const HEAT_KEY = 'plan:heat';

export function useHeat(date: IsoDate | null) {
  const { state } = useAccount();
  const runtime = state.status === 'ready' ? state.runtime : null;
  const accountId = runtime?.accountId ?? null;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [accountId, 'heat'],
    enabled: runtime !== null,
    staleTime: Infinity,
    queryFn: async () => (await runtime!.journal.getKv<HeatEntry | null>(HEAT_KEY))?.value ?? null,
  });
  const save = async (entry: HeatEntry | null) => {
    if (!runtime) return;
    await runtime.journal.setKv(HEAT_KEY, entry);
    queryClient.setQueryData([accountId, 'heat'], entry);
  };
  const entry = query.data ?? null;
  // Only the day it was given for: yesterday's heat says nothing about today.
  return { entry: entry && date && entry.date === date ? entry : null, save };
}
