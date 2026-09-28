import { Platform } from 'react-native';

import type { HrSample, SleepSample, TrendSample } from '@/domain/training';

import { healthConnectData } from './health-connect';

/**
 * Heart rate and health trends from Apple Health (docs/ROADMAP.md 3.5). Read on this phone with
 * the runner's consent, only while the matching setting is on, and never sent to PaceLeague's
 * servers: zones and trends are worked out here and shown only to the runner.
 */
export type TrendQuantity = 'restingHr' | 'hrv' | 'vo2max';

export interface HealthDataPort {
  isAvailable(): boolean;
  /** Asks to read heart rate, for zones. Health never says whether reading was allowed. */
  requestHeartRate(): Promise<void>;
  /** Asks to read resting heart rate, heart rate variability, VO2 max and sleep. */
  requestTrends(): Promise<void>;
  heartRate(fromMs: number, toMs: number): Promise<HrSample[]>;
  trend(kind: TrendQuantity, fromMs: number, toMs: number): Promise<TrendSample[]>;
  sleep(fromMs: number, toMs: number): Promise<SleepSample[]>;
}

// ---------------------------------------------------------------------------------------
// The device port (iOS only; @kingstinct/react-native-healthkit)
// ---------------------------------------------------------------------------------------
type HealthKitLibrary = typeof import('@kingstinct/react-native-healthkit');

const TREND_READ = [
  'HKQuantityTypeIdentifierRestingHeartRate',
  'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  'HKQuantityTypeIdentifierVO2Max',
  'HKCategoryTypeIdentifierSleepAnalysis',
] as const;

const range = (fromMs: number, toMs: number) => ({ date: { startDate: new Date(fromMs), endDate: new Date(toMs) } });

let port: HealthDataPort | null | undefined;

export function deviceHealthData(): HealthDataPort | null {
  // Android: Health Connect, once prepareHealthConnect() has found it.
  if (Platform.OS === 'android') return healthConnectData();
  if (port !== undefined) return port;
  port = null;
  if (__DEV__ && Platform.OS === 'web') {
    // Development on the web: a browser test can supply sample data (see demoHealthData).
    const demo = (globalThis as { __PACELEAGUE_HEALTH_DEMO__?: boolean }).__PACELEAGUE_HEALTH_DEMO__;
    if (demo) port = demoHealthData();
    return port;
  }
  if (Platform.OS !== 'ios') return port;
  let lib: HealthKitLibrary;
  try {
    // Loaded lazily: the native side exists only in builds made with the HealthKit plugin.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('@kingstinct/react-native-healthkit') as HealthKitLibrary;
    if (!lib.isHealthDataAvailable()) return port;
  } catch {
    return port;
  }
  port = {
    isAvailable: () => true,
    requestHeartRate: async () => {
      await lib.requestAuthorization({ toRead: ['HKQuantityTypeIdentifierHeartRate'], toShare: [] });
    },
    requestTrends: async () => {
      await lib.requestAuthorization({ toRead: TREND_READ, toShare: [] });
    },
    heartRate: async (fromMs, toMs) => {
      const samples = await lib.queryQuantitySamples('HKQuantityTypeIdentifierHeartRate', {
        limit: 0,
        ascending: true,
        unit: 'count/min',
        filter: range(fromMs, toMs),
      });
      return samples.map((s) => ({ t: s.startDate.getTime(), bpm: s.quantity }));
    },
    trend: async (kind, fromMs, toMs) => {
      const options = { limit: 0, ascending: true, filter: range(fromMs, toMs) };
      const samples =
        kind === 'restingHr'
          ? await lib.queryQuantitySamples('HKQuantityTypeIdentifierRestingHeartRate', { ...options, unit: 'count/min' })
          : kind === 'hrv'
            ? await lib.queryQuantitySamples('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', { ...options, unit: 'ms' })
            : await lib.queryQuantitySamples('HKQuantityTypeIdentifierVO2Max', { ...options, unit: 'ml/(kg*min)' });
      return samples.map((s) => ({ t: s.startDate.getTime(), value: s.quantity }));
    },
    sleep: async (fromMs, toMs) => {
      const samples = await lib.queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis', { limit: 0, ascending: true, filter: range(fromMs, toMs) });
      return samples.map((s) => ({ startMs: s.startDate.getTime(), endMs: s.endDate.getTime(), value: Number(s.value) }));
    },
  };
  return port;
}

/**
 * Made-up readings for trying the screens in a browser during development: a heart rate that
 * climbs through the zones, and gently improving trends. Never used in a release build.
 */
function demoHealthData(): HealthDataPort {
  const DAY = 86_400_000;
  const days = (fromMs: number, toMs: number) => {
    const out: number[] = [];
    for (let t = Math.ceil(fromMs / DAY) * DAY + 7 * 3_600_000; t < toMs; t += DAY) out.push(t);
    return out;
  };
  return {
    isAvailable: () => true,
    requestHeartRate: async () => undefined,
    requestTrends: async () => undefined,
    heartRate: async (fromMs, toMs) => {
      const out: HrSample[] = [];
      const span = Math.max(1, toMs - fromMs);
      for (let t = fromMs; t < toMs; t += 5_000) out.push({ t, bpm: Math.round(118 + 62 * ((t - fromMs) / span) + 4 * Math.sin(t / 40_000)) });
      return out;
    },
    trend: async (kind, fromMs, toMs) =>
      days(fromMs, toMs).map((t, i) => ({
        t,
        value: kind === 'restingHr' ? 58 - i * 0.03 + Math.sin(i) : kind === 'hrv' ? 48 + i * 0.05 + 3 * Math.sin(i / 2) : 44 + i * 0.01,
      })),
    sleep: async (fromMs, toMs) =>
      days(fromMs, toMs).map((t, i) => ({ startMs: t - 8.5 * 3_600_000, endMs: t - (1 + (i % 3) * 0.25) * 3_600_000, value: 1 })),
  };
}
