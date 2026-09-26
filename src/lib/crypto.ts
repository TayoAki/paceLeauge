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
