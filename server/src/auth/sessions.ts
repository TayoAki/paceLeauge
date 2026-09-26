import { createHash, randomBytes } from 'node:crypto';

import type { ServerConfig } from '../config';
import { transaction, type Pool, type PoolClient } from '../db';
import { signJwt } from '../jwt';
import { loadUser, userJson, type UserRecord } from './users';

/**
 * Sessions: a short-lived HS256 access token plus an opaque refresh token. Refreshing rotates
 * the refresh token; presenting an already-rotated token after a short grace window (two
 * requests racing on one device) is treated as theft and ends the whole session. The `amr`
 * timestamp is the original sign-in time and never moves on refresh, so "recent sign-in"
 * checks on the server (export, account deletion) keep meaning what they say.
 */
export type SignInMethod = 'otp' | 'apple' | 'password';

const AMR_METHOD: Record<SignInMethod, string> = { otp: 'otp', apple: 'oauth', password: 'password' };

export type SessionError = 'refresh_token_not_found' | 'refresh_token_already_used' | 'session_expired' | 'user_not_found';

export interface SessionPayload {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: ReturnType<typeof userJson>;
}

const REUSE_GRACE_S = 10;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionService {
  constructor(
    private readonly pool: Pool,
    private readonly config: Pick<ServerConfig, 'accessTokenTtlS' | 'refreshTokenTtlS'>,
    private readonly secret: string,
  ) {}

  private accessToken(user: UserRecord, sessionId: string, method: SignInMethod, signedInAt: Date) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.config.accessTokenTtlS;
    const providers = [...new Set(user.identities.map((i) => i.provider))];
    const token = signJwt(
      {
        iss: 'paceleague',
        aud: 'authenticated',
        sub: user.id,
        email: user.email ?? '',
        phone: '',
        role: 'authenticated',
        aal: 'aal1',
        amr: [{ method: AMR_METHOD[method], timestamp: Math.floor(signedInAt.getTime() / 1000) }],
        session_id: sessionId,
        is_anonymous: false,
        app_metadata: { provider: providers[0] ?? 'email', providers },
        user_metadata: {},
        iat: now,
        exp: expiresAt,
      },
      this.secret,
    );
    return { token, expiresAt };
  }

  private async issueRefreshToken(client: PoolClient, sessionId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await client.query('insert into auth.refresh_tokens (token_hash, session_id) values ($1, $2)', [hashToken(token), sessionId]);
    return token;
  }

  private async response(client: PoolClient, userId: string, sessionId: string, method: SignInMethod, signedInAt: Date): Promise<SessionPayload | null> {
    const user = await loadUser(client, userId);
    if (!user) return null;
    const refreshToken = await this.issueRefreshToken(client, sessionId);
    const access = this.accessToken(user, sessionId, method, signedInAt);
    return {
      access_token: access.token,
      token_type: 'bearer' as const,
      expires_in: this.config.accessTokenTtlS,
      expires_at: access.expiresAt,
      refresh_token: refreshToken,
      user: userJson(user),
    };
  }

  /** A new session for a user who just proved who they are (inside the sign-in transaction). */
  async create(client: PoolClient, userId: string, method: SignInMethod): Promise<SessionPayload> {
    const { rows } = await client.query<{ id: string; signed_in_at: Date }>(
      'insert into auth.sessions (user_id, method) values ($1, $2) returning id, signed_in_at',
      [userId, method],
    );
    const session = rows[0]!;
    const result = await this.response(client, userId, session.id, method, session.signed_in_at);
    if (!result) throw new Error('user vanished during sign-in');
    return result;
  }

  async refresh(token: string): Promise<{ ok: true; session: SessionPayload } | { ok: false; error: SessionError }> {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<{
        session_id: string;
        user_id: string;
        method: SignInMethod;
        signed_in_at: Date;
        token_age_s: number;
        rotated_s: number | null;
        session_revoked: boolean;
      }>(
        `select t.session_id, s.user_id, s.method, s.signed_in_at,
                extract(epoch from now() - t.created_at)::float8 as token_age_s,
                extract(epoch from now() - t.revoked_at)::float8 as rotated_s,
                s.revoked_at is not null as session_revoked
           from auth.refresh_tokens t join auth.sessions s on s.id = t.session_id
          where t.token_hash = $1
          for update of s`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row || row.session_revoked) return { ok: false as const, error: 'refresh_token_not_found' as const };
      if (row.token_age_s > this.config.refreshTokenTtlS) return { ok: false as const, error: 'session_expired' as const };
      if (row.rotated_s !== null && row.rotated_s > REUSE_GRACE_S) {
        await client.query('update auth.sessions set revoked_at = now() where id = $1', [row.session_id]);
        await client.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where session_id = $1', [row.session_id]);
        return { ok: false as const, error: 'refresh_token_already_used' as const };
      }
      await client.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where token_hash = $1', [hashToken(token)]);
      await client.query('update auth.sessions set refreshed_at = now() where id = $1', [row.session_id]);
      const session = await this.response(client, row.user_id, row.session_id, row.method, row.signed_in_at);
      if (!session) return { ok: false as const, error: 'user_not_found' as const };
      return { ok: true as const, session };
    });
  }

  /** Ends this session, every session of the user, or every other session. */
  async revoke(userId: string, sessionId: string | null, scope: 'local' | 'global' | 'others'): Promise<void> {
    await transaction(this.pool, async (client) => {
      const where =
        scope === 'global' ? 'user_id = $1' : scope === 'others' ? 'user_id = $1 and id is distinct from $2' : 'user_id = $1 and id = $2';
      const params = scope === 'global' ? [userId] : [userId, sessionId];
      const ended = await client.query<{ id: string }>(`update auth.sessions set revoked_at = now() where ${where} and revoked_at is null returning id`, params);
      const ids = ended.rows.map((r) => r.id);
      if (ids.length > 0) await client.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where session_id = any($1::uuid[])', [ids]);
    });
  }
}
