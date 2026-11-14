// What happens to an item the api answered with stale_version: the station
// changed the record after the person began the edit. The current record
// replaces the local row, and the edit is merged field by field (merge.ts)
// against it. No conflict: the item goes back to the line by itself, on the
// current version. Conflict: it waits for the person to choose, field by field.
//
// Only the fields the item sends are compared: a key absent from an upload
// means "keep what the server has", so it can never be a conflict.
import type { HouseholdBody, RegistrationBody, UploadResult } from "../contract";
import { dbEvents } from "../db/events";
import { outboxRepo, type OutboxItem } from "../db/repos/outboxRepo";
import type { Db } from "../db/types";
import { familyEditable, householdEditable, registrationEditable, splitItemBody } from "./editable";
import { applyChoices, merge } from "./merge";
import { targetTable } from "./outbox";

type Body = Record<string, unknown>;
const pick = (source: Body, keys: string[]): Body => Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
const withoutVersion = ({ version: _version, ...rest }: Body): Body => rest;

// The local row becomes the station's record: body, version and merge base, and the reload mark is cleared.
async function writeCurrent(db: Db, item: OutboxItem, current: Body, version: number, base: Body): Promise<void> {
  const table = targetTable(item.type);
  if (table === null || item.target_id === null) return;
  await db.run(`UPDATE ${table} SET body = ?, version = ?, base_version = ?, base_body = ?, needs_reload = 0 WHERE key = ?`,
    [JSON.stringify(current), version, version, JSON.stringify(base), item.target_id]);
  dbEvents.emit(table);
}

export async function handleStale(db: Db, item: OutboxItem, result: UploadResult): Promise<void> {
  const current = result.current as Body | undefined;
  const version = result.current_version;
  const table = targetTable(item.type);
  if (table === null || current === undefined || current === null || typeof version !== "number") {
    // Nothing to merge with: never guess.
    await outboxRepo.update(db, item.seq, { state: "needs_attention", error: "invalid_request", path: null });
    return;
  }

  await db.tx(async (tx) => {
    // For a family the answer's record is the household (Q4), as is the row.
    const rowBase = table === "households"
      ? householdEditable(current as unknown as HouseholdBody) : registrationEditable(current as unknown as RegistrationBody);
    await writeCurrent(tx, item, current, version, rowBase as unknown as Body);

    const { ids, fields } = splitItemBody(item.type, withoutVersion(item.body));
    let station: Body = rowBase as unknown as Body;
    if (item.type === "family") {
      const familyId = ids.family_id;
      if (typeof familyId !== "string") {
        // A family that does not exist yet has nothing to merge: it only needs the household's current version.
        await outboxRepo.update(tx, item.seq, { state: "pending", edit_base_version: version });
        return;
      }
      const family = familyEditable(current as unknown as HouseholdBody, familyId);
      if (family === null) {
        await outboxRepo.update(tx, item.seq, { state: "needs_attention", error: "family_not_found", path: "family_id", edit_base_version: version });
        return;
      }
      station = family as unknown as Body;
    }

    const sent = Object.keys(fields);
    const merged = merge(pick(item.edit_base_body ?? {}, sent), fields, pick(station, sent));
    await outboxRepo.update(tx, item.seq, {
      body: { ...ids, ...merged.body }, edit_base_version: version, edit_base_body: station,
      state: merged.conflicts.length > 0 ? "conflict" : "pending", conflicts: merged.conflicts.length > 0 ? merged.conflicts : null,
      error: null, path: null,
    });
  });
}

// The person chose a side for every field in conflict: the item goes back to the line with the same client_uuid.
export async function resolveConflict(db: Db, seq: number, choices: Record<string, "station" | "tablet">): Promise<void> {
  await db.tx(async (tx) => {
    const item = await outboxRepo.bySeq(tx, seq);
    if (!item || item.state !== "conflict" || item.conflicts === null) throw new Error("este registro não está em conflito");
    const { ids, fields } = splitItemBody(item.type, item.body);
    const chosen = applyChoices(fields, item.conflicts, choices); // throws MissingChoiceError when a field has no choice
    await outboxRepo.update(tx, seq, { body: { ...ids, ...chosen }, conflicts: null, state: "pending" });
  });
}
