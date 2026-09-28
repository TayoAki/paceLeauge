import { randomBytes } from 'node:crypto';

import { createAppleVerifier, type AppleVerifier } from './auth/apple';
import type { ServerConfig } from './config';
import type { Pool } from './db';
import { createApi } from './http';
import { legalDir, loadLegalPages } from './legal';
import type { Logger } from './log';
import { createMailer, loadCodeTemplate, type Mailer } from './mailer';
import { findDbDir } from './migrate';
import { createGarminWorker, createTerraApi, publishGarminSettings, type GarminWorker, type TerraApi } from './garmin';
import { createStravaApi, createStravaWorker, publishStravaSettings, type StravaApi, type StravaWorker } from './strava';

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

export async function createService(options: {
  config: ServerConfig;
  pool: Pool;
  log: Logger;
  mailer?: Mailer;
  apple?: AppleVerifier;
  fetchImpl?: typeof fetch;
  /** Replaces Strava's API (tests). */
  stravaApi?: StravaApi;
  /** Replaces Terra's API (tests). */
  terraApi?: TerraApi;
}): Promise<ReturnType<typeof createApi> & { strava: StravaWorker | null; garmin: GarminWorker | null }> {
  const { config, pool, log } = options;
  const secret = await resolveSigningSecret(pool, config);
  let template: string | null = null;
  let legal: ReturnType<typeof loadLegalPages> = {};
  try {
    const dbDir = findDbDir();
    template = loadCodeTemplate(dbDir);
    legal = loadLegalPages(legalDir(dbDir));
  } catch {
    template = null;
  }
  const mailer = options.mailer ?? createMailer(config, log, template, options.fetchImpl);
  const apple = options.apple ?? createAppleVerifier(config.appleAudiences, options.fetchImpl);
  // Strava export (docs/ROADMAP.md 2.3) runs only when its credentials are configured.
  await publishStravaSettings(pool, config.strava);
  const stravaApi = config.strava ? (options.stravaApi ?? createStravaApi(config.strava, options.fetchImpl)) : null;
  const strava = config.strava && stravaApi ? { api: stravaApi, config: config.strava } : null;
  // Garmin sync through Terra (docs/ROADMAP.md 2.4), likewise.
  await publishGarminSettings(pool, config.garmin);
  const terra = config.garmin ? (options.terraApi ?? createTerraApi(config.garmin, options.fetchImpl)) : null;
  const garmin = config.garmin && terra ? { terra, config: config.garmin } : null;
  const api = createApi({ config, pool, secret, mailer, apple, log, legal, strava, garmin });
  return {
    ...api,
    strava: strava ? createStravaWorker({ pool, api: strava.api, config: strava.config, log }) : null,
    garmin: garmin ? createGarminWorker({ pool, terra: garmin.terra, log }) : null,
  };
}
