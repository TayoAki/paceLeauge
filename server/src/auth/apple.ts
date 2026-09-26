import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

import { decodeSegment } from '../jwt';

/**
 * Verifies a native Sign in with Apple identity token: RS256 signature against Apple's published
 * keys, issuer, audience (the app's bundle identifier), expiry, and the nonce — the app sent
 * Apple the SHA-256 of a one-time value and sends us the raw value, so a captured token can't
 * be replayed by someone else.
 */
export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

export class AppleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleTokenError';
  }
}

export interface AppleVerifier {
  verify(idToken: string, rawNonce: string | undefined): Promise<AppleIdentity>;
}

const ISSUER = 'https://appleid.apple.com';
const KEYS_URL = 'https://appleid.apple.com/auth/keys';
const KEY_CACHE_MS = 60 * 60_000;
const MIN_REFETCH_MS = 60_000;
const CLOCK_SKEW_S = 300;

type Fetch = typeof fetch;

/** The RSA public-key fields Apple publishes (JWK). */
interface AppleJwk {
  kty: string;
  kid?: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export function createAppleVerifier(audiences: string[], fetchImpl: Fetch = fetch, now: () => number = Date.now): AppleVerifier {
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function loadKeys(force: boolean): Promise<void> {
    const age = now() - fetchedAt;
    if (!force && age < KEY_CACHE_MS && keys.size > 0) return;
    if (force && age < MIN_REFETCH_MS) return;
    const response = await fetchImpl(KEYS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new AppleTokenError(`Apple keys unavailable (HTTP ${response.status})`);
    const body = (await response.json()) as { keys?: AppleJwk[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next;
    fetchedAt = now();
  }

  return {
    async verify(idToken, rawNonce) {
      if (audiences.length === 0) throw new AppleTokenError('Sign in with Apple is not configured');
      if (!rawNonce) throw new AppleTokenError('nonce required');
      const parts = idToken.split('.');
      if (parts.length !== 3 || idToken.length > 8192) throw new AppleTokenError('malformed token');
      const [headerPart, bodyPart, signaturePart] = parts as [string, string, string];
      const header = decodeSegment(headerPart);
      if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw new AppleTokenError('unexpected token header');

      await loadKeys(false);
      if (!keys.has(header.kid)) await loadKeys(true);
      const key = keys.get(header.kid);
      if (!key) throw new AppleTokenError('unknown signing key');
      const valid = verify('RSA-SHA256', Buffer.from(`${headerPart}.${bodyPart}`), key, Buffer.from(signaturePart, 'base64url'));
      if (!valid) throw new AppleTokenError('bad signature');

      const claims = decodeSegment(bodyPart);
      if (!claims) throw new AppleTokenError('malformed claims');
      const nowS = Math.floor(now() / 1000);
      if (claims.iss !== ISSUER) throw new AppleTokenError('wrong issuer');
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.some((a) => typeof a === 'string' && audiences.includes(a))) throw new AppleTokenError('wrong audience');
      if (typeof claims.exp !== 'number' || claims.exp <= nowS) throw new AppleTokenError('expired');
      if (typeof claims.iat === 'number' && claims.iat > nowS + CLOCK_SKEW_S) throw new AppleTokenError('issued in the future');
      const expectedNonce = createHash('sha256').update(rawNonce).digest('hex');
      if (claims.nonce !== expectedNonce) throw new AppleTokenError('nonce mismatch');
      if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new AppleTokenError('missing subject');

      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
      const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
      return { sub: claims.sub, email, emailVerified };
    },
  };
}
