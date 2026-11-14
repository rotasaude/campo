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
import { applyHouseholdFields, splitItemBody } from "../../sync/editable";

export interface HouseholdView {
  // The local key (what routes and other items point to) and the server id; null while the household only exists on the tablet.
  key: string; id: string | null;
  body: HouseholdBody;
  // Something of this household is still in the line; an edit of it waits for the person to choose (conflict).
  pending: boolean; conflict: boolean;
  bornHere: boolean;
}

interface Row { key: string; id: string | null; client_uuid: string | null; body: string }

export const HOUSEHOLD_TABLES = ["households", "outbox"];

async function toView(db: Db, row: Row, queue: OutboxItem[]): Promise<HouseholdView> {
  const mine = queue.filter((item) => item.target_id === row.key && (item.type === "household" || item.type === "family"));
  let body = JSON.parse(row.body) as HouseholdBody;
  for (const item of mine) {
    if (item.type !== "household") continue;
    const { fields } = splitItemBody("household", item.body);
    const area = typeof fields.micro_area_id === "string" && fields.micro_area_id !== body.micro_area?.id
      ? await territoryRepo.microAreaRef(db, fields.micro_area_id) : null;
    body = applyHouseholdFields(body, fields, area);
  }
  return {
    key: row.key, id: row.id, body, pending: mine.length > 0, conflict: mine.some((item) => item.state === "conflict"),
    bornHere: row.client_uuid !== null,
  };
}

export async function readHousehold(db: Db, key: string): Promise<HouseholdView | null> {
  const row = await db.get<Row>("SELECT key, id, client_uuid, body FROM households WHERE key = ?", [key]);
  return row ? toView(db, row, await outboxRepo.all(db)) : null;
}

// By street and number, as an agent walks them. `microAreaId`: only that micro-area's (by what the server last said).
export async function listHouseholds(db: Db, microAreaId?: string): Promise<HouseholdView[]> {
  const rows = microAreaId === undefined
    ? await db.all<Row>("SELECT key, id, client_uuid, body FROM households ORDER BY street_norm, number, key")
    : await db.all<Row>("SELECT key, id, client_uuid, body FROM households WHERE micro_area_id = ? ORDER BY street_norm, number, key", [microAreaId]);
  const queue = await outboxRepo.all(db);
  const views: HouseholdView[] = [];
  for (const row of rows) views.push(await toView(db, row, queue));
  return views;
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
