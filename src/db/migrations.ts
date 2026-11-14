// Local schema (SQLCipher). JSON columns hold the contract's bodies as text;
// the columns beside them exist only to find and order rows. Nothing here is
// the source of truth: the territory is a copy of the server, and the outbox
// is what the tablet still owes it.
import type { Db } from "./types";

export const SCHEMA_VERSION = 1;

const FLAG = (column: string) => `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`;

const STATEMENTS = [
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

// Values every installation starts with; the session ones (host, user, city offset) are written at registration.
const META_DEFAULTS: [string, string][] = [
  ["schema_version", String(SCHEMA_VERSION)],
  ["clock_skew_ms", "0"],
  ["mobile_data", "0"],
];

export class UnknownSchemaError extends Error {}

// Idempotent: runs at every open.
export async function migrate(db: Db): Promise<void> {
  await db.tx(async (tx) => {
    for (const statement of STATEMENTS) await tx.exec(statement);
    for (const [key, value] of META_DEFAULTS) await tx.run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", [key, value]);
    const row = await tx.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["schema_version"]);
    // A database written by a newer app: never guess its shape.
    if (row?.value !== String(SCHEMA_VERSION)) throw new UnknownSchemaError(`esquema local ${row?.value ?? "ausente"}: atualize o app`);
  });
}
