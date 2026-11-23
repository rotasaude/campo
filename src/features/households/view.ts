// A household as the screens show it: what the server last said (the row)
// with what the tablet still owes the server (the outbox) applied on top, in
// the order it was written. Nothing is stored twice: when the item is
// accepted the row takes the accepted fields, and when the download brings
// the record the row becomes the server's again.
import type { HouseholdBody, Location } from "../../contract";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { dictLabel, type RegistrationDictionaries } from "../../rules/dictionaries";
import { applyFamilyItem, applyHouseholdFields, splitItemBody } from "../../sync/editable";

export interface HouseholdView {
  // The local key (what routes and other items point to) and the server id; null while the household only exists on the tablet.
  key: string; id: string | null;
  body: HouseholdBody;
  // What the server last said, untouched by the line, and the version and projection an edit begun NOW is based on.
  // A form keeps `base` from the moment it opened and gives it back when it saves: a download in between must not
  // become the base of what the person typed (Q41).
  server: HouseholdBody;
  base: EditBase | null;
  // Something of this household is still in the line; an edit of it waits for the person to choose (conflict).
  pending: boolean; conflict: boolean;
  bornHere: boolean;
}

export interface EditBase { version: number; body: Record<string, unknown> }
interface Row { key: string; id: string | null; client_uuid: string | null; body: string; base_version: number | null; base_body: string | null }

export const HOUSEHOLD_TABLES = ["households", "outbox"];

async function toView(db: Db, row: Row, queue: OutboxItem[]): Promise<HouseholdView> {
  const mine = queue.filter((item) => item.target_id === row.key && (item.type === "household" || item.type === "family"));
  const server = JSON.parse(row.body) as HouseholdBody;
  let body = server;
  for (const item of mine) {
    if (item.type === "family") {
      const responsible = (item.body.responsible ?? {}) as { patient_id?: string; patient_client_uuid?: string };
      const ref = responsible.patient_id ?? responsible.patient_client_uuid ?? null;
      body = applyFamilyItem(body, item.client_uuid, item.body, ref === null ? null : await territoryRepo.personName(db, ref));
      continue;
    }
    const { fields } = splitItemBody("household", item.body);
    const area = typeof fields.micro_area_id === "string" && fields.micro_area_id !== body.micro_area?.id
      ? await territoryRepo.microAreaRef(db, fields.micro_area_id) : null;
    body = applyHouseholdFields(body, fields, area);
  }
  return {
    key: row.key, id: row.id, body, server,
    base: row.base_version !== null && row.base_body !== null ? { version: row.base_version, body: JSON.parse(row.base_body) as Record<string, unknown> } : null,
    pending: mine.length > 0, conflict: mine.some((item) => item.state === "conflict"), bornHere: row.client_uuid !== null,
  };
}

export async function readHousehold(db: Db, key: string): Promise<HouseholdView | null> {
  const row = await db.get<Row>("SELECT key, id, client_uuid, body, base_version, base_body FROM households WHERE key = ?", [key]);
  return row ? toView(db, row, await outboxRepo.all(db)) : null;
}

// By street and number, as an agent walks them. `microAreaId`: only that micro-area's (by what the server last said).
export async function listHouseholds(db: Db, microAreaId?: string): Promise<HouseholdView[]> {
  const rows = microAreaId === undefined
    ? await db.all<Row>("SELECT key, id, client_uuid, body, base_version, base_body FROM households ORDER BY street_norm, number, key")
    : await db.all<Row>("SELECT key, id, client_uuid, body, base_version, base_body FROM households WHERE micro_area_id = ? ORDER BY street_norm, number, key", [microAreaId]);
  const queue = await outboxRepo.all(db);
  const views: HouseholdView[] = [];
  for (const row of rows) views.push(await toView(db, row, queue));
  return views;
}

// "Rua das Flores, 120": the api's address_short (apps/api HomeVisits::Json.address_short, main 85dc80ee) — the street
// type capitalized and the street, then the number or "S/N"; without a street, "Sem endereço". Never the complement
// (free text). A street type the dictionary does not have is left out, as on the api.
// Somebody still lives here, as the tablet knows it: a registration filed under the household with no exit (the api's
// active registration, exit_reason nil). The api re-reads it under its lock and stays the authority.
export async function hasActiveResident(db: Db, key: string): Promise<boolean> {
  const rows = await db.all<{ body: string }>("SELECT body FROM registrations WHERE household_key = ?", [key]);
  return rows.some((row) => (JSON.parse(row.body) as { exit?: unknown }).exit == null);
}

export function addressShort(body: Pick<HouseholdBody, "address">, dict: RegistrationDictionaries | null): string {
  const a = body.address ?? {};
  const label = dict === null || !a.street_type ? null : dict.stringDomains.tipo_logradouro.find((entry) => entry.code === a.street_type)?.label ?? null;
  const type = label === null ? null : label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
  const street = [type, a.street ?? null].filter((part): part is string => part !== null).join(" ");
  if (street === "") return "Sem endereço";
  const number = a.no_number ? "S/N" : a.number ?? null;
  return number === null ? street : `${street}, ${number}`;
}

// "RUA das Flores, 120 — fundos": the address in one line, as the agent says it. Without a dictionary the street type is left out.
export function addressLine(body: Pick<HouseholdBody, "address">, dict: RegistrationDictionaries | null): string {
  const a = body.address ?? {};
  const type = dict !== null && a.street_type ? dictLabel(dict, "tipo_logradouro", a.street_type) : "";
  const street = [type, a.street ?? ""].filter((part) => part !== "").join(" ");
  if (street === "") return "Endereço não informado";
  const number = a.no_number ? "s/n" : a.number ?? "";
  return [street + (number === "" ? "" : `, ${number}`), a.complement ?? ""].filter((part) => part !== "").join(" — ");
}

// The point of the household in words: never the coordinates themselves.
export function pointText(location: Location | null): string {
  if (location === null) return "Sem ponto no mapa";
  if (location.source === "map") return "Ponto marcado no mapa";
  return `Ponto marcado pelo GPS (precisão de ${String(location.accuracy_m ?? 0).replace(".", ",")} m)`;
}
