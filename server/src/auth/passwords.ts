import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt: memory-hard and built into Node, so there is no native
 * dependency. Hashes are stored as `scrypt$N$r$p$salt$hash` (base64url) so the cost can be raised
 * later without invalidating existing passwords. Hashing runs on libuv's thread pool, never on
 * the event loop.
 */
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common';

// The most common choices, plus the obvious ones for a running app. Short on purpose: the
// length rule and per-account rate limits do the heavy lifting.
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  '87654321', 'qwerty12', 'qwerty123', 'qwertyuiop', '1q2w3e4r', '1qaz2wsx', 'abc12345', 'abcd1234',
  'iloveyou', 'letmein1', 'welcome1', 'trustno1', 'sunshine', 'princess', 'football', 'baseball',
  'running1', 'runner123', 'marathon', 'paceleague',
]);

function derive(password: string, salt: Buffer, cost: typeof COST): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...cost, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function parse(stored: string): { cost: typeof COST; salt: Buffer; key: Buffer } | null {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  const sane = Number.isInteger(cost.N) && cost.N >= 2 ** 10 && cost.N <= 2 ** 17 && cost.r >= 1 && cost.r <= 16 && cost.p >= 1 && cost.p <= 4;
  if (scheme !== 'scrypt' || !sane || !salt || !key) return null;
  return { cost, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
}

// Checked against when an account has no password, so "no such account" and "wrong password"
// take the same time.
let decoy: Promise<string> | null = null;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const target = parse(stored ?? (await (decoy ??= hashPassword(randomBytes(16).toString('hex')))));
  if (!target) return false;
  const key = await derive(password, target.salt, target.cost);
  return stored !== null && key.length === target.key.length && timingSafeEqual(key, target.key);
}

/** Why a new password is refused, or null. Length counts characters, not bytes. */
export function passwordProblem(password: string, email: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  const lower = password.toLowerCase();
  const local = email.split('@')[0] ?? '';
  if (COMMON.has(lower) || lower === email || (local.length >= 4 && lower === local) || /^(.)\1+$/u.test(password)) return 'too_common';
  return null;
}

/** A temporary password for an operator reset: 16 unambiguous characters (≈ 79 bits). */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte < limit && out.length < 16) out += alphabet[byte % alphabet.length];
    }
  }
  return out.match(/.{4}/g)!.join('-');
}
