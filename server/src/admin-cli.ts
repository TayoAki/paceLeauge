import { setTemporaryPassword } from './auth/admin';
import { ConfigError, loadConfig } from './config';
import { createPool } from './db';
import { maskEmail } from './mailer';

/**
 * Operator commands. Run them inside the API container, where DATABASE_URL reaches the database
 * on Railway's private network:
 *
 *   railway ssh --service api
 *   node dist/admin.js set-password <email>
 *
 * set-password gives the account a new temporary password, ends all of its sessions and prints
 * the password once. Send it to the runner over a channel you trust; they can change it in
 * Profile → Privacy → Change password.
 *
 *   node dist/admin.js grant-pro <email> <days>
 *
 * grant-pro gives the account Pro for that many days (testers, support); 0 ends a grant. Store
 * subscriptions are RevenueCat's: a grant never replaces one that's running, and the store's next
 * event replaces a grant.
 */
const USAGE = 'usage: node dist/admin.js set-password <email>\n       node dist/admin.js grant-pro <email> <days>';

async function main(): Promise<void> {
  const [command, arg, extra] = process.argv.slice(2);
  const days = extra === undefined ? NaN : Number(extra);
  if (!arg || !(command === 'set-password' || (command === 'grant-pro' && Number.isInteger(days) && days >= 0 && days <= 3650))) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const email = arg.trim().toLowerCase();
  const config = loadConfig();
  const pool = createPool({ ...config, databasePoolMax: 1 });
  try {
    if (command === 'grant-pro') {
      const { rows } = await pool.query<{ id: string }>('select id from auth.users where lower(email) = $1', [email]);
      if (!rows[0]) {
        console.error(`No account uses ${maskEmail(email)}.`);
        process.exitCode = 1;
        return;
      }
      await pool.query(`select private.grant_pro($1, now() + make_interval(days => $2))`, [rows[0].id, days]);
      const { rows: after } = await pool.query<{ source: string }>('select source from private.entitlements where user_id = $1', [rows[0].id]);
      if (after[0]?.source !== 'grant') console.log(`${maskEmail(email)} has Pro from the store, so nothing changed.`);
      else console.log(days > 0 ? `${maskEmail(email)} has Pro for ${days} days.` : `${maskEmail(email)}'s Pro grant has ended.`);
      return;
    }
    const password = await setTemporaryPassword(pool, email);
    if (password === null) {
      console.error(`No account uses ${maskEmail(email)}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Temporary password for ${maskEmail(email)}: ${password}\nAll of the account's sessions have ended.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? `Invalid configuration: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
