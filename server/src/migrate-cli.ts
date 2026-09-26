import { ConfigError, loadConfig } from './config';
import { createPool } from './db';
import { createLogger } from './log';
import { findDbDir, migrate, migrationFiles, runBootstrap } from './migrate';

// Railway pre-deploy command: validate configuration, apply pending migrations, run one-time
// bootstrap actions. A failure here stops the deploy before the new version takes traffic.
const log = createLogger();

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ ...config, databasePoolMax: 1 });
  const client = await pool.connect();
  try {
    const applied = await migrate(client, migrationFiles(findDbDir()), log);
    await runBootstrap(client, config, log);
    log.info('migrations complete', { applied: applied.length });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  log.error(error instanceof ConfigError ? 'invalid configuration' : 'migration failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
