// The copy of the server's zoonoses records (35b): animals and leishmaniasis surveys. Each receipt overwrites the row,
// whatever its version (Q20): the api re-emits an animal with the same version when its last rabies vaccination or its
// collar due date changes (Q29 of 35a). The animal's end comes by the removal (out_of_scope, Q21); a status other than
// "active" is a defence, never the normal way out. The microchip number is never here, only has_microchip (§16).
import type { AnimalBody, LeishSurveyBody } from "../../contract";
import type { Db } from "../types";
import { territoryRepo } from "./territoryRepo";

export interface AnimalRow {
  key: string;
  id: string | null;
  client_uuid: string | null;
  household_key: string;
  species: AnimalBody["species"];
  status: string;
  version: number | null;
  body: AnimalBody;
}

const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });

// The local key of the server's animal: the row that has its id, or the tablet-born row its creation was given to.
async function animalKey(db: Db, id: string): Promise<string | null> {
  const byId = await db.get<{ key: string }>("SELECT key FROM animals WHERE id = ?", [id]);
  if (byId) return byId.key;
  const born = await db.get<{ key: string }>(
    "SELECT a.key AS key FROM client_ids c JOIN animals a ON a.key = c.client_uuid WHERE c.id = ? AND c.type = ?", [id, "animal"]);
  return born?.key ?? null;
}

type RawAnimal = Omit<AnimalRow, "body"> & { body: string };

export const zoonosesRepo = {
  // Filed under the household's local key, which is not the server id when the household was born on the tablet.
  async putAnimal(db: Db, a: AnimalBody): Promise<void> {
    const key = await animalKey(db, a.id);
    if (a.status !== "active") {
      if (key !== null) await db.run("DELETE FROM animals WHERE key = ?", [key]);
      return;
    }
    const householdKey = (await territoryRepo.householdKey(db, a.household_id)) ?? a.household_id;
    // Only the schema's keys are written: a number the body should never carry stays out whatever the server sends (§16).
    const { microchip: _microchip, registry_number: _registry, ...safe } = a as AnimalBody & { microchip?: unknown; registry_number?: unknown };
    await db.run(
      `INSERT INTO animals (key, id, household_key, species, status, version, base_version, needs_reload, body) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT (key) DO UPDATE SET id = excluded.id, household_key = excluded.household_key, species = excluded.species,
         status = excluded.status, version = excluded.version, base_version = excluded.base_version, needs_reload = 0, body = excluded.body`,
      [key ?? a.id, a.id, householdKey, a.species, a.status, a.version, a.version, JSON.stringify(safe)]);
  },

  async removeAnimal(db: Db, id: string): Promise<void> {
    const key = await animalKey(db, id);
    if (key !== null) await db.run("DELETE FROM animals WHERE key = ?", [key]);
  },

  async putLeishSurvey(db: Db, s: LeishSurveyBody): Promise<void> {
    await db.run(
      `INSERT INTO leish_surveys (id, version, body) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, body = excluded.body`,
      [s.id, s.version, JSON.stringify(s)]);
  },

  async removeLeishSurvey(db: Db, id: string): Promise<void> {
    await db.run("DELETE FROM leish_surveys WHERE id = ?", [id]);
  },

  // By name without case, then by key; an animal without a name (a community one) goes by the empty name.
  async animalsOf(db: Db, householdKey: string): Promise<AnimalRow[]> {
    const rows = await db.all<RawAnimal>(
      "SELECT key, id, client_uuid, household_key, species, status, version, body FROM animals WHERE household_key = ?", [householdKey]);
    return rows.map((r) => ({ ...r, body: JSON.parse(r.body) as AnimalBody }))
      .sort((a, b) => collator.compare(a.body.name ?? "", b.body.name ?? "") || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  },

  // The surveys that list this household (Q21). A household born on the tablet has no server id: only the stray
  // collection is left to it.
  async openSurveysFor(db: Db, householdId: string | null): Promise<LeishSurveyBody[]> {
    if (householdId === null) return [];
    const rows = await db.all<{ body: string }>("SELECT body FROM leish_surveys ORDER BY id");
    return rows.map((r) => JSON.parse(r.body) as LeishSurveyBody).filter((s) => s.household_ids.includes(householdId));
  },
};
