import { createHash } from 'node:crypto';

import type { Pool } from '../db';

/**
 * Fixed-window counter in auth.rate_limits. The increment is its own statement (autocommit), so
 * a request that fails afterwards still counts — guessing can't reset its own budget.
 */
export async function takeRateLimit(pool: Pool, bucket: string, max: number, windowS: number): Promise<boolean> {
  const { rows } = await pool.query<{ hits: number }>(
    `insert into auth.rate_limits as rl (bucket, window_start, hits)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (bucket, window_start) do update set hits = rl.hits + 1
     returning hits`,
    [bucket, windowS],
  );
  return (rows[0]?.hits ?? Infinity) <= max;
}

/** Buckets never store addresses in the clear. */
export function hashKey(value: string): string {
  return createHash('sha256').update(`pl-rate-v1:${value}`).digest('hex').slice(0, 32);
}
