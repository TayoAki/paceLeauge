import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import type { ServerConfig } from '../config';
import { transaction, type Pool } from '../db';
import type { Logger } from '../log';
import type { Mailer } from '../mailer';
import { hashKey, takeRateLimit } from './rate-limit';

/**
 * Six-digit sign-in codes. One live code per address, stored as an HMAC keyed by the server's
 * secret; it expires, works once, and dies after a few wrong guesses. Sending has a per-address
 * cooldown and hourly cap. The review account (App Review, staging checks) and the development
 * code are explicit configuration, and the development code is refused outside development.
 */
export type IssueResult = { status: 'sent' } | { status: 'cooldown'; retryAfterS: number } | { status: 'rate_limited' };

function equalText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class CodeService {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    private readonly config: Pick<ServerConfig, 'codes' | 'devFixedCode' | 'reviewAccount'>,
    secret: string,
    private readonly mailer: Mailer,
    private readonly log: Logger,
  ) {
    this.key = createHash('sha256').update(`pl-code-v1:${secret}`).digest();
  }

  private hmac(email: string, code: string): string {
    return createHmac('sha256', this.key).update(`${email}:${code}`).digest('hex');
  }

  private isReviewAccount(email: string): boolean {
    return this.config.reviewAccount !== null && this.config.reviewAccount.email === email;
  }

  async issue(email: string): Promise<IssueResult> {
    // The review account's code is fixed and its inbox may not exist: send nothing.
    if (this.isReviewAccount(email)) return { status: 'sent' };
    const { ttlS, resendCooldownS, maxPerEmailPerHour } = this.config.codes;

    const recent = await this.pool.query<{ age_s: number }>(
      'select extract(epoch from now() - sent_at)::float8 as age_s from auth.one_time_codes where email = $1',
      [email],
    );
    const age = recent.rows[0]?.age_s;
    if (age !== undefined && age < resendCooldownS) return { status: 'cooldown', retryAfterS: Math.ceil(resendCooldownS - age) };
    if (!(await takeRateLimit(this.pool, `code:send:${hashKey(email)}`, maxPerEmailPerHour, 3600))) return { status: 'rate_limited' };

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.pool.query(
      `insert into auth.one_time_codes (email, code_hmac, expires_at, sent_at, attempts)
       values ($1, $2, now() + make_interval(secs => $3), now(), 0)
       on conflict (email) do update set code_hmac = excluded.code_hmac, expires_at = excluded.expires_at, sent_at = now(), attempts = 0`,
      [email, this.hmac(email, code), ttlS],
    );
    try {
      await this.mailer.sendCode({ to: email, code, ttlMinutes: Math.round(ttlS / 60) });
    } catch (error) {
      // Don't leave a code the runner never received blocking a retry behind the cooldown.
      await this.pool.query('delete from auth.one_time_codes where email = $1 and code_hmac = $2', [email, this.hmac(email, code)]);
      this.log.error('sign-in code email failed', { error: error instanceof Error ? error.message : 'unknown' });
      throw error;
    }
    return { status: 'sent' };
  }

  /** True once per issued code; wrong guesses count toward the code's attempt limit. */
  async verify(email: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    if (this.config.devFixedCode !== null && equalText(code, this.config.devFixedCode)) return true;
    if (this.isReviewAccount(email)) return equalText(code, this.config.reviewAccount!.code);

    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<{ code_hmac: string; expired: boolean; attempts: number }>(
        'select code_hmac, expires_at <= now() as expired, attempts from auth.one_time_codes where email = $1 for update',
        [email],
      );
      const row = rows[0];
      if (!row) return false;
      if (row.expired || row.attempts >= this.config.codes.maxAttempts) {
        await client.query('delete from auth.one_time_codes where email = $1', [email]);
        return false;
      }
      if (equalText(row.code_hmac, this.hmac(email, code))) {
        await client.query('delete from auth.one_time_codes where email = $1', [email]);
        return true;
      }
      if (row.attempts + 1 >= this.config.codes.maxAttempts) await client.query('delete from auth.one_time_codes where email = $1', [email]);
      else await client.query('update auth.one_time_codes set attempts = attempts + 1 where email = $1', [email]);
      return false;
    });
  }
}
