// Local schema (SQLCipher). JSON columns hold the contract's bodies as text;
// the columns beside them exist only to find and order rows. Nothing here is
// the source of truth: the territory is a copy of the server, and the outbox
// is what the tablet still owes it.
import type { Db } from "./types";

export const SCHEMA_VERSION = 3;

const FLAG = (column: string) => `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`;

// v1 (24c). Kept as it was: a v1 database is made complete by these before it is taken to v2.
const STATEMENTS_V1 = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS micro_areas (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL, team_id TEXT NOT NULL)`,
  // key: the server id, or the client_uuid of a household born on the tablet.
  `CREATE TABLE IF NOT EXISTS households (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, micro_area_id TEXT NOT NULL, version INTEGER,
     body TEXT NOT NULL, base_version INTEGER, base_body TEXT, ${FLAG("needs_reload")},
     street_norm TEXT NOT NULL, number TEXT NOT NULL, ${FLAG("has_location")})`,
  // Index only: the family's body lives in households.body.families. id: the server id or the client_uuid.
  `CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY NOT NULL, household_key TEXT NOT NULL, responsible_patient_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS registrations (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, household_key TEXT, family_id TEXT, patient_id TEXT,
     version INTEGER, body TEXT NOT NULL, base_version INTEGER, base_body TEXT, ${FLAG("needs_reload")},
     name_norm TEXT NOT NULL, birth_date TEXT, mother_norm TEXT)`,
  `CREATE TABLE IF NOT EXISTS who_to_visit (micro_area_id TEXT PRIMARY KEY NOT NULL, people TEXT NOT NULL, generated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reference (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, body TEXT NOT NULL)`,
  // target_id: the key of the row the item edits (the table comes from `type`). edit_base_*: what the
  // person saw when the edit began — the version the item is sent with, whatever the download brought since (Q41).
  `CREATE TABLE IF NOT EXISTS outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, client_uuid TEXT NOT NULL UNIQUE, type TEXT NOT NULL, body TEXT NOT NULL,
     target_id TEXT, edit_base_version INTEGER, edit_base_body TEXT, depends_on TEXT NOT NULL DEFAULT '[]',
     state TEXT NOT NULL, error TEXT, path TEXT, candidates TEXT, confirmable INTEGER, conflicts TEXT, sent_version INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS client_ids (client_uuid TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_visits (
     client_uuid TEXT PRIMARY KEY NOT NULL, city_day TEXT NOT NULL, occurred_at TEXT NOT NULL, summary TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'withdrawn')), server_id TEXT, accepted_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS local_activities (
     client_uuid TEXT PRIMARY KEY NOT NULL, held_on TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL,
     server_id TEXT, accepted_at TEXT)`,
  // The four first columns are null until a first download is proved good: the row may hold only a partial
  // (which file it is of; where it stopped is the size of the file on disk).
  `CREATE TABLE IF NOT EXISTS map_file (
     id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT, sha256 TEXT, size_bytes INTEGER,
     path TEXT, partial_path TEXT, partial_sha256 TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_households_micro_area ON households (micro_area_id)`,
  `CREATE INDEX IF NOT EXISTS idx_households_address ON households (street_norm, number)`,
  `CREATE INDEX IF NOT EXISTS idx_registrations_household ON registrations (household_key)`,
  `CREATE INDEX IF NOT EXISTS idx_registrations_person ON registrations (name_norm, birth_date)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox (state, seq)`,
];

// v2 (35a): the vector control copies of the server. The household's vector profile lives in households.body (§14).
const STATEMENTS_V2 = [
  `CREATE TABLE IF NOT EXISTS city_blocks (
     id TEXT PRIMARY KEY NOT NULL, neighborhood_id TEXT NOT NULL, number TEXT NOT NULL, ${FLAG("active")},
     version INTEGER NOT NULL, body TEXT NOT NULL)`,
  // key: the server id, or the client_uuid of the installation made on the tablet.
  `CREATE TABLE IF NOT EXISTS ovitraps (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, household_key TEXT NOT NULL, number TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'removed', 'lost')), version INTEGER, body TEXT NOT NULL)`,
  // household_id: the server's (a LIRAa item never names a household born on the tablet).
  `CREATE TABLE IF NOT EXISTS liraa_items (
     id TEXT PRIMARY KEY NOT NULL, survey_id TEXT NOT NULL, household_id TEXT NOT NULL, city_block_id TEXT NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS transmission_blocks (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_city_blocks_neighborhood ON city_blocks (neighborhood_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ovitraps_household ON ovitraps (household_key)`,
  `CREATE INDEX IF NOT EXISTS idx_liraa_items_household ON liraa_items (household_id)`,
];

// v3 (35b): the zoonoses copies of the server and what the tablet keeps of its own.
const STATEMENTS_V3 = [
  // key: the server id, or the client_uuid of the animal born on the tablet. body never holds the microchip number (§16).
  `CREATE TABLE IF NOT EXISTS animals (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, household_key TEXT NOT NULL,
     species TEXT NOT NULL CHECK (species IN ('dog', 'cat', 'other')), status TEXT NOT NULL, version INTEGER, base_version INTEGER,
     ${FLAG("needs_reload")}, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS leish_surveys (id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL)`,
  // The collections made on the tablet today: the label comes with the acceptance (Q21).
  `CREATE TABLE IF NOT EXISTS local_leish_collections (
     client_uuid TEXT PRIMARY KEY NOT NULL, animal_key TEXT NOT NULL, city_day TEXT NOT NULL, label TEXT,
     state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')), accepted_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_animals_household ON animals (household_key)`,
  `CREATE INDEX IF NOT EXISTS idx_local_leish_collections_day ON local_leish_collections (city_day)`,
];

// Values every installation starts with; the session ones (host, user, city offset) are written at registration.
const META_DEFAULTS: [string, string][] = [
  ["schema_version", String(SCHEMA_VERSION)],
  ["clock_skew_ms", "0"],
  ["mobile_data", "0"],
];

export class UnknownSchemaError extends Error {}

// Idempotent: runs at every open, in one transaction — an upgrade that fails leaves the database as it was.
// 1 → 3 and 2 → 3 never delete a row: the queue and the territory stay. Only the cursor goes (Q6, Q13(4)): the next
// download is a full one, and brings the new entities. last_download_ok_at and its horizon stay, so the 30 days do not
// start over and the tablet is not taken for a first load waiting for Wi-Fi.
export async function migrate(db: Db): Promise<void> {
  await db.tx(async (tx) => {
    for (const statement of STATEMENTS_V1) await tx.exec(statement);
    for (const [key, value] of META_DEFAULTS) await tx.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", [key, value]);
    const row = await tx.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["schema_version"]);
    const from = row?.value;
    // A database written by a newer app: never guess its shape.
    if (from !== "1" && from !== "2" && from !== String(SCHEMA_VERSION)) throw new UnknownSchemaError(`esquema local ${from ?? "ausente"}: atualize o app`);
    if (from !== "2") for (const statement of STATEMENTS_V2) await tx.exec(statement);
    for (const statement of STATEMENTS_V3) await tx.exec(statement);
    if (from === "3") return;
    await tx.run("DELETE FROM meta WHERE key = ?", ["cursor"]);
    await tx.run("UPDATE meta SET value = ? WHERE key = ?", [String(SCHEMA_VERSION), "schema_version"]);
  });
}
