import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createAppleVerifier } from '../../server/src/auth/apple';
import { loadConfig, type ServerConfig } from '../../server/src/config';
import { createPool } from '../../server/src/db';
import { silentLogger } from '../../server/src/log';
import { createMemoryMailer, type MemoryMailer } from '../../server/src/mailer';
import { createService } from '../../server/src/service';
import type { GarminWorker, TerraApi } from '../../server/src/garmin';
import type { BillingWorker, RevenueCatApi } from '../../server/src/revenuecat';
import type { StravaApi, StravaWorker } from '../../server/src/strava';
import { TestDb } from '../backend/helpers/db';

/**
 * Runs the real API (server/) on an ephemeral port over a fresh clone of the migrated test
 * database, with an in-memory mailer and a local Apple signing key, and hands out supabase-js
 * clients configured exactly like the app's.
 */
export const PUBLIC_KEY = 'pl_test_public_key_0123456789';
export const BUNDLE_ID = 'com.example.paceleague.test';

export interface TestApi {
  url: string;
  db: TestDb;
  mailer: MemoryMailer;
  config: ServerConfig;
  /** A supabase-js client like the app's; each gets its own client address for rate limits. */
  client(ip?: string): SupabaseClient;
  /** The newest code emailed to `email`. */
  lastCode(email: string): string;
  appleToken(claims: Record<string, unknown>, options?: { kid?: string; key?: KeyObject }): string;
  appleKeyFetches: () => number;
  /** The Strava worker, when the environment configures Strava. */
  strava: StravaWorker | null;
  /** The Garmin worker, when the environment configures Terra. */
  garmin: GarminWorker | null;
  /** Pro trial reminders. */
  billing: BillingWorker;
  close(): Promise<void>;
}

export async function startTestApi(
  env: Record<string, string> = {},
  options: { stravaApi?: StravaApi; terraApi?: TerraApi; revenuecatApi?: RevenueCatApi | null } = {},
): Promise<TestApi> {
  const db = await TestDb.create();
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: db.url,
    PUBLIC_API_KEY: PUBLIC_KEY,
    EMAIL_PROVIDER: 'memory',
    APPLE_AUDIENCES: BUNDLE_ID,
    TRUST_PROXY: 'true',
    RUN_JOBS: 'false',
    ...env,
  });
  const pool = createPool({ ...config, databasePoolMax: 10 });
  const mailer = createMemoryMailer();

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  let fetches = 0;
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url) !== 'https://appleid.apple.com/auth/keys') throw new Error(`unexpected fetch ${String(url)}`);
    fetches += 1;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const { server, strava, garmin, billing } = await createService({
    config,
    pool,
    log: silentLogger,
    mailer,
    apple: createAppleVerifier(config.appleAudiences, fakeFetch),
    stravaApi: options.stravaApi,
    terraApi: options.terraApi,
    revenuecatApi: options.revenuecatApi,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    db,
    mailer,
    config,
    client(ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
      return createClient(url, PUBLIC_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { 'x-forwarded-for': ip } },
      });
    },
    lastCode(email) {
      const message = [...mailer.sent].reverse().find((m) => m.to === email);
      if (!message) throw new Error(`no code sent to ${email}`);
      return message.code;
    },
    appleToken(claims, options = {}) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: options.kid ?? 'test-kid' })).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const body = Buffer.from(
        JSON.stringify({ iss: 'https://appleid.apple.com', aud: BUNDLE_ID, iat: now, exp: now + 600, sub: `apple-${randomUUID()}`, ...claims }),
      ).toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), options.key ?? privateKey).toString('base64url');
      return `${header}.${body}.${signature}`;
    },
    appleKeyFetches: () => fetches,
    strava,
    garmin,
    billing,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await db.close();
    },
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function signIn(api: TestApi, email = `${randomUUID()}@example.test`, ip?: string) {
  const client = api.client(ip);
  const sent = await client.auth.signInWithOtp({ email });
  if (sent.error) throw sent.error;
  const verified = await client.auth.verifyOtp({ email, token: api.lastCode(email), type: 'email' });
  if (verified.error || !verified.data.session) throw verified.error ?? new Error('no session');
  return { client, email, session: verified.data.session };
}
