// The animals of a household as the screens show them (35b): the row (the download's, or the one made at the creation)
// with the animal items still in the line on top, in the order they were written (as ovitraps/view.ts). The row's
// version is the server's last receipt (putAnimal overwrites it every time, Q20), so what the person typed and has not
// sent lives only in the line and is read from there. An edit sent back as animal_changed (stale_version, never merged)
// is not put on top: the row is the current version, and "Corrigir" opens the form on it.
// Never the number of the microchip: the row has only has_microchip, and so does every view (§16).
// The vaccine and the collar in the line (Task 7) go on top of the dates: the vaccine puts its vaccinated_on, the collar
// placed_on + collar_months (the api's due_on). They count as something of the animal waiting, and refused, held.
// The blood collections (Task 8) count the same, and each shows its label only once the api gave it (Q21).
import type { AnimalBody } from "../../contract";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import { applyAnimalItem, tutorOf, zoonosesRepo } from "../../db/repos/zoonosesRepo";
import type { Db } from "../../db/types";
import { collarDueOn } from "../../rules/animal";
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
  // The collections made on this tablet (local_leish_collections), in order: the label is null until the acceptance.
  collections: { clientUuid: string; label: string | null }[];
}

export interface EditBase { version: number; body: Record<string, unknown> }

// What the form opens with: the animal with the line on top, and the version and body an edit begun NOW is based on
// (Q41: the form keeps it from the moment it opened). `creating`: born here and not accepted yet — no situation yet.
// `retypeMicrochip`: its creation was refused at the microchip (microchip_taken): the same number would be refused
// forever, so the form asks for it again, empty — the old one is never shown (§16).
export interface AnimalEditView {
  key: string; id: string | null; householdKey: string; body: AnimalBody; base: EditBase | null; creating: boolean; retypeMicrochip: boolean;
}

export const ANIMAL_TABLES = ["animals", "outbox", "local_leish_collections"];

// The record as the screens read it while only the tablet has it.
export const blankAnimal = (id: string, householdId: string): AnimalBody => ({
  id, version: 0, household_id: householdId, species: "dog", name: null, sex: "unknown", size: null, coat: null, breed: null, birth_estimate_on: null,
  status: "active", neutered: false, tutor: null, community: false, last_rabies_vaccination_on: null, collar_due_on: null, has_microchip: false,
});

const mineOf = (queue: OutboxItem[], key: string) => queue.filter((item) => item.type === "animal" && item.target_id === key);
const changedAtStation = (item: OutboxItem) => item.state === "needs_attention" && item.error === ANIMAL_CHANGED;

// The vaccines, collars and collections in the line that name this animal: by its server id or its local key (animal_id), or by the
// client_uuid it was born under (animal_client_uuid).
const careOf = (queue: OutboxItem[], names: { key: string; id: string | null; client_uuid: string | null }) => queue.filter((item) => {
  if (item.type !== "rabies_vaccination" && item.type !== "collar" && item.type !== "leish_collection") return false;
  const { animal_id: id, animal_client_uuid: born } = item.body;
  return (typeof id === "string" && (id === names.id || id === names.key)) || (typeof born === "string" && (born === names.key || born === names.client_uuid));
});

// A refused vaccine or collar stays on top, with the field's date, until it is discarded: the dose was really applied.
// Without the collar months (no zoonoses domains) the collar's date stays the row's until the download.
function withCare(body: AnimalBody, care: OutboxItem[], collarMonths: number | null): AnimalBody {
  let out = body;
  for (const item of care) {
    const { vaccinated_on: vaccinatedOn, placed_on: placedOn } = item.body;
    if (item.type === "rabies_vaccination" && typeof vaccinatedOn === "string") out = { ...out, last_rabies_vaccination_on: vaccinatedOn };
    if (item.type === "collar" && typeof placedOn === "string" && collarMonths !== null) out = { ...out, collar_due_on: collarDueOn(placedOn, collarMonths) };
  }
  return out;
}

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
  const domains = (await loadReference(db).catch(() => null))?.zoonosesDomains ?? null;
  const sexes = domains?.sexes ?? [];
  const views: AnimalView[] = [];
  for (const row of rows) {
    const own = mineOf(queue, row.key);
    const care = careOf(queue, row);
    const mine = [...own, ...care];
    const body = withCare(await onTop(db, row.body, own), care, domains?.parameters.collar_months ?? null);
    const collections = await zoonosesRepo.collectionsOf(db, [row.key, ...(row.id ? [row.id] : []), ...(row.client_uuid ? [row.client_uuid] : [])]);
    views.push({
      key: row.key, id: row.id, species: body.species, name: body.name, sexLabel: sexes.find((sex) => sex.code === body.sex)?.label ?? body.sex,
      status: body.status, tutorName: body.tutor?.display_name || null, community: body.community, hasMicrochip: body.has_microchip,
      lastVaccinationOn: body.last_rabies_vaccination_on, collarDueOn: body.collar_due_on, waiting: mine.length > 0, held: heldOf(mine),
      collections: collections.map((c) => ({ clientUuid: c.client_uuid, label: c.state === "accepted" ? c.label : null })),
    });
  }
  return views;
}

export async function readAnimal(db: Db, key: string): Promise<AnimalEditView | null> {
  const row = await db.get<{ id: string | null; household_key: string; base_version: number | null; body: string }>(
    "SELECT id, household_key, base_version, body FROM animals WHERE key = ?", [key]);
  const queue = await outboxRepo.all(db);
  const mine = mineOf(queue, key);
  const collarMonths = (await loadReference(db).catch(() => null))?.zoonosesDomains?.parameters.collar_months ?? null;
  const care = (id: string | null) => careOf(queue, { key, id, client_uuid: key });
  if (row) {
    const stored = JSON.parse(row.body) as AnimalBody;
    return {
      key, id: row.id, householdKey: row.household_key, body: withCare(await onTop(db, stored, mine), care(row.id), collarMonths),
      base: row.base_version === null ? null : { version: row.base_version, body: stored as unknown as Record<string, unknown> }, creating: row.id === null,
      retypeMicrochip: row.id === null && mine.some((item) => item.client_uuid === key && item.state === "needs_attention" && item.path === "microchip"),
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
    key, id: String(edit.body.animal_id), householdKey, body: withCare(await onTop(db, based, mine), care(String(edit.body.animal_id)), collarMonths),
    base: edit.edit_base_version === null || edit.edit_base_body === null ? null : { version: edit.edit_base_version, body: edit.edit_base_body }, creating: false,
    retypeMicrochip: false,
  };
}

export interface TodayCollection { clientUuid: string; animalName: string | null; label: string | null }

// "Hoje" (Q21): the collections of the city's day, in the order they were made, each with the animal's name as the line
// leaves it and the api's label once accepted. The line survives the screen and the Q42 restart; the purge of the next
// day takes the accepted ones (retention.ts).
export async function todayCollections(db: Db, cityDay: string): Promise<TodayCollection[]> {
  const rows = await db.all<{ client_uuid: string; animal_key: string; label: string | null; state: string }>(
    "SELECT client_uuid, animal_key, label, state FROM local_leish_collections WHERE city_day = ? ORDER BY rowid", [cityDay]);
  const out: TodayCollection[] = [];
  for (const row of rows) {
    out.push({ clientUuid: row.client_uuid, animalName: (await readAnimal(db, row.animal_key))?.body.name ?? null, label: row.state === "accepted" ? row.label : null });
  }
  return out;
}
