import { mapAuthError, signInWithPassword, signUpWithPassword } from '@/features/account/auth-actions';

// No backend: anything that reaches the network fails with not_configured.
jest.mock('@/api/client', () => ({ supabase: null }));

describe('sign-in errors', () => {
  it('maps the server’s error codes to specific, calm copy', () => {
    expect(mapAuthError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' })).toMatchObject({
      code: 'invalid_credentials',
      message: 'That email and password don’t match.',
    });
    expect(mapAuthError({ code: 'user_already_exists', status: 422, message: 'User already registered' }).code).toBe('account_exists');
    expect(mapAuthError({ code: 'weak_password', message: 'Password should be at least 8 characters.', reasons: ['length'] }).message).toBe(
      'Use at least 8 characters.',
    );
    expect(mapAuthError({ code: 'weak_password', message: 'Password should be at most 128 characters.', reasons: ['length'] }).message).toBe(
      'Use 128 characters or fewer.',
    );
    expect(mapAuthError({ code: 'weak_password', message: 'Password is too easy to guess.', reasons: ['pwned'] }).message).toMatch(/too easy to guess/);
    expect(mapAuthError({ code: 'reauthentication_needed', status: 400 }).code).toBe('reauth_needed');
    expect(mapAuthError({ code: 'same_password', status: 422 }).code).toBe('same_password');
    expect(mapAuthError({ code: 'over_request_rate_limit', status: 429 }).code).toBe('rate_limited');
    expect(mapAuthError({ code: 'otp_expired', status: 403, message: 'Token has expired or is invalid' }).code).toBe('invalid_code');
    expect(mapAuthError({ message: 'Failed to fetch', status: 0 }).code).toBe('network');
    expect(mapAuthError(null).code).toBe('unknown');
  });

  it('checks the obvious before calling the server', async () => {
    await expect(signUpWithPassword('not-an-email', 'long enough phrase')).rejects.toMatchObject({ code: 'invalid_email' });
    await expect(signUpWithPassword('a@example.com', 'short')).rejects.toMatchObject({ code: 'weak_password' });
    await expect(signInWithPassword('a@example.com', '')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(signInWithPassword('a@example.com', 'long enough phrase')).rejects.toMatchObject({ code: 'not_configured' });
  });
});
