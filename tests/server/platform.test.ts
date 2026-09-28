import pg from 'pg';

import { ConfigError, loadConfig } from '../../server/src/config';
import { createPool } from '../../server/src/db';
import { runFrequentJobs, runHourlyJobs } from '../../server/src/jobs';
import { silentLogger } from '../../server/src/log';
import { createMailer, maskEmail } from '../../server/src/mailer';
import { findDbDir, migrate, MigrationError, migrationFiles, runBootstrap } from '../../server/src/migrate';
import { resolveSigningSecret } from '../../server/src/service';
import { TestDb } from '../backend/helpers/db';

const base = { DATABASE_URL: 'postgres://localhost/x', PUBLIC_API_KEY: 'pl_public_key_0123456789' };

describe('configuration', () => {
  it('refuses unsafe production settings at boot', () => {
    const production = { ...base, APP_ENV: 'production' };
    expect(() => loadConfig(production)).toThrow(/EMAIL_PROVIDER/);
    expect(() => loadConfig({ ...production, EMAIL_PROVIDER: 'log' })).toThrow(/Production must deliver sign-in codes by email/);
    const ok = { ...production, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_test', EMAIL_FROM: 'PaceLeague <codes@example.com>' };
    expect(loadConfig(ok).appEnv).toBe('production');
    expect(() => loadConfig({ ...ok, DEV_FIXED_CODE: '123456' })).toThrow(/only allowed in development/);
    expect(() => loadConfig({ ...ok, BOOTSTRAP_ENABLE_COMPETITION: 'true' })).toThrow(/not allowed in production/);
    expect(() => loadConfig({ ...ok, JWT_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...ok, PUBLIC_API_KEY: '' })).toThrow(/PUBLIC_API_KEY/);
    expect(() => loadConfig({ ...ok, REVIEW_ACCOUNT_EMAIL: 'review@example.com' })).toThrow(/both/);
  });

  it('uses safe defaults locally and trusts the proxy on Railway', () => {
    const local = loadConfig({ DATABASE_URL: 'postgres://localhost/x' });
    expect(local).toMatchObject({ appEnv: 'development', email: { provider: 'log' }, trustProxy: false, corsOrigins: [] });
    expect(loadConfig({ ...base, APP_ENV: 'staging', EMAIL_PROVIDER: 'log', RAILWAY_ENVIRONMENT_NAME: 'staging' }).trustProxy).toBe(true);
  });
});

describe('migrator', () => {
  let adminUrl: URL;
  let dbName: string;
  let client: pg.Client;

  beforeAll(async () => {
    adminUrl = new URL(process.env.PG_TEST_URL ?? `postgres://postgres@127.0.0.1:${process.env.PGPORT ?? 54329}/postgres`);
    dbName = `pl_migrate_${Date.now().toString(36)}`;
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    const url = new URL(adminUrl.toString());
    url.pathname = `/${dbName}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  });

  it('applies the platform layer then every migration once, and refuses edited history', async () => {
    const files = migrationFiles(findDbDir());
    expect(files[0]!.name).toBe('platform/0001_platform.sql');
    expect(files.every((f) => !f.name.startsWith('test-support/'))).toBe(true);
    const c = client as unknown as pg.PoolClient;
    const first = await migrate(c, files, silentLogger);
    expect(first).toHaveLength(files.length);
    expect(await migrate(c, files, silentLogger)).toEqual([]);

    const edited = files.map((f, i) => (i === 1 ? { ...f, checksum: 'edited' } : f));
    await expect(migrate(c, edited, silentLogger)).rejects.toThrow(MigrationError);

    const { rows } = await client.query(`select enabled from private.app_flags where key = 'competition_enabled'`);
    expect(rows[0].enabled).toBe(false);
    await runBootstrap(c, { appEnv: 'staging', bootstrapEnableCompetition: true }, silentLogger);
    await client.query(`select private.set_flag('competition_enabled', false, 'operator paused scoring', 'ops')`);
    // Bootstrap runs once: a later boot never overrides an operator's decision.
    await runBootstrap(c, { appEnv: 'staging', bootstrapEnableCompetition: true }, silentLogger);
    const after = await client.query(`select enabled from private.app_flags where key = 'competition_enabled'`);
    expect(after.rows[0].enabled).toBe(false);
  });
});

describe('scheduled jobs and secrets', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await TestDb.create();
  });

  afterAll(async () => {
    await db.close();
  });

  it('generates one signing secret and keeps it', async () => {
    const pool = createPool({ databaseUrl: db.url, databaseSsl: 'disable', databasePoolMax: 2 });
    try {
      const first = await resolveSigningSecret(pool, { jwtSecret: null });
      expect(first.length).toBeGreaterThanOrEqual(64);
      expect(await resolveSigningSecret(pool, { jwtSecret: null })).toBe(first);
      expect(await resolveSigningSecret(pool, { jwtSecret: 'x'.repeat(40) })).toBe('x'.repeat(40));
    } finally {
      await pool.end();
    }
  });

  it('runs account deletions from the job loop, one instance at a time', async () => {
    const runner = await db.createRunner('Leaver');
    await db.rpc(runner, 'request_account_deletion', {}, { recentAuth: true });
    const pool = createPool({ databaseUrl: db.url, databaseSsl: 'disable', databasePoolMax: 3 });
    try {
      // Another instance holds the job lock: this one skips.
      const holder = await pool.connect();
      await holder.query('select pg_advisory_lock(7340101)');
      await runFrequentJobs(pool, silentLogger);
      expect((await db.sql('select 1 from auth.users where id = $1', [runner.id])).length).toBe(1);
      await holder.query('select pg_advisory_unlock(7340101)');
      holder.release();

      await runFrequentJobs(pool, silentLogger);
      expect((await db.sql('select 1 from auth.users where id = $1', [runner.id])).length).toBe(0);

      // The hourly job keeps diagnostics reports for 30 days.
      const sender = await db.createRunner('Reporter');
      await db.rpc(sender, 'submit_diagnostics', { p_report: { app_version: 'test' } });
      await db.rpc(sender, 'submit_diagnostics', { p_report: { app_version: 'old' } });
      await db.sql(`update private.diagnostic_reports set created_at = now() - interval '31 days' where report ->> 'app_version' = 'old'`);
      await expect(runHourlyJobs(pool, silentLogger)).resolves.toBeUndefined();
      expect(await db.sql(`select report ->> 'app_version' as v from private.diagnostic_reports where user_id = $1`, [sender.id])).toEqual([{ v: 'test' }]);
    } finally {
      await pool.end();
    }
  });
});

describe('email delivery', () => {
  const message = { to: 'alex@example.com', code: '482913', ttlMinutes: 10 };

  function recorder() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('sends through Resend and Postmark HTTPS APIs', async () => {
    const resend = recorder();
    await createMailer({ email: { provider: 'resend', apiKey: 're_key', from: 'PaceLeague <c@x.com>', replyTo: null } }, silentLogger, '<p>{{ .Token }}</p>', resend.fetchImpl).sendCode(message);
    expect(resend.calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((resend.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_key');
    const body = JSON.parse(String(resend.calls[0]!.init.body));
    expect(body).toMatchObject({ to: ['alex@example.com'], subject: 'Your PaceLeague sign-in code', html: '<p>482913</p>' });
    expect(body.text).toContain('482913');

    const postmark = recorder();
    await createMailer({ email: { provider: 'postmark', apiKey: 'pm_key', from: 'c@x.com', replyTo: null } }, silentLogger, null, postmark.fetchImpl).sendCode(message);
    expect(postmark.calls[0]!.url).toBe('https://api.postmarkapp.com/email');
    expect(JSON.parse(String(postmark.calls[0]!.init.body))).toMatchObject({ To: 'alex@example.com', MessageStream: 'outbound' });
  });

  it('never echoes a provider’s error body, and masks addresses in logs', async () => {
    const failing = (async () => new Response('{"message":"invalid key re_secret for alex@example.com"}', { status: 401 })) as typeof fetch;
    const mailer = createMailer({ email: { provider: 'resend', apiKey: 're_secret', from: 'c@x.com', replyTo: null } }, silentLogger, null, failing);
    await expect(mailer.sendCode(message)).rejects.toThrow('Resend rejected the message (HTTP 401)');
    expect(maskEmail('alex@example.com')).toBe('a***@example.com');
  });
});
