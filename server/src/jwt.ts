import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HS256 access tokens. Verification pins the algorithm (a token claiming `none` or any other
 * algorithm is rejected), compares signatures in constant time, requires `exp`, and fails closed
 * on anything malformed.
 */
export type Claims = Record<string, unknown>;

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

export function signJwt(payload: Claims, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac('sha256', secret).update(`${HEADER}.${body}`).digest());
  return `${HEADER}.${body}.${signature}`;
}

export function verifyJwt(token: string, secret: string, nowS = Math.floor(Date.now() / 1000)): Claims | null {
  if (token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  if (decodeSegment(header)?.alg !== 'HS256') return null;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = decodeSegment(body);
  if (!claims || typeof claims.exp !== 'number' || claims.exp <= nowS) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > nowS + 60) return null;
  return claims;
}
