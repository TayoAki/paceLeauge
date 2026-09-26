import type { SQLiteDatabase } from 'expo-sqlite';

import type { SqlDatabase, SqlValue } from './types';

export function fromExpoDatabase(db: SQLiteDatabase): SqlDatabase {
  return {
    execAsync: (source) => db.execAsync(source),
    runAsync: async (source, params: SqlValue[] = []) => {
      const result = await db.runAsync(source, params);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    getFirstAsync: <T>(source: string, params: SqlValue[] = []) => db.getFirstAsync<T>(source, params),
    getAllAsync: <T>(source: string, params: SqlValue[] = []) => db.getAllAsync<T>(source, params),
    closeAsync: () => db.closeAsync(),
  };
}
