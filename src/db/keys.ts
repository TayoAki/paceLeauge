import { randomHex, sha256Hex } from '@/lib/crypto';
import { deviceStore } from '@/lib/device-store';

/** Stable, non-reversible local name for an account's journal and key. */
export async function accountStorageId(accountId: string): Promise<string> {
  return (await sha256Hex(`pl-account-v1:${accountId}`)).slice(0, 24);
}

export class DatabaseKeyUnavailableError extends Error {
  constructor() {
    super('This phone can’t unlock your saved runs right now. Unlock the phone and try again.');
    this.name = 'DatabaseKeyUnavailableError';
  }
}

/**
 * Returns the account's journal key. A missing key is only created for a brand-new journal:
 * an existing encrypted journal is never silently replaced by an unencrypted or re-keyed one.
 */
export async function databaseKey(storageId: string, journalExists: boolean): Promise<string> {
  const name = `pl.dbkey.${storageId}`;
  let key: string | null;
  try {
    key = await deviceStore.get(name);
  } catch {
    throw new DatabaseKeyUnavailableError();
  }
  if (key) return key;
  if (journalExists) throw new DatabaseKeyUnavailableError();
  key = randomHex(32);
  await deviceStore.set(name, key);
  return key;
}

export async function forgetDatabaseKey(storageId: string): Promise<void> {
  await deviceStore.remove(`pl.dbkey.${storageId}`);
}
