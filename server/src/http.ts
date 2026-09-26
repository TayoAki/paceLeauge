import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AppleTokenError, type AppleVerifier } from './auth/apple';
import { CodeService } from './auth/codes';
import { hashKey, takeRateLimit } from './auth/rate-limit';
import { SessionService } from './auth/sessions';
import { loadUser, signInWithAppleId, signInWithEmail, userJson } from './auth/users';
import type { ServerConfig } from './config';
import { transaction, type Pool } from './db';
import { verifyJwt, type Claims } from './jwt';
import type { Logger } from './log';
import type { Mailer } from './mailer';
import { callRpc, type Claims as RpcClaims } from './rpc';

/**
 * The PaceLeague API. It speaks the two protocols the app's client library (supabase-js)
 * already uses — Supabase Auth's email-code/session endpoints under /auth/v1 and PostgREST's RPC
 * endpoint under /rest/v1/rpc — so the app needs no custom networking code, while all business
 * rules stay in PostgreSQL.
 */
export interface ApiDeps {
  config: ServerConfig;
  pool: Pool;
  /** HS256 secret for access tokens (and the key for one-time-code HMACs). */
  secret: string;
  mailer: Mailer;
  apple: AppleVerifier;
  log: Logger;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const AUTH_BODY_LIMIT = 16 * 1024;
const RPC_BODY_LIMIT = 1024 * 1024;
const AUTH_HEADERS = { 'X-Supabase-Api-Version': '2024-01-01' };

function authError(status: number, code: string, msg: string): HttpError {
  return new HttpError(status, { code, error_code: code, msg });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (status === 204 || body === undefined || body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, { code: 'PGRST413', message: 'Payload too large' });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, { code: 'PGRST413', message: 'Payload too large' });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, { code: 'PGRST102', message: 'Invalid JSON body' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, { code: 'PGRST102', message: 'Expected a JSON object' });
  return parsed as Record<string, unknown>;
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

function str(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export function createApi(deps: ApiDeps): { server: Server; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> } {
  const { config, pool, log, apple } = deps;
  const codes = new CodeService(pool, config, deps.secret, deps.mailer, log);
  const sessions = new SessionService(pool, config, deps.secret);

  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      // Railway's edge sets X-Real-IP to the client's address.
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && real.trim()) return real.trim();
      // Otherwise a proxy appends the address it saw, so the last hop is the one to trust.
      const forwarded = req.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
      const hops = value?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      if (hops.length > 0) return hops[hops.length - 1]!;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const limit = async (bucket: string, max: number, windowS: number, code = 'over_request_rate_limit') => {
    if (!(await takeRateLimit(pool, bucket, max, windowS))) throw authError(429, code, 'Too many requests. Please wait a moment and try again.');
  };

  const applyCors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowAll = config.corsOrigins === '*';
    if (!allowAll && !(config.corsOrigins as string[]).includes(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    const requested = req.headers['access-control-request-headers'];
    res.setHeader('Access-Control-Allow-Headers', typeof requested === 'string' ? requested : 'authorization, apikey, content-type, x-client-info');
    res.setHeader('Access-Control-Expose-Headers', 'X-Supabase-Api-Version');
    res.setHeader('Access-Control-Max-Age', '600');
  };

  const verifiedUser = (req: IncomingMessage): Claims | null => {
    const token = bearer(req);
    if (!token || safeEqual(token, config.publicApiKey)) return null;
    const claims = verifyJwt(token, deps.secret);
    return claims && claims.role === 'authenticated' && claims.aud === 'authenticated' && typeof claims.sub === 'string' ? claims : null;
  };

  async function auth(req: IncomingMessage, res: ServerResponse, route: string, url: URL): Promise<void> {
    const ip = hashKey(clientIp(req));
    if (route === 'POST /otp') {
      await limit(`code:send:ip:${ip}`, 30, 3600, 'over_email_send_rate_limit');
      const body = await readJson(req, AUTH_BODY_LIMIT);
      const email = str(body.email, 254)?.trim().toLowerCase() ?? '';
      if (!EMAIL.test(email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (body.create_user === false) {
        const exists = await pool.query(`select 1 from auth.identities where provider = 'email' and provider_id = $1`, [email]);
        if (exists.rowCount === 0) throw authError(422, 'otp_disabled', 'Signups not allowed for otp');
      }
      const result = await codes.issue(email);
      if (result.status === 'cooldown') {
        throw authError(429, 'over_email_send_rate_limit', `For security purposes, you can only request this after ${result.retryAfterS} seconds.`);
      }
      if (result.status === 'rate_limited') throw authError(429, 'over_email_send_rate_limit', 'Email rate limit exceeded');
      return send(res, 200, {}, AUTH_HEADERS);
    }
    if (route === 'POST /verify') {
      await limit(`code:verify:ip:${ip}`, 60, 3600);
      const body = await readJson(req, AUTH_BODY_LIMIT);
      const email = str(body.email, 254)?.trim().toLowerCase() ?? '';
      const code = str(body.token, 16) ?? '';
      const type = body.type;
      if (!EMAIL.test(email) || !['email', 'magiclink', 'signup'].includes(String(type)) || !(await codes.verify(email, code))) {
        throw authError(403, 'otp_expired', 'Token has expired or is invalid');
      }
      const session = await transaction(pool, async (client) => sessions.create(client, await signInWithEmail(client, email), 'otp'));
      return send(res, 200, session, AUTH_HEADERS);
    }
    if (route === 'POST /token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token') {
        await limit(`token:ip:${ip}`, 600, 3600);
        const body = await readJson(req, AUTH_BODY_LIMIT);
        const token = str(body.refresh_token, 256);
        if (!token) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        const result = await sessions.refresh(token);
        if (!result.ok) {
          const msg = {
            refresh_token_not_found: 'Invalid Refresh Token: Refresh Token Not Found',
            refresh_token_already_used: 'Invalid Refresh Token: Already Used',
            session_expired: 'Session Expired',
            user_not_found: 'User from sub claim in JWT does not exist',
          }[result.error];
          throw authError(400, result.error, msg);
        }
        return send(res, 200, result.session, AUTH_HEADERS);
      }
      if (grant === 'id_token') {
        await limit(`apple:ip:${ip}`, 60, 3600);
        const body = await readJson(req, AUTH_BODY_LIMIT);
        if (body.provider !== 'apple' || config.appleAudiences.length === 0) {
          throw authError(400, 'provider_disabled', 'Unsupported provider: provider is not enabled');
        }
        let identity;
        try {
          identity = await apple.verify(str(body.id_token, 8192) ?? '', str(body.nonce, 512) ?? undefined);
        } catch (error) {
          if (error instanceof AppleTokenError) {
            log.warn('apple token rejected', { reason: error.message });
            throw authError(400, 'invalid_credentials', 'Sign in with Apple could not be verified');
          }
          throw error;
        }
        const session = await transaction(pool, async (client) =>
          sessions.create(client, await signInWithAppleId(client, identity.sub, identity.email, identity.emailVerified), 'apple'),
        );
        return send(res, 200, session, AUTH_HEADERS);
      }
      throw authError(400, 'unsupported_grant_type', 'Unsupported grant type');
    }
    if (route === 'GET /user') {
      const claims = verifiedUser(req);
      if (!claims) throw authError(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
      const user = await transaction(pool, (client) => loadUser(client, claims.sub as string));
      if (!user) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
      return send(res, 200, userJson(user), AUTH_HEADERS);
    }
    if (route === 'POST /logout') {
      const claims = verifiedUser(req);
      if (!claims) throw authError(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
      const scope = url.searchParams.get('scope');
      await sessions.revoke(claims.sub as string, typeof claims.session_id === 'string' ? claims.session_id : null, scope === 'local' || scope === 'others' ? scope : 'global');
      return send(res, 204, null, AUTH_HEADERS);
    }
    if (route === 'GET /settings') {
      return send(
        res,
        200,
        { external: { email: true, apple: config.appleAudiences.length > 0 }, disable_signup: false, mailer_autoconfirm: false, phone_autoconfirm: false },
        AUTH_HEADERS,
      );
    }
    throw authError(404, 'not_found', 'Not found');
  }

  async function rpc(req: IncomingMessage, res: ServerResponse, fn: string): Promise<void> {
    const token = bearer(req);
    let claims: RpcClaims;
    if (!token || safeEqual(token, config.publicApiKey)) {
      claims = { role: 'anon' };
    } else {
      const verified = verifiedUser(req);
      if (!verified) throw new HttpError(401, { code: 'PGRST301', details: null, hint: null, message: 'JWT expired or invalid' });
      claims = verified as RpcClaims;
    }
    const body = await readJson(req, RPC_BODY_LIMIT);
    const result = await callRpc(pool, fn, body, claims, {
      'x-forwarded-for': clientIp(req),
      'user-agent': String(req.headers['user-agent'] ?? '').slice(0, 200),
    });
    send(res, result.status, result.body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://api.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let route = path;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (config.appEnv === 'staging' || config.appEnv === 'production') res.setHeader('Strict-Transport-Security', 'max-age=63072000');
    applyCors(req, res);
    try {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (path === '/health' || path === '/') {
        route = '/health';
        await pool.query('select 1');
        return send(res, 200, { ok: true });
      }
      const apikey = (req.headers.apikey as string | undefined) ?? url.searchParams.get('apikey') ?? '';
      if (!safeEqual(apikey, config.publicApiKey)) throw new HttpError(401, { message: 'Invalid API key' });

      if (path.startsWith('/auth/v1/')) {
        route = `${req.method} ${path.slice('/auth/v1'.length)}`;
        try {
          return await auth(req, res, route, url);
        } catch (error) {
          if (error instanceof HttpError) return send(res, error.status, error.body, AUTH_HEADERS);
          throw error;
        }
      }
      const rpcMatch = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]{1,63})$/.exec(path);
      if (rpcMatch && req.method === 'POST') {
        route = `rpc:${rpcMatch[1]}`;
        return await rpc(req, res, rpcMatch[1]!);
      }
      throw new HttpError(404, { code: 'PGRST125', details: null, hint: null, message: 'Invalid path specified in request URL' });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, error.body);
      log.error('request failed', { route, error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) send(res, 500, { code: 'XX000', details: null, hint: null, message: 'Internal error' });
    } finally {
      if (route !== '/health') log.info('request', { method: req.method, route, status: res.statusCode, ms: Date.now() - started });
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  // Longer than the proxy's idle timeout, so the proxy never reuses a connection we just closed.
  server.keepAliveTimeout = 65_000;
  return { server, handle };
}
