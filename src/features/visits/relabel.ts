// sample_label_taken (Q7(1)): another visit of the city already has a tube with this label. The label is made from the
// first eight characters of the visit's client_uuid (§9, sampleLabel), so the way out is a new client_uuid — the server
// never recorded the refused visit (the refusal undoes it whole, and leaves no receipt), so the new one is a first
// sending, not a second visit. Only on the agent's tap, only for this refusal, and the new labels are shown at once:
// the tubes must be labelled again before the visit goes.
//
// One transaction: the item's client_uuid, the sheet line's key and everything in the line that names the old uuid —
// what depends on it (an ovitrap installation waits for the bulletin that set the block) and a `<kind>_client_uuid`
// in a body (a withdrawal's visit_client_uuid). Half of it would leave an item citing a visit that no longer exists.
import type { VectorInspectionBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { sampleLabel } from "../../rules/vectorInspection";
import { refreshBlocked } from "../../sync/dispatch";
import { NOT_WAITING } from "../registrations/duplicates";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A draw that keeps the eight first characters would make the same labels: drawn again, a few times at most.
const DRAWS = 3;

// The labels a bulletin's samples get under a client_uuid, in the order of the bulletin.
export function bulletinLabels(item: Pick<OutboxItem, "client_uuid" | "body">): string[] {
  const samples = ((item.body.vector_inspection as VectorInspectionBody | undefined)?.samples ?? []) as { number: number }[];
  return samples.map((sample) => sampleLabel(item.client_uuid, sample.number));
}

export const canRelabel = (item: Pick<OutboxItem, "type" | "state" | "error">): boolean =>
  item.type === "home_visit" && item.state === "needs_attention" && item.error === "sample_label_taken";

export async function relabelVisit(db: Db, seq: number, newUuid: () => string): Promise<{ clientUuid: string; labels: string[] }> {
  const result = await db.tx(async (tx) => {
    const item = await outboxRepo.bySeq(tx, seq);
    if (!item || !canRelabel(item)) throw new Error(NOT_WAITING);
    const old = item.client_uuid;
    // Never for what the server has: an id for the uuid, or a sheet line no longer pending.
    const known = await tx.get<{ id: string }>("SELECT id FROM client_ids WHERE client_uuid = ?", [old]);
    const line = await tx.get<{ state: string }>("SELECT state FROM local_visits WHERE client_uuid = ?", [old]);
    if (known || (line && line.state !== "pending")) throw new Error(NOT_WAITING);

    let fresh = "";
    for (let draw = 0; draw < DRAWS && (fresh === "" || fresh.slice(0, 8) === old.slice(0, 8)); draw += 1) fresh = newUuid().toLowerCase();
    if (!UUID.test(fresh) || fresh.slice(0, 8) === old.slice(0, 8)) throw new Error("client_uuid inválido");
    const taken = await tx.get<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM outbox WHERE client_uuid = ?) + (SELECT COUNT(*) FROM local_visits WHERE client_uuid = ?)
            + (SELECT COUNT(*) FROM client_ids WHERE client_uuid = ?) AS n`, [fresh, fresh, fresh]);
    if ((taken?.n ?? 0) > 0) throw new Error("client_uuid inválido");

    await outboxRepo.rekey(tx, seq, fresh);
    await outboxRepo.update(tx, seq, { state: "pending", error: null, path: null, candidates: null, confirmable: null, attempts: 0 });
    await tx.run("UPDATE local_visits SET client_uuid = ? WHERE client_uuid = ?", [fresh, old]);
    for (const other of await outboxRepo.all(tx)) {
      if (other.seq === seq) continue;
      const cites = other.depends_on.some((dep) => dep.client_uuid === old);
      const named = Object.entries(other.body).filter(([key, value]) => key.endsWith("_client_uuid") && value === old).map(([key]) => key);
      if (!cites && named.length === 0) continue;
      await outboxRepo.update(tx, other.seq, {
        ...(cites ? { depends_on: other.depends_on.map((dep) => (dep.client_uuid === old ? { ...dep, client_uuid: fresh } : dep)) } : {}),
        ...(named.length > 0 ? { body: { ...other.body, ...Object.fromEntries(named.map((key) => [key, fresh])) } } : {}),
      });
    }
    // What was held only because of this one goes back to the line.
    await refreshBlocked(tx);
    return { clientUuid: fresh, labels: bulletinLabels({ client_uuid: fresh, body: item.body }) };
  });
  dbEvents.emit("local_visits");
  return result;
}
