// Registers or edits a household on the tablet: the outbox gets the item and
// the row is there for the screens at once. A new household is a row born
// here (its key is the item's client_uuid) until the server gives it an id.
// An edit of a downloaded one carries, as its base, what the row had when the
// edit began (Q41) — the merge needs it if the station changed the record
// meanwhile. A second edit while the first waits is the same item. The
// endemic agent saves only non-residential properties (35a, Q13(1)).
import type { HouseholdBody, HouseholdItemBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import type { Problem } from "../../rules/registry";
import { applyHouseholdFields } from "../../sync/editable";
import { coalesceOrEnqueue, enqueue, type Dep } from "../../sync/outbox";
import { normalizeText } from "../../sync/text";
import { AGENT_CBO_NOT_ALLOWED, AGENT_HAS_RESIDENT, ERROR_PHRASES } from "../messages/errorPhrases";
import { agentRegistersNonResidential, canEditHousehold, loadSession, myMicroAreas } from "../session";
import { hasActiveResident } from "./view";

// What the form gives: the household item without what names the record (filled here and when it is sent).
export type HouseholdFields = Omit<HouseholdItemBody, "household_id" | "version">;

export const CONFLICT_PENDING = "Resolva o conflito deste domicílio antes de editar";
export class HouseholdInConflictError extends Error {
  constructor() { super(CONFLICT_PENDING); }
}

// The dashboard's phrase for the agent's edit of a property with an active resident: now with its sibling in errorPhrases (Q54).
export { AGENT_HAS_RESIDENT };

// Q13(1): what the api would refuse to the endemic agent, refused before anything is enqueued, in the api's order
// (TerritoryRegistry::Access.endemic_scope, then SaveHousehold#write):
//   - a micro-area that is not one of his session's → out_of_scope (the api sends no path; here, under Microárea);
//   - a type out of his list, typed or the one the household has → cbo_not_allowed, under the type, with the dashboard's
//     AGENT_CBO_NOT_ALLOWED (Q54: his CBO is allowed, the type is not);
//   - an edit of a household with an active resident on the tablet → cbo_not_allowed, with the dashboard's phrase.
export class HouseholdRefusedError extends Error {
  constructor(readonly problem: Problem) { super(problem.message); }
}

async function agentRefusal(
  db: Db, o: { microAreaId: string; types: (string | null)[]; householdKey?: string },
): Promise<HouseholdRefusedError | null> {
  const session = await loadSession(db);
  if (!agentRegistersNonResidential(session)) return null;
  if (!myMicroAreas(session).some((area) => area.id === o.microAreaId)) {
    return new HouseholdRefusedError({ path: "micro_area_id", message: ERROR_PHRASES.out_of_scope });
  }
  if (!o.types.every((type) => canEditHousehold(session, type))) {
    return new HouseholdRefusedError({ path: "property_type", message: AGENT_CBO_NOT_ALLOWED });
  }
  // The api sends no path: the form shows it over the button.
  if (o.householdKey !== undefined && await hasActiveResident(db, o.householdKey)) return new HouseholdRefusedError({ path: "", message: AGENT_HAS_RESIDENT });
  return null;
}

export interface SaveDeps { newUuid(): string; now(): number }

type Body = Record<string, unknown>;

// `editBase`: the version and projection the form had when it opened (view.base). Without it the row's own, as it is now —
// right only for a caller that reads and writes in one go.
export async function saveHousehold(
  db: Db, input: { key?: string; fields: HouseholdFields; editBase?: { version: number; body: Record<string, unknown> } | null }, deps: SaveDeps,
): Promise<{ key: string; clientUuid: string }> {
  const fields = input.fields as unknown as Body;
  const saved = await db.tx(async (tx) => {
    if (input.key === undefined) {
      const refusal = await agentRefusal(tx, { microAreaId: input.fields.micro_area_id, types: [input.fields.property_type] });
      if (refusal) throw refusal;
      const clientUuid = deps.newUuid().toLowerCase();
      const area = (await territoryRepo.microAreaRef(tx, input.fields.micro_area_id)) ?? { id: input.fields.micro_area_id, code: "" };
      // The record as the screens read it, until the server's own arrives.
      const blank = {
        id: clientUuid, micro_area: area, address: {}, property_type: input.fields.property_type, contact_phone: null, refused: false, status: "active",
        version: 0, registered_at: new Date(deps.now()).toISOString(), registered_by: { name: null }, location: null, families: [], living_conditions: {},
      } as unknown as HouseholdBody;
      const body = applyHouseholdFields(blank, fields, area);
      await tx.run(
        `INSERT INTO households (key, id, client_uuid, micro_area_id, version, body, base_version, base_body, needs_reload, street_norm, number, has_location)
         VALUES (?, NULL, ?, ?, NULL, ?, NULL, NULL, 0, ?, ?, ?)`,
        [clientUuid, clientUuid, area.id, JSON.stringify(body), normalizeText(body.address?.street ?? ""), body.address?.number ?? "", body.location ? 1 : 0]);
      await enqueue(tx, { type: "household", body: fields, targetId: clientUuid, clientUuid }, () => clientUuid);
      return { key: clientUuid, clientUuid };
    }

    const row = await tx.get<{ id: string | null; client_uuid: string | null; base_version: number | null; base_body: string | null; body: string }>(
      "SELECT id, client_uuid, base_version, base_body, body FROM households WHERE key = ?", [input.key]);
    if (!row) throw new Error("domicílio não encontrado");
    // The api looks at the type typed and at the one the household has (no turning a home into a shop, nor back).
    const refusal = await agentRefusal(tx, {
      microAreaId: input.fields.micro_area_id, householdKey: input.key,
      types: [input.fields.property_type, (JSON.parse(row.body) as { property_type?: string }).property_type ?? null],
    });
    if (refusal) throw refusal;
    const queued = (await outboxRepo.all(tx)).filter((item) => item.target_id === input.key && (item.type === "household" || item.type === "family"));
    if (queued.some((item) => item.state === "conflict")) throw new HouseholdInConflictError();

    // Born here and still without an id: the edit can only go after the creation was accepted.
    const creation = row.id === null ? queued.find((item) => item.type === "household" && item.client_uuid === row.client_uuid) : undefined;
    const depends: Dep[] = creation ? [{ client_uuid: creation.client_uuid, kind: "version" }] : [];
    const item = await coalesceOrEnqueue(tx, {
      type: "household", targetId: input.key, deps: depends,
      body: row.id === null ? fields : { household_id: row.id, ...fields },
      editBase: input.editBase ?? (row.base_version !== null && row.base_body !== null ? { version: row.base_version, body: JSON.parse(row.base_body) as Body } : undefined),
    }, deps.newUuid);
    return { key: input.key, clientUuid: item.client_uuid };
  });
  dbEvents.emit("households");
  dbEvents.emit("outbox");
  return saved;
}
