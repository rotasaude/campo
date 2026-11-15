// Registers a person in a household, or edits a registration, on the tablet.
// A new person is ONE item: the registration carries the person typed
// (new_patient). Its client_uuid is what a family or a visit made right after
// cites as that person (Q26). A household or a family born on this tablet and
// not yet accepted is cited by its client_uuid, and the item waits for it.
// Identity and the exit from the registry are not edited here (Q47).
import type { RegistrationBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import type { NewPatient } from "../../rules/registry";
import { applyRegistrationFields } from "../../sync/editable";
import { coalesceOrEnqueue, enqueue, type Dep } from "../../sync/outbox";
import { normalizeText } from "../../sync/text";

type Values = Record<string, unknown>;

// What the form edits of a registration.
export interface RegistrationFields {
  is_responsible: boolean; refused: boolean;
  patient_demographics: { race_color: string | null; ethnicity: string | null };
  identification: Values; sociodemographic: Values; health_conditions: Values; street_situation?: Values | null;
}
export type RegistrationPerson =
  | { kind: "new"; patient: NewPatient; duplicatesReviewed?: boolean }
  | { kind: "patient"; patientId: string; displayName: string };

export type SaveRegistrationInput =
  | { key?: undefined; householdKey: string | null; familyId: string | null; person: RegistrationPerson; fields: RegistrationFields }
  // `editBase`: what the form had when it opened (view.base); without it, the row's own as it is now.
  | { key: string; fields: RegistrationFields; editBase?: { version: number; body: Values } | null };

export const REGISTRATION_CONFLICT_PENDING = "Resolva o conflito deste cadastro antes de editar";
export class RegistrationInConflictError extends Error {
  constructor() { super(REGISTRATION_CONFLICT_PENDING); }
}

export interface SaveDeps { newUuid(): string; now(): number }

export async function saveRegistration(db: Db, input: SaveRegistrationInput, deps: SaveDeps): Promise<{ key: string; clientUuid: string }> {
  const fields = input.fields as unknown as Values;
  const saved = await db.tx(async (tx) => {
    if (input.key !== undefined) {
      const key = input.key;
      const row = await tx.get<{ id: string | null; client_uuid: string | null; base_version: number | null; base_body: string | null }>(
        "SELECT id, client_uuid, base_version, base_body FROM registrations WHERE key = ?", [key]);
      if (!row) throw new Error("cadastro não encontrado");
      const queued = (await outboxRepo.all(tx)).filter((item) => item.target_id === key && item.type === "individual_registration");
      if (queued.some((item) => item.state === "conflict")) throw new RegistrationInConflictError();
      // Born here and still without an id: the edit can only go after the creation was accepted.
      const creation = row.id === null ? queued.find((item) => item.client_uuid === row.client_uuid) : undefined;
      // Still waiting in the line: the edit becomes part of the creation itself (which keeps the person typed and where they live).
      const merges = creation !== undefined && (creation.state === "pending" || creation.state === "needs_attention");
      const edit = await coalesceOrEnqueue(tx, {
        type: "individual_registration", targetId: key, deps: creation && !merges ? [{ client_uuid: creation.client_uuid, kind: "version" }] : [],
        body: merges ? { ...creation.body, ...fields } : row.id === null ? fields : { registration_id: row.id, ...fields },
        editBase: input.editBase ?? (row.base_version !== null && row.base_body !== null ? { version: row.base_version, body: JSON.parse(row.base_body) as Values } : undefined),
      }, deps.newUuid);
      return { key, clientUuid: edit.client_uuid };
    }

    const clientUuid = deps.newUuid().toLowerCase();
    const queue = await outboxRepo.all(tx);
    const depends: Dep[] = [];
    const where: Values = {};
    if (input.householdKey !== null) {
      const household = await tx.get<{ id: string | null; client_uuid: string | null }>("SELECT id, client_uuid FROM households WHERE key = ?", [input.householdKey]);
      if (!household) throw new Error("domicílio não encontrado");
      if (household.id !== null) where.household_id = household.id;
      else {
        where.household_client_uuid = household.client_uuid;
        if (household.client_uuid !== null && queue.some((item) => item.client_uuid === household.client_uuid)) depends.push({ client_uuid: household.client_uuid, kind: "cite" });
      }
    }
    if (input.familyId !== null) {
      // A family born here is known by the client_uuid of its own item, while that item is in the line.
      if (queue.some((item) => item.type === "family" && item.client_uuid === input.familyId)) {
        where.family_client_uuid = input.familyId;
        depends.push({ client_uuid: input.familyId, kind: "cite" });
      } else where.family_id = input.familyId;
    }
    const person: Values = input.person.kind === "new"
      ? { new_patient: input.person.patient, ...(input.person.duplicatesReviewed ? { duplicates_reviewed: true } : {}) }
      : { patient_id: input.person.patientId };

    // The record as the screens read it, until the server's own arrives.
    const typed = input.person.kind === "new" ? input.person.patient : null;
    const blank = {
      id: clientUuid,
      patient: {
        id: input.person.kind === "new" ? clientUuid : input.person.patientId,
        display_name: typed ? (typed.social_name?.trim() || typed.full_name) : (input.person as { displayName: string }).displayName,
        full_name: typed?.full_name ?? "", mother_name: typed?.mother_name ?? null, birth_date: typed?.birth_date ?? null, sex: typed?.sex ?? null,
        has_cpf: !!typed?.cpf, no_cpf_reason: typed?.no_cpf_reason ?? null, cns_masked: null, identity_locked: false,
      },
      patient_demographics: { race_color: null, ethnicity: null }, household_id: input.householdKey, family_id: input.familyId, is_responsible: false,
      identification: {}, sociodemographic: {}, health_conditions: {}, street_situation: null, refused: false, exit: null, version: 0,
      registered_at: new Date(deps.now()).toISOString(), registered_by: { name: null }, identity_changed_at: null, identity_review_pending: false,
    } as unknown as RegistrationBody;
    const body = applyRegistrationFields(blank, fields);
    await tx.run(
      `INSERT INTO registrations (key, id, client_uuid, household_key, family_id, patient_id, version, body, base_version, base_body, needs_reload, name_norm, birth_date, mother_norm)
       VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, 0, ?, ?, ?)`,
      [clientUuid, clientUuid, input.householdKey, input.familyId, input.person.kind === "patient" ? input.person.patientId : null, JSON.stringify(body),
        normalizeText(typed?.full_name ?? body.patient.display_name), typed?.birth_date ?? null, typed?.mother_name ? normalizeText(typed.mother_name) : null]);
    await enqueue(tx, { type: "individual_registration", body: { ...person, ...where, ...fields }, targetId: clientUuid, clientUuid, deps: depends }, () => clientUuid);
    return { key: clientUuid, clientUuid };
  });
  dbEvents.emit("registrations");
  dbEvents.emit("outbox");
  return saved;
}
