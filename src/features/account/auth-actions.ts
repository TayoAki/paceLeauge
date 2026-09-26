import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { supabase } from '@/api/client';
import { randomHex, sha256Hex } from '@/lib/crypto';

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'invalid_email'
      | 'invalid_code'
      | 'invalid_credentials'
      | 'weak_password'
      | 'account_exists'
      | 'same_password'
      | 'reauth_needed'
      | 'rate_limited'
      | 'network'
      | 'cancelled'
      | 'unavailable'
      | 'wrong_account'
      | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function client() {
  if (!supabase) throw new AuthError('not_configured', 'The app is not connected to a backend.');
  return supabase;
}

export const PASSWORD_MIN_LENGTH = 8;

/** Maps an auth failure to calm, specific copy — by the server's error code first. */
export function mapAuthError(error: { message?: string; status?: number; code?: string; reasons?: string[] } | null): AuthError {
  const message = error?.message ?? '';
  const code = error?.code ?? '';
  if (error?.status === 429 || /rate_limit/.test(code) || /rate limit|too many/i.test(message)) {
    return new AuthError('rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  }
  switch (code) {
    case 'invalid_credentials':
      return new AuthError('invalid_credentials', 'That email and password don’t match.');
    case 'user_already_exists':
      return new AuthError('account_exists', 'There’s already an account with this email. Sign in instead.');
    case 'weak_password':
      return new AuthError(
        'weak_password',
        /at most/i.test(message)
          ? 'Use 128 characters or fewer.'
          : error?.reasons?.includes('length')
            ? `Use at least ${PASSWORD_MIN_LENGTH} characters.`
            : 'That password is too easy to guess. Try a short phrase instead.',
      );
    case 'same_password':
      return new AuthError('same_password', 'That’s your current password. Choose a new one.');
    case 'reauthentication_needed':
      return new AuthError('reauth_needed', 'For your security, confirm it’s you first.');
    case 'validation_failed':
      return new AuthError('invalid_email', 'Enter a valid email address.');
    case 'otp_expired':
      return new AuthError('invalid_code', 'That code didn’t work. Check it, or request a new one.');
  }
  if (/network|fetch/i.test(message)) return new AuthError('network', 'You’re offline. Connect and try again.');
  if (/expired|invalid|otp/i.test(message)) return new AuthError('invalid_code', 'That code didn’t work. Check it, or request a new one.');
  return new AuthError('unknown', 'Something went wrong. Please try again.');
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function emailAddress(email: string): string {
  const address = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(address)) throw new AuthError('invalid_email', 'Enter a valid email address.');
  return address;
}

/** A new account with a password. The session starts at once; no confirmation email is sent. */
export async function signUpWithPassword(email: string, password: string): Promise<void> {
  const address = emailAddress(email);
  if ([...password].length < PASSWORD_MIN_LENGTH) throw new AuthError('weak_password', `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  const { error } = await client().auth.signUp({ email: address, password });
  if (error) throw mapAuthError(error);
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const address = emailAddress(email);
  if (!password) throw new AuthError('invalid_credentials', 'Enter your password.');
  const { error } = await client().auth.signInWithPassword({ email: address, password });
  if (error) throw mapAuthError(error);
}

/** Needs a recent sign-in (`reauth_needed` otherwise); other devices are signed out. */
export async function changePassword(password: string): Promise<void> {
  if ([...password].length < PASSWORD_MIN_LENGTH) throw new AuthError('weak_password', `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  const { error } = await client().auth.updateUser({ password });
  if (error) throw mapAuthError(error);
}

export async function sendEmailCode(email: string): Promise<void> {
  const address = emailAddress(email);
  const { error } = await client().auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } });
  if (error) throw mapAuthError(error);
}

export async function verifyEmailCode(email: string, code: string): Promise<void> {
  const token = code.replace(/\D/g, '');
  if (token.length !== 6) throw new AuthError('invalid_code', 'Enter the 6-digit code from the email.');
  const { error } = await client().auth.verifyOtp({ email: email.trim().toLowerCase(), token, type: 'email' });
  if (error) throw mapAuthError(error);
}

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

/**
 * Native Sign in with Apple. Apple receives the SHA-256 of a one-time nonce; the API
 * receives the raw nonce and verifies the pair. Only the email scope is requested.
 *
 * `expectedAppleUser` (re-authentication) is the Apple user identifier already linked to the
 * signed-in account: a different Apple ID is refused *before* any token exchange, so confirming
 * identity can never switch accounts.
 */
export async function signInWithApple(expectedAppleUser?: string): Promise<void> {
  const rawNonce = randomHex(32);
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: await sha256Hex(rawNonce),
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw new AuthError('cancelled', 'Sign in was cancelled.');
    throw new AuthError('unavailable', 'Sign in with Apple isn’t available right now.');
  }
  if (!credential.identityToken) throw new AuthError('unavailable', 'Apple didn’t return a sign-in token.');
  if (expectedAppleUser !== undefined && credential.user !== expectedAppleUser) {
    throw new AuthError('wrong_account', 'That Apple ID belongs to a different account. Use the Apple ID you signed up with, or confirm by email.');
  }
  const { error } = await client().auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: rawNonce });
  if (error) throw mapAuthError(error);
}

export async function signOutEverywhere(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut({ scope: 'local' });
}
