import { ConfigError, loadConfig } from './config';
import { createPool } from './db';
import { startJobs } from './jobs';
import { createLogger } from './log';
import { createService } from './service';

// Production entrypoint (Railway): migrations already ran in the pre-deploy step (migrate-cli).
const log = createLogger((process.env.LOG_LEVEL as 'debug' | 'info' | undefined) ?? 'info');

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const { server, strava, garmin, billing } = await createService({ config, pool, log });
  const jobs = config.runJobs ? startJobs(pool, log, { strava, garmin, billing }) : null;

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  log.info('api listening', {
    env: config.appEnv,
    port: config.port,
    email: config.email.provider,
    apple: config.appleAudiences.length > 0,
    reviewAccount: config.reviewAccount !== null,
    jobs: config.runJobs,
    strava: config.strava !== null,
    garmin: config.garmin !== null,
    revenuecat: config.revenuecat !== null,
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    server.close();
    server.closeIdleConnections();
    void (jobs?.stop() ?? Promise.resolve())
      .then(() => pool.end())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  log.error(error instanceof ConfigError ? 'invalid configuration' : 'startup failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
