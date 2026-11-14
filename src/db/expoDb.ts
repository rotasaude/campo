// The device implementation of Db: expo-sqlite built with SQLCipher. One
// connection per process — a second one would not carry the key.
import * as SQLite from "expo-sqlite";
import type { Db, SqlParam } from "./types";

type Conn = Pick<SQLite.SQLiteDatabase, "execAsync" | "runAsync" | "getAllAsync" | "getFirstAsync">;

function adapt(conn: Conn, root: SQLite.SQLiteDatabase, inTx: boolean): Db {
  const db: Db = {
    exec: (sql) => conn.execAsync(sql),
    run: async (sql, params = []) => {
      const result = await conn.runAsync(sql, params);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    all: <T>(sql: string, params: SqlParam[] = []) => conn.getAllAsync<T>(sql, params),
    get: <T>(sql: string, params: SqlParam[] = []) => conn.getFirstAsync<T>(sql, params),
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (inTx) return fn(db);
      let result!: T;
      // Exclusive: nothing else of the app interleaves with the transaction; it rolls back when the task throws.
      await root.withExclusiveTransactionAsync(async (txn) => { result = await fn(adapt(txn, root, true)); });
      return result;
    },
    close: () => root.closeAsync(),
  };
  return db;
}

let opened: Promise<Db> | null = null;

export function openExpoDb(name: string): Promise<Db> {
  opened ??= SQLite.openDatabaseAsync(name).then((conn) => adapt(conn, conn, false));
  return opened;
}

// After wipeAll closed and deleted the file: the next open must be a new connection.
export function forgetExpoDb(): void {
  opened = null;
}
