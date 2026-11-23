// "Imóveis a visitar" of the endemic agent, computed on the tablet with the api's rule (src/rules/vectorDue.ts; Q11):
// the households of the scope with the profile as the tablet knows it (profile.ts) and the facts of the vector page —
// the pending LIRAa items and the active transmission blocks. Over the downloaded `last_worked_on` and
// `last_situation`, the bulletins of this tablet that the download cannot have brought yet, as the api keeps them
// (apps/api VectorControl::RecordInspection.last_attributes): the day of the latest worked visit and the situation of
// the latest one.
// - a bulletin waiting in the line sets the situation over the download and consumes the LIRAa item it inspects (any
//   situation takes an item out of `pending` on the api, Liraa::Items.inspected!);
// - an accepted one (today's) newer than the last good download sets the situation the same way: the download has
//   not brought it yet (review I1). At or before that download, it only fills a situation the download left null —
//   the download already speaks for the server, an inspection after this one included;
// - the worked day is the latest of the download's and of these bulletins'.
// `accepted_at` is the device's clock and `last_download_ok_at` the trusted one (src/sync/trustedTime.ts): the first is
// brought to the server's by the measured skew before they are compared.
// A transmission block stays a reason after the visit, as on the api: the list follows the blockade, not the visit.
// Nothing of a person: the household by its address and type, never who lives there.
import type { HouseholdBody } from "../../contract";
import type { Db } from "../../db/types";
import { dueList, type DueItem, type DueInput } from "../../rules/vectorDue";
import type { VectorSituation } from "../../rules/vectorDomains";
import { loadReference } from "../../sync/reference";
import { addressShort, listHouseholds } from "../households/view";
import { canRecordInspection, cityTodayOf, loadSession } from "../session";
import { overlayProfile, readLocalBulletins, type LocalBulletin, type VectorProfile } from "./profile";

export type DueEntry = DueItem & { address: string; block: { id: string; number: string } | null; propertyType: string };

// What the sheet reads: a change in any of them changes the list.
export const DUE_TABLES = ["households", "outbox", "local_visits", "liraa_items", "transmission_blocks", "city_blocks", "reference", "session", "meta"];

const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

// The profile with this tablet's bulletins of the household (oldest first) over the last work. `fresh`: an accepted
// bulletin the last good download cannot have brought.
function withLocalWork(profile: VectorProfile | null, mine: readonly LocalBulletin[], fresh: (b: LocalBulletin) => boolean): VectorProfile | null {
  if (mine.length === 0) return profile;
  const base: VectorProfile = profile ?? { city_block_id: null, risk_class: null, last_worked_on: null, last_situation: null };
  let newest: VectorSituation | null = null;
  let accepted: VectorSituation | null = null;
  let worked: string | null = null;
  for (const b of mine) {
    if (b.state === "waiting" || fresh(b)) newest = b.vector.situation;
    else accepted = b.vector.situation;
    if (b.vector.situation === "worked") worked = later(worked, b.day);
  }
  return { ...base, last_worked_on: later(base.last_worked_on, worked), last_situation: newest ?? base.last_situation ?? accepted };
}

// Only for who records the bulletin (canRecordInspection) with the visit on (the bulletin goes inside the visit):
// anybody else gets an empty sheet.
export async function loadDue(db: Db, now: number): Promise<{ items: DueEntry[] }> {
  const reference = await loadReference(db).catch(() => null);
  const domains = reference?.vectorDomains ?? null;
  const session = await loadSession(db);
  if (domains === null || session?.features.home_visits === false || !canRecordInspection(session, reference)) return { items: [] };

  const today = await cityTodayOf(db, now);
  const bulletins = await readLocalBulletins(db);
  const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('last_download_ok_at', 'clock_skew_ms')")).map((row) => [row.key, row.value]));
  const lastOk = meta.has("last_download_ok_at") ? Date.parse(meta.get("last_download_ok_at")!) : null;
  const skew = Number(meta.get("clock_skew_ms") ?? 0) || 0;
  const fresh = (b: LocalBulletin): boolean => b.state === "accepted" && b.acceptedAt !== null
    && (lastOk === null || Number.isNaN(lastOk) || Date.parse(b.acceptedAt) + skew > lastOk);
  const consumed = new Set(bulletins.flatMap((b) => (b.state === "waiting" && b.vector.activity === "liraa" && b.liraaDrawItemId !== null ? [b.liraaDrawItemId] : [])));
  // The lowest id first, as vectorRepo.pendingLiraaItem and activeBlockFor (the api picks the oldest; Q43).
  const liraa = new Map<string, string>();
  for (const item of await db.all<{ id: string; household_id: string }>("SELECT id, household_id FROM liraa_items WHERE status = 'pending' ORDER BY id")) {
    if (!consumed.has(item.id) && !liraa.has(item.household_id)) liraa.set(item.household_id, item.id);
  }
  const blockades = (await db.all<{ id: string; body: string }>("SELECT id, body FROM transmission_blocks WHERE status = 'active' ORDER BY id"))
    .map((row) => ({ id: row.id, blocks: (JSON.parse(row.body) as { block_ids: string[] }).block_ids }));
  const blocks = new Map((await db.all<{ id: string; number: string }>("SELECT id, number FROM city_blocks")).map((row) => [row.id, row.number]));

  const rows: DueInput[] = [];
  const shown = new Map<string, { address: string; propertyType: string; blockId: string | null }>();
  for (const view of await listHouseholds(db)) {
    const body: HouseholdBody = view.body;
    const mine = bulletins.filter((b) => b.householdKey === view.key);
    const profile = withLocalWork(overlayProfile(body.vector, mine), mine, fresh);
    const blockId = profile?.city_block_id ?? null;
    rows.push({
      householdKey: view.key, householdId: view.id, status: body.status, propertyType: body.property_type,
      neighborhoodId: body.address?.neighborhood_id ?? null, profile,
      liraaItemId: view.id === null ? null : liraa.get(view.id) ?? null,
      transmissionBlockId: blockId === null ? null : blockades.find((t) => t.blocks.includes(blockId))?.id ?? null,
    });
    shown.set(view.key, { address: addressShort(body, reference?.dictionaries ?? null), propertyType: body.property_type, blockId });
  }

  const items = dueList(rows, today, domains.cadences, domains.parameters).map((item): DueEntry => {
    const { address, propertyType, blockId } = shown.get(item.householdKey)!;
    const number = blockId === null ? undefined : blocks.get(blockId);
    return { ...item, address, propertyType, block: blockId !== null && number !== undefined ? { id: blockId, number } : null };
  });
  return { items };
}
