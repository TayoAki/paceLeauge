import type { Pool } from './db';
import type { Logger } from './log';
import type { GarminWorker } from './garmin';
import type { StravaWorker } from './strava';

/**
 * Scheduled work. Railway's Postgres has no pg_cron, so the service runs the jobs that
 * db/migrations/…_maintenance.sql would otherwise schedule. A session advisory lock makes sure
 * only one instance runs a job at a time, however many replicas are deployed.
 */
const FREQUENT_LOCK = 7_340_101;
const HOURLY_LOCK = 7_340_102;
const STRAVA_LOCK = 7_340_103;
const GARMIN_LOCK = 7_340_104;

const AUTH_CLEANUP = `
  delete from auth.one_time_codes where expires_at < now() - interval '1 hour';
  delete from auth.rate_limits where window_start < now() - interval '2 days';
  delete from auth.refresh_tokens where revoked_at < now() - interval '30 days';
  delete from auth.sessions where revoked_at < now() - interval '30 days';
`;

async function withLock(pool: Pool, key: number, work: (run: (sql: string) => Promise<unknown>) => Promise<void>): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [key]);
    if (!rows[0]?.locked) return false;
    try {
      await work(async (sql) => (await client.query(sql)).rows);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [key]);
    }
    return true;
  } finally {
    client.release();
  }
}

export async function runFrequentJobs(pool: Pool, log: Logger): Promise<void> {
  await withLock(pool, FREQUENT_LOCK, async (run) => {
    const [row] = (await run('select private.run_frequent_jobs() as result')) as { result: Record<string, number> }[];
    const result = row?.result ?? {};
    if (Object.values(result).some((n) => n > 0)) log.info('frequent jobs', result);
  });
}

export async function runHourlyJobs(pool: Pool, log: Logger): Promise<void> {
  await withLock(pool, HOURLY_LOCK, async (run) => {
    const [row] = (await run('select private.purge_expired() as result')) as { result: Record<string, number> }[];
    await run(AUTH_CLEANUP);
    log.info('hourly retention', row?.result ?? {});
  });
}

/** Strava uploads and revocations (docs/ROADMAP.md 2.3), one instance at a time. */
export async function runStravaJobs(pool: Pool, log: Logger, worker: StravaWorker): Promise<void> {
  await withLock(pool, STRAVA_LOCK, async () => {
    const result = await worker.runOnce();
    if (Object.values(result).some((n) => n > 0)) log.info('strava jobs', result);
  });
}

/** Garmin activities from Terra and ended links (docs/ROADMAP.md 2.4), one instance at a time. */
export async function runGarminJobs(pool: Pool, log: Logger, worker: GarminWorker): Promise<void> {
  await withLock(pool, GARMIN_LOCK, async () => {
    const result = await worker.runOnce();
    if (Object.values(result).some((n) => n > 0)) log.info('garmin jobs', result);
  });
}

export function startJobs(
  pool: Pool,
  log: Logger,
  options: { intervals?: { frequentMs: number; hourlyMs: number }; strava?: StravaWorker | null; garmin?: GarminWorker | null } = {},
): { stop: () => Promise<void> } {
  const intervals = options.intervals ?? { frequentMs: 60_000, hourlyMs: 3_600_000 };
  const strava = options.strava ?? null;
  const garmin = options.garmin ?? null;
  let stopped = false;
  const running = new Set<Promise<void>>();
  const schedule = (name: string, everyMs: number, job: () => Promise<void>) => {
    const tick = () => {
      if (stopped) return;
      const run = job()
        .catch((error: unknown) => log.error('job failed', { job: name, error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          running.delete(run);
          if (!stopped) timer = setTimeout(tick, everyMs);
        });
      running.add(run);
    };
    let timer = setTimeout(tick, Math.min(everyMs, 5_000));
    return () => clearTimeout(timer);
  };
  const cancels = [
    schedule('frequent', intervals.frequentMs, () => runFrequentJobs(pool, log)),
    schedule('hourly', intervals.hourlyMs, () => runHourlyJobs(pool, log)),
    ...(strava ? [schedule('strava', intervals.frequentMs, () => runStravaJobs(pool, log, strava))] : []),
    ...(garmin ? [schedule('garmin', intervals.frequentMs, () => runGarminJobs(pool, log, garmin))] : []),
  ];
  return {
    async stop() {
      stopped = true;
      cancels.forEach((cancel) => cancel());
      await Promise.allSettled([...running]);
    },
  };
}
