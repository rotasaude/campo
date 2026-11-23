// The active ovitraps as the screens show them: the row (the download's, or the one made at the installation) with the
// collections still in the line on top, in the order they were made. A collection that reinstalls opens the next paddle
// on its day (the api's reinstall, Q33); one that removes takes the ovitrap off the list at once. A collection waiting
// for the person (refused) still counts: it is what the tablet will tell the server, until it is fixed or discarded.
// Nothing of a person: the household by its local key.
import { outboxRepo } from "../../db/repos/outboxRepo";
import { collectionTarget, vectorRepo } from "../../db/repos/vectorRepo";
import type { Db } from "../../db/types";

export interface OvitrapView {
  key: string; id: string | null; number: string; householdKey: string;
  // The open paddle's installation day, or null (none open).
  installedOn: string | null;
  // Its installation or a collection still waits in the line.
  waiting: boolean;
  // One of them waits for the person (refused) or is held behind one that does (review M2): the screen points to
  // "precisa de atenção" and offers no collection.
  held: "needs_attention" | "blocked" | null;
}

export const OVITRAP_TABLES = ["ovitraps", "outbox"];

export async function readOvitraps(db: Db, householdKey?: string): Promise<OvitrapView[]> {
  const rows = await vectorRepo.ovitrapsOf(db, householdKey);
  const queue = await outboxRepo.all(db);
  const views: OvitrapView[] = [];
  for (const row of rows) {
    const refs = new Set([row.id, row.client_uuid].filter((ref): ref is string => ref !== null));
    let installedOn = row.body.open_reading?.installed_on ?? null;
    let removed = false;
    const mine = queue.filter((item) => (row.client_uuid !== null && item.client_uuid === row.client_uuid)
      || (item.type === "ovitrap_collection" && refs.has(collectionTarget(item.body) ?? "")));
    for (const item of mine) {
      if (item.type !== "ovitrap_collection") continue;
      if (item.body.remove === true) removed = true;
      else installedOn = String(item.body.collected_on);
    }
    const held = mine.some((item) => item.state === "needs_attention") ? "needs_attention" : mine.some((item) => item.state === "blocked") ? "blocked" : null;
    if (!removed) views.push({ key: row.key, id: row.id, number: row.number, householdKey: row.household_key, installedOn, waiting: mine.length > 0, held });
  }
  return views;
}

// The numbers the tablet knows to be taken (ovitrap_number_taken): the active ovitraps of the scope and the
// installations in the line, as the list shows them. `except`: the ovitrap whose number is being corrected.
export async function takenNumbers(db: Db, except?: string): Promise<string[]> {
  return (await readOvitraps(db)).filter((o) => o.key !== except).map((o) => o.number);
}
