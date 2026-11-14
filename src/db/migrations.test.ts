import { dbEvents } from "./events";
import { SCHEMA_VERSION, UnknownSchemaError, migrate } from "./migrations";
import { createEmptyTestDb, createTestDb } from "./testing/sqljsDb";

const TABLES = [
  "client_ids", "families", "households", "local_activities", "local_visits", "map_file", "meta", "micro_areas", "outbox",
  "reference", "registrations", "session", "who_to_visit",
];
const INDEXES = [
  "idx_households_address", "idx_households_micro_area", "idx_outbox_state", "idx_registrations_household", "idx_registrations_person",
];

const names = async (db: Awaited<ReturnType<typeof createTestDb>>, type: string) =>
  (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [type]))
    .map((row) => row.name);

test("creates every table and index of the local schema", async () => {
  const db = await createTestDb();
  expect(await names(db, "table")).toEqual(TABLES);
  expect(await names(db, "index")).toEqual(INDEXES);
});

test("migrating twice changes nothing and keeps the data", async () => {
  const db = await createTestDb();
  await db.run("INSERT INTO meta (key, value) VALUES ('mobile_data', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await migrate(db);
  await migrate(db);
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: String(SCHEMA_VERSION) });
  expect(await db.get("SELECT value FROM meta WHERE key = 'mobile_data'")).toEqual({ value: "1" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'clock_skew_ms'")).toEqual({ value: "0" });
});

test("a database from a newer app is refused, untouched", async () => {
  const db = await createTestDb();
  await db.run("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  await expect(migrate(db)).rejects.toBeInstanceOf(UnknownSchemaError);
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "2" });
});

test("the columns the sync depends on exist with their rules", async () => {
  const db = await createTestDb();
  const columns = async (table: string) => (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
  expect(await columns("outbox")).toEqual([
    "seq", "client_uuid", "type", "body", "target_id", "edit_base_version", "edit_base_body", "depends_on", "state", "error", "path",
    "candidates", "confirmable", "conflicts", "sent_version", "attempts", "created_at", "updated_at",
  ]);
  expect(await columns("households")).toEqual([
    "key", "id", "client_uuid", "micro_area_id", "version", "body", "base_version", "base_body", "local_body", "needs_reload",
    "street_norm", "number", "has_location",
  ]);
  expect(await columns("registrations")).toEqual([
    "key", "id", "client_uuid", "household_key", "family_id", "patient_id", "version", "body", "base_version", "base_body", "local_body",
    "needs_reload", "name_norm", "birth_date", "mother_norm",
  ]);
  expect(await columns("map_file")).toEqual(["id", "version", "sha256", "size_bytes", "path", "partial_path", "partial_sha256"]);

  const outbox = (uuid: string) => db.run(
    "INSERT INTO outbox (client_uuid, type, body, state, created_at, updated_at) VALUES (?, 'household', '{}', 'pending', 't', 't')", [uuid]);
  expect((await outbox("a")).lastInsertRowId).toBe(1);
  expect((await outbox("b")).lastInsertRowId).toBe(2);
  await expect(outbox("a")).rejects.toThrow();
  expect(await db.get("SELECT depends_on, attempts FROM outbox WHERE seq = 1")).toEqual({ depends_on: "[]", attempts: 0 });
  await expect(db.run("INSERT INTO session (id, body, fetched_at) VALUES (2, '{}', 't')")).rejects.toThrow();
  await expect(db.run(
    "INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('v', 'd', 'o', '{}', 'sent')")).rejects.toThrow();
});

test("tx rolls back everything when the block throws, and a tx inside a tx joins it", async () => {
  const db = await createEmptyTestDb();
  await db.exec("CREATE TABLE t (n INTEGER)");
  await expect(db.tx(async (tx) => {
    await tx.run("INSERT INTO t (n) VALUES (1)");
    await tx.tx(async (inner) => { await inner.run("INSERT INTO t (n) VALUES (2)"); });
    throw new Error("boom");
  })).rejects.toThrow("boom");
  expect(await db.all("SELECT n FROM t")).toEqual([]);
  expect(await db.tx(async (tx) => { await tx.run("INSERT INTO t (n) VALUES (3)"); return "ok"; })).toBe("ok");
  expect(await db.all("SELECT n FROM t")).toEqual([{ n: 3 }]);
});

test("dbEvents tells only the listeners of the table, until they unsubscribe", () => {
  const households = jest.fn();
  const outbox = jest.fn();
  const stop = dbEvents.on("households", households);
  dbEvents.on("outbox", outbox);
  dbEvents.emit("households");
  expect(households).toHaveBeenCalledTimes(1);
  expect(outbox).not.toHaveBeenCalled();
  stop();
  dbEvents.emit("households");
  expect(households).toHaveBeenCalledTimes(1);
});
