// Ported from the api (Q11 of 35a: "a folha do app porta a regra do api, com os casos do spec dele"): the cadence of
// apps/api/app/services/vector_control/cadence.rb and the list of apps/api/app/services/vector_control/due.rb (api main
// 85dc80ee), with the cases of their specs in vectorDue.test.ts. The dashboard has no rule to port (it reads
// GET /vector_control/due); `startFor` is the dashboard's (apps/dashboard src/modules/vectorControl/DueList.tsx, main
// 2e3a2a9). What changed:
// - the facts come from the tablet (src/features/vector/dueData.ts), not from the database: the profile, the pending
//   LIRAa item and the active transmission block of the household's block;
// - the tie-break is the household's local key (the server id, or the client_uuid of a household born on the tablet);
// - no page and no cursor: the sheet is the whole list.
// A future divergence between this file and the api's is a defect of one of them: a card.
//
// The rule: one item per active household that has a reason, the first that holds, in this order — transmission_block
// (its block is in an active blockade), liraa (a pending item), pending (the last situation was closed or refused), due
// (never worked, or last_worked_on + the cadence's days ≤ today). One link per item: the reason's. Order: reason, then
// due_since with null (never worked) first (Q8), then the key. Never a person.
import type { Cadence, RiskClass, VectorControlDomains, VectorSituation } from "./vectorDomains";
import { PE_PROPERTY, type VectorStart } from "./vectorInspection";

export const DUE_REASONS = ["transmission_block", "liraa", "pending", "due"] as const;
export type DueReason = (typeof DUE_REASONS)[number];
export type CadenceParameters = Pick<VectorControlDomains["parameters"], "default_days" | "strategic_point_days">;

const PENDING_SITUATIONS: readonly VectorSituation[] = ["closed", "refused"];

// Days between two visits, from the most specific row to the most general (neighbourhood null = city, risk null = any):
// a PE: (neighbourhood, PE) → (city, PE) → strategic_point_days; the others: (neighbourhood, risk) → (neighbourhood, any)
// → (city, risk) → (city, any) (Q10) → default_days.
export function cadenceDays(h: { propertyType: string; neighborhoodId: string | null; riskClass: RiskClass | null }, cadences: Cadence[], p: CadenceParameters): number {
  const pe = h.propertyType === PE_PROPERTY;
  const steps: [string | null, RiskClass | null][] = pe
    ? [[h.neighborhoodId, null], [null, null]]
    : [[h.neighborhoodId, h.riskClass], [h.neighborhoodId, null], [null, h.riskClass], [null, null]];
  for (const [neighborhoodId, riskClass] of steps) {
    const found = cadences.find((c) => c.neighborhood_id === neighborhoodId && c.risk_class === riskClass && c.strategic_point === pe);
    if (found) return found.days;
  }
  return pe ? p.strategic_point_days : p.default_days;
}

export interface DueInput {
  householdKey: string; householdId: string | null; status: "active" | "inactive"; propertyType: string; neighborhoodId: string | null;
  profile: { city_block_id: string | null; risk_class: RiskClass | null; last_worked_on: string | null; last_situation: VectorSituation | null } | null;
  // The pending LIRAa item of the household and the active transmission block of its block, as the tablet knows them.
  liraaItemId: string | null; transmissionBlockId: string | null;
}

export interface DueItem {
  householdKey: string; reason: DueReason; dueSince: string | null; lastWorkedOn: string | null; riskClass: RiskClass | null;
  liraaDrawItemId: string | null; transmissionBlockId: string | null;
}

// AAAA-MM-DD + n days, in the calendar (no clock).
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function byOrder(a: DueItem, b: DueItem): number {
  const rank = DUE_REASONS.indexOf(a.reason) - DUE_REASONS.indexOf(b.reason);
  if (rank !== 0) return rank;
  if (a.dueSince !== b.dueSince) {
    if (a.dueSince === null) return -1;
    if (b.dueSince === null) return 1;
    return compare(a.dueSince, b.dueSince);
  }
  return compare(a.householdKey, b.householdKey);
}

// `today`: the city's day (AAAA-MM-DD).
export function dueList(rows: DueInput[], today: string, cadences: Cadence[], p: CadenceParameters): DueItem[] {
  const items: DueItem[] = [];
  for (const row of rows) {
    if (row.status !== "active") continue;
    const risk = row.profile?.risk_class ?? null;
    const lastWorkedOn = row.profile?.last_worked_on ?? null;
    const days = cadenceDays({ propertyType: row.propertyType, neighborhoodId: row.neighborhoodId, riskClass: risk }, cadences, p);
    const dueSince = lastWorkedOn === null ? null : addDays(lastWorkedOn, days);
    const transmissionBlockId = row.transmissionBlockId;
    const liraaDrawItemId = transmissionBlockId === null ? row.liraaItemId : null;
    const situation = row.profile?.last_situation ?? null;
    const reason: DueReason | null = transmissionBlockId !== null ? "transmission_block"
      : liraaDrawItemId !== null ? "liraa"
      : situation !== null && PENDING_SITUATIONS.includes(situation) ? "pending"
      : dueSince === null || dueSince <= today ? "due"
      : null;
    if (reason === null) continue;
    items.push({ householdKey: row.householdKey, reason, dueSince, lastWorkedOn, riskClass: risk, liraaDrawItemId, transmissionBlockId });
  }
  return items.sort(byOrder);
}

// The bulletin's link comes from the item's reason (the screen does not guess the item); PE by the property type.
export function startFor(item: DueItem, propertyType: string): VectorStart {
  if (item.reason === "transmission_block") return { activity: "transmission_block", transmissionBlockId: item.transmissionBlockId };
  if (item.reason === "liraa") return { activity: "liraa", liraaDrawItemId: item.liraaDrawItemId };
  // A pending strategic point (property "4"): a PE of recovery; the blockade and the LIRAa keep the activity of the link.
  if (item.reason === "pending") return propertyType === PE_PROPERTY ? { activity: "pe", workType: "pending" } : { workType: "pending" };
  if (propertyType === PE_PROPERTY) return { activity: "pe" };
  return {};
}
