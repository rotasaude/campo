import { SECURE_KEYS, type SecureStorePort } from "../security/secureStore";
import { memorySecure } from "../security/testing";
import { DB_NAME, MissingKeyError, UnencryptedDatabaseError, openEncryptedDb } from "./open";
import { createEmptyTestDb } from "./testing/sqljsDb";
import type { Db } from "./types";

// A raw database that records every SQL it is asked to run and answers cipher_version as told.
async function fakeDeps(o: { sqls: string[]; cipher: string | null; secure?: SecureStorePort }) {
  const real = await createEmptyTestDb();
  const closed = { value: false };
  const names: string[] = [];
  const wrap = (inner: Db): Db => ({
    exec: async (sql) => { o.sqls.push(sql); if (!/^PRAGMA key/.test(sql)) await inner.exec(sql); },
    run: async (sql, params) => { o.sqls.push(sql); return inner.run(sql, params); },
    all: async (sql, params) => { o.sqls.push(sql); return inner.all(sql, params); },
    get: async <T>(sql: string, params?: (string | number | null)[]) => {
      o.sqls.push(sql);
      if (/cipher_version/i.test(sql)) return (o.cipher === null ? null : { cipher_version: o.cipher }) as T | null;
      return inner.get<T>(sql, params);
    },
    tx: (fn) => inner.tx((tx) => fn(wrap(tx))),
    close: async () => { closed.value = true; },
  });
  const random = jest.fn((n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256));
  const secure = o.secure ?? memorySecure();
  return { deps: { secure, random, openRaw: async (name: string) => { names.push(name); return wrap(real); } }, secure, random, closed, names };
}

test("creates a 32-byte key once and keys the database before anything else", async () => {
  const sqls: string[] = [];
  const { deps, secure, names } = await fakeDeps({ sqls, cipher: "4.17.0 community" });
  const db = await openEncryptedDb(deps, { create: true });
  expect(names).toEqual([DB_NAME]);
  expect(sqls[0]).toMatch(/^PRAGMA key = "x'[0-9a-f]{64}'"$/);
  expect(sqls[1]).toMatch(/cipher_version/i);
  const key = (await secure.get(SECURE_KEYS.dbKey))!;
  expect(key).toHaveLength(64);
  expect(sqls[0]).toContain(key);
  // Opened and migrated: the schema answers.
  expect(await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "3" });
});

test("refuses an unencrypted build: no row from cipher_version", async () => {
  const sqls: string[] = [];
  const { deps, closed } = await fakeDeps({ sqls, cipher: null });
  await expect(openEncryptedDb(deps, { create: true })).rejects.toBeInstanceOf(UnencryptedDatabaseError);
  expect(sqls.some((s) => /CREATE TABLE|SELECT .* FROM (outbox|households)/i.test(s))).toBe(false);
  expect(sqls).toHaveLength(2);
  expect(closed.value).toBe(true);
});

test("an empty cipher_version is no cipher either", async () => {
  const { deps } = await fakeDeps({ sqls: [], cipher: "" });
  await expect(openEncryptedDb(deps, { create: true })).rejects.toBeInstanceOf(UnencryptedDatabaseError);
});

test("reuses the stored key", async () => {
  const secure = memorySecure();
  const first = await fakeDeps({ sqls: [], cipher: "4.17.0 community", secure });
  await openEncryptedDb(first.deps, { create: true });
  const key = await secure.get(SECURE_KEYS.dbKey);

  const sqls: string[] = [];
  const second = await fakeDeps({ sqls, cipher: "4.17.0 community", secure });
  await openEncryptedDb(second.deps);
  expect(second.random).not.toHaveBeenCalled();
  expect(sqls[0]).toBe(`PRAGMA key = "x'${key}'"`);
  expect(await secure.get(SECURE_KEYS.dbKey)).toBe(key);
});

test("missing key without create → MissingKeyError, and the database is not even opened", async () => {
  const { deps, names, random } = await fakeDeps({ sqls: [], cipher: "4.17.0 community" });
  await expect(openEncryptedDb(deps)).rejects.toBeInstanceOf(MissingKeyError);
  expect(names).toEqual([]);
  expect(random).not.toHaveBeenCalled();
});

test("a stored value that is not a key never reaches the PRAGMA", async () => {
  const sqls: string[] = [];
  const secure = memorySecure({ [SECURE_KEYS.dbKey]: `x'; ATTACH DATABASE 'y' AS z; --` });
  const { deps } = await fakeDeps({ sqls, cipher: "4.17.0 community", secure });
  await expect(openEncryptedDb(deps)).rejects.toBeInstanceOf(MissingKeyError);
  expect(sqls).toEqual([]);
});
