// A home visit recorded on the tablet: the item for the outbox and a line on
// today's sheet. Whatever the visit points to that was born on this tablet
// and has no server id yet (the household, the person, the family) is cited
// by client_uuid, and the visit waits for it in the line. A person typed in
// the visit itself becomes a patient item of its own. The position goes only
// when it is a precise GPS reading — otherwise the key is absent, never null.
// The sheet keeps when and where; nothing of what was said in the house.
import type { Location } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { textProblem, type VisitDraft, type VisitOutcome, type VisitRules, type VisitSubject } from "../../rules/homeVisit";
import { cityToday } from "../../sync/clock";
import { enqueue, removeUnsent, type Dep } from "../../sync/outbox";
import type { LocalVisitSummary } from "../map/mapData";

export const NOT_SENT_WILL_BE_ERASED = "Esta visita ainda não foi enviada e será apagada";
export const VISIT_BEING_SENT = "A visita está sendo enviada agora. Tente de novo em instantes.";
export const WITHDRAW_REASON = { min: 10, max: 500 } as const;

type Values = Record<string, unknown>;
export interface VisitSummary extends LocalVisitSummary { subject: VisitSubject; outcome: VisitOutcome }

export interface SaveVisitContext {
  teamId: string;
  // A precise GPS reading taken when the visit was saved, or null.
  location: Location | null;
  visitBody: VisitRules["visitBody"];
  newUuid(): string;
  now(): number;
}

// In the draft the household is named by its local key; a person by the patient's id (for somebody registered on this
// tablet, the client_uuid of that registration); a family by its id (born here: the client_uuid of its item).
export async function saveVisit(db: Db, draft: VisitDraft, ctx: SaveVisitContext): Promise<string> {
  const clientUuid = await db.tx(async (tx) => {
    const queue = await outboxRepo.all(tx);
    const queued = (uuid: string | null) => uuid !== null && queue.some((item) => item.client_uuid === uuid);
    const { household_id: householdKey, patient_id: patientRef, new_patient: typed, duplicates_reviewed: reviewed, family_id: familyRef, ...rest } = ctx.visitBody(draft) as Values;
    const body: Values = { team_id: ctx.teamId, ...rest };
    const depends: Dep[] = [];

    if (typeof householdKey === "string") {
      const household = await tx.get<{ id: string | null; client_uuid: string | null }>("SELECT id, client_uuid FROM households WHERE key = ?", [householdKey]);
      if (!household) throw new Error("domicílio não encontrado");
      if (household.id !== null) body.household_id = household.id;
      else {
        body.household_client_uuid = household.client_uuid;
        if (queued(household.client_uuid)) depends.push({ client_uuid: household.client_uuid as string, kind: "cite" });
      }
    }
    if (typeof patientRef === "string") {
      // Somebody registered on this tablet and not yet known to the server is the registration item itself (Q26).
      const born = await tx.get<{ client_uuid: string }>("SELECT client_uuid FROM registrations WHERE key = ? AND client_uuid IS NOT NULL AND patient_id IS NULL", [patientRef]);
      if (born && queued(born.client_uuid)) {
        body.patient_client_uuid = born.client_uuid;
        depends.push({ client_uuid: born.client_uuid, kind: "cite" });
      } else body.patient_id = patientRef;
    }
    if (typed !== undefined) {
      const patient = await enqueue(tx, { type: "patient", body: { new_patient: typed, ...(reviewed === true ? { duplicates_reviewed: true } : {}) } }, ctx.newUuid);
      body.patient_client_uuid = patient.client_uuid;
      depends.push({ client_uuid: patient.client_uuid, kind: "cite" });
    }
    if (typeof familyRef === "string") {
      if (queue.some((item) => item.type === "family" && item.client_uuid === familyRef)) {
        body.family_client_uuid = familyRef;
        depends.push({ client_uuid: familyRef, kind: "cite" });
      } else body.family_id = familyRef;
    }
    if (ctx.location !== null) body.location = ctx.location;

    const item = await enqueue(tx, { type: "home_visit", body, deps: depends }, ctx.newUuid);
    const summary: VisitSummary = { household: typeof householdKey === "string" ? householdKey : null, subject: (rest.subject ?? "none") as VisitSubject, outcome: rest.outcome as VisitOutcome };
    await tx.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, ?, ?, ?, 'pending')",
      [item.client_uuid, draft.day, String(rest.occurred_at), JSON.stringify(summary)]);
    return item.client_uuid;
  });
  dbEvents.emit("local_visits");
  return clientUuid;
}

export interface TodayVisit {
  clientUuid: string; time: string; occurredAt: string; state: "pending" | "accepted" | "withdrawn";
  householdKey: string | null; subject: VisitSubject; outcome: VisitOutcome;
  // The outbox item of the visit, while it has one (what the screen says about the sending), and a withdrawal on its way.
  sending: "pending" | "sending" | "needs_attention" | "conflict" | "blocked" | null; withdrawalQueued: boolean;
}

export const TODAY_TABLES = ["local_visits", "outbox", "meta"];

// The visits of the city's day, in the order they were made.
export async function todayVisits(db: Db, now: number): Promise<TodayVisit[]> {
  const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('city_offset_min', 'clock_skew_ms')")).map((row) => [row.key, row.value]));
  const today = cityToday(now, Number(meta.get("clock_skew_ms") ?? 0) || 0, Number(meta.get("city_offset_min") ?? 0) || 0);
  const queue = await outboxRepo.all(db);
  const rows = await db.all<{ client_uuid: string; occurred_at: string; summary: string; state: TodayVisit["state"] }>(
    "SELECT client_uuid, occurred_at, summary, state FROM local_visits WHERE city_day = ? ORDER BY occurred_at, client_uuid", [today]);
  return rows.map((row) => {
    const summary = JSON.parse(row.summary) as Partial<VisitSummary>;
    return {
      clientUuid: row.client_uuid, time: row.occurred_at.slice(11, 16), occurredAt: row.occurred_at, state: row.state,
      householdKey: summary.household ?? null, subject: summary.subject ?? "none", outcome: summary.outcome ?? 1,
      sending: queue.find((item) => item.client_uuid === row.client_uuid)?.state ?? null,
      withdrawalQueued: queue.some((item) => item.type === "home_visit_withdrawal" && item.body.visit_client_uuid === row.client_uuid),
    };
  });
}

// A visit that never left the tablet is erased (with what was created only for it); one the server has is withdrawn by
// an item of its own, with the reason — the sheet only changes when the server accepts the withdrawal.
export async function withdrawVisit(db: Db, clientUuid: string, reason: string, deps: { newUuid(): string }): Promise<"erased" | "queued"> {
  const visit = await db.get<{ state: string }>("SELECT state FROM local_visits WHERE client_uuid = ?", [clientUuid]);
  if (!visit) throw new Error("visita não encontrada");
  const item = await outboxRepo.byClientUuid(db, clientUuid);
  if (item) {
    if (item.state === "sending") throw new Error(VISIT_BEING_SENT);
    await removeUnsent(db, clientUuid);
    // A person typed only for this visit goes with it.
    for (const dep of item.depends_on) {
      const cited = await outboxRepo.byClientUuid(db, dep.client_uuid);
      if (cited?.type === "patient" && cited.state !== "sending") await removeUnsent(db, cited.client_uuid);
    }
    await db.run("DELETE FROM local_visits WHERE client_uuid = ?", [clientUuid]);
    dbEvents.emit("local_visits");
    return "erased";
  }
  const queued = (await outboxRepo.all(db)).some((other) => other.type === "home_visit_withdrawal" && other.body.visit_client_uuid === clientUuid);
  if (queued) return "queued";
  const refusal = textProblem(reason, { ...WITHDRAW_REASON, path: "reason" });
  if (refusal) throw new Error(refusal.text);
  await enqueue(db, { type: "home_visit_withdrawal", body: { visit_client_uuid: clientUuid, reason: reason.trim() } }, deps.newUuid);
  dbEvents.emit("local_visits");
  return "queued";
}
