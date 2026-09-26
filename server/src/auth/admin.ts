import { transaction, type Pool } from '../db';
import { hashPassword, temporaryPassword } from './passwords';

/**
 * Operator reset for a forgotten password (there is no reset email yet): a new temporary password
 * for the account registered with `email`, and every one of its sessions ended. Returns the
 * password, or null when no account uses that address.
 */
export async function setTemporaryPassword(pool: Pool, email: string): Promise<string | null> {
  const password = temporaryPassword();
  const hash = await hashPassword(password);
  const found = await transaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>('update auth.users set encrypted_password = $2, updated_at = now() where email = $1 returning id', [
      email,
      hash,
    ]);
    const userId = rows[0]?.id;
    if (!userId) return false;
    await client.query(
      `insert into auth.identities (user_id, provider, provider_id, email) values ($1, 'email', $2, $2) on conflict (provider, provider_id) do nothing`,
      [userId, email],
    );
    const ended = await client.query<{ id: string }>('update auth.sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id', [userId]);
    if (ended.rowCount) {
      await client.query('update auth.refresh_tokens set revoked_at = coalesce(revoked_at, now()) where session_id = any($1::uuid[])', [ended.rows.map((r) => r.id)]);
    }
    return true;
  });
  return found ? password : null;
}
