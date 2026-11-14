// The device adapter over a fake expo-sqlite. What matters here: ONE native connection for everything.
// expo-sqlite's withExclusiveTransactionAsync opens a second connection, which never receives PRAGMA key —
// on an encrypted file it cannot read, and on an empty one it would write in clear.
import { forgetExpoDb, openExpoDb } from "./expoDb";

const mockOpened: string[] = [];
const mockCommands: string[] = [];
const mockExclusive = jest.fn();

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(async (name: string) => {
    mockOpened.push(name);
    return {
      execAsync: async (sql: string) => { mockCommands.push(sql); },
      runAsync: async (sql: string) => { mockCommands.push(sql); return { changes: 1, lastInsertRowId: 9 }; },
      getAllAsync: async (sql: string) => { mockCommands.push(sql); return [{ n: 1 }]; },
      getFirstAsync: async (sql: string) => { mockCommands.push(sql); return { cipher_version: "4.17.0 community" }; },
      withExclusiveTransactionAsync: mockExclusive,
      withTransactionAsync: mockExclusive,
      closeAsync: async () => { mockCommands.push("CLOSE"); },
    };
  }),
}));


beforeEach(() => { mockOpened.length = 0; mockCommands.length = 0; mockExclusive.mockClear(); forgetExpoDb(); });

test("the key, the transaction and the reads all go through the one connection", async () => {
  const db = await openExpoDb("campo.db");
  await db.exec(`PRAGMA key = "x'00'"`);
  expect(await db.get("PRAGMA cipher_version")).toEqual({ cipher_version: "4.17.0 community" });
  const result = await db.tx(async (tx) => {
    const run = await tx.run("INSERT INTO meta (key, value) VALUES (?, ?)", ["a", "b"]);
    await tx.all("SELECT 1 AS n");
    return run.lastInsertRowId;
  });
  expect(result).toBe(9);
  expect(mockOpened).toEqual(["campo.db"]);
  expect(mockExclusive).not.toHaveBeenCalled();
  expect(mockCommands).toEqual([`PRAGMA key = "x'00'"`, "PRAGMA cipher_version", "BEGIN IMMEDIATE", "INSERT INTO meta (key, value) VALUES (?, ?)", "SELECT 1 AS n", "COMMIT"]);
});

test("opening twice gives the same connection; after forget, a new one", async () => {
  const first = await openExpoDb("campo.db");
  expect(await openExpoDb("campo.db")).toBe(first);
  forgetExpoDb();
  expect(await openExpoDb("campo.db")).not.toBe(first);
  expect(mockOpened).toEqual(["campo.db", "campo.db"]);
});
