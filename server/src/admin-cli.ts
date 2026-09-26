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
 */
async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command !== 'set-password' || !arg) {
    console.error('usage: node dist/admin.js set-password <email>');
    process.exitCode = 1;
    return;
  }
  const email = arg.trim().toLowerCase();
  const config = loadConfig();
  const pool = createPool({ ...config, databasePoolMax: 1 });
  try {
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
