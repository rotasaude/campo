// The ovitrap of the endemic agent, offline (35a; contract §6, §13; Q7, Q10, Q11, Q33): the installation and the paddle's
// collection as outbox items. The api applies a batch in order (Q10) and resolves `<kind>_client_uuid` by its ledger, so
// what an item names that was born on this tablet is cited by client_uuid and the item waits for it in the line:
// - the installation cites the household born here and the bulletin still in the line that gave the household its
//   block (without it the api refuses household_without_block);
// - the collection cites the installation still in the line and the earlier collections of the same ovitrap.
// The collection always says both: `reinstall: !remove` (Q33: the api refuses reinstall false without remove; with
// remove it ignores reinstall, Q7(5)). Nothing of a person: the household by its key or id, the ovitrap by its number.
import type { OvitrapCollectionItemBody, OvitrapInstallationItemBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { collectionTarget, vectorRepo } from "../../db/repos/vectorRepo";
import type { Db } from "../../db/types";
import type { ReadingCondition } from "../../rules/ovitrap";
import { enqueue, resend, type Dep } from "../../sync/outbox";

// One transaction: the item and the local row go together or not at all.
export async function installOvitrap(db: Db, input: { householdKey: string; number: string; clientUuid: string; today: string }): Promise<string> {
  const clientUuid = await db.tx(async (tx) => {
    const queue = await outboxRepo.all(tx);
    const queued = (uuid: string | null) => uuid !== null && queue.some((item) => item.client_uuid === uuid);
    const household = await tx.get<{ id: string | null; client_uuid: string | null }>("SELECT id, client_uuid FROM households WHERE key = ?", [input.householdKey]);
    if (!household) throw new Error("domicílio não encontrado");
    const body: Partial<OvitrapInstallationItemBody> = {};
    const deps: Dep[] = [];
    if (household.id !== null) body.household_id = household.id;
    else {
      body.household_client_uuid = household.client_uuid as string;
      if (queued(household.client_uuid)) deps.push({ client_uuid: household.client_uuid as string, kind: "cite" });
    }
    // The bulletins still in the line that set this household's block: the api must apply them first (Q10). A refused
    // one gave nothing (the same rule as readLocalBulletins, src/features/vector/profile.ts): citing it would hold the
    // installation behind a refusal.
    const gave = await tx.all<{ client_uuid: string }>(
      `SELECT v.client_uuid FROM local_visits v JOIN outbox o ON o.client_uuid = v.client_uuid
       WHERE o.type = 'home_visit' AND o.state NOT IN ('needs_attention', 'conflict')
         AND json_extract(v.summary, '$.household') = ? AND json_extract(v.summary, '$.vector.city_block_id') IS NOT NULL ORDER BY o.seq`,
      [input.householdKey]);
    for (const visit of gave) deps.push({ client_uuid: visit.client_uuid, kind: "cite" });
    Object.assign(body, { number: input.number, consent: true, installed_on: input.today });

    const item = await enqueue(tx, { type: "ovitrap_installation", body, deps, clientUuid: input.clientUuid }, () => input.clientUuid);
    await vectorRepo.putInstalled(tx, {
      clientUuid: item.client_uuid, householdKey: input.householdKey, householdId: household.id ?? input.householdKey, number: input.number, installedOn: input.today,
    });
    return item.client_uuid;
  });
  dbEvents.emit("ovitraps");
  return clientUuid;
}

export async function collectOvitrap(db: Db, input: { ovitrapKey: string; condition: ReadingCondition; remove: boolean; today: string; newUuid(): string }): Promise<string> {
  const clientUuid = await db.tx(async (tx) => {
    const row = await tx.get<{ key: string; id: string | null; client_uuid: string | null }>("SELECT key, id, client_uuid FROM ovitraps WHERE key = ?", [input.ovitrapKey]);
    if (!row) throw new Error("ovitrampa não encontrada");
    const queue = await outboxRepo.all(tx);
    const refs = new Set([row.id, row.client_uuid].filter((ref): ref is string => ref !== null));
    const deps: Dep[] = [];
    const installation = row.client_uuid === null ? undefined : queue.find((item) => item.type === "ovitrap_installation" && item.client_uuid === row.client_uuid);
    if (installation) deps.push({ client_uuid: installation.client_uuid, kind: "cite" });
    for (const earlier of queue) {
      const target = earlier.type === "ovitrap_collection" ? collectionTarget(earlier.body) : null;
      if (target !== null && refs.has(target)) deps.push({ client_uuid: earlier.client_uuid, kind: "cite" });
    }
    const body: OvitrapCollectionItemBody = {
      ...(row.id !== null ? { ovitrap_id: row.id } : { ovitrap_client_uuid: row.client_uuid as string }),
      collected_on: input.today, condition: input.condition, reinstall: !input.remove, remove: input.remove,
    };
    return (await enqueue(tx, { type: "ovitrap_collection", body, deps }, input.newUuid)).client_uuid;
  });
  dbEvents.emit("ovitraps");
  return clientUuid;
}

// "Corrigir número" (Q11): the installation refused with ovitrap_number_taken goes back to the line with the new number
// and the same client_uuid, and the local row takes the number. One transaction.
export async function correctNumber(db: Db, seq: number, number: string): Promise<void> {
  await db.tx(async (tx) => {
    const item = await outboxRepo.bySeq(tx, seq);
    if (!item || item.type !== "ovitrap_installation" || item.state !== "needs_attention") return;
    await resend(tx, seq, { ...item.body, number });
    await vectorRepo.renumber(tx, item.client_uuid, number);
  });
  dbEvents.emit("ovitraps");
}
