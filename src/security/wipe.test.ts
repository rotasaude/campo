import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { HIGH_WATER_KEY } from "../sync/trustedTime";
import { SECURE_KEYS } from "./secureStore";
import { memorySecure } from "./testing";
import { wipeAll, wipeOwed, wipeTerritory } from "./wipe";

const KEPT = ["outbox", "client_ids", "reference", "map_file", "session"];
const WIPED = [
  "micro_areas", "households", "families", "registrations", "who_to_visit", "local_visits", "local_activities",
  "city_blocks", "liraa_items", "ovitraps", "transmission_blocks",
];

async function fill(db: Db): Promise<void> {
  await db.exec(`
    INSERT INTO micro_areas (id, body, team_id) VALUES ('ma1', '{}', 't1');
    INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('hh1', 'ma1', '{}', 'flores', '120');
    INSERT INTO families (id, household_key) VALUES ('fa1', 'hh1');
    INSERT INTO registrations (key, body, name_norm) VALUES ('rg1', '{}', 'maria');
    INSERT INTO who_to_visit (micro_area_id, people, generated_at) VALUES ('ma1', '[]', 't');
    INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('v1', 'd', 'o', '{}', 'pending');
    INSERT INTO local_activities (client_uuid, held_on, summary, state) VALUES ('a1', 'd', '{}', 'pending');
    INSERT INTO outbox (client_uuid, type, body, state, created_at, updated_at) VALUES ('o1', 'household', '{}', 'pending', 't', 't');
    INSERT INTO client_ids (client_uuid, type, id) VALUES ('o0', 'household', 'hh0');
    INSERT INTO reference (id, version, body) VALUES (1, 'v', '{}');
    INSERT INTO map_file (id, version, sha256, size_bytes, path) VALUES (1, '2026-11-01', 'ab', 10, 'map/x.pmtiles');
    INSERT INTO session (id, body, fetched_at) VALUES (1, '{}', 't');
    INSERT INTO city_blocks (id, neighborhood_id, number, active, version, body) VALUES ('cb1', 'nb1', '12', 1, 1, '{}');
    INSERT INTO liraa_items (id, survey_id, household_id, city_block_id, status, version, body) VALUES ('li1', 'sv1', 'hh1', 'cb1', 'pending', 1, '{}');
    INSERT INTO ovitraps (key, id, household_key, number, status, version, body) VALUES ('ov1', 'ov1', 'hh1', 'OVT-1', 'active', 1, '{}');
    INSERT INTO transmission_blocks (id, status, version, body) VALUES ('tb1', 'active', 1, '{}');
    INSERT INTO meta (key, value) VALUES ('cursor', 'abc'), ('last_download_ok_at', 't'), ('session_host', 'curitiba.rotasaude.app');
  `);
}
const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

test("wipeTerritory keeps outbox, reference and map", async () => {
  const db = await createTestDb();
  await fill(db);
  await wipeTerritory(db);
  for (const table of WIPED) expect([table, await count(db, table)]).toEqual([table, 0]);
  for (const table of KEPT) expect([table, await count(db, table)]).toEqual([table, 1]);
  const meta = (await db.all<{ key: string }>("SELECT key FROM meta ORDER BY key")).map((row) => row.key);
  expect(meta).toEqual(["clock_skew_ms", "mobile_data", "schema_version", "session_host"]);
});

// campo#2: the clock the 30 days are counted on is not territory. Losing it would let a clock set back hide the age.
test("wipeTerritory keeps the trusted clock (high water and skew)", async () => {
  const db = await createTestDb();
  await fill(db);
  await db.run("INSERT INTO meta (key, value) VALUES (?, '1763200000000')", [HIGH_WATER_KEY]);
  await db.run("UPDATE meta SET value = '-5000' WHERE key = 'clock_skew_ms'");
  await wipeTerritory(db);
  expect(await db.get("SELECT value FROM meta WHERE key = ?", [HIGH_WATER_KEY])).toEqual({ value: "1763200000000" });
  expect(await db.get("SELECT value FROM meta WHERE key = 'clock_skew_ms'")).toEqual({ value: "-5000" });
});

// An ovitrap installed on this tablet exists nowhere else until its item is accepted; a collection still in the line
// names the installation by its client_uuid. Either way the row stays, as the household the queue edits does.
test("wipeTerritory empties the vector tables but keeps an ovitrap the queue still installs or collects", async () => {
  const db = await createTestDb();
  await fill(db);
  const ovitrap = (key: string, id: string | null, clientUuid: string | null) => db.run(
    "INSERT INTO ovitraps (key, id, client_uuid, household_key, number, status, body) VALUES (?, ?, ?, 'hh1', ?, 'active', '{}')",
    [key, id, clientUuid, key.toUpperCase()]);
  const item = (clientUuid: string, type: string, body: object) => db.run(
    "INSERT INTO outbox (client_uuid, type, body, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', 't', 't')",
    [clientUuid, type, JSON.stringify(body)]);
  await ovitrap("srv", "srv", null); // the server's: comes back with the next download
  await ovitrap("installing", null, "installing"); // its installation is still in the line
  await item("installing", "ovitrap_installation", { household_id: "hh1", number: "INSTALLING", consent: true, installed_on: "2026-11-12" });
  await ovitrap("collecting", "srv2", "collecting"); // installation accepted, a collection still in the line
  await item("co1", "ovitrap_collection", { ovitrap_client_uuid: "collecting", collected_on: "2026-11-17", condition: "ok" });
  await ovitrap("done", "srv3", "done"); // installed here, accepted, nothing left in the line
  await item("co2", "ovitrap_collection", { ovitrap_id: "srv", collected_on: "2026-11-17", condition: "ok" });
  await wipeTerritory(db);
  expect(await db.all("SELECT key FROM ovitraps ORDER BY key")).toEqual([{ key: "collecting" }, { key: "installing" }]);
  for (const table of ["city_blocks", "liraa_items", "transmission_blocks"]) expect([table, await count(db, table)]).toEqual([table, 0]);
});

test("wipeAll deletes the db file, map dir and every secure key", async () => {
  const secure = memorySecure(Object.fromEntries(Object.values(SECURE_KEYS).map((key) => [key, "x"])));
  const deleted: string[] = [];
  const order: string[] = [];
  const fs = {
    documentDirectory: "file:///data/user/0/br.rotasaude.campo/files/",
    deleteAsync: async (uri: string, options: { idempotent: true }) => { expect(options).toEqual({ idempotent: true }); order.push("fs"); deleted.push(uri); },
  };
  await wipeAll({ secure, fs, closeDb: async () => { order.push("close"); } });
  expect(order[0]).toBe("close"); // the file is closed before it is deleted
  expect(deleted).toEqual([
    "file:///data/user/0/br.rotasaude.campo/files/SQLite/campo.db",
    "file:///data/user/0/br.rotasaude.campo/files/SQLite/campo.db-wal",
    "file:///data/user/0/br.rotasaude.campo/files/SQLite/campo.db-shm",
    "file:///data/user/0/br.rotasaude.campo/files/SQLite/campo.db-journal",
    "file:///data/user/0/br.rotasaude.campo/files/map/",
  ]);
  expect(secure.data.size).toBe(0);
});

test("wipeAll goes to the end even when a step fails, and then says so", async () => {
  const secure = memorySecure({ [SECURE_KEYS.token]: "rsf_x", [SECURE_KEYS.dbKey]: "k" });
  const fs = { documentDirectory: "file:///d/", deleteAsync: jest.fn(async () => { throw new Error("EBUSY"); }) };
  await expect(wipeAll({ secure, fs, closeDb: async () => { throw new Error("closed twice"); } })).rejects.toThrow(/passo\(s\) falharam/);
  expect(fs.deleteAsync).toHaveBeenCalledTimes(5);
  // Everything of the installation is gone from the store; what stays is only the debt of the erasure itself.
  for (const key of Object.values(SECURE_KEYS)) expect(await secure.get(key)).toBeNull();
});

// Q82(3b): an erasure that did not finish is never taken for done. It stays owed, where the next start-up finds it
// before anything else — the store, since the database is what is being erased.
test("an erasure that fails stays owed until one goes to the end", async () => {
  const secure = memorySecure({ [SECURE_KEYS.token]: "rsf_x", [SECURE_KEYS.dbKey]: "k" });
  expect(await wipeOwed(secure)).toBe(false);
  const broken = { documentDirectory: "file:///d/", deleteAsync: async () => { throw new Error("EBUSY"); } };
  await expect(wipeAll({ secure, fs: broken, closeDb: async () => undefined })).rejects.toThrow(/passo\(s\) falharam/);
  expect(await wipeOwed(secure)).toBe(true);

  const working = { documentDirectory: "file:///d/", deleteAsync: async () => undefined };
  await wipeAll({ secure, fs: working, closeDb: async () => undefined });
  expect(await wipeOwed(secure)).toBe(false);
  expect(secure.data.size).toBe(0);
});
