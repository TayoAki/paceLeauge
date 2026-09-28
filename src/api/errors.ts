/**
 * Stable error codes raised by the SQL RPCs (message = code) plus transport-level codes.
 * The sync engine uses the classification to decide between retrying, re-authenticating
 * and marking an item as needing attention.
 */
export type TransportCode = 'network' | 'timeout' | 'server_error' | 'auth_expired' | 'permission_denied' | 'invalid_response' | 'unknown';

export const PERMANENT_CODES = new Set([
  'invalid_input',
  'invalid_chunk',
  'chunk_too_large',
  'checksum_mismatch',
  'chunk_conflict',
  'manifest_mismatch',
  'idempotency_conflict',
  'version_conflict',
  'not_found',
  'profile_required',
  'account_deleting',
  'eligibility_required',
  'age_restricted',
  'too_many_shoes',
  'edit_increases_distance',
  'cannot_undo_merge',
  'not_in_league',
  'permission_denied',
  'invalid_response',
]);

const RETRYABLE_CODES = new Set(['network', 'timeout', 'server_error', 'rate_limited', 'upload_incomplete']);

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = 'ApiError';
  }

  get isRetryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  get isAuth(): boolean {
    return this.code === 'auth_expired' || this.code === 'not_authenticated';
  }

  get isPermanent(): boolean {
    return PERMANENT_CODES.has(this.code);
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new ApiError('timeout');
  return new ApiError('unknown', null, error instanceof Error ? error.message : String(error));
}

interface PostgrestLikeError {
  message?: string;
  code?: string;
  details?: string | null;
}

/** Maps a supabase-js/PostgREST failure to a stable ApiError. */
export function fromPostgrest(error: PostgrestLikeError, status: number): ApiError {
  const message = error.message ?? '';
  const sqlState = error.code ?? '';
  if (status === 0 || /network request failed|failed to fetch|fetcherror|typeerror/i.test(message)) {
    return new ApiError(/abort/i.test(message) ? 'timeout' : 'network', status);
  }
  if (status === 401 || sqlState === 'PGRST301' || sqlState === 'PGRST303' || message === 'not_authenticated') {
    return new ApiError('auth_expired', status);
  }
  if (sqlState === '42501') return new ApiError('permission_denied', status);
  if (/^[a-z][a-z0-9_]*$/.test(message)) return new ApiError(message, status, error.details ?? null);
  if (status >= 500) return new ApiError('server_error', status, message);
  return new ApiError('unknown', status, message);
}
