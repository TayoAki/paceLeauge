import type { Journal } from '@/db/journal';
import { newId } from '@/lib/crypto';

/**
 * Minimized product telemetry (REQ-015): an allowlist of event names with enumerated
 * string/boolean props only — never coordinates, routes, titles, emails, tokens or precise
 * health statistics. Events queue in the journal and flush with the sync engine; losing
 * them never blocks recording or saving.
 */
const ALLOWED: Record<string, readonly string[]> = {
  account_created: [],
  onboarding_completed: ['goal_set', 'units'],
  permission_result: ['permission', 'result', 'precise'],
  run_started: [],
  run_saved_local: ['interrupted', 'duration_bucket', 'points_bucket'],
  run_sync_outcome: ['outcome', 'latency_bucket', 'reason'],
  league_joined: ['source'],
  league_week_participated: [],
  share_sheet_opened: ['format'],
  deletion_requested: [],
  sync_retry: ['reason', 'attempt_bucket'],
  outbox_backlog: ['size_bucket', 'age_bucket'],
  recorder_interrupted: ['reason'],
  app_error: ['code', 'area'],
};

export type TelemetryName = keyof typeof ALLOWED;
export type TelemetryProps = Record<string, string | boolean>;

const VALUE = /^[a-z0-9_]{1,32}$/;

export function sanitizeProps(name: string, props: TelemetryProps = {}): TelemetryProps | null {
  const allowed = ALLOWED[name];
  if (!allowed) return null;
  const clean: TelemetryProps = {};
  for (const key of allowed) {
    const value = props[key];
    if (typeof value === 'boolean' || (typeof value === 'string' && VALUE.test(value))) clean[key] = value;
  }
  return clean;
}

export function durationBucket(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 5) return 'lt_5m';
  if (minutes < 15) return 'm5_15';
  if (minutes < 30) return 'm15_30';
  if (minutes < 60) return 'm30_60';
  if (minutes < 120) return 'h1_2';
  return 'ge_2h';
}

export function countBucket(n: number): string {
  if (n === 0) return 'zero';
  if (n < 100) return 'lt_100';
  if (n < 1000) return 'lt_1k';
  if (n < 10_000) return 'lt_10k';
  return 'ge_10k';
}

export function createTelemetry(journal: Journal, clock: () => number = Date.now) {
  return {
    track(name: TelemetryName, props?: TelemetryProps): void {
      const clean = sanitizeProps(name, props);
      if (!clean) return;
      void journal.queueEvent({ eventId: newId(), name, occurredAt: clock(), props: clean }).catch(() => undefined);
    },
  };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
