import pg from 'pg';

import { loadConfig } from '../../server/src/config';
import { createPool } from '../../server/src/db';
import { startJobs } from '../../server/src/jobs';
import { createLogger } from '../../server/src/log';
import { findDbDir, migrate, migrationFiles, runBootstrap } from '../../server/src/migrate';
import { createService } from '../../server/src/service';
import { databaseUrl } from '../db/apply-migrations';

/**
 * Local development backend: the production API (server/) in development mode, over a local
 * PostgreSQL migrated by the production migrator. Create accounts with a password in the app;
 * seeded runners share one demo password. With EXPO_PUBLIC_EMAIL_SIGN_IN=code, every address
 * accepts the sign-in code 123456 (codes are printed, never emailed). League scoring is on.
 *
 *   npm run db:local            # start the local Postgres (scripts/db/local-db.sh)
 *   npm run dev:backend         # the API on http://127.0.0.1:54400
 *   npm run dev:backend -- --reset --seed alex@demo.paceleague.test
 */
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const PORT = process.env.DEV_BACKEND_PORT ?? '54400';
const DATABASE = process.env.DEV_BACKEND_DB ?? 'paceleague_dev';
const ADMIN_URL = process.env.PG_TEST_URL ?? `postgres://postgres@127.0.0.1:${process.env.PGPORT ?? 54329}/postgres`;

async function main(): Promise<void> {
  const log = createLogger(process.env.DEV_BACKEND_QUIET === '1' ? 'warn' : 'info');
  const config = loadConfig({
    APP_ENV: 'development',
    HOST: '127.0.0.1',
    PORT,
    DATABASE_URL: databaseUrl(DATABASE, ADMIN_URL),
    DEV_FIXED_CODE: process.env.DEV_BACKEND_OTP ?? '123456',
    EMAIL_PROVIDER: 'log',
    CORS_ORIGINS: '*',
    BOOTSTRAP_ENABLE_COMPETITION: 'true',
    APPLE_AUDIENCES: process.env.APPLE_AUDIENCES,
    // Route planning (docs/ROADMAP.md 5.1): a GraphHopper server, such as one run locally.
    ROUTING_URL: process.env.ROUTING_URL,
    ROUTING_API_KEY: process.env.ROUTING_API_KEY,
    ROUTING_ELEVATION: process.env.ROUTING_ELEVATION,
  });

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = (await admin.query('select 1 from pg_database where datname = $1', [DATABASE])).rowCount === 1;
  if (exists && flag('--reset')) {
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [DATABASE]);
    await admin.query(`drop database ${DATABASE}`);
  }
  if (!exists || flag('--reset')) await admin.query(`create database ${DATABASE}`);
  await admin.end();

  const pool = createPool(config);
  const client = await pool.connect();
  try {
    await migrate(client, migrationFiles(findDbDir()), log);
    await runBootstrap(client, config, log);
  } finally {
    client.release();
  }

  const seedEmail = option('--seed');
  let seeded: { email: string; password: string } | null = null;
  if (seedEmail) {
    const { DEMO_PASSWORD, seedDemo } = await import('./seed');
    await seedDemo(pool, { viewerEmail: seedEmail.toLowerCase() });
    seeded = { email: seedEmail.toLowerCase(), password: DEMO_PASSWORD };
  }

  const { server, strava, garmin, billing } = await createService({ config, pool, log });
  const jobs = startJobs(pool, log, { strava, garmin, billing });
  server.listen(config.port, config.host, () => {
    console.log(`\nPaceLeague API (development) on http://127.0.0.1:${config.port} — database ${DATABASE}`);
    console.log('Start the app against it with:\n');
    console.log(`  EXPO_PUBLIC_API_URL=http://127.0.0.1:${config.port}`);
    console.log(`  EXPO_PUBLIC_API_KEY=${config.publicApiKey}\n`);
    if (seeded) console.log(`Seeded runner: ${seeded.email} / password ${seeded.password}`);
    console.log(`Or create an account in the app. With EXPO_PUBLIC_EMAIL_SIGN_IN=code, any email accepts code ${config.devFixedCode}.\n`);
  });
  const shutdown = () => {
    server.close();
    void jobs.stop().then(() => pool.end()).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
