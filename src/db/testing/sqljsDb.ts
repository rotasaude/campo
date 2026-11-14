// Test support: the same Db over sql.js (SQLite compiled to WebAssembly), in
// memory. It has no cipher — openEncryptedDb is tested with a fake raw
// database; everything else only needs SQL.
import initSqlJs, { type Database } from "sql.js";
import { migrate } from "../migrations";
import type { Db, SqlParam } from "../types";

function adapt(raw: Database): Db {
  let depth = 0;
  const rows = <T>(sql: string, params: SqlParam[]): T[] => {
    const statement = raw.prepare(sql);
    try {
      statement.bind(params);
      const out: T[] = [];
      while (statement.step()) out.push(statement.getAsObject() as T);
      return out;
    } finally {
      statement.free();
    }
  };
  const db: Db = {
    async exec(sql) { raw.exec(sql); },
    async run(sql, params = []) {
      raw.run(sql, params);
      const changes = raw.getRowsModified();
      const lastInsertRowId = Number(raw.exec("SELECT last_insert_rowid()")[0].values[0][0]);
      return { changes, lastInsertRowId };
    },
    async all<T>(sql: string, params: SqlParam[] = []) { return rows<T>(sql, params); },
    async get<T>(sql: string, params: SqlParam[] = []) { return rows<T>(sql, params)[0] ?? null; },
    async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (depth > 0) return fn(db);
      raw.exec("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const result = await fn(db);
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      } finally {
        depth -= 1;
      }
    },
    async close() { raw.close(); },
  };
  return db;
}

// A bare database: the migration tests run `migrate` themselves.
export async function createEmptyTestDb(): Promise<Db> {
  const SQL = await initSqlJs();
  return adapt(new SQL.Database());
}

// In memory and already migrated.
export async function createTestDb(): Promise<Db> {
  const db = await createEmptyTestDb();
  await migrate(db);
  return db;
}
