import type pg from 'pg';

/**
 * The slice of PostgREST the app uses: `POST /rest/v1/rpc/<fn>` with named JSON arguments,
 * executed like PostgREST executes it — one transaction, `role` switched to the caller's JWT
 * role, the claims in `request.jwt.claims` and the request headers in `request.headers` —
 * so RLS, grants, auth.uid() and the rate limiters behave as they do on Supabase.
 * Development only; production traffic goes to the real Supabase API.
 */

export interface RpcResponse {
  status: number;
  body: unknown;
}

interface FunctionInfo {
  args: { name: string; type: string }[];
  requiredCount: number;
  returnsVoid: boolean;
  returnsSet: boolean;
}

export type Claims = Record<string, unknown> & { role: 'anon' | 'authenticated' };

const cache = new Map<string, FunctionInfo | null>();

async function describe(pool: pg.Pool, name: string): Promise<FunctionInfo | null> {
  if (cache.has(name)) return cache.get(name) ?? null;
  const { rows } = await pool.query<{ names: string[] | null; types: string[]; nargs: number; ndefaults: number; rettype: string; retset: boolean }>(
    `select p.proargnames as names,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) with ordinality u(t, i) order by i) as types,
            p.pronargs as nargs, p.pronargdefaults as ndefaults,
            format_type(p.prorettype, null) as rettype, p.proretset as retset
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`,
    [name],
  );
  const row = rows.length === 1 ? rows[0] : undefined;
  const info = row
    ? {
        args: row.types.map((type, i) => ({ name: row.names?.[i] ?? `$${i + 1}`, type })),
        requiredCount: row.nargs - row.ndefaults,
        returnsVoid: row.rettype === 'void',
        returnsSet: row.retset,
      }
    : null;
  cache.set(name, info);
  return info;
}

/** PostgREST's SQLSTATE → HTTP status table (the entries the app can meet). */
export function statusForSqlState(sqlState: string, role: string): number {
  if (/^PT\d{3}$/.test(sqlState)) return Number(sqlState.slice(2));
  if (sqlState === '42501') return role === 'anon' ? 401 : 403;
  if (sqlState === 'P0001') return 400;
  if (sqlState === '23503' || sqlState === '23505') return 409;
  if (sqlState === '25006') return 405;
  if (sqlState === '42883' || sqlState === '42P01') return 404;
  if (sqlState.startsWith('08') || sqlState.startsWith('53')) return 503;
  if (sqlState.startsWith('28') || sqlState.startsWith('0L') || sqlState.startsWith('0P')) return 403;
  if (sqlState.startsWith('54')) return 413;
  if (/^(09|25|2D|38|39|3B|40|55|57|58|F0|HV|P0|XX)/.test(sqlState)) return 500;
  return 400;
}

function toParam(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'json' || type === 'jsonb') return JSON.stringify(value);
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  return value;
}

export async function callRpc(
  pool: pg.Pool,
  fn: string,
  args: Record<string, unknown>,
  claims: Claims,
  headers: Record<string, string> = {},
): Promise<RpcResponse> {
  const info = /^[a-z_][a-z0-9_]*$/.test(fn) ? await describe(pool, fn) : null;
  const keys = Object.keys(args);
  const known = new Set(info?.args.map((a) => a.name));
  const missingRequired = info?.args.slice(0, info.requiredCount).some((a) => !(a.name in args));
  if (!info || keys.some((k) => !known.has(k)) || missingRequired) {
    return {
      status: 404,
      body: {
        code: 'PGRST202',
        details: `Searched for the function public.${fn} with parameters ${keys.join(', ') || 'none'}, but no matches were found in the schema cache.`,
        hint: null,
        message: `Could not find the function public.${fn}(${keys.join(', ')}) in the schema cache`,
      },
    };
  }

  const used = info.args.filter((a) => a.name in args);
  const call = `public.${fn}(${used.map((a, i) => `${a.name} => $${i + 1}::${a.type}`).join(', ')})`;
  const sql = info.returnsSet ? `select coalesce(json_agg(r), '[]'::json) as result from ${call} r` : `select ${call} as result`;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true), set_config('role', $3, true)`, [
      JSON.stringify(claims),
      JSON.stringify(headers),
      claims.role,
    ]);
    const result = await client.query<{ result: unknown }>(sql, used.map((a) => toParam(a.type, args[a.name])));
    await client.query('commit');
    if (info.returnsVoid) return { status: 204, body: null };
    return { status: 200, body: result.rows[0]?.result ?? null };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    const e = error as { code?: string; message?: string; detail?: string; hint?: string };
    const code = e.code ?? 'XX000';
    return { status: statusForSqlState(code, claims.role), body: { code, details: e.detail || null, hint: e.hint ?? null, message: e.message ?? 'error' } };
  } finally {
    client.release();
  }
}
