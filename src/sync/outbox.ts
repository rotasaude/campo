// The outbox: what the tablet still owes the server, in the order it was
// written. An item leaves the queue only when the server accepted it
// (accepted or duplicate). The client_uuid is the idempotency key: resending
// after a crash or a fix always carries the same one.
import type { ItemType } from "../contract";
import { dbEvents } from "../db/events";
import { outboxRepo, type Dep, type OutboxItem, type OutboxState } from "../db/repos/outboxRepo";
import type { Db } from "../db/types";

export type { Dep, OutboxItem, OutboxState };
type Body = Record<string, unknown>;

// The table of the row an item edits. A family has no row of its own: it lives in its household's body. The animal (35b)
// is edited by the same versioned path (Q20).
export function targetTable(type: ItemType): "households" | "registrations" | "animals" | null {
  if (type === "household" || type === "family") return "households";
  if (type === "individual_registration") return "registrations";
  if (type === "animal") return "animals";
  return null;
}

export interface EnqueueInput {
  type: ItemType; body: Body; targetId?: string; editBase?: { version: number; body: Body }; deps?: Dep[]; clientUuid?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// `newUuid` is the crypto port's randomUUID; the contract wants lowercase (contracts#2).
export async function enqueue(db: Db, input: EnqueueInput, newUuid: () => string): Promise<OutboxItem> {
  const clientUuid = (input.clientUuid ?? newUuid()).toLowerCase();
  if (!UUID.test(clientUuid)) throw new Error("client_uuid inválido");
  return outboxRepo.insert(db, {
    clientUuid, type: input.type, body: input.body, targetId: input.targetId ?? null, editBase: input.editBase ?? null, deps: input.deps ?? [],
  });
}

// A second edit of something still waiting replaces the body of the waiting item: same client_uuid, same
// edit base (what the person first saw). Only items the server has not judged yet, or judged and returned.
export async function coalesceOrEnqueue(db: Db, input: EnqueueInput, newUuid: () => string): Promise<OutboxItem> {
  if (input.targetId !== undefined) {
    const waiting = (await outboxRepo.all(db)).find((item) =>
      item.target_id === input.targetId && item.type === input.type && (item.state === "pending" || item.state === "needs_attention"));
    if (waiting) {
      await outboxRepo.update(db, waiting.seq, { body: input.body, state: "pending", error: null, path: null, candidates: null, confirmable: null });
      return (await outboxRepo.bySeq(db, waiting.seq))!;
    }
  }
  return enqueue(db, input, newUuid);
}

// At every open: an item caught mid-flight by a crash goes back to the line. If the server did receive it, the resend answers duplicate.
export async function recoverSending(db: Db): Promise<number> {
  const stuck = (await outboxRepo.all(db)).filter((item) => item.state === "sending");
  for (const item of stuck) await outboxRepo.update(db, item.seq, { state: "pending" });
  return stuck.length;
}

// Everything that has not left the queue, whatever its state.
export function pendingCount(db: Db): Promise<number> {
  return outboxRepo.count(db);
}

// What goes when an item the server never accepted is discarded: the item and everything in the line that only makes
// sense with it — what cites it (a visit to a person who will not exist) and what waits for its version (an edit of a
// record whose creation is being thrown away, which would otherwise be sent as a creation of its own). Items already on
// their way are left alone. Empty when the item cannot be discarded.
function doomedBy(all: OutboxItem[], clientUuid: string): OutboxItem[] {
  const first = all.find((item) => item.client_uuid === clientUuid);
  if (!first || (first.state !== "pending" && first.state !== "needs_attention" && first.state !== "blocked")) return [];
  const doomed = new Set([clientUuid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of all) {
      if (doomed.has(item.client_uuid) || item.state === "sending") continue;
      if (item.depends_on.some((dep) => doomed.has(dep.client_uuid))) { doomed.add(item.client_uuid); grew = true; }
    }
  }
  return all.filter((item) => doomed.has(item.client_uuid));
}

// How many OTHER records go with this one: what the person is told before confirming.
export async function discardImpact(db: Db, clientUuid: string): Promise<number> {
  return Math.max(0, doomedBy(await outboxRepo.all(db), clientUuid).length - 1);
}

// What a discarded item had put on the tablet's own lists goes with it, in the same transaction: nothing may be left
// reading as if it had been sent.
async function forget(tx: Db, item: OutboxItem): Promise<void> {
  if (item.type === "home_visit") await tx.run("DELETE FROM local_visits WHERE client_uuid = ?", [item.client_uuid]);
  else if (item.type === "collective_activity") await tx.run("DELETE FROM local_activities WHERE client_uuid = ?", [item.client_uuid]);
  // The ovitrap installed here that the server never had (35a).
  else if (item.type === "ovitrap_installation") await tx.run("DELETE FROM ovitraps WHERE key = ? AND id IS NULL", [item.client_uuid]);
  else if (item.type === "household" && item.target_id !== null) {
    // Only the creation owns the row: an edit of a record born here is another item.
    const born = await tx.run("DELETE FROM households WHERE key = ? AND id IS NULL AND client_uuid = ?", [item.target_id, item.client_uuid]);
    if (born.changes > 0) await tx.run("DELETE FROM families WHERE household_key = ?", [item.target_id]);
  } else if (item.type === "individual_registration" && item.target_id !== null) {
    await tx.run("DELETE FROM registrations WHERE key = ? AND id IS NULL AND client_uuid = ?", [item.target_id, item.client_uuid]);
  } else if (item.type === "animal" && item.target_id !== null) {
    // The same for the animal (35b): only its creation owns the row.
    await tx.run("DELETE FROM animals WHERE key = ? AND id IS NULL AND client_uuid = ?", [item.target_id, item.client_uuid]);
  } else if (item.type === "family" && typeof item.body.family_id !== "string") {
    // A family that was being created: who had been put in it is in no family again.
    for (const row of await tx.all<{ key: string; body: string }>("SELECT key, body FROM registrations WHERE family_id = ?", [item.client_uuid])) {
      await tx.run("UPDATE registrations SET family_id = NULL, body = ? WHERE key = ?", [JSON.stringify({ ...(JSON.parse(row.body) as Body), family_id: null }), row.key]);
    }
  }
}

// Discards an item the server never accepted, with everything that only existed because of it (see doomedBy).
export async function removeUnsent(db: Db, clientUuid: string): Promise<void> {
  await db.tx(async (tx) => {
    for (const item of doomedBy(await outboxRepo.all(tx), clientUuid)) {
      await outboxRepo.remove(tx, item.seq);
      await forget(tx, item);
    }
  });
  for (const table of ["households", "registrations", "local_visits", "local_activities", "ovitraps", "animals"]) dbEvents.emit(table);
}

// After a fix in the form: the same item goes back to the line with the new body and the same client_uuid.
export async function resend(db: Db, seq: number, body?: Body): Promise<void> {
  await db.tx(async (tx) => {
    const item = await outboxRepo.bySeq(tx, seq);
    if (!item || item.state !== "needs_attention") return;
    await outboxRepo.update(tx, seq, {
      ...(body ? { body } : {}), state: "pending", error: null, path: null, candidates: null, confirmable: null, attempts: 0,
    });
    // What was blocked only because of this one goes back too; the next round decides again.
    for (const other of await outboxRepo.all(tx)) {
      if (other.state === "blocked" && other.depends_on.some((dep) => dep.client_uuid === item.client_uuid)) {
        await outboxRepo.update(tx, other.seq, { state: "pending" });
      }
    }
  });
}
