// Builds a database with the production migrator (server/src/migrate.ts) — the same code the
// API's pre-deploy step runs on Railway. Used for the backend test template and the dev backend.
//   tsx scripts/db/apply-migrations.ts [--database paceleague_template] [--permissive]
// --permissive (or DB_PLATFORM=permissive) adds the Supabase-like default privileges from
// db/test-support between the platform layer and the migrations, to prove RLS alone protects data.
// Connection: PG_TEST_URL (admin URL to the "postgres" database) or the local harness default.
import pg from 'pg';

import { createLogger } from '../../server/src/log';
import { findDbDir, migrate, migrationFiles } from '../../server/src/migrate';

const args = process.argv.slice(2);
const database = args.includes('--database') ? (args[args.indexOf('--database') + 1] ?? 'paceleague_template') : 'paceleague_template';
const permissive = args.includes('--permissive') || process.env.DB_PLATFORM === 'permissive';
const adminUrl = process.env.PG_TEST_URL ?? `postgres://postgres@127.0.0.1:${process.env.PGPORT ?? 54329}/postgres`;

export function databaseUrl(name: string, base = adminUrl): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function recreateDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name]);
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
}

export async function buildDatabase(name: string, options: { permissive?: boolean; quiet?: boolean } = {}): Promise<void> {
  await recreateDatabase(name);
  const client = new pg.Client({ connectionString: databaseUrl(name) });
  await client.connect();
  try {
    const files = migrationFiles(findDbDir(), { extraBeforeMigrations: options.permissive ? ['test-support'] : [] });
    await migrate(client as unknown as pg.PoolClient, files, createLogger(options.quiet ? 'warn' : 'info'));
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('apply-migrations.ts')) {
  buildDatabase(database, { permissive })
    .then(() => console.log(`✓ ${database} (${permissive ? 'permissive Supabase-like defaults' : 'strict platform'})`))
    .catch((error: unknown) => {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
