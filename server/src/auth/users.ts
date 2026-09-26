import type { PoolClient } from '../db';

/**
 * Accounts and their sign-in identities. An email code signs in the account that owns that
 * address; Sign in with Apple signs in the account linked to Apple's stable user identifier, and
 * links to an existing account only through an Apple-verified email address.
 */
export type Provider = 'email' | 'apple';

export interface UserRecord {
  id: string;
  email: string | null;
  created_at: Date;
  updated_at: Date;
  last_sign_in_at: Date | null;
  identities: { id: string; provider: Provider; provider_id: string; email: string | null; created_at: Date; last_sign_in_at: Date | null }[];
}

export async function loadUser(client: PoolClient, userId: string): Promise<UserRecord | null> {
  const { rows } = await client.query<Omit<UserRecord, 'identities'>>(
    'select id, email, created_at, updated_at, last_sign_in_at from auth.users where id = $1',
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

/** The account owning `email` (created on first sign-in). */
export async function signInWithEmail(client: PoolClient, email: string): Promise<string> {
  const identity = await client.query<{ user_id: string }>(`select user_id from auth.identities where provider = 'email' and provider_id = $1`, [email]);
  let userId = identity.rows[0]?.user_id;
  if (!userId) {
    const created = await client.query<{ id: string }>(
      `insert into auth.users (email) values ($1) on conflict (email) do update set updated_at = now() returning id`,
      [email],
    );
    userId = created.rows[0]!.id;
    await link(client, userId, 'email', email, email);
  }
  await markSignedIn(client, userId, 'email', email);
  return userId;
}

/** The account linked to this Apple ID; links an existing account only via a verified email. */
export async function signInWithAppleId(client: PoolClient, sub: string, email: string | null, emailVerified: boolean): Promise<string> {
  const identity = await client.query<{ user_id: string }>(`select user_id from auth.identities where provider = 'apple' and provider_id = $1`, [sub]);
  let userId = identity.rows[0]?.user_id;
  if (!userId && email && emailVerified) {
    const existing = await client.query<{ id: string }>('select id from auth.users where email = $1', [email]);
    userId = existing.rows[0]?.id;
  }
  if (!userId) {
    // An unverified address is never attached, so it can't be used to reach someone else's account.
    const created = await client.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email && emailVerified ? email : null]);
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
    email_confirmed_at: user.email ? iso(user.created_at) : null,
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
