import { ApiError } from '@/api/errors';
import type { RpcTransport } from '@/api/pace-api';

import { RpcError, type TestDb, type TestUser } from '../backend/helpers/db';

/**
 * Transport that executes the app's RPC calls directly against the test database, with
 * the same request semantics PostgREST uses (role + JWT claims). Lets integration tests run
 * the real client code (PaceApi, SyncEngine) against the real SQL backend.
 */
export interface TransportOptions {
  failNext?: (fn: string) => ApiError | null;
  /**
   * Replayed historical runs would otherwise count as late uploads (the server stamps the
   * receipt time with the real clock). Pin it to just after the run ended, as a live
   * upload would have been.
   */
  pinReceipt?: boolean;
}

export function sqlTransport(db: TestDb, user: TestUser, faults: TransportOptions = {}): RpcTransport {
  return async (fn, args) => {
    const fault = faults.failNext?.(fn);
    if (fault) throw fault;
    try {
      const result = await db.rpc(user, fn, args);
      if (fn === 'start_run_upload' && faults.pinReceipt !== false && result?.status === 'uploading') {
        await db.sql(`update public.runs set first_received_at = ended_at + interval '5 seconds' where id = $1`, [result.run_id]);
      }
      return result;
    } catch (error) {
      if (error instanceof RpcError) {
        if (error.sqlState === '42501') throw new ApiError('permission_denied', 403);
        if (error.sqlState === '28000') throw new ApiError('auth_expired', 401);
        throw new ApiError(error.code, 400, error.detail ?? null);
      }
      throw error;
    }
  };
}
