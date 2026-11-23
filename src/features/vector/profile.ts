// The household's vector profile as the tablet knows it now: the `vector` the download brought (§14) with, over it, the
// block and the risk set by the bulletins of this tablet that the download cannot have brought yet:
// - a bulletin still waiting in the line (pending, sending, or blocked behind what it cites) sets them over the download;
// - an accepted one only fills what the download has as null — the round downloads after it sends, so a value
//   downloaded is newer than the acceptance (a change by the coordination is never hidden); the sheet keeps the
//   accepted ones of today only (src/sync/retention.ts);
// - a refused one (needs attention) counts for nothing: the server did not take its block.
// Without this a second visit would offer the block again and the server would refuse it (block_already_set).
// No person here: the profile is of the place.
import type { CityBlockBody, HouseholdBody, LiraaItemBody, TransmissionBlockBody } from "../../contract";
import { vectorRepo } from "../../db/repos/vectorRepo";
import type { Db } from "../../db/types";
import type { RiskClass, VectorSituation } from "../../rules/vectorDomains";
import type { VisitSummary, VisitVectorSummary } from "../visits/save";

export interface VectorProfile {
  city_block_id: string | null; risk_class: RiskClass | null; last_worked_on: string | null; last_situation: VectorSituation | null;
}

const EMPTY: VectorProfile = { city_block_id: null, risk_class: null, last_worked_on: null, last_situation: null };
type Set = Pick<VisitVectorSummary, "city_block_id" | "risk_class">;

// A bulletin of this tablet that still counts for the place: waiting in the line (pending, sending, or blocked behind
// what it cites) or accepted (the sheet keeps today's only, src/sync/retention.ts). A refused one (needs attention) and
// a withdrawn one are left out. `day`: the visit's city day; `acceptedAt`: when the acceptance came back (the device's
// clock, src/sync/dispatch.ts); `liraaDrawItemId`: the LIRAa item it inspects, from the sheet (Q47(b)) or, for a visit
// saved before the sheet kept it, from the line while it waits.
export interface LocalBulletin {
  householdKey: string; day: string; state: "waiting" | "accepted"; acceptedAt: string | null; vector: VisitVectorSummary; liraaDrawItemId: string | null;
}

// Oldest first.
export async function readLocalBulletins(db: Db): Promise<LocalBulletin[]> {
  const visits = await db.all<{ city_day: string; summary: string; state: string; accepted_at: string | null; queued: string | null; body: string | null }>(
    `SELECT v.city_day, v.summary, v.state, v.accepted_at, o.state AS queued, o.body FROM local_visits v LEFT JOIN outbox o ON o.client_uuid = v.client_uuid
     WHERE v.state IN ('pending', 'accepted') ORDER BY v.occurred_at, v.client_uuid`);
  const bulletins: LocalBulletin[] = [];
  for (const visit of visits) {
    const summary = JSON.parse(visit.summary) as Partial<VisitSummary>;
    if (typeof summary.household !== "string" || !summary.vector) continue;
    if (visit.state !== "accepted" && (visit.queued === null || visit.queued === "needs_attention")) continue;
    const inspection = visit.body === null ? null : (JSON.parse(visit.body) as { vector_inspection?: { liraa_draw_item_id?: string } }).vector_inspection;
    bulletins.push({
      householdKey: summary.household, day: visit.city_day, state: visit.state === "accepted" ? "accepted" : "waiting",
      acceptedAt: visit.state === "accepted" ? visit.accepted_at : null, vector: summary.vector,
      liraaDrawItemId: summary.vector.liraa_draw_item_id ?? inspection?.liraa_draw_item_id ?? null,
    });
  }
  return bulletins;
}

// The profile from the downloaded `vector` and the household's own bulletins (oldest first). `vector` absent (the gate
// off in the city) is no profile; null (a place with no profile yet) is no profile until a bulletin gives it a block or
// a risk.
export function overlayProfile(vector: HouseholdBody["vector"], bulletins: readonly LocalBulletin[]): VectorProfile | null {
  if (vector === undefined) return null;
  const sets = (state: LocalBulletin["state"]): Set[] => bulletins
    .filter((b) => b.state === state && (b.vector.city_block_id !== undefined || b.vector.risk_class !== undefined)).map((b) => b.vector);

  let profile: VectorProfile | null = vector === null ? null : {
    city_block_id: vector.city_block_id, risk_class: vector.risk_class, last_worked_on: vector.last_worked_on, last_situation: vector.last_situation,
  };
  // Accepted, oldest first, only into what the download left null (a later acceptance over an earlier one).
  const downloadedBlock = vector?.city_block_id ?? null;
  const downloadedRisk = vector?.risk_class ?? null;
  for (const set of sets("accepted")) {
    const base: VectorProfile = profile ?? EMPTY;
    profile = {
      ...base,
      city_block_id: downloadedBlock ?? set.city_block_id ?? base.city_block_id,
      risk_class: downloadedRisk ?? set.risk_class ?? base.risk_class,
    };
  }
  // Waiting, oldest first, over everything.
  for (const set of sets("waiting")) {
    const base: VectorProfile = profile ?? EMPTY;
    profile = { ...base, city_block_id: set.city_block_id ?? base.city_block_id, risk_class: set.risk_class ?? base.risk_class };
  }
  return profile;
}

// `householdKey`: the household's local key.
export async function readProfile(db: Db, householdKey: string): Promise<VectorProfile | null> {
  const row = await db.get<{ body: string }>("SELECT body FROM households WHERE key = ?", [householdKey]);
  if (!row) return null;
  const vector = (JSON.parse(row.body) as HouseholdBody).vector;
  if (vector === undefined) return null;
  return overlayProfile(vector, (await readLocalBulletins(db)).filter((b) => b.householdKey === householdKey));
}

// What the bulletin's rules read of the place, from the tablet (the api reads the same from its database): the
// profile, the household's neighbourhood with its active blocks (only when the profile has no block: the choice is
// offered only then), the LIRAa items of the household and the active transmission blocks.
export interface InspectionFacts {
  profile: VectorProfile | null; neighborhoodId: string | null; blocks: CityBlockBody[] | null;
  liraaItems: LiraaItemBody[]; transmissionBlocks: TransmissionBlockBody[];
}

export async function readInspectionFacts(db: Db, householdKey: string): Promise<InspectionFacts> {
  const row = await db.get<{ id: string | null; body: string }>("SELECT id, body FROM households WHERE key = ?", [householdKey]);
  const body = row ? (JSON.parse(row.body) as HouseholdBody) : null;
  const profile = await readProfile(db, householdKey);
  const neighborhoodId = body?.address?.neighborhood_id ?? null;
  const blocks = profile?.city_block_id || neighborhoodId === null ? null : await vectorRepo.blocksOf(db, neighborhoodId);
  // A LIRAa item names the household by the server's id: a household born on the tablet has none.
  const liraaItems = row?.id ? (await db.all<{ body: string }>("SELECT body FROM liraa_items WHERE household_id = ? ORDER BY id", [row.id])).map((r) => JSON.parse(r.body) as LiraaItemBody) : [];
  const transmissionBlocks = (await db.all<{ body: string }>("SELECT body FROM transmission_blocks WHERE status = 'active' ORDER BY id")).map((r) => JSON.parse(r.body) as TransmissionBlockBody);
  return { profile, neighborhoodId, blocks, liraaItems, transmissionBlocks };
}
