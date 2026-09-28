import { Journal } from '@/db/journal';
import { openAccountDatabase } from '@/db/open';
import type { IsoDate } from '@/domain/types';
import { newId } from '@/lib/crypto';
import { deviceStore } from '@/lib/device-store';
import { RECORDING_ACCOUNT_KEY } from '@/features/recording/constants';
import { locationDriver } from '@/features/recording/location-driver';
import { RecorderService } from '@/features/recording/recorder-service';
import { setActiveRecorder } from '@/features/recording/registry';
import type { CreditedDays } from '@/features/recording/run-draft';
import { countBucket, createTelemetry, durationBucket, type Telemetry } from '@/features/telemetry/telemetry';

/**
 * One open journal + recorder per account per process, shared by the UI and by the
 * background location task (a second connection would bypass the journal's write
 * serialization).
 */
export interface AccountRuntime {
  accountId: string;
  journal: Journal;
  recorder: RecorderService;
  telemetry: Telemetry;
}

let current: AccountRuntime | null = null;
let opening: { accountId: string; promise: Promise<AccountRuntime> } | null = null;

export const WEEK_CACHE_KEY = 'q:week';

/** Same-day totals already credited by the server, from the cached week summary. */
async function creditedDaysFrom(journal: Journal): Promise<CreditedDays> {
  const cached = await journal.getKv<{ days: { date: IsoDate; distance_cm: number; active_ms: number }[] }>(WEEK_CACHE_KEY);
  const days = new Map<IsoDate, { distanceCm: number; activeMs: number }>();
  for (const d of cached?.value.days ?? []) {
    if (d.distance_cm > 0 || d.active_ms > 0) days.set(d.date, { distanceCm: d.distance_cm, activeMs: d.active_ms });
  }
  return days;
}

async function create(accountId: string): Promise<AccountRuntime> {
  const journal = await Journal.open(await openAccountDatabase(accountId));
  const telemetry = createTelemetry(journal);
  const recorder = new RecorderService({
    journal,
    location: locationDriver,
    newRunId: newId,
    heartbeatMs: 5_000,
    creditedDays: () => creditedDaysFrom(journal),
    onRecordingChange: async (active) => {
      if (active) await deviceStore.set(RECORDING_ACCOUNT_KEY, accountId);
      else await deviceStore.remove(RECORDING_ACCOUNT_KEY);
    },
    onEvent: (event) => {
      if (event.name === 'run_saved_local') {
        telemetry.track('run_saved_local', {
          interrupted: event.interrupted,
          duration_bucket: durationBucket(event.activeMs),
          points_bucket: countBucket(event.points),
        });
      } else if (event.name === 'recorder_interrupted') {
        telemetry.track('recorder_interrupted', { reason: event.reason });
      } else if (event.name === 'run_started') {
        telemetry.track('run_started');
      }
      // Pause and resume events drive voice cues only; they are not telemetry.
    },
  });
  await recorder.init();
  setActiveRecorder(recorder);
  return { accountId, journal, recorder, telemetry };
}

export async function openAccountRuntime(accountId: string): Promise<AccountRuntime> {
  if (current?.accountId === accountId) return current;
  if (current) await closeAccountRuntime();
  if (opening?.accountId !== accountId) {
    const promise = create(accountId).then((runtime) => {
      current = runtime;
      return runtime;
    });
    opening = { accountId, promise };
    promise.catch(() => undefined).finally(() => {
      if (opening?.promise === promise) opening = null;
    });
  }
  return opening!.promise;
}

export function currentAccountRuntime(): AccountRuntime | null {
  return current;
}

export class RunInProgressError extends Error {
  constructor() {
    super('Finish or discard your run first.');
    this.name = 'RunInProgressError';
  }
}

/** Closes the account's journal. Refuses while a run is in progress. */
export async function closeAccountRuntime(): Promise<void> {
  const runtime = current;
  if (!runtime) return;
  if (await runtime.journal.getSession()) throw new RunInProgressError();
  runtime.recorder.dispose();
  setActiveRecorder(null);
  current = null;
  await runtime.journal.close();
}

/** The account whose run is recording on this device, if any (survives session expiry). */
export function recordingAccountId(): Promise<string | null> {
  return deviceStore.get(RECORDING_ACCOUNT_KEY).catch(() => null);
}
