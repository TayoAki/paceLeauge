import { File } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

import { accountStorageId, databaseKey, forgetDatabaseKey } from './keys';
import { fromExpoDatabase } from './expo-adapter';
import type { SqlDatabase } from './types';

function fileName(storageId: string): string {
  return `pl_${storageId}.db`;
}

function journalExists(storageId: string): boolean {
  try {
    return new File(SQLite.defaultDatabaseDirectory, fileName(storageId)).exists;
  } catch {
    return false;
  }
}

/**
 * Opens (or creates) the signed-in account's encrypted journal. SQLCipher is enabled by the
 * expo-sqlite config plugin; the raw 256-bit key lives in the Keychain.
 */
export async function openAccountDatabase(accountId: string): Promise<SqlDatabase> {
  const storageId = await accountStorageId(accountId);
  const key = await databaseKey(storageId, journalExists(storageId));
  const db = await SQLite.openDatabaseAsync(fileName(storageId));
  await db.execAsync(`PRAGMA key = "x'${key}'"`);
  // Fails with "file is not a database" if the key does not match: never continue unencrypted.
  await db.getFirstAsync('select count(*) as n from sqlite_master');
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return fromExpoDatabase(db);
}

/** Removes this account's journal and key from the device (after explicit confirmation). */
export async function deleteAccountDatabase(accountId: string): Promise<void> {
  const storageId = await accountStorageId(accountId);
  await SQLite.deleteDatabaseAsync(fileName(storageId)).catch(() => undefined);
  await forgetDatabaseKey(storageId);
}
