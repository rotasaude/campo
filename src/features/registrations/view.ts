// A registration as the screens show it: the row (what the server last said,
// or the person as typed when the record was born here) with the queued
// edits applied on top, in the order they were written.
import type { RegistrationBody } from "../../contract";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { applyRegistrationFields, splitItemBody } from "../../sync/editable";

export interface RegistrationView {
  key: string; id: string | null; householdKey: string | null;
  body: RegistrationBody;
  // The version and projection an edit begun now is based on; a form keeps it from the moment it opened (Q41).
  base: { version: number; body: Record<string, unknown> } | null;
  pending: boolean; conflict: boolean; bornHere: boolean;
}

export const REGISTRATION_TABLES = ["registrations", "outbox"];

export async function readRegistration(db: Db, key: string): Promise<RegistrationView | null> {
  const row = await db.get<{ key: string; id: string | null; client_uuid: string | null; household_key: string | null; body: string; base_version: number | null; base_body: string | null }>(
    "SELECT key, id, client_uuid, household_key, body, base_version, base_body FROM registrations WHERE key = ?", [key]);
  if (!row) return null;
  const mine = (await outboxRepo.all(db)).filter((item) => item.target_id === key && item.type === "individual_registration");
  let body = JSON.parse(row.body) as RegistrationBody;
  for (const item of mine) body = applyRegistrationFields(body, splitItemBody("individual_registration", item.body).fields);
  return {
    key: row.key, id: row.id, householdKey: row.household_key, body,
    base: row.base_version !== null && row.base_body !== null ? { version: row.base_version, body: JSON.parse(row.base_body) as Record<string, unknown> } : null,
    pending: mine.length > 0,
    conflict: mine.some((item) => item.state === "conflict"), bornHere: row.client_uuid !== null,
  };
}
