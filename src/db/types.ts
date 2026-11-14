// The local database as the app sees it. Two implementations: expoDb.ts
// (SQLCipher through expo-sqlite, on the device) and testing/sqljsDb.ts
// (sql.js in memory, in the tests).
export type SqlParam = string | number | null;

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlParam[]): Promise<T | null>;
  // BEGIN IMMEDIATE … COMMIT; ROLLBACK when `fn` throws. A tx inside a tx joins the outer one.
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
