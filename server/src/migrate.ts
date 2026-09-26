import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ServerConfig } from './config';
import type { PoolClient } from './db';
import type { Logger } from './log';

/**
 * Forward-only migrations with a checksummed ledger (`platform.schema_migrations`). Files run in
 * order — db/platform/*.sql, then db/migrations/*.sql — each in its own transaction, under a
 * session advisory lock so two deploys can never migrate at once. Editing a file that has
 * already been applied is refused: add a new migration instead.
 */
export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const LOCK_KEY = 7_340_001;

/** The repository's `db/` directory: DB_DIR, or the nearest `db/migrations` above `start`. */
export function findDbDir(start = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  if (env.DB_DIR) return resolve(env.DB_DIR);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'db', 'migrations'))) return join(dir, 'db');
    const parent = dirname(dir);
    if (parent === dir) throw new MigrationError('db/migrations not found (set DB_DIR)');
    dir = parent;
  }
}

function read(dbDir: string, folder: string): MigrationFile[] {
  const dir = join(dbDir, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      return { name: `${folder}/${file}`, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Migration order. `extraBeforeMigrations` exists for the test suite only (it inserts the
 * Supabase-like permissive default privileges between the platform layer and the migrations).
 */
export function migrationFiles(dbDir: string, options: { extraBeforeMigrations?: string[] } = {}): MigrationFile[] {
  const extra = (options.extraBeforeMigrations ?? []).flatMap((folder) => read(dbDir, folder));
  return [...read(dbDir, 'platform'), ...extra, ...read(dbDir, 'migrations')];
}

function describeFailure(file: MigrationFile, error: unknown): string {
  const e = error as { message?: string; position?: string; where?: string };
  let context = '';
  const position = Number(e.position);
  if (Number.isFinite(position) && position > 0) {
    const line = file.sql.slice(0, position).split('\n').length;
    context = ` (line ${line}: ${file.sql.split('\n')[line - 1]?.trim()})`;
  }
  return `${file.name}: ${e.message ?? String(error)}${context}${e.where ? ` — ${e.where}` : ''}`;
}

export async function migrate(client: PoolClient, files: MigrationFile[], log: Logger): Promise<string[]> {
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`
      create schema if not exists platform;
      revoke all on schema platform from public;
      create table if not exists platform.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);
    const { rows } = await client.query<{ name: string; checksum: string }>('select name, checksum from platform.schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const done: string[] = [];
    for (const file of files) {
      const previous = applied.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new MigrationError(`${file.name} changed after it was applied. Never edit an applied migration — add a new one.`);
        }
        continue;
      }
      await client.query('begin');
      try {
        await client.query(file.sql);
        await client.query('insert into platform.schema_migrations (name, checksum) values ($1, $2)', [file.name, file.checksum]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw new MigrationError(describeFailure(file, error));
      }
      log.info('migration applied', { name: file.name });
      done.push(file.name);
    }
    return done;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}

/** One-time conveniences for non-production environments, recorded so they never repeat. */
export async function runBootstrap(client: PoolClient, config: Pick<ServerConfig, 'appEnv' | 'bootstrapEnableCompetition'>, log: Logger): Promise<void> {
  if (!config.bootstrapEnableCompetition) return;
  const inserted = await client.query(`insert into platform.bootstrap_actions (name) values ('enable_competition') on conflict do nothing returning name`);
  if (inserted.rowCount !== 1) return;
  await client.query(`select private.set_flag('competition_enabled', true, $1, 'bootstrap')`, [`BOOTSTRAP_ENABLE_COMPETITION on ${config.appEnv}`]);
  log.info('bootstrap: competition enabled (once)');
}
