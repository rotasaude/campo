// The household's vector profile as the tablet knows it now: the `vector` the download brought (§14) with, over it, the
// block and the risk that the bulletins of this tablet set and the download has not brought back yet — those still in
// the line and those accepted (the sheet keeps the accepted ones of today only: src/sync/retention.ts). Without it a
// second visit would offer the block again and the server would refuse it (block_already_set).
// No person here: the profile is of the place.
import type { CityBlockBody, HouseholdBody, LiraaItemBody, TransmissionBlockBody } from "../../contract";
import { vectorRepo } from "../../db/repos/vectorRepo";
import type { Db } from "../../db/types";
import type { RiskClass, VectorSituation } from "../../rules/vectorDomains";
import type { VisitSummary } from "../visits/save";

export interface VectorProfile {
  city_block_id: string | null; risk_class: RiskClass | null; last_worked_on: string | null; last_situation: VectorSituation | null;
}

// `householdKey`: the household's local key. `vector` absent (the gate off in the city) is no profile; null (a place
// with no profile yet) is no profile until a bulletin of this tablet gives it a block or a risk.
export async function readProfile(db: Db, householdKey: string): Promise<VectorProfile | null> {
  const row = await db.get<{ body: string }>("SELECT body FROM households WHERE key = ?", [householdKey]);
  if (!row) return null;
  const vector = (JSON.parse(row.body) as HouseholdBody).vector;
  if (vector === undefined) return null;

  let profile: VectorProfile | null = vector === null ? null : {
    city_block_id: vector.city_block_id, risk_class: vector.risk_class, last_worked_on: vector.last_worked_on, last_situation: vector.last_situation,
  };
  const visits = await db.all<{ summary: string }>(
    "SELECT summary FROM local_visits WHERE state IN ('pending', 'accepted') ORDER BY occurred_at, client_uuid");
  for (const visit of visits) {
    const summary = JSON.parse(visit.summary) as Partial<VisitSummary>;
    const set = summary.vector;
    if (summary.household !== householdKey || !set || (set.city_block_id === undefined && set.risk_class === undefined)) continue;
    profile ??= { city_block_id: null, risk_class: null, last_worked_on: null, last_situation: null };
    if (set.city_block_id !== undefined) profile = { ...profile, city_block_id: set.city_block_id };
    if (set.risk_class !== undefined) profile = { ...profile, risk_class: set.risk_class };
  }
  return profile;
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
