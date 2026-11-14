// Downloads the device's scope: GET /field/v1/changes, page by page, until
// has_more is false. A page is applied in one transaction together with its
// cursor — a crash in the middle leaves the page unapplied and the cursor
// where it was, so nothing is lost and nothing is applied twice.
//
// The download never touches the outbox: an edit waiting to be sent keeps the
// version the person saw (Q41), and meets the station's change at send time.
import type { ChangesResponse, HouseholdBody, MicroAreaBody, RegistrationBody, WhoToVisit } from "../contract";
import { territoryRepo } from "../db/repos/territoryRepo";
import type { Db } from "../db/types";
import { wipeTerritory } from "../security/wipe";
import type { FieldClient } from "./http";

export async function applyPage(db: Db, page: ChangesResponse): Promise<void> {
  await db.tx(async (tx) => {
    // A scope change: everything the tablet has of the territory is replaced by what follows.
    if (page.reset) await wipeTerritory(tx);

    // Households before registrations: a registration is filed under its household's local key.
    const order = { micro_area: 0, household: 1, registration: 2 } as const;
    const items = [...page.items].sort((a, b) => order[a.type] - order[b.type]);
    for (const item of items) {
      if (item.type === "micro_area") await territoryRepo.putMicroArea(tx, item.body as unknown as MicroAreaBody);
      else if (item.type === "household") await territoryRepo.putHousehold(tx, item.body as unknown as HouseholdBody);
      else await territoryRepo.putRegistration(tx, item.body as unknown as RegistrationBody);
    }
    // moved, erased and out_of_scope end the same way on the tablet: the record is not here any more.
    for (const removal of page.removals) {
      if (removal.type === "household") await territoryRepo.removeHousehold(tx, removal.id);
      else await territoryRepo.removeRegistration(tx, removal.id);
    }
    // null on the middle pages: the list of the last full download stays until the new one arrives whole.
    if (page.who_to_visit) await territoryRepo.replaceWhoToVisit(tx, page.who_to_visit as unknown as WhoToVisit);
    await territoryRepo.setMeta(tx, "cursor", page.next_cursor);
  });
  territoryRepo.emitTerritory();
}

// A FieldHttpError goes up to the round; the pages already applied stay, and the next call continues from the cursor.
export async function downloadAll(deps: { db: Db; client: Pick<FieldClient, "changes">; now: () => number }): Promise<{ complete: boolean }> {
  for (;;) {
    const cursor = await territoryRepo.getMeta(deps.db, "cursor");
    const page = await deps.client.changes(cursor);
    await applyPage(deps.db, page);
    if (!page.has_more) break;
  }
  // Only a download that reached the end counts for the 30-day retention.
  await territoryRepo.setMeta(deps.db, "last_download_ok_at", new Date(deps.now()).toISOString());
  return { complete: true };
}
