import type { SupabaseClient } from '@supabase/supabase-js';

import { fromPostgrest, toApiError } from './errors';
import type { RpcTransport } from './pace-api';

const DEFAULT_TIMEOUT_MS = 10_000;

/** PostgREST RPC transport with a per-request timeout (reads time out after 10 s). */
export function supabaseTransport(client: SupabaseClient): RpcTransport {
  return async (fn, args, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const { data, error, status } = await client.rpc(fn, args).abortSignal(controller.signal);
      if (error) throw fromPostgrest(error, status);
      return data;
    } catch (error) {
      throw toApiError(error);
    } finally {
      clearTimeout(timer);
    }
  };
}
