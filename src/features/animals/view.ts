// The animals of a household as the screens show them (35b): the row (the download's, or the one made at the creation)
// with the animal items still in the line on top, in the order they were written (as ovitraps/view.ts). The row's
// version is the server's last receipt (putAnimal overwrites it every time, Q20), so what the person typed and has not
// sent lives only in the line and is read from there. An edit sent back as animal_changed (stale_version, never merged)
// is not put on top: the row is the current version, and "Corrigir" opens the form on it.
// Never the number of the microchip: the row has only has_microchip, and so does every view (§16).
import type { AnimalBody } from "../../contract";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import { applyAnimalItem, tutorOf, zoonosesRepo } from "../../db/repos/zoonosesRepo";
import type { Db } from "../../db/types";
import { loadReference } from "../../sync/reference";
import { ANIMAL_CHANGED } from "../../sync/stale";

export interface AnimalView {
  // The local key (the server id, or the creation's client_uuid) and the server id; null while it exists only here.
  key: string; id: string | null;
  species: AnimalBody["species"]; name: string | null; sexLabel: string; status: AnimalBody["status"];
  tutorName: string | null; community: boolean; hasMicrochip: boolean;
  lastVaccinationOn: string | null; collarDueOn: string | null;
  // Something of it is still in the line; and whether it waits for the person (refused) or behind one that does.
  waiting: boolean; held: "needs_attention" | "blocked" | null;
}

export interface EditBase { version: number; body: Record<string, unknown> }

// What the form opens with: the animal with the line on top, and the version and body an edit begun NOW is based on
// (Q41: the form keeps it from the moment it opened). `creating`: born here and not accepted yet — no situation yet.
export interface AnimalEditView { key: string; id: string | null; householdKey: string; body: AnimalBody; base: EditBase | null; creating: boolean }

export const ANIMAL_TABLES = ["animals", "outbox"];

// The record as the screens read it while only the tablet has it.
export const blankAnimal = (id: string, householdId: string): AnimalBody => ({
  id, version: 0, household_id: householdId, species: "dog", name: null, sex: "unknown", size: null, coat: null, breed: null, birth_estimate_on: null,
  status: "active", neutered: false, tutor: null, community: false, last_rabies_vaccination_on: null, collar_due_on: null, has_microchip: false,
});

const mineOf = (queue: OutboxItem[], key: string) => queue.filter((item) => item.type === "animal" && item.target_id === key);
const changedAtStation = (item: OutboxItem) => item.state === "needs_attention" && item.error === ANIMAL_CHANGED;

async function onTop(db: Db, body: AnimalBody, mine: OutboxItem[]): Promise<AnimalBody> {
  let out = body;
  for (const item of mine) if (!changedAtStation(item)) out = applyAnimalItem(out, item.body, await tutorOf(db, item.body, out.tutor));
  return out;
}

const heldOf = (mine: OutboxItem[]): AnimalView["held"] =>
  mine.some((item) => item.state === "needs_attention") ? "needs_attention" : mine.some((item) => item.state === "blocked") ? "blocked" : null;

export async function readAnimals(db: Db, householdKey: string): Promise<AnimalView[]> {
  const rows = await zoonosesRepo.animalsOf(db, householdKey);
  const queue = await outboxRepo.all(db);
  const sexes = (await loadReference(db).catch(() => null))?.zoonosesDomains?.sexes ?? [];
  const views: AnimalView[] = [];
  for (const row of rows) {
    const mine = mineOf(queue, row.key);
    const body = await onTop(db, row.body, mine);
    views.push({
      key: row.key, id: row.id, species: body.species, name: body.name, sexLabel: sexes.find((sex) => sex.code === body.sex)?.label ?? body.sex,
      status: body.status, tutorName: body.tutor?.display_name || null, community: body.community, hasMicrochip: body.has_microchip,
      lastVaccinationOn: body.last_rabies_vaccination_on, collarDueOn: body.collar_due_on, waiting: mine.length > 0, held: heldOf(mine),
    });
  }
  return views;
}

export async function readAnimal(db: Db, key: string): Promise<AnimalEditView | null> {
  const row = await db.get<{ id: string | null; household_key: string; base_version: number | null; body: string }>(
    "SELECT id, household_key, base_version, body FROM animals WHERE key = ?", [key]);
  const mine = mineOf(await outboxRepo.all(db), key);
  if (row) {
    const stored = JSON.parse(row.body) as AnimalBody;
    return {
      key, id: row.id, householdKey: row.household_key, body: await onTop(db, stored, mine),
      base: row.base_version === null ? null : { version: row.base_version, body: stored as unknown as Record<string, unknown> }, creating: row.id === null,
    };
  }
  // The reset erased the row of a server animal that is only edited in the line (it comes back with the next download):
  // the edit is what the tablet has, over the body it was based on.
  const edit = [...mine].reverse().find((item) => typeof item.body.animal_id === "string");
  if (!edit) return null;
  const householdId = typeof edit.body.household_id === "string" ? edit.body.household_id : null;
  const householdKey = householdId === null ? String(edit.body.household_client_uuid ?? "")
    : (await territoryRepo.householdKey(db, householdId)) ?? householdId;
  const based = (edit.edit_base_body as unknown as AnimalBody | null) ?? blankAnimal(String(edit.body.animal_id), householdId ?? householdKey);
  return {
    key, id: String(edit.body.animal_id), householdKey, body: await onTop(db, based, mine),
    base: edit.edit_base_version === null || edit.edit_base_body === null ? null : { version: edit.edit_base_version, body: edit.edit_base_body }, creating: false,
  };
}
