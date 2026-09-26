import { deviceStore } from '@/lib/device-store';

/**
 * Supabase session storage in the Keychain. Sessions can exceed SecureStore's recommended
 * value size, so values are split into chunks. Tokens never touch AsyncStorage.
 */
const CHUNK = 1800;

function part(key: string, i: number): string {
  return `${key}.${i}`;
}

export const chunkedSecureStorage = {
  async getItem(key: string): Promise<string | null> {
    const count = Number(await deviceStore.get(`${key}.n`));
    if (!Number.isInteger(count) || count <= 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const value = await deviceStore.get(part(key, i));
      if (value === null) return null;
      parts.push(value);
    }
    return parts.join('');
  },
  async setItem(key: string, value: string): Promise<void> {
    const previous = Number(await deviceStore.get(`${key}.n`)) || 0;
    const count = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < count; i += 1) await deviceStore.set(part(key, i), value.slice(i * CHUNK, (i + 1) * CHUNK));
    await deviceStore.set(`${key}.n`, String(count));
    for (let i = count; i < previous; i += 1) await deviceStore.remove(part(key, i));
  },
  async removeItem(key: string): Promise<void> {
    const count = Number(await deviceStore.get(`${key}.n`)) || 0;
    for (let i = 0; i < count; i += 1) await deviceStore.remove(part(key, i));
    await deviceStore.remove(`${key}.n`);
  },
};
