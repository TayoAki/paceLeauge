import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { DevAuth, prepareAuthSchema } from './gotrue';
import { callRpc, type Claims } from './postgrest';

/**
 * Local development backend: the Supabase Auth and PostgREST endpoints the app calls, served
 * over a local PostgreSQL built from the same shim + migrations as the backend tests. It lets
 * the real app run end to end (web preview or a simulator) without Docker or a cloud project.
 *
 *   npm run db:local            # start the local Postgres (scripts/db/local-db.sh)
 *   npm run dev:backend         # this server on http://127.0.0.1:54400
 *   npm run dev:backend -- --reset --seed demo@paceleague.test
 *
 * Never deploy this: the sign-in code is fixed and printed, and the JWT secret is public.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const PORT = Number(process.env.DEV_BACKEND_PORT ?? 54400);
const DATABASE = process.env.DEV_BACKEND_DB ?? 'paceleague_dev';
const ADMIN_URL = process.env.PG_TEST_URL ?? `postgres://postgres@127.0.0.1:${process.env.PGPORT ?? 54329}/postgres`;
export const DEV_JWT_SECRET = 'paceleague-local-dev-secret-not-for-production';

function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function ensureDatabase(reset: boolean): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = (await admin.query('select 1 from pg_database where datname = $1', [DATABASE])).rowCount === 1;
  await admin.end();
  if (exists && !reset) return;
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/db/apply-migrations.mjs'), '--database', DATABASE], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) throw new Error('applying migrations failed');
  const db = new pg.Client({ connectionString: databaseUrl(DATABASE) });
  await db.connect();
  // Competition ships disabled; the development backend runs with it on.
  await db.query(`select private.set_flag('competition_enabled', true, 'local development backend', 'dev-backend')`);
  await db.end();
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, X-Supabase-Api-Version');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

async function handle(pool: pg.Pool, devAuth: DevAuth, req: IncomingMessage, res: ServerResponse): Promise<void> {
  cors(req, res);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '');
  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (path === '' || path === '/health') return send(res, 200, { ok: true, database: DATABASE });

  // Every Supabase request carries the project's public API key.
  const apikey = (req.headers.apikey as string | undefined) ?? url.searchParams.get('apikey') ?? undefined;
  const apikeyClaims = devAuth.claims(apikey);
  if (!apikeyClaims) return send(res, 401, { message: 'Invalid API key', hint: 'Use the anon key printed by the dev backend.' });

  if (path.startsWith('/auth/v1/')) {
    const headers = { 'X-Supabase-Api-Version': '2024-01-01' };
    const route = `${req.method} ${path.slice('/auth/v1'.length)}`;
    const claims = devAuth.claims(bearer(req));
    let result;
    if (route === 'POST /otp') result = await devAuth.sendOtp(await readJson(req));
    else if (route === 'POST /verify') result = await devAuth.verifyOtp(await readJson(req));
    else if (route === 'POST /token' && url.searchParams.get('grant_type') === 'refresh_token') result = await devAuth.refresh(await readJson(req));
    else if (route === 'POST /token') result = { status: 400, body: { code: 'provider_disabled', msg: 'Only email codes are available on the development backend.' } };
    else if (route === 'GET /user') result = await devAuth.user(claims);
    else if (route === 'POST /logout') result = await devAuth.logout(claims, url.searchParams.get('scope') ?? 'global');
    else if (route === 'GET /settings') result = { status: 200, body: { external: { email: true, apple: false }, disable_signup: false, mailer_autoconfirm: false } };
    else result = { status: 404, body: { code: 'not_found', msg: `${route} is not emulated` } };
    return send(res, result.status, result.body, headers);
  }

  const rpc = /^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/.exec(path);
  if (rpc && req.method === 'POST') {
    const token = bearer(req) ?? apikey;
    const claims = devAuth.claims(token);
    if (!claims || (claims.role !== 'anon' && claims.role !== 'authenticated')) {
      return send(res, 401, { code: 'PGRST301', details: null, hint: null, message: 'JWT expired' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    }
    const forwarded = req.socket.remoteAddress ?? 'unknown';
    const result = await callRpc(pool, rpc[1]!, await readJson(req), claims as Claims, {
      'x-forwarded-for': forwarded,
      'user-agent': String(req.headers['user-agent'] ?? ''),
    });
    return send(res, result.status, result.body);
  }

  return send(res, 404, { code: 'PGRST125', details: null, hint: null, message: `Invalid path specified in request URL: ${path}` });
}

async function main(): Promise<void> {
  await ensureDatabase(flag('--reset'));
  const pool = new pg.Pool({ connectionString: databaseUrl(DATABASE), max: 20 });
  pool.on('error', (error) => console.error('[db]', error.message));
  await prepareAuthSchema(pool);
  const devAuth = new DevAuth(pool, {
    jwtSecret: DEV_JWT_SECRET,
    otpCode: process.env.DEV_BACKEND_OTP ?? '123456',
    accessTtlS: Number(process.env.DEV_BACKEND_ACCESS_TTL_S ?? 3600),
  });

  const seedEmail = option('--seed');
  if (seedEmail) {
    const { seedDemo } = await import('./seed');
    await seedDemo(pool, { viewerEmail: seedEmail.toLowerCase() });
  }

  const server = createServer((req, res) => {
    const started = Date.now();
    handle(pool, devAuth, req, res)
      .catch((error: unknown) => {
        console.error('[server]', error);
        if (!res.headersSent) send(res, 500, { code: 'XX000', message: 'internal error' });
      })
      .finally(() => {
        if (process.env.DEV_BACKEND_QUIET !== '1' && req.method !== 'OPTIONS') {
          console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started} ms)`);
        }
      });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nPaceLeague development backend on http://127.0.0.1:${PORT} (database ${DATABASE})`);
    console.log('Start the app against it with:\n');
    console.log(`  EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:${PORT}`);
    console.log(`  EXPO_PUBLIC_SUPABASE_ANON_KEY=${devAuth.anonKey()}\n`);
    console.log(`Sign-in code for any email: ${process.env.DEV_BACKEND_OTP ?? '123456'}\n`);
  });
  const shutdown = () => {
    server.close();
    void pool.end().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
