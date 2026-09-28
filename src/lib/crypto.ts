import * as Crypto from 'expo-crypto';

export function newId(): string {
  return Crypto.randomUUID();
}

export async function sha256Hex(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, { encoding: Crypto.CryptoEncoding.HEX });
}

export function randomHex(bytes: number): string {
  return Array.from(Crypto.getRandomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  // A copy on a plain ArrayBuffer (the digest API won't take a view of a shared buffer).
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A stable UUID-shaped id from a hex digest (the same input always gives the same id). */
export function uuidFromHex(hex: string): string {
  const h = hex.padEnd(32, '0').slice(0, 32).split('');
  h[12] = '5'; // "name-based"
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
