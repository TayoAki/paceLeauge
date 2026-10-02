import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AppleTokenError, type AppleVerifier } from './auth/apple';
import { CodeService } from './auth/codes';
import { hashPassword, PASSWORD_MAX_LENGTH, passwordProblem, verifyPassword } from './auth/passwords';
import { hashKey, takeRateLimit } from './auth/rate-limit';
import { SessionService } from './auth/sessions';
import {
  createPasswordAccount,
  findByEmail,
  loadUser,
  markPasswordSignIn,
  passwordHashOf,
  setPassword,
  signInWithAppleId,
  signInWithEmail,
  userJson,
} from './auth/users';
import type { GarminConfig, RevenueCatConfig, RoutingConfig, ServerConfig, StravaConfig } from './config';
import { transaction, type Pool } from './db';
import { verifyJwt, type Claims } from './jwt';
import type { LegalDoc } from './legal';
import type { Logger } from './log';
import type { Mailer } from './mailer';
import { callRpc, type Claims as RpcClaims } from './rpc';
import { handleTerraEvent, IngestError, startGarminConnect, verifyTerraSignature, type TerraApi } from './garmin';
import { handleRevenueCatEvent, webhookAuthorized, type RevenueCatApi } from './revenuecat';
import { heatmapLinks, heatmapTile, MAX_ZOOM, MIN_ZOOM, verifyTileToken } from './heatmap';
import { PlanInputError, planRoute, RoutingError, type RoutingApi } from './routing';
import { stravaCallback, stravaWebhookChallenge, stravaWebhookEvent, type StravaApi, type StravaHttpResult } from './strava';

/**
 * The PaceLeague API. It speaks the two protocols the app's client library (supabase-js)
 * already uses — Supabase Auth's email-code, password and session endpoints under /auth/v1 and
 * PostgREST's RPC endpoint under /rest/v1/rpc — so the app needs no custom networking code, while
 * all business rules stay in PostgreSQL. It also serves the Privacy Policy and Terms pages.
 */
export interface ApiDeps {
  config: ServerConfig;
  pool: Pool;
  /** HS256 secret for access tokens (and the key for one-time-code HMACs). */
  secret: string;
  mailer: Mailer;
  apple: AppleVerifier;
  log: Logger;
  /** Rendered /legal pages (server/src/legal.ts). */
  legal?: Partial<Record<LegalDoc, string>>;
  /** Strava export (server/src/strava.ts), when configured. */
  strava?: { api: StravaApi; config: StravaConfig } | null;
  /** Garmin through Terra (server/src/garmin.ts), when configured. */
  garmin?: { terra: TerraApi; config: GarminConfig } | null;
  /** Pro through RevenueCat (server/src/revenuecat.ts), when configured. */
  revenuecat?: { config: RevenueCatConfig; api: RevenueCatApi | null } | null;
  /** Route planning (server/src/routing.ts), when a routing service is configured. */
  routing?: { api: RoutingApi; config: RoutingConfig } | null;
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
/** Terra can send a long activity's GPS samples in one event. */
const TERRA_BODY_LIMIT = 25 * 1024 * 1024;
const AUTH_HEADERS = { 'X-Supabase-Api-Version': '2024-01-01' };
/** Same window as private.has_recent_auth(): changing the password needs a fresh sign-in. */
const RECENT_SIGN_IN_S = 600;
const WEAK_PASSWORD: Record<NonNullable<ReturnType<typeof passwordProblem>>, { msg: string; reasons: string[] }> = {
  too_short: { msg: 'Password should be at least 8 characters.', reasons: ['length'] },
  too_long: { msg: `Password should be at most ${PASSWORD_MAX_LENGTH} characters.`, reasons: ['length'] },
  too_common: { msg: 'Password is too easy to guess.', reasons: ['pwned'] },
};
const LEGAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function authError(status: number, code: string, msg: string): HttpError {
  return new HttpError(status, { code, error_code: code, msg });
}

function weakPassword(password: string, email: string): HttpError | null {
  const problem = passwordProblem(password, email);
  if (!problem) return null;
  const { msg, reasons } = WEAK_PASSWORD[problem];
  return new HttpError(422, { code: 'weak_password', error_code: 'weak_password', msg, weak_password: { reasons } });
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

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, { message: 'Payload too large' });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, { message: 'Payload too large' });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
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

function emailOf(value: unknown): string {
  return str(value, 254)?.trim().toLowerCase() ?? '';
}

/** When the token's session signed in (the JWT `amr` timestamp, which refreshing never moves). */
function signedInAt(claims: Claims): number {
  const amr = Array.isArray(claims.amr) ? (claims.amr as { timestamp?: unknown }[]) : [];
  return Math.max(0, ...amr.map((entry) => (typeof entry?.timestamp === 'number' ? entry.timestamp : 0)));
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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
    if (route === 'POST /signup') {
      if (!config.passwordSignIn) throw authError(422, 'signup_disabled', 'Signups not allowed for this instance');
      await limit(`signup:ip:${ip}`, 20, 3600);
      const body = await readJson(req, AUTH_BODY_LIMIT);
      const email = emailOf(body.email);
      if (!EMAIL.test(email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      const password = typeof body.password === 'string' ? body.password : '';
      const weak = weakPassword(password, email);
      if (weak) throw weak;
      const hash = await hashPassword(password);
      const session = await transaction(pool, async (client) => {
        const userId = await createPasswordAccount(client, email, hash);
        return userId ? sessions.create(client, userId, 'password') : null;
      });
      if (!session) throw authError(422, 'user_already_exists', 'User already registered');
      return send(res, 200, session, AUTH_HEADERS);
    }
    if (route === 'PUT /user') {
      const claims = verifiedUser(req);
      if (!claims) throw authError(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
      const userId = claims.sub as string;
      await limit(`user:update:${hashKey(userId)}`, 10, 3600);
      const body = await readJson(req, AUTH_BODY_LIMIT);
      if (body.email != null || body.phone != null) throw authError(422, 'validation_failed', 'Only the password can be changed');
      if (typeof body.password !== 'string') throw authError(422, 'validation_failed', 'Password is required');
      if (!config.passwordSignIn) throw authError(422, 'provider_disabled', 'Password sign-in is disabled');
      if (Date.now() / 1000 - signedInAt(claims) > RECENT_SIGN_IN_S) {
        throw authError(400, 'reauthentication_needed', 'Password update requires reauthentication');
      }
      const current = await transaction(pool, (client) => passwordHashOf(client, userId));
      if (!current) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
      if (!current.email) throw authError(422, 'validation_failed', 'This account has no email address to sign in with');
      const weak = weakPassword(body.password, current.email);
      if (weak) throw weak;
      if (current.passwordHash && (await verifyPassword(body.password, current.passwordHash))) {
        throw authError(422, 'same_password', 'New password should be different from the old password.');
      }
      const hash = await hashPassword(body.password);
      const user = await transaction(pool, async (client) => {
        await setPassword(client, userId, hash);
        return loadUser(client, userId);
      });
      if (!user) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
      // A new password ends every other session; this device stays signed in.
      await sessions.revoke(userId, typeof claims.session_id === 'string' ? claims.session_id : null, 'others');
      return send(res, 200, userJson(user), AUTH_HEADERS);
    }
    if (route === 'POST /otp') {
      await limit(`code:send:ip:${ip}`, 30, 3600, 'over_email_send_rate_limit');
      const body = await readJson(req, AUTH_BODY_LIMIT);
      const email = emailOf(body.email);
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
      const email = emailOf(body.email);
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
      if (grant === 'password') {
        if (!config.passwordSignIn) throw authError(400, 'provider_disabled', 'Email logins are disabled');
        await limit(`password:ip:${ip}`, 60, 3600);
        const body = await readJson(req, AUTH_BODY_LIMIT);
        const email = emailOf(body.email);
        const password = typeof body.password === 'string' ? body.password : '';
        if (!EMAIL.test(email)) throw authError(400, 'invalid_credentials', 'Invalid login credentials');
        await limit(`password:email:${hashKey(email)}`, 10, 900);
        const account = await findByEmail(pool, email);
        // Unknown accounts and over-long input still pay for one hash, so timing reveals nothing.
        const usable = account?.passwordHash && [...password].length <= PASSWORD_MAX_LENGTH ? account.passwordHash : null;
        const matches = await verifyPassword(password, usable);
        if (!account || !matches) throw authError(400, 'invalid_credentials', 'Invalid login credentials');
        const session = await transaction(pool, async (client) => {
          // The password must still be the one just checked (an email proof may have cleared it).
          const { rows } = await client.query<{ encrypted_password: string | null }>('select encrypted_password from auth.users where id = $1 for update', [
            account.id,
          ]);
          if (rows[0]?.encrypted_password !== usable) return null;
          await markPasswordSignIn(client, account.id, email);
          return sessions.create(client, account.id, 'password');
        });
        if (!session) throw authError(400, 'invalid_credentials', 'Invalid login credentials');
        return send(res, 200, session, AUTH_HEADERS);
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
        {
          external: { email: true, apple: config.appleAudiences.length > 0 },
          disable_signup: false,
          // Password sign-ups start a session at once; no confirmation email is sent.
          mailer_autoconfirm: config.passwordSignIn,
          phone_autoconfirm: false,
        },
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
    // RPCs the service answers itself, because they need a partner's credentials.
    if (fn === 'start_garmin_connect') {
      const fail = (message: string, status = 400) => send(res, status, { code: 'P0001', details: null, hint: null, message });
      if (claims.role !== 'authenticated') return fail('not_authenticated', 401);
      if (!deps.garmin) return fail('not_available');
      try {
        return send(res, 200, await startGarminConnect({ pool, terra: deps.garmin.terra, config: deps.garmin.config }, claims.sub as string, body.p_return_to));
      } catch (error) {
        if (error instanceof IngestError) return fail(error.code);
        log.warn('garmin connect start failed', { error: error instanceof Error ? error.message : String(error) });
        return fail('server_error', 502);
      }
    }
    if (fn === 'get_heatmap_tiles') {
      // Signed links to the heatmap's tiles (docs/ROADMAP.md 5.4), for map views that can't send headers.
      const fail = (message: string, status = 400) => send(res, status, { code: 'P0001', details: null, hint: null, message });
      if (claims.role !== 'authenticated') return fail('not_authenticated', 401);
      try {
        return send(res, 200, await heatmapLinks(pool, deps.secret, claims.sub as string));
      } catch (error) {
        const message = (error as { message?: string }).message ?? '';
        if (/^[a-z_]{3,40}$/.test(message)) return fail(message);
        throw error;
      }
    }
    if (fn === 'plan_route') {
      const fail = (message: string, status = 400) => send(res, status, { code: 'P0001', details: null, hint: null, message });
      if (claims.role !== 'authenticated') return fail('not_authenticated', 401);
      if (!deps.routing) return fail('not_available');
      try {
        return send(res, 200, await planRoute({ pool, api: deps.routing.api, config: deps.routing.config, log }, claims.sub as string, body));
      } catch (error) {
        if (error instanceof PlanInputError) return fail(error.code);
        if (error instanceof RoutingError) {
          if (error.code === 'routing_failed') log.warn('routing failed', { error: error.message });
          return fail(error.code, error.code === 'routing_failed' ? 502 : 400);
        }
        throw error;
      }
    }
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
      const legalDoc = path === '/support' ? 'support' : (/^\/legal\/(privacy|terms)$/.exec(path)?.[1] as LegalDoc | undefined);
      if (legalDoc && (req.method === 'GET' || req.method === 'HEAD')) {
        const html = deps.legal?.[legalDoc];
        if (!html) throw new HttpError(404, { message: 'Not found' });
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Security-Policy', LEGAL_CSP);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      // Strava calls these itself (the runner's browser after connecting, and Strava's webhook), so
      // they carry no API key; each checks what it receives instead.
      const stravaMatch = /^\/integrations\/strava\/(callback|webhook)$/.exec(path);
      if (stravaMatch) {
        route = `${req.method} /integrations/strava/${stravaMatch[1]}`;
        if (!deps.strava) throw new HttpError(404, { message: 'Not found' });
        await limit(`strava:${stravaMatch[1]}:ip:${hashKey(clientIp(req))}`, 120, 3600);
        let result: StravaHttpResult;
        if (stravaMatch[1] === 'callback' && req.method === 'GET') {
          result = await stravaCallback({ pool, api: deps.strava.api, config: deps.strava.config, log }, url);
        } else if (stravaMatch[1] === 'webhook' && req.method === 'GET') {
          result = stravaWebhookChallenge(deps.strava.config, url);
        } else if (stravaMatch[1] === 'webhook' && req.method === 'POST') {
          result = await stravaWebhookEvent(pool, await readJson(req, AUTH_BODY_LIMIT));
        } else {
          throw new HttpError(405, { message: 'Method not allowed' });
        }
        for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
        res.writeHead(result.status);
        res.end(result.body);
        return;
      }
      if (path === '/integrations/garmin/webhook') {
        route = `${req.method} /integrations/garmin/webhook`;
        if (!deps.garmin) throw new HttpError(404, { message: 'Not found' });
        if (req.method !== 'POST') throw new HttpError(405, { message: 'Method not allowed' });
        const raw = await readRaw(req, TERRA_BODY_LIMIT);
        const signature = req.headers['terra-signature'];
        if (!verifyTerraSignature(deps.garmin.config.webhookSecret, typeof signature === 'string' ? signature : undefined, raw)) {
          throw new HttpError(401, { message: 'Invalid signature' });
        }
        let event: unknown;
        try {
          event = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, { message: 'Invalid JSON body' });
        }
        if (event && typeof event === 'object' && !Array.isArray(event)) await handleTerraEvent(pool, log, event as Record<string, unknown>);
        return send(res, 200, { ok: true });
      }
      // RevenueCat reports Pro purchases, renewals, refunds and expiries (docs/ROADMAP.md 3.6),
      // with the shared Authorization value set in its dashboard.
      if (path === '/integrations/revenuecat/webhook') {
        route = `${req.method} /integrations/revenuecat/webhook`;
        if (!deps.revenuecat) throw new HttpError(404, { message: 'Not found' });
        if (req.method !== 'POST') throw new HttpError(405, { message: 'Method not allowed' });
        await limit(`revenuecat:ip:${hashKey(clientIp(req))}`, 3_600, 3600);
        const authorization = req.headers.authorization;
        if (!webhookAuthorized(deps.revenuecat.config, typeof authorization === 'string' ? authorization : undefined)) {
          throw new HttpError(401, { message: 'Unauthorized' });
        }
        await handleRevenueCatEvent({ pool, log, config: deps.revenuecat.config, api: deps.revenuecat.api }, await readJson(req, AUTH_BODY_LIMIT * 4));
        return send(res, 200, { ok: true });
      }
      // Heatmap tiles (docs/ROADMAP.md 5.4): map views load them without headers, so the link's
      // signature stands in for the API key and the session.
      const tileMatch = /^\/heatmap\/(\d{1,12})\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(path);
      if (tileMatch) {
        route = `${req.method} /heatmap/tile`;
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, { message: 'Method not allowed' });
        const [build, z, x, y] = tileMatch.slice(1).map(Number) as [number, number, number, number];
        if (z < MIN_ZOOM || z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, { message: 'Not found' });
        if (!verifyTileToken(deps.secret, build, url.searchParams.get('t'), Math.floor(Date.now() / 1000))) {
          throw new HttpError(403, { message: 'This map link has expired' });
        }
        await limit(`heatmap:tile:ip:${hashKey(clientIp(req))}`, 6_000, 3600);
        const png = await heatmapTile(pool, build, z, x, y);
        if (!png) throw new HttpError(404, { message: 'This map has been updated' });
        // The build is in the address, so a tile never changes; the link itself expires.
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
        res.end(req.method === 'HEAD' ? undefined : png);
        return;
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
