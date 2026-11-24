// Test support: the local schema v2 (campo dbc54b3, the 35a) as it was shipped, frozen. The migration tests read it, with
// the v1 below, to build the database a tablet of the 35a has when it is updated to the 35b. Never change it: a v2 tablet
// does not change.
const FLAG = (column: string) => `${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`;

export { SCHEMA_V1 } from "./schemaV1";

// What v2 adds to v1: apply after SCHEMA_V1.
export const SCHEMA_V2: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS city_blocks (
     id TEXT PRIMARY KEY NOT NULL, neighborhood_id TEXT NOT NULL, number TEXT NOT NULL, ${FLAG("active")},
     version INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ovitraps (
     key TEXT PRIMARY KEY NOT NULL, id TEXT UNIQUE, client_uuid TEXT, household_key TEXT NOT NULL, number TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active', 'removed', 'lost')), version INTEGER, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS liraa_items (
     id TEXT PRIMARY KEY NOT NULL, survey_id TEXT NOT NULL, household_id TEXT NOT NULL, city_block_id TEXT NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS transmission_blocks (id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_city_blocks_neighborhood ON city_blocks (neighborhood_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ovitraps_household ON ovitraps (household_key)`,
  `CREATE INDEX IF NOT EXISTS idx_liraa_items_household ON liraa_items (household_id)`,
];
