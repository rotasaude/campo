// Registers a family in a household, or edits one, on the tablet. A family
// has no row of its own: it lives in its household, and its item travels with
// the household's version. The responsible of a new family is one of the
// residents of that household — somebody the server already knows, or a
// person registered on this tablet a moment ago, cited by the client_uuid of
// that registration (Q26). Changing the responsible is not done in the app.
import type { HouseholdBody, RegistrationBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { familyEditable } from "../../sync/editable";
import { enqueue, type Dep } from "../../sync/outbox";

type Values = Record<string, unknown>;

export interface FamilyFields { income_band: string | null; members_count: number | null; living_since: string | null; moved_out?: boolean }
export type SaveFamilyInput =
  // `editBase`: the household's version and the family as the form had them when it opened; without it, as the row is now.
  | { householdKey: string; familyId: string; fields: FamilyFields; editBase?: { version: number; body: Values } | null }
  | { householdKey: string; responsibleKey: string; fields: FamilyFields };

export const FAMILY_CONFLICT_PENDING = "Resolva o conflito deste domicílio antes de editar a família";
export const FAMILY_NOT_SENT_YET = "Esta família ainda está sendo enviada. Sincronize e edite depois.";
export class FamilyInConflictError extends Error {
  constructor() { super(FAMILY_CONFLICT_PENDING); }
}

export interface SaveDeps { newUuid(): string; now(): number }

export interface ResponsibleOption { registrationKey: string; name: string; patientId: string | null; bornHere: boolean }

// The residents of the household, by name: who can head a new family there.
export async function responsibleOptions(db: Db, householdKey: string): Promise<ResponsibleOption[]> {
  const rows = await db.all<{ key: string; client_uuid: string | null; patient_id: string | null; body: string }>(
    "SELECT key, client_uuid, patient_id, body FROM registrations WHERE household_key = ? ORDER BY name_norm", [householdKey]);
  return rows.map((row) => ({
    registrationKey: row.key, name: (JSON.parse(row.body) as RegistrationBody).patient.display_name, patientId: row.patient_id, bornHere: row.client_uuid !== null,
  }));
}

export async function saveFamily(db: Db, input: SaveFamilyInput, deps: SaveDeps): Promise<{ clientUuid: string }> {
  const saved = await db.tx(async (tx) => {
    const household = await tx.get<{ id: string | null; client_uuid: string | null; base_version: number | null; body: string }>(
      "SELECT id, client_uuid, base_version, body FROM households WHERE key = ?", [input.householdKey]);
    if (!household) throw new Error("domicílio não encontrado");
    const queue = await outboxRepo.all(tx);
    const here = queue.filter((item) => item.target_id === input.householdKey && (item.type === "household" || item.type === "family"));
    if (here.some((item) => item.state === "conflict")) throw new FamilyInConflictError();
    const where: Values = household.id !== null ? { household_id: household.id } : { household_client_uuid: household.client_uuid };
    const fields: Values = { income_band: input.fields.income_band, members_count: input.fields.members_count, living_since: input.fields.living_since };

    if ("familyId" in input) {
      // A family born here is known by its creation item while that item waits: the edit becomes part of the creation.
      const creation = here.find((item) => item.type === "family" && item.client_uuid === input.familyId);
      if (creation) {
        if (creation.state !== "pending" && creation.state !== "needs_attention") throw new Error(FAMILY_NOT_SENT_YET);
        await outboxRepo.update(tx, creation.seq, { body: { ...creation.body, ...fields }, state: "pending", error: null, path: null, candidates: null, confirmable: null });
        return { clientUuid: creation.client_uuid };
      }
      const body = { ...where, family_id: input.familyId, ...fields, moved_out: input.fields.moved_out === true };
      const waiting = here.find((item) => item.type === "family" && item.body.family_id === input.familyId && (item.state === "pending" || item.state === "needs_attention"));
      if (waiting) {
        await outboxRepo.update(tx, waiting.seq, { body, state: "pending", error: null, path: null, candidates: null, confirmable: null });
        return { clientUuid: waiting.client_uuid };
      }
      const base = familyEditable(JSON.parse(household.body) as HouseholdBody, input.familyId);
      const item = await enqueue(tx, {
        type: "family", targetId: input.householdKey, body,
        editBase: input.editBase ?? (household.base_version !== null && base !== null ? { version: household.base_version, body: base as unknown as Values } : undefined),
      }, deps.newUuid);
      return { clientUuid: item.client_uuid };
    }

    const responsible = await tx.get<{ key: string; client_uuid: string | null; patient_id: string | null; household_key: string | null; family_id: string | null; body: string }>(
      "SELECT key, client_uuid, patient_id, household_key, family_id, body FROM registrations WHERE key = ?", [input.responsibleKey]);
    if (!responsible || responsible.household_key !== input.householdKey) throw new Error("o responsável não mora neste domicílio");
    const depends: Dep[] = [];
    // The household was born here and has not been accepted: the family needs the version its creation will get.
    if (household.id === null && household.client_uuid !== null && queue.some((item) => item.client_uuid === household.client_uuid)) {
      depends.push({ client_uuid: household.client_uuid, kind: "version" });
    }
    let who: Values;
    if (responsible.patient_id !== null) who = { patient_id: responsible.patient_id };
    else {
      who = { patient_client_uuid: responsible.client_uuid };
      if (responsible.client_uuid !== null && queue.some((item) => item.client_uuid === responsible.client_uuid)) depends.push({ client_uuid: responsible.client_uuid, kind: "cite" });
    }
    const item = await enqueue(tx, { type: "family", targetId: input.householdKey, body: { ...where, responsible: who, ...fields }, deps: depends }, deps.newUuid);
    // The api puts the responsible's registration in the family (Q25); the tablet shows it so at once.
    if (responsible.family_id === null) {
      const body = { ...(JSON.parse(responsible.body) as RegistrationBody), family_id: item.client_uuid, is_responsible: true };
      await tx.run("UPDATE registrations SET family_id = ?, body = ? WHERE key = ?", [item.client_uuid, JSON.stringify(body), responsible.key]);
    }
    return { clientUuid: item.client_uuid };
  });
  dbEvents.emit("households");
  dbEvents.emit("registrations");
  dbEvents.emit("outbox");
  return saved;
}
