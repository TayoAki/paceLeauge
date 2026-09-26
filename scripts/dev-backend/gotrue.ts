import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

import { signJwt, verifyJwt } from './jwt';

/**
 * The slice of Supabase Auth (GoTrue) the app uses on web: email one-time codes, refresh-token
 * rotation, the current user and sign-out. Every email receives the same development code,
 * printed on startup. The `amr` claim keeps the original sign-in time across refreshes, so the
 * server's "recent sign-in" checks (export, account deletion) behave as they do on Supabase.
 * Development only.
 */

export interface AuthConfig {
  jwtSecret: string;
  otpCode: string;
  accessTtlS: number;
}

export interface AuthResponse {
  status: number;
  body: unknown;
}

const REFRESH_REUSE_WINDOW_MS = 10_000;

export async function prepareAuthSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    create schema if not exists dev_backend;
    revoke all on schema dev_backend from public;
    create table if not exists dev_backend.sessions (
      id uuid primary key,
      user_id uuid not null,
      signed_in_at bigint not null,
      revoked_at timestamptz
    );
    create table if not exists dev_backend.refresh_tokens (
      token text primary key,
      session_id uuid not null references dev_backend.sessions (id) on delete cascade,
      revoked_at timestamptz
    );
  `);
}

function authError(status: number, code: string, msg: string): AuthResponse {
  return { status, body: { code, error_code: code, msg } };
}

interface UserRow {
  id: string;
  email: string;
  created_at: Date;
}

function userJson(user: UserRow, signedInAt: number) {
  const created = user.created_at.toISOString();
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: created,
    phone: '',
    confirmed_at: created,
    last_sign_in_at: new Date(signedInAt * 1000).toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: created,
    updated_at: created,
    is_anonymous: false,
  };
}

export class DevAuth {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AuthConfig,
  ) {}

  anonKey(): string {
    return signJwt({ iss: 'paceleague-dev', role: 'anon', iat: 1_700_000_000, exp: 4_102_444_800 }, this.config.jwtSecret);
  }

  /** Claims of a valid bearer token, or null. */
  claims(token: string | undefined): Record<string, unknown> | null {
    if (!token) return null;
    return verifyJwt(token, this.config.jwtSecret);
  }

  private async session(userId: string, sessionId: string, signedInAt: number): Promise<AuthResponse> {
    const { rows } = await this.pool.query<UserRow>('select id, email, created_at from auth.users where id = $1', [userId]);
    const user = rows[0];
    if (!user) return authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    const refreshToken = randomBytes(18).toString('base64url');
    await this.pool.query('insert into dev_backend.refresh_tokens (token, session_id) values ($1, $2)', [refreshToken, sessionId]);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.config.accessTtlS;
    const accessToken = signJwt(
      {
        iss: 'paceleague-dev/auth/v1',
        aud: 'authenticated',
        sub: user.id,
        email: user.email,
        phone: '',
        role: 'authenticated',
        aal: 'aal1',
        amr: [{ method: 'otp', timestamp: signedInAt }],
        session_id: sessionId,
        is_anonymous: false,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        iat: now,
        exp: expiresAt,
      },
      this.config.jwtSecret,
    );
    return {
      status: 200,
      body: {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: this.config.accessTtlS,
        expires_at: expiresAt,
        refresh_token: refreshToken,
        user: userJson(user, signedInAt),
      },
    };
  }

  /** POST /auth/v1/otp — "send" the code (it is printed on startup). */
  async sendOtp(body: { email?: unknown; create_user?: unknown }): Promise<AuthResponse> {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
    const exists = await this.pool.query('select 1 from auth.users where email = $1', [email]);
    if (exists.rowCount === 0 && body.create_user === false) return authError(422, 'otp_disabled', 'Signups not allowed for otp');
    console.log(`[auth] sign-in code for ${email}: ${this.config.otpCode}`);
    return { status: 200, body: {} };
  }

  /** POST /auth/v1/verify — exchange email + code for a session (creating the user). */
  async verifyOtp(body: { email?: unknown; token?: unknown; type?: unknown }): Promise<AuthResponse> {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || body.token !== this.config.otpCode || (body.type !== 'email' && body.type !== 'magiclink')) {
      return authError(403, 'otp_expired', 'Token has expired or is invalid');
    }
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into auth.users (email, raw_app_meta_data) values ($1, '{"provider":"email","providers":["email"]}')
       on conflict (email) do update set email = excluded.email returning id`,
      [email],
    );
    const userId = rows[0]!.id;
    const sessionId = randomUUID();
    const signedInAt = Math.floor(Date.now() / 1000);
    await this.pool.query('insert into dev_backend.sessions (id, user_id, signed_in_at) values ($1, $2, $3)', [sessionId, userId, signedInAt]);
    return this.session(userId, sessionId, signedInAt);
  }

  /** POST /auth/v1/token?grant_type=refresh_token — rotate the refresh token. */
  async refresh(body: { refresh_token?: unknown }): Promise<AuthResponse> {
    const token = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    const { rows } = await this.pool.query<{ session_id: string; revoked_at: Date | null; user_id: string; signed_in_at: string; session_revoked: Date | null }>(
      `select t.session_id, t.revoked_at, s.user_id, s.signed_in_at, s.revoked_at as session_revoked
         from dev_backend.refresh_tokens t join dev_backend.sessions s on s.id = t.session_id
        where t.token = $1`,
      [token],
    );
    const row = rows[0];
    if (!row || row.session_revoked) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    if (row.revoked_at && Date.now() - row.revoked_at.getTime() > REFRESH_REUSE_WINDOW_MS) {
      // Reuse of a rotated token outside the grace window: revoke the whole session (GoTrue behaviour).
      await this.pool.query('update dev_backend.sessions set revoked_at = now() where id = $1', [row.session_id]);
      return authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
    }
    await this.pool.query('update dev_backend.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where token = $1', [token]);
    return this.session(row.user_id, row.session_id, Number(row.signed_in_at));
  }

  /** GET /auth/v1/user */
  async user(claims: Record<string, unknown> | null): Promise<AuthResponse> {
    if (!claims || claims.role !== 'authenticated') return authError(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
    const { rows } = await this.pool.query<UserRow>('select id, email, created_at from auth.users where id = $1', [claims.sub]);
    const user = rows[0];
    if (!user) return authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
    const amr = (claims.amr as { timestamp?: number }[] | undefined)?.[0]?.timestamp ?? Math.floor(Date.now() / 1000);
    return { status: 200, body: userJson(user, amr) };
  }

  /** POST /auth/v1/logout?scope=local|global|others */
  async logout(claims: Record<string, unknown> | null, scope: string): Promise<AuthResponse> {
    if (!claims || claims.role !== 'authenticated') return { status: 204, body: null };
    if (scope === 'global') {
      await this.pool.query('update dev_backend.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [claims.sub]);
    } else if (scope === 'others') {
      await this.pool.query('update dev_backend.sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [
        claims.sub,
        claims.session_id,
      ]);
    } else {
      await this.pool.query('update dev_backend.sessions set revoked_at = now() where id = $1', [claims.session_id]);
    }
    return { status: 204, body: null };
  }
}
