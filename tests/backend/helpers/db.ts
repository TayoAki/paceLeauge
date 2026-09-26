import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Backend test harness. Each test file clones the migrated template database
 * (scripts/db/apply-migrations.mjs) and calls RPCs the way PostgREST does: inside a
 * transaction with `SET LOCAL ROLE authenticated|anon` and the JWT claims in
 * `request.jwt.claims`, so RLS, grants and auth.uid() behave as in production.
 */

const ADMIN_URL = process.env.PG_TEST_URL ?? `postgres://postgres@127.0.0.1:${process.env.PGPORT ?? 54329}/postgres`;
const TEMPLATE = 'paceleague_template';

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface TestUser {
  id: string;
  email: string;
  /** Epoch seconds of the last sign-in (goes into the JWT `amr` claim). */
  signedInAt: number;
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    readonly sqlState: string | undefined,
    readonly detail: string | undefined,
  ) {
    super(code);
    this.name = 'RpcError';
  }
}

type Caller = TestUser | 'anon';

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export class TestDb {
  private constructor(
    readonly name: string,
    readonly pool: pg.Pool,
  ) {}

  static async create(): Promise<TestDb> {
    const name = `pl_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`create database ${name} template ${TEMPLATE}`);
    } finally {
      await admin.end();
    }
    const pool = new pg.Pool({ connectionString: urlFor(name), max: 30 });
    pool.on('error', () => {});
    const db = new TestDb(name, pool);
    await db.sql(`select private.set_flag('competition_enabled', true, 'backend test suite', 'jest')`);
    return db;
  }

  async close(): Promise<void> {
    await this.pool.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${this.name} with (force)`);
    } finally {
      await admin.end();
    }
  }

  /** Runs SQL as the database owner (the equivalent of the service/operator context). */
  async sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.sql<T>(text, params);
    if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
    return rows[0] as T;
  }

  async createUser(email = `${randomUUID()}@example.test`): Promise<TestUser> {
    const row = await this.one<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email]);
    return { id: row.id, email, signedInAt: Math.floor(Date.now() / 1000) };
  }

  /** Executes `fn` inside a request-shaped transaction for the caller. */
  async as<T>(caller: Caller, fn: (client: pg.PoolClient) => Promise<T>, options: { recentAuth?: boolean } = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (caller === 'anon') {
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
        await client.query('set local role anon');
      } else {
        const signedInAt = options.recentAuth === false ? caller.signedInAt - 3600 : caller.signedInAt;
        const claims = { sub: caller.id, role: 'authenticated', email: caller.email, amr: [{ method: 'otp', timestamp: signedInAt }] };
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await client.query('set local role authenticated');
      }
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Calls public.<fn>(named args) as the caller; returns the jsonb result. */
  async rpc<T = any>(caller: Caller, fn: string, args: Record<string, unknown> = {}, options: { recentAuth?: boolean } = {}): Promise<T> {
    const names = Object.keys(args);
    const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
    const values = names.map((n) => serialize(args[n]));
    try {
      return await this.as(
        caller,
        async (client) => {
          const result = await client.query(`select public.${fn}(${placeholders}) as result`, values);
          return result.rows[0]?.result as T;
        },
        options,
      );
    } catch (error) {
      const e = error as { message: string; code?: string; detail?: string };
      throw new RpcError(e.message, e.code, e.detail);
    }
  }

  /** Expects the RPC to fail and returns the stable error code (message). */
  async rpcError(caller: Caller, fn: string, args: Record<string, unknown> = {}, options: { recentAuth?: boolean } = {}): Promise<RpcError> {
    try {
      await this.rpc(caller, fn, args, options);
    } catch (error) {
      if (error instanceof RpcError) return error;
      throw error;
    }
    throw new Error(`expected ${fn} to fail`);
  }

  /** A signed-in runner with a profile (onboarding complete). */
  async createRunner(alias: string, options: { units?: 'metric' | 'imperial'; goalDays?: number | null } = {}): Promise<TestUser> {
    const user = await this.createUser();
    await this.rpc(user, 'save_profile', {
      p_alias: alias,
      p_units: options.units ?? 'metric',
      p_goal_days: options.goalDays === undefined ? 3 : options.goalDays,
      p_notification_tz: 'America/Chicago',
      p_ack_eligibility: true,
    });
    return user;
  }
}

export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}
