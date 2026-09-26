import pg from 'pg';

import type { ServerConfig } from './config';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(config: Pick<ServerConfig, 'databaseUrl' | 'databaseSsl' | 'databasePoolMax'>): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.databaseSsl === 'disable' ? undefined : { rejectUnauthorized: config.databaseSsl === 'require' },
  });
  // An idle client's connection dropping must not crash the process; the pool replaces it.
  pool.on('error', () => {});
  return pool;
}

/** Runs `fn` in a transaction on one pooled connection. */
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
