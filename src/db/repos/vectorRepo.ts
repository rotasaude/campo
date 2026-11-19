// The copy of the server's vector control entities (35a): city blocks, ovitraps, LIRAa items and transmission blocks.
// Each receipt overwrites the row, whatever its version (Q29): the api re-emits with the same version when another row
// changed or when the entity enters the scope. The end comes by the status, never by a removal: an ovitrap that is not
// active, a LIRAa item that is not pending and a closed blockade leave the tablet. A city block stays when inactive (it
// is still a neighbour and history). Nothing here holds a person: a blockade never carries a case (§17).
import type { CityBlockBody, LiraaItemBody, OvitrapBody, TransmissionBlockBody } from "../../contract";
import type { Db } from "../types";
import { territoryRepo } from "./territoryRepo";

export interface OvitrapRow {
  key: string;
  id: string | null;
  client_uuid: string | null;
  household_key: string;
  number: string;
  status: OvitrapBody["status"];
  version: number | null;
  body: OvitrapBody;
}

const natural = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

// The local key of the server's ovitrap: the row that has its id, or the tablet-born row its installation was given to.
async function ovitrapKey(db: Db, id: string): Promise<string | null> {
  const byId = await db.get<{ key: string }>("SELECT key FROM ovitraps WHERE id = ?", [id]);
  if (byId) return byId.key;
  const born = await db.get<{ key: string }>(
    "SELECT o.key AS key FROM client_ids c JOIN ovitraps o ON o.key = c.client_uuid WHERE c.id = ? AND c.type = ?", [id, "ovitrap_installation"]);
  return born?.key ?? null;
}

type RawOvitrap = Omit<OvitrapRow, "body"> & { body: string };
const toOvitrap = (row: RawOvitrap): OvitrapRow => ({ ...row, body: JSON.parse(row.body) as OvitrapBody });

export const vectorRepo = {
  async putCityBlock(db: Db, b: CityBlockBody): Promise<void> {
    await db.run(
      `INSERT INTO city_blocks (id, neighborhood_id, number, active, version, body) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET neighborhood_id = excluded.neighborhood_id, number = excluded.number, active = excluded.active,
         version = excluded.version, body = excluded.body`,
      [b.id, b.neighborhood_id, b.number, b.active ? 1 : 0, b.version, JSON.stringify(b)]);
  },

  // Filed under the household's local key, which is not the server id when the household was born on the tablet.
  async putOvitrap(db: Db, o: OvitrapBody): Promise<void> {
    const key = await ovitrapKey(db, o.id);
    if (o.status !== "active") {
      if (key !== null) await db.run("DELETE FROM ovitraps WHERE key = ?", [key]);
      return;
    }
    const householdKey = (await territoryRepo.householdKey(db, o.household_id)) ?? o.household_id;
    await db.run(
      `INSERT INTO ovitraps (key, id, household_key, number, status, version, body) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET id = excluded.id, household_key = excluded.household_key, number = excluded.number,
         status = excluded.status, version = excluded.version, body = excluded.body`,
      [key ?? o.id, o.id, householdKey, o.number, o.status, o.version, JSON.stringify(o)]);
  },

  // inspected, substituted and closed (the survey ended) all leave the sheet.
  async putLiraaItem(db: Db, i: LiraaItemBody): Promise<void> {
    if (i.status !== "pending") {
      await db.run("DELETE FROM liraa_items WHERE id = ?", [i.id]);
      return;
    }
    await db.run(
      `INSERT INTO liraa_items (id, survey_id, household_id, city_block_id, status, version, body) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET survey_id = excluded.survey_id, household_id = excluded.household_id,
         city_block_id = excluded.city_block_id, status = excluded.status, version = excluded.version, body = excluded.body`,
      [i.id, i.survey_id, i.household_id, i.city_block_id, i.status, i.version, JSON.stringify(i)]);
  },

  // Only the schema's keys are written: whatever else a body might bring stays out (§17).
  async putTransmissionBlock(db: Db, t: TransmissionBlockBody): Promise<void> {
    if (t.status === "closed") {
      await db.run("DELETE FROM transmission_blocks WHERE id = ?", [t.id]);
      return;
    }
    const body: TransmissionBlockBody = { id: t.id, status: t.status, block_ids: t.block_ids, cycles: t.cycles, version: t.version };
    await db.run(
      `INSERT INTO transmission_blocks (id, status, version, body) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, version = excluded.version, body = excluded.body`,
      [t.id, t.status, t.version, JSON.stringify(body)]);
  },

  // The active blocks of a neighbourhood, by number in natural order ("2" before "12", "12" before "12A").
  async blocksOf(db: Db, neighborhoodId: string): Promise<CityBlockBody[]> {
    const rows = await db.all<{ body: string }>("SELECT body FROM city_blocks WHERE neighborhood_id = ? AND active = 1", [neighborhoodId]);
    return rows.map((r) => JSON.parse(r.body) as CityBlockBody).sort((a, b) => natural.compare(a.number, b.number) || a.id.localeCompare(b.id));
  },

  // householdId: the server's (a LIRAa item never names a household born on the tablet).
  // Two pending items (two surveys drawn the same household): the api picks the oldest by `created_at, id`
  // (apps/api due.rb); the feed has neither created_at nor drawn_at, so the app picks the lowest id. The divergence is
  // accepted (Q43): the inspection carries `liraa_draw_item_id`, so nothing is lost.
  async pendingLiraaItem(db: Db, householdId: string): Promise<LiraaItemBody | null> {
    const row = await db.get<{ body: string }>("SELECT body FROM liraa_items WHERE household_id = ? AND status = 'pending' ORDER BY id LIMIT 1", [householdId]);
    return row ? (JSON.parse(row.body) as LiraaItemBody) : null;
  },

  async activeBlockFor(db: Db, cityBlockId: string): Promise<TransmissionBlockBody | null> {
    const rows = await db.all<{ body: string }>("SELECT body FROM transmission_blocks WHERE status = 'active' ORDER BY id");
    return rows.map((r) => JSON.parse(r.body) as TransmissionBlockBody).find((t) => t.block_ids.includes(cityBlockId)) ?? null;
  },

  // Every ovitrap the tablet has, or the household's (by its local key), by number in natural order.
  async ovitrapsOf(db: Db, householdKey?: string): Promise<OvitrapRow[]> {
    const rows = householdKey === undefined
      ? await db.all<RawOvitrap>("SELECT key, id, client_uuid, household_key, number, status, version, body FROM ovitraps")
      : await db.all<RawOvitrap>("SELECT key, id, client_uuid, household_key, number, status, version, body FROM ovitraps WHERE household_key = ?", [householdKey]);
    return rows.map(toOvitrap).sort((a, b) => natural.compare(a.number, b.number) || a.key.localeCompare(b.key));
  },
};
