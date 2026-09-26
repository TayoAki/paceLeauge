import type { Pool, PoolClient } from '../db';

/**
 * Accounts and their sign-in identities. An email code signs in the account that owns that
 * address; Sign in with Apple signs in the account linked to Apple's stable user identifier, and
 * links to an existing account only through an Apple-verified email address; a password signs in
 * the account registered with that address.
 *
 * Registering with a password doesn't prove the address, so such an account is unverified. When
 * someone later proves they own the address (an emailed code, or Apple's verified email), the
 * account is theirs: the unproven password is cleared and its sessions end.
 */
export type Provider = 'email' | 'apple';

export interface UserRecord {
  id: string;
  email: string | null;
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
  last_sign_in_at: Date | null;
  identities: { id: string; provider: Provider; provider_id: string; email: string | null; created_at: Date; last_sign_in_at: Date | null }[];
}

export async function loadUser(client: PoolClient, userId: string): Promise<UserRecord | null> {
  const { rows } = await client.query<Omit<UserRecord, 'identities'>>(
    'select id, email, email_verified, created_at, updated_at, last_sign_in_at from auth.users where id = $1',
    [userId],
  );
  const user = rows[0];
  if (!user) return null;
  const identities = await client.query<UserRecord['identities'][number]>(
    'select id, provider, provider_id, email, created_at, last_sign_in_at from auth.identities where user_id = $1 order by created_at',
    [userId],
  );
  return { ...user, identities: identities.rows };
}

async function link(client: PoolClient, userId: string, provider: Provider, providerId: string, email: string | null): Promise<void> {
  await client.query(
    `insert into auth.identities (user_id, provider, provider_id, email, last_sign_in_at) values ($1, $2, $3, $4, now())
     on conflict (provider, provider_id) do update set last_sign_in_at = now()`,
    [userId, provider, providerId, email],
  );
}

async function markSignedIn(client: PoolClient, userId: string, provider: Provider, providerId: string): Promise<void> {
  await client.query('update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1', [userId]);
  await client.query('update auth.identities set last_sign_in_at = now() where provider = $1 and provider_id = $2', [provider, providerId]);
}

/** The address was just proven: an unverified account becomes verified, dropping its unproven password and sessions. */
async function claimEmail(client: PoolClient, userId: string): Promise<void> {
  const claimed = await client.query(
    'update auth.users set email_verified = true, encrypted_password = null, updated_at = now() where id = $1 and not email_verified',
    [userId],
  );
  if (claimed.rowCount === 0) return;
  const ended = await client.query<{ id: string }>('update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id', [userId]);
  if (ended.rowCount) {
    await client.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where session_id = any($1::uuid[])', [ended.rows.map((r) => r.id)]);
  }
}

/** The account owning `email` (created on first sign-in). Only call after the address was proven. */
export async function signInWithEmail(client: PoolClient, email: string): Promise<string> {
  const identity = await client.query<{ user_id: string }>(`select user_id from auth.identities where provider = 'email' and provider_id = $1`, [email]);
  let userId = identity.rows[0]?.user_id;
  if (!userId) {
    const created = await client.query<{ id: string }>(
      `insert into auth.users (email, email_verified) values ($1, true) on conflict (email) do update set updated_at = now() returning id`,
      [email],
    );
    userId = created.rows[0]!.id;
    await link(client, userId, 'email', email, email);
  }
  await claimEmail(client, userId);
  await markSignedIn(client, userId, 'email', email);
  return userId;
}

/** A new account with a password, or null when the address already has an account. */
export async function createPasswordAccount(client: PoolClient, email: string, passwordHash: string): Promise<string | null> {
  const created = await client.query<{ id: string }>(
    'insert into auth.users (email, encrypted_password) values ($1, $2) on conflict (email) do nothing returning id',
    [email, passwordHash],
  );
  const userId = created.rows[0]?.id;
  if (!userId) return null;
  await link(client, userId, 'email', email, email);
  await markSignedIn(client, userId, 'email', email);
  return userId;
}

/** The account registered with `email` and its password hash (null when it has none). */
export async function findByEmail(pool: Pool, email: string): Promise<{ id: string; passwordHash: string | null } | null> {
  const { rows } = await pool.query<{ id: string; encrypted_password: string | null }>('select id, encrypted_password from auth.users where email = $1', [email]);
  return rows[0] ? { id: rows[0].id, passwordHash: rows[0].encrypted_password } : null;
}

export async function passwordHashOf(client: PoolClient, userId: string): Promise<{ email: string | null; passwordHash: string | null } | null> {
  const { rows } = await client.query<{ email: string | null; encrypted_password: string | null }>('select email, encrypted_password from auth.users where id = $1', [
    userId,
  ]);
  return rows[0] ? { email: rows[0].email, passwordHash: rows[0].encrypted_password } : null;
}

/** Sets a password; the account's email becomes a sign-in identity if it wasn't one yet. */
export async function setPassword(client: PoolClient, userId: string, passwordHash: string): Promise<void> {
  const { rows } = await client.query<{ email: string | null }>(
    'update auth.users set encrypted_password = $2, updated_at = now() where id = $1 returning email',
    [userId, passwordHash],
  );
  const email = rows[0]?.email;
  if (email) {
    await client.query(
      `insert into auth.identities (user_id, provider, provider_id, email) values ($1, 'email', $2, $2) on conflict (provider, provider_id) do nothing`,
      [userId, email],
    );
  }
}

export async function markPasswordSignIn(client: PoolClient, userId: string, email: string): Promise<void> {
  await markSignedIn(client, userId, 'email', email);
}

/** The account linked to this Apple ID; links an existing account only via a verified email. */
export async function signInWithAppleId(client: PoolClient, sub: string, email: string | null, emailVerified: boolean): Promise<string> {
  const identity = await client.query<{ user_id: string }>(`select user_id from auth.identities where provider = 'apple' and provider_id = $1`, [sub]);
  let userId = identity.rows[0]?.user_id;
  if (!userId && email && emailVerified) {
    const existing = await client.query<{ id: string }>('select id from auth.users where email = $1', [email]);
    userId = existing.rows[0]?.id;
    if (userId) await claimEmail(client, userId);
  }
  if (!userId) {
    // An unverified address is never attached, so it can't be used to reach someone else's account.
    const verified = Boolean(email && emailVerified);
    const created = await client.query<{ id: string }>('insert into auth.users (email, email_verified) values ($1, $2) returning id', [
      verified ? email : null,
      verified,
    ]);
    userId = created.rows[0]!.id;
  }
  await link(client, userId, 'apple', sub, email);
  await markSignedIn(client, userId, 'apple', sub);
  return userId;
}

/** The user object in the shape the app's auth client expects (Supabase Auth compatible). */
export function userJson(user: UserRecord) {
  const providers = [...new Set(user.identities.map((i) => i.provider))];
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email ?? '',
    email_confirmed_at: user.email && user.email_verified ? iso(user.created_at) : null,
    phone: '',
    confirmed_at: iso(user.created_at),
    last_sign_in_at: iso(user.last_sign_in_at),
    app_metadata: { provider: providers[0] ?? 'email', providers },
    user_metadata: {},
    identities: user.identities.map((i) => ({
      identity_id: i.id,
      id: i.provider_id,
      user_id: user.id,
      provider: i.provider,
      identity_data: { sub: i.provider_id, email: i.email ?? undefined },
      email: i.email ?? undefined,
      created_at: iso(i.created_at),
      last_sign_in_at: iso(i.last_sign_in_at),
      updated_at: iso(i.last_sign_in_at ?? i.created_at),
    })),
    created_at: iso(user.created_at),
    updated_at: iso(user.updated_at),
    is_anonymous: false,
  };
}
