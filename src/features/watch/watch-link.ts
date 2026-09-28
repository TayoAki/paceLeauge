import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

/**
 * The phone's link to the PaceLeague Apple Watch app (docs/ROADMAP.md 2.2; native side:
 * modules/watch-link). Null where there is no watch support (Android, web, or a build without the
 * module), and every caller copes with that.
 */
export interface WatchStatus {
  supported: boolean;
  paired: boolean;
  installed: boolean;
  reachable: boolean;
}

/** The run on the watch, mirrored live (iOS 17). */
export interface WatchWorkoutEvent {
  state: 'running' | 'paused' | 'ended';
  elapsed_s?: number;
  distance_m?: number;
  heart_rate?: number | null;
  indoor?: boolean;
}

export interface WatchLinkPort {
  status(): WatchStatus;
  updateContext(json: string): boolean;
  pendingRuns(): { name: string; json: string }[];
  ackRun(name: string): void;
  onRun(listener: () => void): () => void;
  onWorkout(listener: (event: WatchWorkoutEvent) => void): () => void;
  /** A planned route for the watch's next run (docs/ROADMAP.md 5.1); false when it can't go. */
  sendRoute(json: string): boolean;
}

interface NativeWatchLink {
  status(): WatchStatus;
  updateContext(json: string): boolean;
  sendRoute?(json: string): boolean;
  pendingRuns(): { name: string; json: string }[];
  ackRun(name: string): void;
  addListener(event: 'onWatchRun' | 'onWatchWorkout', listener: (payload: Record<string, unknown>) => void): { remove(): void };
}

let port: WatchLinkPort | null | undefined;

export function deviceWatchLink(): WatchLinkPort | null {
  if (port !== undefined) return port;
  port = null;
  if (Platform.OS !== 'ios') return port;
  const native = requireOptionalNativeModule<NativeWatchLink>('WatchLink');
  if (!native) return port;
  port = {
    status: () => native.status(),
    updateContext: (json) => native.updateContext(json),
    pendingRuns: () => native.pendingRuns(),
    ackRun: (name) => native.ackRun(name),
    // Absent from builds made before routes could be sent.
    sendRoute: (json) => native.sendRoute?.(json) ?? false,
    onRun: (listener) => {
      const sub = native.addListener('onWatchRun', () => listener());
      return () => sub.remove();
    },
    onWorkout: (listener) => {
      const sub = native.addListener('onWatchWorkout', (payload) => {
        const state = payload.state;
        if (state === 'running' || state === 'paused' || state === 'ended') listener(payload as unknown as WatchWorkoutEvent);
      });
      return () => sub.remove();
    },
  };
  return port;
}

/** What the watch shows before a run and on its complication (targets/watch/Shared.swift). */
export interface WatchContext {
  units: 'metric' | 'imperial';
  cues: boolean;
  active_days: number | null;
  goal_days: number | null;
  league_name: string | null;
  league_rank: number | null;
}

export function watchContextJson(context: WatchContext): string {
  return JSON.stringify(context);
}
