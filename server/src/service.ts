import { randomBytes } from 'node:crypto';

import { createAppleVerifier, type AppleVerifier } from './auth/apple';
import type { ServerConfig } from './config';
import type { Pool } from './db';
import { createApi } from './http';
import type { Logger } from './log';
import { createMailer, loadCodeTemplate, type Mailer } from './mailer';
import { findDbDir } from './migrate';

/**
 * The signing secret: JWT_SECRET when set, otherwise one generated on first boot and kept in
 * platform.settings — so no secret ever has to be copied between systems. Rotating it (set
 * JWT_SECRET, or delete the row) signs everyone out of their current access token only; refresh
 * tokens keep working.
 */
export async function resolveSigningSecret(pool: Pool, config: Pick<ServerConfig, 'jwtSecret'>): Promise<string> {
  if (config.jwtSecret) return config.jwtSecret;
  const { rows } = await pool.query<{ value: string }>(
    `insert into platform.settings (key, value) values ('jwt_secret', $1)
     on conflict (key) do update set key = excluded.key
     returning value`,
    [randomBytes(48).toString('base64url')],
  );
  return rows[0]!.value;
}

export async function createService(options: { config: ServerConfig; pool: Pool; log: Logger; mailer?: Mailer; apple?: AppleVerifier; fetchImpl?: typeof fetch }) {
  const { config, pool, log } = options;
  const secret = await resolveSigningSecret(pool, config);
  let template: string | null = null;
  try {
    template = loadCodeTemplate(findDbDir());
  } catch {
    template = null;
  }
  const mailer = options.mailer ?? createMailer(config, log, template, options.fetchImpl);
  const apple = options.apple ?? createAppleVerifier(config.appleAudiences, options.fetchImpl);
  return createApi({ config, pool, secret, mailer, apple, log });
}
