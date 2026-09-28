import { useSyncExternalStore } from 'react';

import { offlineMaps, type OfflineArea } from './offline-maps';

/** The signed-in account's map areas on this phone (docs/ROADMAP.md 5.2). */
export function useOfflineAreas(): { available: boolean; areas: OfflineArea[] } {
  const store = offlineMaps();
  const areas = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { available: store.available, areas };
}
