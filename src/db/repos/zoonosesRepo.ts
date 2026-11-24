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
type Body = Record<string, unknown>;

// What the tablet tells of the tutor: the patient's id, or (born here, N1/Q29) the key of the registration, with the name
// the local registry has. Never a document.
export type AnimalTutor = AnimalBody["tutor"];

// The animal item's fields over the row's body (D4: the body is whole, absent = empty). Only the download's keys are
// written, one by one: the number of the microchip an item of creation carries never reaches the row (§16), only that
// there is one. The status changes only by an edit that sends it.
export function applyAnimalItem(body: AnimalBody, item: Body, tutor: AnimalTutor): AnimalBody {
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  return {
    ...body,
    species: item.species as AnimalBody["species"], sex: item.sex as AnimalBody["sex"],
    size: (typeof item.size === "string" ? item.size : null) as AnimalBody["size"],
    name: text(item.name), coat: text(item.coat), breed: text(item.breed),
    birth_estimate_on: typeof item.birth_estimate_month === "string" ? `${item.birth_estimate_month}-01` : null,
    community: item.community === true, tutor: item.community === true ? null : tutor,
    status: typeof item.status === "string" ? (item.status as AnimalBody["status"]) : body.status,
    has_microchip: body.has_microchip || (typeof item.microchip === "string" && item.microchip.trim() !== ""),
  };
}

// The tutor an animal item names, as the row shows it. A tutor the local registry no longer has keeps the name the
// row had for the same person.
export async function tutorOf(db: Db, item: Body, before: AnimalTutor): Promise<AnimalTutor> {
  const ref = typeof item.tutor_patient_id === "string" ? item.tutor_patient_id : typeof item.tutor_client_uuid === "string" ? item.tutor_client_uuid : null;
  if (ref === null || item.community === true) return null;
  const name = (await territoryRepo.personName(db, ref)) ?? (before?.patient_id === ref ? before.display_name : null);
  return { patient_id: ref, display_name: name ?? "" };
}

// The row an item of the animal names: by animal_id (the server's, or the tablet-born row its creation was given to),
// or by animal_client_uuid (the row born under it).
async function citedKey(db: Db, item: Body): Promise<string | null> {
  if (typeof item.animal_id === "string") return animalKey(db, item.animal_id);
  if (typeof item.animal_client_uuid !== "string") return null;
  const born = await db.get<{ key: string }>("SELECT key FROM animals WHERE key = ? OR client_uuid = ?", [item.animal_client_uuid, item.animal_client_uuid]);
  return born?.key ?? null;
}

async function setCareDate(db: Db, item: Body, field: "last_rabies_vaccination_on" | "collar_due_on", date: string): Promise<void> {
  const key = await citedKey(db, item);
  if (key === null) return;
  const row = await db.get<{ body: string }>("SELECT body FROM animals WHERE key = ?", [key]);
  if (!row) return;
  const body = JSON.parse(row.body) as AnimalBody;
  const current = body[field];
  if (current !== null && current >= date) return;
  await db.run("UPDATE animals SET body = ? WHERE key = ?", [JSON.stringify({ ...body, [field]: date }), key]);
}

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

  // The animal registered on the tablet: its row under the creation's client_uuid, with no id and no version until the
  // server accepts it. `body` is the download's shape (applyAnimalItem), without the number.
  async putBorn(db: Db, input: { clientUuid: string; householdKey: string; body: AnimalBody }): Promise<void> {
    await db.run(
      `INSERT INTO animals (key, id, client_uuid, household_key, species, status, version, base_version, needs_reload, body)
       VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, 0, ?)`,
      [input.clientUuid, input.clientUuid, input.householdKey, input.body.species, input.body.status, JSON.stringify(input.body)]);
  },

  // The server accepted an animal item (Q20): the row carries what was accepted — id, version (also as the base of the
  // next edit), the fields — until the next download brings the record itself. A row the reset erased stays erased.
  async acceptAnimal(db: Db, key: string, itemBody: Body, result: { id: string | null; version: number }): Promise<void> {
    const row = await db.get<{ id: string | null; body: string }>("SELECT id, body FROM animals WHERE key = ?", [key]);
    if (!row) return;
    const before = JSON.parse(row.body) as AnimalBody;
    const id = result.id ?? row.id;
    const body: AnimalBody = { ...applyAnimalItem(before, itemBody, await tutorOf(db, itemBody, before.tutor)), version: result.version, ...(id === null ? {} : { id }) };
    await db.run("UPDATE animals SET id = ?, species = ?, status = ?, version = ?, base_version = ?, needs_reload = 0, body = ? WHERE key = ?",
      [id, body.species, body.status, result.version, result.version, JSON.stringify(body), key]);
  },

  // An accepted vaccine or collar (Q20): until the download brings the animal, the row shows its date. Only the body
  // changes: these dates move without a new version (Q29 of 35a), so the base of an edit stays. A later date already
  // there stays (an old duplicate answered after a newer download). A row the tablet no longer has stays absent.
  async acceptVaccination(db: Db, itemBody: Body): Promise<void> {
    if (typeof itemBody.vaccinated_on === "string") await setCareDate(db, itemBody, "last_rabies_vaccination_on", itemBody.vaccinated_on);
  },

  // `dueOn`: placed_on + collar_months (collarDueOn), which the answer does not carry.
  async acceptCollar(db: Db, itemBody: Body, dueOn: string): Promise<void> {
    await setCareDate(db, itemBody, "collar_due_on", dueOn);
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
