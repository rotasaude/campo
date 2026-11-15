// Registers or edits a household on the tablet: the outbox gets the item and
// the row is there for the screens at once. A new household is a row born
// here (its key is the item's client_uuid) until the server gives it an id.
// An edit of a downloaded one carries, as its base, what the row had when the
// edit began (Q41) — the merge needs it if the station changed the record
// meanwhile. A second edit while the first waits is the same item.
import type { HouseholdBody, HouseholdItemBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { applyHouseholdFields } from "../../sync/editable";
import { coalesceOrEnqueue, enqueue, type Dep } from "../../sync/outbox";
import { normalizeText } from "../../sync/text";

// What the form gives: the household item without what names the record (filled here and when it is sent).
export type HouseholdFields = Omit<HouseholdItemBody, "household_id" | "version">;

export const CONFLICT_PENDING = "Resolva o conflito deste domicílio antes de editar";
export class HouseholdInConflictError extends Error {
  constructor() { super(CONFLICT_PENDING); }
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

    const row = await tx.get<{ id: string | null; client_uuid: string | null; base_version: number | null; base_body: string | null }>(
      "SELECT id, client_uuid, base_version, base_body FROM households WHERE key = ?", [input.key]);
    if (!row) throw new Error("domicílio não encontrado");
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
