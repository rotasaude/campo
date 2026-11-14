// The device implementation of Db: expo-sqlite built with SQLCipher, on ONE
// connection — the one that received PRAGMA key. expo-sqlite's own
// withExclusiveTransactionAsync opens a second native connection, which never
// gets the key (it could not read the encrypted file, and would write a new
// one in clear), so the transactions are made here, on the same connection,
// with everything else waiting in line (serial.ts).
import * as SQLite from "expo-sqlite";
import { serialDb } from "./serial";
import type { Db } from "./types";

let opened: Promise<Db> | null = null;

export function openExpoDb(name: string): Promise<Db> {
  opened ??= SQLite.openDatabaseAsync(name).then((conn) => serialDb({
    exec: (sql) => conn.execAsync(sql),
    run: async (sql, params) => {
      const result = await conn.runAsync(sql, params);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    all: <T,>(sql: string, params: (string | number | null)[]) => conn.getAllAsync<T>(sql, params),
    get: <T,>(sql: string, params: (string | number | null)[]) => conn.getFirstAsync<T>(sql, params),
    close: () => conn.closeAsync(),
  }));
  return opened;
}

// After wipeAll closed and deleted the file: the next open must be a new connection.
export function forgetExpoDb(): void {
  opened = null;
}
