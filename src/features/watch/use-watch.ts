import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useAccount } from '@/features/account/account-provider';
import { useLeague, useMe, useWeek } from '@/features/data/hooks';

import { deviceWatchLink, watchContextJson, type WatchWorkoutEvent } from './watch-link';

const noopSubscribe = () => () => undefined;

/** Keeps the watch app's start screen and complication in step with the week and league (2.2). */
export function useWatchContextSync(): void {
  const { state } = useAccount();
  const settingsStore = state.status === 'ready' ? state.runtime.runSettings : null;
  const settings = useSyncExternalStore(settingsStore?.subscribe ?? noopSubscribe, () => settingsStore?.getSnapshot() ?? null);
  const units = useMe().data?.data.profile?.units ?? 'metric';
  const week = useWeek().data?.data;
  const league = useLeague(0).data?.data ?? null;
  const sent = useRef<string | null>(null);

  const json = watchContextJson({
    units,
    cues: settings?.cues.enabled ?? true,
    active_days: week?.active_days ?? null,
    goal_days: week?.goal_days ?? null,
    league_name: league?.league?.name ?? null,
    league_rank: league?.me?.rank ?? null,
  });

  useEffect(() => {
    const link = deviceWatchLink();
    if (!link || json === sent.current) return;
    // Sent only when the watch app is installed; it always receives the latest.
    if (link.updateContext(json)) sent.current = json;
  }, [json]);
}

/** The run on the watch while it is mirrored to the phone, or null. */
export function useWatchWorkout(): WatchWorkoutEvent | null {
  const [workout, setWorkout] = useState<WatchWorkoutEvent | null>(null);
  useEffect(() => {
    const link = deviceWatchLink();
    if (!link) return;
    return link.onWorkout((event) => {
      setWorkout((previous) => (event.state === 'ended' ? null : { ...previous, ...event }));
    });
  }, []);
  return workout;
}
