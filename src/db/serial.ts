// One connection, one command at a time. The encrypted database has a single
// native connection (the only one that received the key), so a transaction is
// BEGIN IMMEDIATE … COMMIT on it, and everything else waits in line behind it:
// a screen that reads during a long sync transaction gets its answer after the
// COMMIT, never a half-written state. Both implementations of Db (the device's
// and the tests') are built on this, so the tests run with the same order rules.
import type { Db, SqlParam } from "./types";

export interface Conn {
  exec(sql: string): Promise<void>;
  run(sql: string, params: SqlParam[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T>(sql: string, params: SqlParam[]): Promise<T[]>;
  get<T>(sql: string, params: SqlParam[]): Promise<T | null>;
  close(): Promise<void>;
}

export function serialDb(conn: Conn): Db {
  let tail: Promise<unknown> = Promise.resolve();
  // Runs `task` after everything asked before it, whether that worked or not.
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };

  // Inside a transaction the commands go straight to the connection: the transaction holds the line.
  // Use the handle the transaction gives — the outer one would wait behind the transaction itself.
  const inside = (): { db: Db; end(): void } => {
    let open = true;
    const guard = <T>(task: () => Promise<T>): Promise<T> => (open ? task() : Promise.reject(new Error("transação encerrada")));
    const db: Db = {
      exec: (sql) => guard(() => conn.exec(sql)),
      run: (sql, params = []) => guard(() => conn.run(sql, params)),
      all: <T>(sql: string, params: SqlParam[] = []) => guard(() => conn.all<T>(sql, params)),
      get: <T>(sql: string, params: SqlParam[] = []) => guard(() => conn.get<T>(sql, params)),
      tx: (fn) => guard(() => fn(db)),
      close: () => Promise.reject(new Error("fechar dentro de uma transação")),
    };
    return { db, end: () => { open = false; } };
  };

  return {
    exec: (sql) => enqueue(() => conn.exec(sql)),
    run: (sql, params = []) => enqueue(() => conn.run(sql, params)),
    all: <T>(sql: string, params: SqlParam[] = []) => enqueue(() => conn.all<T>(sql, params)),
    get: <T>(sql: string, params: SqlParam[] = []) => enqueue(() => conn.get<T>(sql, params)),
    tx: <T>(fn: (tx: Db) => Promise<T>) => enqueue(async () => {
      const handle = inside();
      await conn.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(handle.db);
        await conn.exec("COMMIT");
        return result;
      } catch (err) {
        await conn.exec("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        handle.end();
      }
    }),
    close: () => enqueue(() => conn.close()),
  };
}
