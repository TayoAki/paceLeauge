import type { SqlDatabase, SqlValue } from '@/db/types';

// node:sqlite is loaded lazily so the unit project only needs it where used.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

/** node:sqlite implementation of the journal's database interface (tests only). */
export class NodeSqliteDatabase implements SqlDatabase {
  readonly raw: InstanceType<typeof DatabaseSync>;
  /** When set, any statement matching this pattern throws (disk failure injection). */
  failWhen: RegExp | null = null;
  closed = false;

  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
  }

  private guard(source: string): void {
    if (this.closed) throw new Error('database is closed');
    if (this.failWhen?.test(source)) throw new Error('SQLITE_IOERR: injected disk failure');
  }

  async execAsync(source: string): Promise<void> {
    this.guard(source);
    this.raw.exec(source);
  }

  async runAsync(source: string, params: SqlValue[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    this.guard(source);
    const result = this.raw.prepare(source).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getFirstAsync<T>(source: string, params: SqlValue[] = []): Promise<T | null> {
    this.guard(source);
    const row = this.raw.prepare(source).get(...params);
    return (row ? { ...row } : null) as T | null;
  }

  async getAllAsync<T>(source: string, params: SqlValue[] = []): Promise<T[]> {
    this.guard(source);
    return this.raw.prepare(source).all(...params).map((row) => ({ ...row })) as T[];
  }

  async closeAsync(): Promise<void> {
    if (!this.closed) this.raw.close();
    this.closed = true;
  }
}
