// Builds the template database used by backend tests and the local development backend:
// the Supabase compatibility shim first, then every migration in supabase/migrations in order.
//   node scripts/db/apply-migrations.mjs [--database paceleague_template]
// Connection: PG_TEST_URL (admin URL to the "postgres" database) or the local harness default.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const database = args.includes('--database') ? args[args.indexOf('--database') + 1] : 'paceleague_template';
const adminUrl = process.env.PG_TEST_URL ?? `postgres://postgres@127.0.0.1:${process.env.PGPORT ?? 54329}/postgres`;

function urlFor(db) {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [database]);
await admin.query(`drop database if exists ${database}`);
await admin.query(`create database ${database}`);
await admin.end();

const client = new pg.Client({ connectionString: urlFor(database) });
await client.connect();
client.on('notice', (n) => {
  if (process.env.DEBUG_SQL) console.log('NOTICE:', n.message);
});

async function run(file) {
  const sql = readFileSync(file, 'utf8');
  try {
    await client.query(sql);
  } catch (error) {
    const position = Number(error.position);
    let context = '';
    if (Number.isFinite(position)) {
      const line = sql.slice(0, position).split('\n').length;
      context = ` (line ${line}: ${sql.split('\n')[line - 1]?.trim()})`;
    }
    console.error(`✗ ${file.replace(root + '/', '')}: ${error.message}${context}`);
    if (error.where) console.error(`  where: ${error.where}`);
    process.exit(1);
  }
  console.log(`✓ ${file.replace(root + '/', '')}`);
}

await run(join(root, 'supabase/tests/shim/supabase_shim.sql'));
const migrationsDir = join(root, 'supabase/migrations');
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
  await run(join(migrationsDir, file));
}
await client.end();
