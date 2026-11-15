// duplicate_participant: the server takes one participant of an activity for
// a repetition of another. When it is only a likeness (two people typed with
// the same name and birth) the answer says it can be confirmed, and the agent
// may say "it is another person": the participant goes again marked as seen.
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { refreshBlocked } from "../../sync/dispatch";
import { NOT_WAITING } from "../registrations/duplicates";

type Values = Record<string, unknown>;

export async function confirmOtherParticipant(db: Db, seq: number): Promise<void> {
  await db.tx(async (tx) => {
    const item = await outboxRepo.bySeq(tx, seq);
    const index = /^participants\[(\d+)\]/.exec(item?.path ?? "");
    if (!item || item.state !== "needs_attention" || item.type !== "collective_activity" || item.confirmable !== true || !index) throw new Error(NOT_WAITING);
    const participants = ((item.body.participants ?? []) as Values[]).map((participant, i) => (i === Number(index[1]) ? { ...participant, duplicates_reviewed: true } : participant));
    await outboxRepo.update(tx, seq, { body: { ...item.body, participants }, state: "pending", error: null, path: null, candidates: null, confirmable: null, attempts: 0 });
    await refreshBlocked(tx);
  });
}
