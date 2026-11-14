// The outbox: what the tablet still owes the server, in the order it was
// written. An item leaves the queue only when the server accepted it
// (accepted or duplicate). The client_uuid is the idempotency key: resending
// after a crash or a fix always carries the same one.
import type { ItemType } from "../contract";
import { outboxRepo, type Dep, type OutboxItem, type OutboxState } from "../db/repos/outboxRepo";
import type { Db } from "../db/types";

export type { Dep, OutboxItem, OutboxState };
type Body = Record<string, unknown>;

// The table of the row an item edits. A family has no row of its own: it lives in its household's body.
export function targetTable(type: ItemType): "households" | "registrations" | null {
  if (type === "household" || type === "family") return "households";
  if (type === "individual_registration") return "registrations";
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

// Discards an item the server never accepted, and with it everything that cites it (a visit of a person who will not exist).
export async function removeUnsent(db: Db, clientUuid: string): Promise<void> {
  await db.tx(async (tx) => {
    const all = await outboxRepo.all(tx);
    const first = all.find((item) => item.client_uuid === clientUuid);
    if (!first || (first.state !== "pending" && first.state !== "needs_attention" && first.state !== "blocked")) return;
    const doomed = new Set([clientUuid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of all) {
        if (doomed.has(item.client_uuid) || item.state === "sending") continue;
        if (item.depends_on.some((dep) => dep.kind === "cite" && doomed.has(dep.client_uuid))) { doomed.add(item.client_uuid); grew = true; }
      }
    }
    for (const item of all) if (doomed.has(item.client_uuid)) await outboxRepo.remove(tx, item.seq);
  });
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
