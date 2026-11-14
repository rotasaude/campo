import { serialDb, type Conn } from "./serial";

// A connection that takes its time and writes down, in order, every command that reaches it.
function fakeConn() {
  const log: string[] = [];
  let inFlight = 0;
  let overlapped = false;
  const step = async (sql: string, ms = 1): Promise<void> => {
    if (inFlight > 0) overlapped = true;
    inFlight += 1;
    log.push(sql);
    await new Promise((resolve) => setTimeout(resolve, ms));
    inFlight -= 1;
    if (/FAIL/.test(sql)) throw new Error(`refused: ${sql}`);
  };
  const conn: Conn = {
    exec: (sql) => step(sql, /SLOW/.test(sql) ? 15 : 1),
    run: async (sql) => { await step(sql); return { changes: 1, lastInsertRowId: 1 }; },
    all: async <T,>(sql: string) => { await step(sql); return [] as T[]; },
    get: async <T,>(sql: string) => { await step(sql); return null as T | null; },
    close: () => step("CLOSE"),
  };
  return { conn, log, overlapped: () => overlapped };
}

test("commands reach the connection one at a time, in the order they were asked", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  await Promise.all([db.exec("SLOW 1"), db.run("INSERT 2"), db.all("SELECT 3"), db.get("SELECT 4")]);
  expect(f.log).toEqual(["SLOW 1", "INSERT 2", "SELECT 3", "SELECT 4"]);
  expect(f.overlapped()).toBe(false);
});

test("a transaction is BEGIN IMMEDIATE … COMMIT on the same connection", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  const result = await db.tx(async (tx) => { await tx.run("INSERT a"); await tx.get("SELECT b"); return 7; });
  expect(result).toBe(7);
  expect(f.log).toEqual(["BEGIN IMMEDIATE", "INSERT a", "SELECT b", "COMMIT"]);
});

test("nothing from outside lands in the middle of a transaction", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  const tx = db.tx(async (inner) => { await inner.exec("SLOW a"); await inner.run("INSERT b"); });
  const outside = db.all("SELECT from a screen");
  const second = db.tx(async (inner) => { await inner.run("INSERT c"); });
  await Promise.all([tx, outside, second]);
  expect(f.log).toEqual(["BEGIN IMMEDIATE", "SLOW a", "INSERT b", "COMMIT", "SELECT from a screen", "BEGIN IMMEDIATE", "INSERT c", "COMMIT"]);
  expect(f.overlapped()).toBe(false);
});

test("a transaction that throws is rolled back, the error comes out and the queue goes on", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  await expect(db.tx(async (tx) => { await tx.run("INSERT a"); throw new Error("boom"); })).rejects.toThrow("boom");
  await db.run("INSERT after");
  expect(f.log).toEqual(["BEGIN IMMEDIATE", "INSERT a", "ROLLBACK", "INSERT after"]);
});

test("a command that fails outside a transaction does not stop the ones behind it", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  const failed = db.exec("FAIL");
  const next = db.run("INSERT next");
  await expect(failed).rejects.toThrow("refused: FAIL");
  await next;
  expect(f.log).toEqual(["FAIL", "INSERT next"]);
});

test("a transaction inside a transaction joins the outer one", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  await db.tx(async (outer) => { await outer.tx(async (inner) => { await inner.run("INSERT a"); }); await outer.run("INSERT b"); });
  expect(f.log).toEqual(["BEGIN IMMEDIATE", "INSERT a", "INSERT b", "COMMIT"]);
});

test("the handle of a transaction that ended refuses to be used", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  let kept: Parameters<Parameters<typeof db.tx>[0]>[0] | null = null;
  await db.tx(async (tx) => { kept = tx; });
  await expect(kept!.run("INSERT late")).rejects.toThrow("transação encerrada");
  expect(f.log).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
});

test("close waits for what is queued", async () => {
  const f = fakeConn();
  const db = serialDb(f.conn);
  const work = db.tx(async (tx) => { await tx.exec("SLOW a"); });
  const closed = db.close();
  await Promise.all([work, closed]);
  expect(f.log).toEqual(["BEGIN IMMEDIATE", "SLOW a", "COMMIT", "CLOSE"]);
});
