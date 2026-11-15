// A collective activity recorded on the tablet: the item for the outbox and a
// line among the tablet's activities. A participant the server already knows
// goes by the patient's id; one registered on this tablet a moment ago is
// cited by the client_uuid of that registration, and the activity waits for
// it (Q26); a person typed in the activity itself travels inside the
// participant. The line keeps the day, the type and how many — nobody's name.
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { activityBody, type ActivityDraft } from "../../rules/collectiveActivity";
import type { CollectiveDomains } from "../../rules/domains";
import { enqueue, type Dep } from "../../sync/outbox";

type Values = Record<string, unknown>;
export interface ActivitySummary { activity_type: number; shift: number; participants_count: number }
export interface SaveActivityContext { domains: CollectiveDomains; newUuid(): string; now(): number }

// In the draft a participant is named by the patient's id — for somebody registered on this tablet, the client_uuid of that registration.
export async function saveActivity(db: Db, draft: ActivityDraft, ctx: SaveActivityContext): Promise<string> {
  const clientUuid = await db.tx(async (tx) => {
    const body = activityBody(draft, ctx.domains) as unknown as Values;
    const queue = await outboxRepo.all(tx);
    const depends: Dep[] = [];
    const participants: Values[] = [];
    for (const participant of body.participants as Values[]) {
      const { patient_id: ref, ...rest } = participant;
      if (typeof ref !== "string") { participants.push(participant); continue; }
      const born = await tx.get<{ client_uuid: string }>("SELECT client_uuid FROM registrations WHERE key = ? AND client_uuid IS NOT NULL AND patient_id IS NULL", [ref]);
      if (born && queue.some((item) => item.client_uuid === born.client_uuid)) {
        participants.push({ patient_client_uuid: born.client_uuid, ...rest });
        if (!depends.some((dep) => dep.client_uuid === born.client_uuid)) depends.push({ client_uuid: born.client_uuid, kind: "cite" });
      } else participants.push(participant);
    }
    const item = await enqueue(tx, { type: "collective_activity", body: { ...body, participants }, deps: depends }, ctx.newUuid);
    const summary: ActivitySummary = { activity_type: body.activity_type as number, shift: body.shift as number, participants_count: body.participants_count as number };
    await tx.run("INSERT INTO local_activities (client_uuid, held_on, summary, state) VALUES (?, ?, ?, 'pending')", [item.client_uuid, draft.heldOn, JSON.stringify(summary)]);
    return item.client_uuid;
  });
  dbEvents.emit("local_activities");
  return clientUuid;
}
