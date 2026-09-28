import { useSyncExternalStore } from 'react';

import { useAccount } from '@/features/account/account-provider';

import type { WorkoutSnapshot } from './workout-controller';

const noSubscribe = () => () => undefined;
const noSnapshot = () => null;

/** The workout the current (or next) run follows. */
export function useWorkout(): WorkoutSnapshot | null {
  const { state } = useAccount();
  const workout = state.status === 'ready' ? state.runtime.workout : null;
  return useSyncExternalStore(workout?.subscribe ?? noSubscribe, workout?.getSnapshot ?? noSnapshot);
}
