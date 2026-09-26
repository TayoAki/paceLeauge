import * as SQLite from 'expo-sqlite';

import { accountStorageId } from './keys';
import { fromExpoDatabase } from './expo-adapter';
import type { SqlDatabase } from './types';

/** Web development preview: unencrypted OPFS database (the web build is not a product target). */
export async function openAccountDatabase(accountId: string): Promise<SqlDatabase> {
  const storageId = await accountStorageId(accountId);
  const db = await SQLite.openDatabaseAsync(`pl_${storageId}.db`);
  await db.execAsync('PRAGMA foreign_keys = ON;');
  return fromExpoDatabase(db);
}

export async function deleteAccountDatabase(accountId: string): Promise<void> {
  const storageId = await accountStorageId(accountId);
  await SQLite.deleteDatabaseAsync(`pl_${storageId}.db`).catch(() => undefined);
}
