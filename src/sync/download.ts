// Downloads the device's scope: GET /field/v1/changes, page by page, until
// has_more is false. A page is applied in one transaction together with its
// cursor — a crash in the middle leaves the page unapplied and the cursor
// where it was, so nothing is lost and nothing is applied twice.
//
// The download never touches the outbox: an edit waiting to be sent keeps the
// version the person saw (Q41), and meets the station's change at send time.
import type {
  ChangesResponse, CityBlockBody, HouseholdBody, LiraaItemBody, MicroAreaBody, OvitrapBody, RegistrationBody, TransmissionBlockBody, WhoToVisit,
} from "../contract";
import { dbEvents } from "../db/events";
import { territoryRepo } from "../db/repos/territoryRepo";
import { vectorRepo } from "../db/repos/vectorRepo";
import type { Db } from "../db/types";
import { log } from "../log";
import { wipeTerritory } from "../security/wipe";
import type { FieldClient } from "./http";
import { readTrustedNow } from "./trustedTime";

// The types this version of the app stores. A page may bring others (a newer contract, a switch turned on before the
// update reached the tablet): they are skipped, and the rest of the page and its cursor are applied — failing on them
// would roll the page back and stop every later round at the same cursor (Q6(3)).
// Also the order a page is applied in: a city block before the household that names it; households before what is
// filed under their local key (registrations, ovitraps) and before the LIRAa items drawn from them.
export const KNOWN_CHANGE_TYPES: readonly string[] = [
  "micro_area", "city_block", "household", "registration", "ovitrap", "liraa_item", "transmission_block",
];
const ORDER = new Map(KNOWN_CHANGE_TYPES.map((type, index) => [type, index]));
const rank = (type: string): number => ORDER.get(type) ?? KNOWN_CHANGE_TYPES.length;

const known = (change: { type: string }): boolean => {
  if (KNOWN_CHANGE_TYPES.includes(change.type)) return true;
  log("sync.change.skipped", { type: change.type });
  return false;
};

// startsOver: the first page of a download that began without a cursor (Q42) — applied as a reset of the territory,
// in its own transaction, so a tablet that lost its cursor (the migration to v2, the 30 days) keeps nothing from another
// scope. Unlike a server reset it keeps the visits and activities already accepted (Q42 (b)): the person's "Visitado
// hoje" does not go with the update, and the moment of the last full download, so a restart that stops after page 1
// does not send the tablet to the first load. Never before the request: a page that never arrived wipes nothing.
export async function applyPage(db: Db, page: ChangesResponse, options: { startsOver?: boolean } = {}): Promise<void> {
  await db.tx(async (tx) => {
    // A scope change: everything the tablet has of the territory is replaced by what follows.
    if (page.reset) await wipeTerritory(tx);
    else if (options.startsOver === true) await wipeTerritory(tx, { restart: true });

    const items = page.items.filter(known).sort((a, b) => rank(a.type) - rank(b.type));
    for (const item of items) {
      switch (item.type) {
        case "micro_area": await territoryRepo.putMicroArea(tx, item.body as unknown as MicroAreaBody); break;
        case "household": await territoryRepo.putHousehold(tx, item.body as unknown as HouseholdBody); break;
        case "registration": await territoryRepo.putRegistration(tx, item.body as unknown as RegistrationBody); break;
        // Overwritten whatever the version (Q29); the household's `vector` is in its body, as it came (Q6).
        case "city_block": await vectorRepo.putCityBlock(tx, item.body as unknown as CityBlockBody); break;
        case "ovitrap": await vectorRepo.putOvitrap(tx, item.body as unknown as OvitrapBody); break;
        case "liraa_item": await vectorRepo.putLiraaItem(tx, item.body as unknown as LiraaItemBody); break;
        case "transmission_block": await vectorRepo.putTransmissionBlock(tx, item.body as unknown as TransmissionBlockBody); break;
        default: break; // never written: `known` already left it out
      }
    }
    // moved, erased and out_of_scope end the same way on the tablet: the record is not here any more. The vector
    // entities have no removal: their end comes by the status (v1.3.0).
    for (const removal of page.removals.filter(known)) {
      switch (removal.type) {
        case "household": await territoryRepo.removeHousehold(tx, removal.id); break;
        case "registration": await territoryRepo.removeRegistration(tx, removal.id); break;
        default: break;
      }
    }
    // null on the middle pages: the list of the last full download stays until the new one arrives whole.
    if (page.who_to_visit) await territoryRepo.replaceWhoToVisit(tx, page.who_to_visit as unknown as WhoToVisit);
    await territoryRepo.setMeta(tx, "cursor", page.next_cursor);
  });
  territoryRepo.emitTerritory();
}

// A FieldHttpError goes up to the round; the pages already applied stay, and the next call continues from the cursor.
export async function downloadAll(deps: { db: Db; client: Pick<FieldClient, "changes">; now: () => number }): Promise<{ complete: boolean }> {
  for (let first = true; ; first = false) {
    const cursor = await territoryRepo.getMeta(deps.db, "cursor");
    const page = await deps.client.changes(cursor);
    await applyPage(deps.db, page, { startsOver: first && cursor === null });
    if (!page.has_more) break;
  }
  // Only a download that reached the end counts for the 30-day retention, written in the server's time (campo#2).
  await territoryRepo.setMeta(deps.db, "last_download_ok_at", new Date(await readTrustedNow(deps.db, deps.now())).toISOString());
  // The pages told the screens about the territory before this was written: the ones that show it are told now.
  dbEvents.emit("meta");
  return { complete: true };
}
