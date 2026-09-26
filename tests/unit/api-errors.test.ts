import { ApiError, fromPostgrest, toApiError } from '@/api/errors';
import { createPaceApi } from '@/api/pace-api';
import { backoffDelay } from '@/features/sync/sync-engine';

describe('API error mapping', () => {
  it('classifies transport, auth, permission and domain errors', () => {
    expect(fromPostgrest({ message: 'TypeError: Network request failed' }, 0).code).toBe('network');
    expect(fromPostgrest({ message: 'AbortError: The operation was aborted' }, 0).code).toBe('timeout');
    expect(fromPostgrest({ message: 'JWT expired', code: 'PGRST303' }, 401).code).toBe('auth_expired');
    expect(fromPostgrest({ message: 'not_authenticated', code: '28000' }, 403).code).toBe('auth_expired');
    expect(fromPostgrest({ message: 'permission denied for function get_me', code: '42501' }, 401).code).toBe('auth_expired');
    expect(fromPostgrest({ message: 'permission denied for function get_me', code: '42501' }, 403).code).toBe('permission_denied');
    const domain = fromPostgrest({ message: 'upload_incomplete', code: 'P0001', details: '2,3' }, 400);
    expect([domain.code, domain.detail, domain.isRetryable]).toEqual(['upload_incomplete', '2,3', true]);
    expect(fromPostgrest({ message: 'Something odd happened' }, 503).code).toBe('server_error');
  });

  it('knows which errors are retryable, permanent or need sign-in', () => {
    expect(new ApiError('network').isRetryable).toBe(true);
    expect(new ApiError('rate_limited').isRetryable).toBe(true);
    expect(new ApiError('idempotency_conflict').isPermanent).toBe(true);
    expect(new ApiError('auth_expired').isAuth).toBe(true);
    expect(toApiError(Object.assign(new Error('aborted'), { name: 'AbortError' })).code).toBe('timeout');
  });

  it('rejects responses that do not match the schema', async () => {
    const api = createPaceApi(async () => ({ lifetime_xp: 'lots' }));
    await expect(api.getMe()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns join failures returned as values into errors', async () => {
    const api = createPaceApi(async () => ({ error: 'invite_expired' }));
    await expect(api.joinLeague('ABCD1234')).rejects.toMatchObject({ code: 'invite_expired' });
  });
});

describe('retry backoff', () => {
  it('grows exponentially with jitter and caps at 15 minutes', () => {
    expect(backoffDelay(1, () => 1)).toBe(5_000);
    expect(backoffDelay(1, () => 0)).toBe(2_500);
    expect(backoffDelay(4, () => 1)).toBe(40_000);
    expect(backoffDelay(30, () => 1)).toBe(15 * 60_000);
    expect(backoffDelay(1, () => 0, 'rate_limited')).toBe(60_000);
  });
});
