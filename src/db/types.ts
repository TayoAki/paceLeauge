export type SqlValue = string | number | null;

/**
 * The subset of expo-sqlite's async API the journal relies on. Implemented by expo-sqlite on
 * device and web, and by node:sqlite in tests (tests/support/node-sqlite.ts).
 */
export interface SqlDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(source: string, params?: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params?: SqlValue[]): Promise<T[]>;
  closeAsync(): Promise<void>;
}
