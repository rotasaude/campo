import { HIGH_WATER_KEY } from "../sync/trustedTime";
import { dbEvents } from "./events";
import { SCHEMA_VERSION, UnknownSchemaError, migrate } from "./migrations";
import { SCHEMA_V1 } from "./testing/schemaV1";
import { createEmptyTestDb, createTestDb } from "./testing/sqljsDb";
import type { Db } from "./types";

const TABLES = [
  "city_blocks", "client_ids", "families", "households", "liraa_items", "local_activities", "local_visits", "map_file", "meta",
  "micro_areas", "outbox", "ovitraps", "reference", "registrations", "session", "transmission_blocks", "who_to_visit",
];
const INDEXES = [
  "idx_city_blocks_neighborhood", "idx_households_address", "idx_households_micro_area", "idx_liraa_items_household",
  "idx_outbox_state", "idx_ovitraps_household", "idx_registrations_household", "idx_registrations_person",
];

const names = async (db: Db, type: string) =>
  (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", [type]))
    .map((row) => row.name);

// A tablet of the 24c, mid-work: what it holds of the territory, and what it still owes the server.
async function seedV1(db: Db): Promise<void> {
  await db.exec(`
    INSERT INTO households (key, id, micro_area_id, version, body, street_norm, number) VALUES ('hh1', 'hh1', 'ma1', 3, '{}', 'flores', '120');
    INSERT INTO registrations (key, id, household_key, version, body, name_norm) VALUES ('rg1', 'rg1', 'hh1', 2, '{}', 'maria');
    INSERT INTO outbox (client_uuid, type, body, state, created_at, updated_at) VALUES ('o1', 'home_visit', '{}', 'pending', 't', 't');
    INSERT INTO outbox (client_uuid, type, body, state, error, created_at, updated_at)
      VALUES ('o2', 'household', '{}', 'needs_attention', 'invalid_request', 't', 't');
    INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('o1', '2026-11-15', 'o', '{}', 'pending');
  `);
}

async function v1Db(): Promise<Db> {
  const db = await createEmptyTestDb();
  await db.tx(async (tx) => { for (const s of SCHEMA_V1) await tx.exec(s); });
  await db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('cursor', 'c1'), ('last_download_ok_at', '2026-11-15T10:00:00Z')");
  return db;
}

test("creates every table and index of the local schema v2", async () => {
  const db = await createTestDb();
  expect(await names(db, "table")).toEqual(TABLES);
  expect(await names(db, "index")).toEqual(INDEXES);
});

test("upgrades a v1 database with data to v2, keeps everything and resets the cursor (Q6)", async () => {
  const db = await createEmptyTestDb();
  await db.tx(async (tx) => { for (const s of SCHEMA_V1) await tx.exec(s); });
  await db.run("INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('cursor', 'c1'), ('last_download_ok_at', '2026-11-15T10:00:00Z')");
  await seedV1(db);
  await migrate(db);
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "2" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'cursor'")).toBeNull();
  expect(await db.get("SELECT value FROM meta WHERE key = 'last_download_ok_at'")).toEqual({ value: "2026-11-15T10:00:00Z" });
  expect(await db.all("SELECT seq, state FROM outbox ORDER BY seq")).toEqual([{ seq: 1, state: "pending" }, { seq: 2, state: "needs_attention" }]);
  expect(await db.get("SELECT count(*) AS n FROM households")).toEqual({ n: 1 });
  expect(await names(db, "table")).toEqual(expect.arrayContaining(["city_blocks", "liraa_items", "ovitraps", "transmission_blocks"]));
});

test("the upgrade keeps every row of the v1 tables and the whole v1 meta but the cursor", async () => {
  const db = await v1Db();
  await seedV1(db);
  await db.run("INSERT INTO meta (key, value) VALUES ('clock_skew_ms', '-5000'), ('mobile_data', '1'), ('session_host', 'h')");
  const before = await names(db, "table");
  const rows = async () => Object.fromEntries(await Promise.all(before.map(async (t) => [t, await db.all(`SELECT * FROM ${t}`)])));
  const kept = await rows();
  await migrate(db);
  expect(await rows()).toEqual({
    ...kept,
    meta: (kept.meta as { key: string; value: string }[])
      .filter((row) => row.key !== "cursor")
      .map((row) => (row.key === "schema_version" ? { key: "schema_version", value: "2" } : row)),
  });
  expect(await names(db, "table")).toEqual(TABLES);
  expect(await names(db, "index")).toEqual(INDEXES);
});

// campo#2: the clock the 30 days are counted on is not territory. Losing it would let a clock set back hide the age.
test("the upgrade keeps the trusted clock (high water and skew)", async () => {
  const db = await v1Db();
  await db.run("INSERT INTO meta (key, value) VALUES (?, '1763200000000'), ('clock_skew_ms', '-5000')", [HIGH_WATER_KEY]);
  await migrate(db);
  expect(await db.get("SELECT value FROM meta WHERE key = ?", [HIGH_WATER_KEY])).toEqual({ value: "1763200000000" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'clock_skew_ms'")).toEqual({ value: "-5000" });
});

test("migrating a v2 database again keeps its cursor", async () => {
  const db = await createTestDb();
  await db.run("INSERT INTO meta (key, value) VALUES ('cursor', 'c2')");
  await migrate(db);
  expect(await db.get("SELECT value FROM meta WHERE key = 'cursor'")).toEqual({ value: "c2" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "2" });
});

test("a fresh install starts at 2", async () => {
  const db = await createEmptyTestDb();
  await migrate(db);
  expect(SCHEMA_VERSION).toBe(2);
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "2" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'cursor'")).toBeNull();
});

test("an upgrade that fails halfway leaves the v1 database as it was", async () => {
  const db = await v1Db();
  await seedV1(db);
  // A table of the v2 already there with another shape: its index cannot be made, and the whole upgrade goes back.
  await db.exec("CREATE TABLE ovitraps (key TEXT PRIMARY KEY NOT NULL)");
  await expect(migrate(db)).rejects.toThrow();
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "1" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'cursor'")).toEqual({ value: "c1" });
  expect(await names(db, "table")).not.toContain("city_blocks");
});

test("the vector tables keep their rules", async () => {
  const db = await createTestDb();
  const columns = async (table: string) => (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
  expect(await columns("city_blocks")).toEqual(["id", "neighborhood_id", "number", "active", "version", "body"]);
  expect(await columns("ovitraps")).toEqual(["key", "id", "client_uuid", "household_key", "number", "status", "version", "body"]);
  expect(await columns("liraa_items")).toEqual(["id", "survey_id", "household_id", "city_block_id", "status", "version", "body"]);
  expect(await columns("transmission_blocks")).toEqual(["id", "status", "version", "body"]);
  const ovitrap = (key: string, status: string, id: string | null = null) => db.run(
    "INSERT INTO ovitraps (key, id, household_key, number, status, body) VALUES (?, ?, 'hh1', 'OVT-1', ?, '{}')", [key, id, status]);
  for (const status of ["active", "removed", "lost"]) await ovitrap(`k-${status}`, status);
  await expect(ovitrap("k-x", "broken")).rejects.toThrow();
  await ovitrap("k-a", "active", "srv1");
  await expect(ovitrap("k-b", "active", "srv1")).rejects.toThrow();
  await expect(db.run("INSERT INTO city_blocks (id, neighborhood_id, number, active, version, body) VALUES ('b', 'n', '1', 2, 1, '{}')"))
    .rejects.toThrow();
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
  await db.run("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  await db.run("INSERT INTO meta (key, value) VALUES ('cursor', 'c3')");
  await expect(migrate(db)).rejects.toBeInstanceOf(UnknownSchemaError);
  expect(await db.get("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "3" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'cursor'")).toEqual({ value: "c3" });
});

test("the columns the sync depends on exist with their rules", async () => {
  const db = await createTestDb();
  const columns = async (table: string) => (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name);
  expect(await columns("outbox")).toEqual([
    "seq", "client_uuid", "type", "body", "target_id", "edit_base_version", "edit_base_body", "depends_on", "state", "error", "path",
    "candidates", "confirmable", "conflicts", "sent_version", "attempts", "created_at", "updated_at",
  ]);
  expect(await columns("households")).toEqual([
    "key", "id", "client_uuid", "micro_area_id", "version", "body", "base_version", "base_body", "needs_reload",
    "street_norm", "number", "has_location",
  ]);
  expect(await columns("registrations")).toEqual([
    "key", "id", "client_uuid", "household_key", "family_id", "patient_id", "version", "body", "base_version", "base_body",
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
