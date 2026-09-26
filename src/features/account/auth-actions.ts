import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { supabase } from '@/api/client';
import { randomHex, sha256Hex } from '@/lib/crypto';

export class AuthError extends Error {
  constructor(
    readonly code: 'not_configured' | 'invalid_email' | 'invalid_code' | 'rate_limited' | 'network' | 'cancelled' | 'unavailable' | 'unknown',
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

function mapAuthError(error: { message?: string; status?: number; code?: string } | null): AuthError {
  const message = error?.message ?? '';
  if (error?.status === 429 || /rate limit|too many/i.test(message)) {
    return new AuthError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  }
  if (/expired|invalid|otp/i.test(message) || error?.code === 'otp_expired') {
    return new AuthError('invalid_code', 'That code didn’t work. Check it, or request a new one.');
  }
  if (/network|fetch/i.test(message)) return new AuthError('network', 'You’re offline. Connect and try again.');
  return new AuthError('unknown', 'Something went wrong. Please try again.');
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function sendEmailCode(email: string): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(address)) throw new AuthError('invalid_email', 'Enter a valid email address.');
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
 * Native Sign in with Apple. Apple receives the SHA-256 of a one-time nonce; Supabase
 * receives the raw nonce and verifies the pair. Only the email scope is requested.
 */
export async function signInWithApple(): Promise<void> {
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
  const { error } = await client().auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce: rawNonce });
  if (error) throw mapAuthError(error);
}

export async function signOutEverywhere(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut({ scope: 'local' });
}
