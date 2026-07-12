import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';

export function makeStorage(): { db: DatabaseSync; storage: SqliteStorage } {
  const db = openDatabase(':memory:');
  return { db, storage: new SqliteStorage(db) };
}
