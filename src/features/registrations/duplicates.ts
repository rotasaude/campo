// What the agent answers when the server says a person typed on the tablet
// may be somebody it already knows (duplicate_suspected), or already has a
// registration (already_registered).
//
// "É esta pessoa": the typed person is given up for the patient chosen. The
// api only resolves a citation by client_uuid when that item created the
// person (Q26), so everything in the line that cited the typed person is
// rewritten to name the patient. "É outra pessoa": the same item goes again,
// saying the look-alikes were seen.
import type { RegistrationBody } from "../../contract";
import { dbEvents } from "../../db/events";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { refreshBlocked } from "../../sync/dispatch";

export const NOT_WAITING = "este registro não está aguardando resposta";

type Values = Record<string, unknown>;
const isObject = (value: unknown): value is Values => typeof value === "object" && value !== null && !Array.isArray(value);

// Wherever the body names the typed person by client_uuid (a visit, a participant of an activity, the responsible of a
// family), it names the patient instead.
function rewire(value: unknown, clientUuid: string, patientId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewire(item, clientUuid, patientId));
  if (!isObject(value)) return value;
  const out: Values = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "patient_client_uuid" && inner === clientUuid) out.patient_id = patientId;
    else out[key] = rewire(inner, clientUuid, patientId);
  }
  return out;
}

async function waiting(db: Db, seq: number): Promise<OutboxItem> {
  const item = await outboxRepo.bySeq(db, seq);
  if (!item || item.state !== "needs_attention" || (item.type !== "individual_registration" && item.type !== "patient")) throw new Error(NOT_WAITING);
  return item;
}
const CLEARED = { state: "pending", error: null, path: null, candidates: null, confirmable: null, attempts: 0 } as const;

export async function confirmSamePerson(db: Db, seq: number, patientId: string): Promise<void> {
  await db.tx(async (tx) => {
    const item = await waiting(tx, seq);
    for (const other of await outboxRepo.all(tx)) {
      if (other.seq === seq) continue;
      const cites = other.depends_on.some((dep) => dep.client_uuid === item.client_uuid && dep.kind === "cite");
      const body = rewire(other.body, item.client_uuid, patientId) as Values;
      if (!cites && JSON.stringify(body) === JSON.stringify(other.body)) continue;
      await outboxRepo.update(tx, other.seq, { body, depends_on: other.depends_on.filter((dep) => !(dep.client_uuid === item.client_uuid && dep.kind === "cite")) });
    }
    if (item.type === "patient") {
      // The quick registration existed only to create the person: nothing is left of it.
      await outboxRepo.remove(tx, seq);
    } else {
      const { new_patient: _typed, duplicates_reviewed: _reviewed, ...rest } = item.body;
      await outboxRepo.update(tx, seq, { body: { patient_id: patientId, ...rest }, ...CLEARED });
      if (item.target_id !== null) {
        const row = await tx.get<{ body: string }>("SELECT body FROM registrations WHERE key = ?", [item.target_id]);
        if (row) {
          const body = JSON.parse(row.body) as RegistrationBody;
          await tx.run("UPDATE registrations SET patient_id = ?, body = ? WHERE key = ?",
            [patientId, JSON.stringify({ ...body, patient: { ...body.patient, id: patientId } }), item.target_id]);
        }
      }
    }
    await refreshBlocked(tx);
  });
  dbEvents.emit("registrations");
}

export async function confirmOtherPerson(db: Db, seq: number): Promise<void> {
  await db.tx(async (tx) => {
    const item = await waiting(tx, seq);
    await outboxRepo.update(tx, seq, { body: { ...item.body, duplicates_reviewed: true }, ...CLEARED });
    await refreshBlocked(tx);
  });
}

// already_registered: the person typed already has a registration. When the tablet has that registration, the typed
// person is given up for its patient exactly as in "É esta pessoa" — what cited her now names the patient, and nothing
// is lost; only the duplicate registration and the row born here go. The answer is the key of the existing registration.
// When the tablet does not have it (out of this device's scope, or no id came), NOTHING is discarded here: null, and
// the person decides with the ordinary discard, which says what goes with it.
export async function discardForExisting(db: Db, seq: number, existingId: string | null): Promise<string | null> {
  const key = existingId === null ? null : await territoryRepo.registrationKey(db, existingId);
  if (key === null) return null;
  const done = await db.tx(async (tx) => {
    const item = await outboxRepo.bySeq(tx, seq);
    const existing = await tx.get<{ patient_id: string | null }>("SELECT patient_id FROM registrations WHERE key = ?", [key]);
    if (!item || item.type !== "individual_registration" || !existing || existing.patient_id === null) return false;
    for (const other of await outboxRepo.all(tx)) {
      if (other.seq === seq || !other.depends_on.some((dep) => dep.client_uuid === item.client_uuid)) continue;
      await outboxRepo.update(tx, other.seq, {
        body: rewire(other.body, item.client_uuid, existing.patient_id) as Values,
        depends_on: other.depends_on.filter((dep) => dep.client_uuid !== item.client_uuid),
      });
    }
    await outboxRepo.remove(tx, seq);
    if (item.target_id !== null) await tx.run("DELETE FROM registrations WHERE key = ? AND id IS NULL AND client_uuid IS NOT NULL", [item.target_id]);
    await refreshBlocked(tx);
    return true;
  });
  if (!done) return null;
  dbEvents.emit("registrations");
  return key;
}
