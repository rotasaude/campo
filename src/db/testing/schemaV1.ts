// Test support: the local schema v1 (campo 8429bd5) as it was shipped, frozen. Only the migration tests read it, to
// build the database a tablet of the 24c has when it is updated. Never change it: a v1 tablet does not change.
const FLAG = (column: string) => `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`;

export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS micro_areas (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL, team_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS households (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, micro_area_id TEXT NOT NULL, version INTEGER,
     body TEXT NOT NULL, base_version INTEGER, base_body TEXT, ${FLAG("needs_reload")},
     street_norm TEXT NOT NULL, number TEXT NOT NULL, ${FLAG("has_location")})`,
  `CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY NOT NULL, household_key TEXT NOT NULL, responsible_patient_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS registrations (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, household_key TEXT, family_id TEXT, patient_id TEXT,
     version INTEGER, body TEXT NOT NULL, base_version INTEGER, base_body TEXT, ${FLAG("needs_reload")},
     name_norm TEXT NOT NULL, birth_date TEXT, mother_norm TEXT)`,
  `CREATE TABLE IF NOT EXISTS who_to_visit (micro_area_id TEXT PRIMARY KEY NOT NULL, people TEXT NOT NULL, generated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reference (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, body TEXT NOT NULL)`,
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
  `CREATE TABLE IF NOT EXISTS map_file (
     id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT, sha256 TEXT, size_bytes INTEGER,
     path TEXT, partial_path TEXT, partial_sha256 TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_households_micro_area ON households (micro_area_id)`,
  `CREATE INDEX IF NOT EXISTS idx_households_address ON households (street_norm, number)`,
  `CREATE INDEX IF NOT EXISTS idx_registrations_household ON registrations (household_key)`,
  `CREATE INDEX IF NOT EXISTS idx_registrations_person ON registrations (name_norm, birth_date)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox (state, seq)`,
];
