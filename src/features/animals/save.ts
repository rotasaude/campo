// Registers or edits an animal of a household on the tablet (35b; contract §11, Q20, Q22, Q29): the outbox gets the item
// and the row is there for the screens at once. One transaction each.
// - Creation: the whole body, without animal_id and without status. What it names that was born here and is still in
//   the line is cited by client_uuid, and the item waits for it: the household (household_client_uuid) and the tutor
//   registered on this tablet (tutor_client_uuid with the registration's client_uuid, N1 resolved by the Q29 — the same
//   rule as the visit's patient_client_uuid). The number of the microchip goes in this body and nowhere else (§16): the
//   row keeps only has_microchip.
// - Edit: the versioned path of the 24c (Q20) — the whole body with animal_id, never the microchip; the base is what the
//   form opened with (Q41). A change of situation goes as status with status_on, the city's day (Q37), never back to
//   "active"; a situation that stays is not sent (the schema ties status to status_on). A creation still waiting in
//   the line takes the edit in its own body (coalesce) and stays a creation.
// - Vaccine and collar (Task 7): an item of their own, never an edit of the animal. The animal goes by animal_id, or by
//   animal_client_uuid with a `cite` while its creation is in the line (Review Focus 2). They change nothing on the row:
//   its dates show the line on top (view.ts), and an acceptance writes them without a new version (Q29 of 35a).
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { applyAnimalItem, tutorOf, zoonosesRepo } from "../../db/repos/zoonosesRepo";
import type { Db } from "../../db/types";
import type { AnimalDraft } from "../../rules/animal";
import type { AnimalStatus } from "../../rules/zoonosesDomains";
import { coalesceOrEnqueue, enqueue, type Dep, type OutboxItem } from "../../sync/outbox";
import { loadReference } from "../../sync/reference";
import { blankAnimal, readAnimal, type EditBase } from "./view";

type Body = Record<string, unknown>;
export type HouseholdRef = { household_id: string } | { household_client_uuid: string };
export type TutorRef = { tutor_patient_id: string } | { tutor_client_uuid: string };

export interface AnimalBodyContext {
  household: HouseholdRef;
  tutor: TutorRef | null;
  // null: a creation. An edit names the animal (null while its creation is still on its way: filled when it is sent);
  // `status`: the change of situation and its day (Q37), or null when the situation stays.
  edit: { animalId: string | null; status: { code: AnimalStatus; on: string } | null } | null;
}

// The item's body from the form (Q20, Q22): blank is absent; no tutor with "community"; the birth as "AAAA-MM";
// the microchip on creation only; never `neutered` (§7).
export function toAnimalBody(d: AnimalDraft, ctx: AnimalBodyContext): Body {
  const t = (value: string) => value.trim();
  const { edit } = ctx;
  return {
    ...(edit?.animalId ? { animal_id: edit.animalId } : {}),
    ...ctx.household,
    species: d.species, sex: d.sex,
    ...(d.size ? { size: d.size } : {}),
    ...(t(d.name) ? { name: t(d.name) } : {}),
    ...(t(d.coat) ? { coat: t(d.coat) } : {}),
    ...(t(d.breed) ? { breed: t(d.breed) } : {}),
    ...(t(d.birthEstimateMonth) ? { birth_estimate_month: t(d.birthEstimateMonth) } : {}),
    ...(!d.community && ctx.tutor !== null ? ctx.tutor : {}),
    community: d.community,
    ...(edit === null && t(d.microchip) !== "" ? { microchip: t(d.microchip) } : {}),
    // The schema ties them: status never travels without status_on, and neither on a creation.
    ...(edit?.status ? { status: edit.status.code, status_on: edit.status.on } : {}),
  };
}

export const NEVER_BACK_TO_ACTIVE = "o animal não volta a ativo";

export interface SaveAnimalInput {
  householdKey: string;
  draft: AnimalDraft;
  // The animal's local key: an edit. Absent: a creation.
  animalKey?: string;
  // Edit only: the situation chosen (absent = the one it has) and the city's day, the day of a change of situation.
  status?: AnimalStatus;
  today?: string;
  // Edit only: the version and body the form opened with (readAnimal().base). Without it the row's as it is now.
  editBase?: EditBase | null;
  newUuid(): string;
}

export async function saveAnimal(db: Db, input: SaveAnimalInput): Promise<string> {
  const key = await db.tx(async (tx) => {
    const queue = await outboxRepo.all(tx);
    const queued = (uuid: string | null) => uuid !== null && queue.some((item) => item.client_uuid === uuid);
    const deps: Dep[] = [];

    const household = await tx.get<{ id: string | null; client_uuid: string | null }>("SELECT id, client_uuid FROM households WHERE key = ?", [input.householdKey]);
    if (!household) throw new Error("domicílio não encontrado");
    let householdRef: HouseholdRef;
    if (household.id !== null) householdRef = { household_id: household.id };
    else {
      householdRef = { household_client_uuid: household.client_uuid as string };
      if (queued(household.client_uuid)) deps.push({ client_uuid: household.client_uuid as string, kind: "cite" });
    }

    // The tutor by the patient's id, or (registered here and not yet known to the server) by the registration's client_uuid.
    let tutor: TutorRef | null = null;
    const tutorKey = input.draft.community ? null : input.draft.tutorKey;
    if (tutorKey !== null) {
      const registration = await tx.get<{ client_uuid: string | null; patient_id: string | null }>(
        "SELECT client_uuid, patient_id FROM registrations WHERE key = ? OR patient_id = ? LIMIT 1", [tutorKey, tutorKey]);
      if (registration && registration.patient_id === null && registration.client_uuid !== null) {
        tutor = { tutor_client_uuid: registration.client_uuid };
        if (queued(registration.client_uuid)) deps.push({ client_uuid: registration.client_uuid, kind: "cite" });
      } else tutor = { tutor_patient_id: registration?.patient_id ?? tutorKey };
    }

    if (input.animalKey === undefined) {
      const clientUuid = input.newUuid().toLowerCase();
      const body = toAnimalBody(input.draft, { household: householdRef, tutor, edit: null });
      const row = applyAnimalItem(blankAnimal(clientUuid, household.id ?? input.householdKey), body, await tutorOf(tx, body, null));
      await zoonosesRepo.putBorn(tx, { clientUuid, householdKey: input.householdKey, body: row });
      await enqueue(tx, { type: "animal", body, targetId: clientUuid, clientUuid, deps }, () => clientUuid);
      return clientUuid;
    }

    const view = await readAnimal(tx, input.animalKey);
    if (!view) throw new Error("animal não encontrado");
    const status = input.status ?? view.body.status;
    if (status === "active" && view.body.status !== "active") throw new Error(NEVER_BACK_TO_ACTIVE);
    const creation = view.id === null
      ? queue.find((item) => item.type === "animal" && item.client_uuid === input.animalKey && item.target_id === input.animalKey) : undefined;
    let body: Body;
    if (creation && (creation.state === "pending" || creation.state === "needs_attention")) {
      // Not sent yet: the creation takes the edit (coalesce) and keeps the number typed when it was made.
      body = toAnimalBody(input.draft, { household: householdRef, tutor, edit: null });
      delete body.microchip;
      if (typeof creation.body.microchip === "string") body.microchip = creation.body.microchip;
    } else {
      // Changed against what the edit is based on (an earlier edit in the line counts: it is the same item).
      const changed = status !== ((view.base?.body.status as AnimalStatus | undefined) ?? "active");
      if (changed && input.today === undefined) throw new Error("informe o dia da mudança de situação");
      body = toAnimalBody({ ...input.draft, microchip: "" }, {
        household: householdRef, tutor, edit: { animalId: view.id, status: changed ? { code: status, on: input.today as string } : null },
      });
      // On its way: the edit needs the version its acceptance will give.
      if (creation) deps.push({ client_uuid: creation.client_uuid, kind: "version" });
    }
    const item = await coalesceOrEnqueue(tx, { type: "animal", targetId: input.animalKey, body, deps, editBase: input.editBase ?? view.base ?? undefined }, input.newUuid);
    // A body rewritten whole cites what it names now (a tutor chosen in the edit); the version it waits for stays.
    const cites = deps.filter((dep) => dep.kind === "cite");
    const kept = item.depends_on.filter((dep) => dep.kind === "version" && !cites.some((cite) => cite.client_uuid === dep.client_uuid));
    const now = [...kept, ...cites];
    if (JSON.stringify(now) !== JSON.stringify(item.depends_on)) await outboxRepo.update(tx, item.seq, { depends_on: now });
    return input.animalKey;
  });
  dbEvents.emit("animals");
  dbEvents.emit("outbox");
  return key;
}

export type AnimalRef = { animal_id: string } | { animal_client_uuid: string };

// How an item names the animal of `animalKey` (the local key: the server id, or the creation's client_uuid).
// - The row has the server's id: by it.
// - Born here and its creation still in the line: by its client_uuid, waiting for it (cite: it may go in the same batch).
// - Born here and accepted: by the id client_ids has; without one, by its client_uuid, which the server resolves by its
//   ledger, with nothing to wait for.
// - No row (removed by the download, erased by the reset) and nothing born under that key: the server's id is the key.
async function animalRefOf(tx: Db, animalKey: string, queue: OutboxItem[]): Promise<{ ref: AnimalRef; deps: Dep[] }> {
  const row = await tx.get<{ id: string | null; client_uuid: string | null }>("SELECT id, client_uuid FROM animals WHERE key = ?", [animalKey]);
  if (row?.id) return { ref: { animal_id: row.id }, deps: [] };
  const born = row?.client_uuid ?? animalKey;
  if (queue.some((item) => item.type === "animal" && item.client_uuid === born && item.target_id === born)) {
    return { ref: { animal_client_uuid: born }, deps: [{ client_uuid: born, kind: "cite" }] };
  }
  const mapped = await tx.get<{ id: string }>("SELECT id FROM client_ids WHERE client_uuid = ? AND type = 'animal'", [born]);
  if (mapped) return { ref: { animal_id: mapped.id }, deps: [] };
  return { ref: row ? { animal_client_uuid: born } : { animal_id: animalKey }, deps: [] };
}

export interface VaccinateInput {
  animalKey: string; productId: string; adverseEvent: boolean; adverseNote: string | null;
  // The city's day (cityTodayOf).
  today: string;
  newUuid(): string;
}

// "Vacinar" (§3, §11): the dose of the reference's open campaign, at home — the item carries no modality, the api sets
// house. adverse_note only with adverse_event (Q20). The second dose in the campaign is the api's call (Q19).
export async function vaccinate(db: Db, input: VaccinateInput): Promise<string> {
  const uuid = await db.tx(async (tx) => {
    const campaign = (await loadReference(tx).catch(() => null))?.zoonosesDomains?.open_campaign ?? null;
    if (campaign === null) throw new Error("sem campanha aberta");
    const { ref, deps } = await animalRefOf(tx, input.animalKey, await outboxRepo.all(tx));
    const note = input.adverseNote?.trim() ?? "";
    const body = {
      ...ref, campaign_id: campaign.id, vaccinated_on: input.today, vector_product_id: input.productId, adverse_event: input.adverseEvent,
      ...(input.adverseEvent && note !== "" ? { adverse_note: note } : {}),
    };
    return (await enqueue(tx, { type: "rabies_vaccination", body, deps }, input.newUuid)).client_uuid;
  });
  dbEvents.emit("outbox");
  return uuid;
}

export interface PlaceCollarInput { animalKey: string; productId: string; today: string; newUuid(): string }

// "Colocar coleira" (§11): the due date is the api's (placed_on + collar_months), never in the body.
export async function placeCollar(db: Db, input: PlaceCollarInput): Promise<string> {
  const uuid = await db.tx(async (tx) => {
    const { ref, deps } = await animalRefOf(tx, input.animalKey, await outboxRepo.all(tx));
    const body = { ...ref, vector_product_id: input.productId, placed_on: input.today };
    return (await enqueue(tx, { type: "collar", body, deps }, input.newUuid)).client_uuid;
  });
  dbEvents.emit("outbox");
  return uuid;
}
