import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { saveFamily } from "../families/save";
import { HH, loadedTablet } from "../testing";
import { confirmOtherPerson, confirmSamePerson, discardForExisting } from "./duplicates";
import { saveRegistration, type RegistrationFields } from "./save";
import { readRegistration } from "./view";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const deps = { newUuid, now: () => NOW };
const EXISTING = "1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c";
const REG = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b"; // the patient of that registration
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2" };
const fields: RegistrationFields = { is_responsible: true, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const wire = (items: { client_uuid: string; type: string; body: Record<string, unknown> }[], versions: Record<string, number> = {}) =>
  ({ items: items.map(({ client_uuid, type, body }) => ({ client_uuid, type, body: client_uuid in versions ? { ...body, version: versions[client_uuid] } : body })) });

// A person registered on the tablet, heading a new family and visited: the server answers "this may be somebody I know".
async function suspected() {
  const db = await loadedTablet();
  const person = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields }, deps);
  const family = await saveFamily(db, { householdKey: HH, responsibleKey: person.key, fields: { income_band: null, members_count: 1, living_since: null } }, deps);
  const visit = await enqueue(db, {
    type: "home_visit", deps: [{ client_uuid: person.clientUuid, kind: "cite" }],
    body: { team_id: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "resident", patient_client_uuid: person.clientUuid, outcome: 1, reasons: [1], shared: false },
  }, newUuid);
  const item = (await outboxRepo.all(db)).find((i) => i.client_uuid === person.clientUuid)!;
  await outboxRepo.update(db, item.seq, { state: "needs_attention", error: "duplicate_suspected", path: "new_patient", candidates: [{ patient_id: EXISTING }] as never });
  return { db, person, family, visit, seq: item.seq };
}

test("'É esta pessoa': the registration names the patient, and what cited the typed person now names the patient too", async () => {
  const t = await suspected();
  await confirmSamePerson(t.db, t.seq, EXISTING);
  const items = await outboxRepo.all(t.db);
  const registration = items.find((i) => i.client_uuid === t.person.clientUuid)!;
  expect(registration.body).toMatchObject({ patient_id: EXISTING, household_id: HH });
  expect(["new_patient" in registration.body, "duplicates_reviewed" in registration.body]).toEqual([false, false]);
  expect([registration.state, registration.error, registration.candidates]).toEqual(["pending", null, null]);

  const family = items.find((i) => i.client_uuid === t.family.clientUuid)!;
  expect(family.body.responsible).toEqual({ patient_id: EXISTING });
  expect(family.depends_on).toEqual([]);
  const visit = items.find((i) => i.client_uuid === t.visit.client_uuid)!;
  expect(visit.body.patient_id).toBe(EXISTING);
  expect("patient_client_uuid" in visit.body).toBe(false);
  expect(visit.depends_on).toEqual([]);
  expectValid("upload-request", wire(items, { [family.client_uuid]: 3 }));
  // The row born here now stands for that patient.
  expect((await readRegistration(t.db, t.person.key))!.body.patient.id).toBe(EXISTING);
});

test("'É outra pessoa': the same item goes back to the line saying the look-alikes were seen", async () => {
  const t = await suspected();
  await confirmOtherPerson(t.db, t.seq);
  const registration = (await outboxRepo.bySeq(t.db, t.seq))!;
  expect(registration.body).toMatchObject({ new_patient: BENEDITA, duplicates_reviewed: true });
  expect([registration.state, registration.error, registration.client_uuid]).toEqual(["pending", null, t.person.clientUuid]);
  // What cited the person still cites the same client_uuid.
  expect((await outboxRepo.all(t.db)).find((i) => i.type === "home_visit")!.body.patient_client_uuid).toBe(t.person.clientUuid);
});

test("the quick registration of a visit (a patient item): 'É esta pessoa' drops the item and the visit names the patient", async () => {
  const db = await loadedTablet();
  const patient = await enqueue(db, { type: "patient", body: { new_patient: BENEDITA } }, newUuid);
  const visit = await enqueue(db, {
    type: "home_visit", deps: [{ client_uuid: patient.client_uuid, kind: "cite" }],
    body: { team_id: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "resident", patient_client_uuid: patient.client_uuid, outcome: 3, reasons: [], shared: false },
  }, newUuid);
  await outboxRepo.update(db, patient.seq, { state: "needs_attention", error: "duplicate_suspected", path: "new_patient" });
  await confirmSamePerson(db, patient.seq, EXISTING);
  const items = await outboxRepo.all(db);
  expect(items.map((i) => i.client_uuid)).toEqual([visit.client_uuid]);
  expect(items[0].body.patient_id).toBe(EXISTING);
  expect(items[0].depends_on).toEqual([]);
  expectValid("upload-request", wire(items));
});

test("already registered, and the tablet has that registration: what cited the typed person now names the patient — nothing is lost", async () => {
  const t = await suspected();
  await outboxRepo.update(t.db, t.seq, { state: "needs_attention", error: "already_registered", path: null, candidates: null });
  expect(await discardForExisting(t.db, t.seq, REG)).toBe(REG);
  const items = await outboxRepo.all(t.db);
  // The duplicate registration is gone, with the row born here; the family and the visit stay, naming the patient the server knows.
  expect(items.map((i) => i.type).sort()).toEqual(["family", "home_visit"]);
  expect(items.find((i) => i.type === "home_visit")!.body).toMatchObject({ patient_id: JOANA });
  expect(items.find((i) => i.type === "family")!.body.responsible).toEqual({ patient_id: JOANA });
  expect(items.every((i) => i.depends_on.length === 0)).toBe(true);
  expect(await readRegistration(t.db, t.person.key)).toBeNull();
});

test("already registered, but that registration is not on this tablet: nothing is discarded here — the person decides", async () => {
  const t = await suspected();
  await outboxRepo.update(t.db, t.seq, { state: "needs_attention", error: "already_registered", path: null, candidates: null });
  const before = await outboxRepo.all(t.db);
  expect(await discardForExisting(t.db, t.seq, "00000000-0000-4000-8000-00000000dead")).toBeNull();
  expect(await discardForExisting(t.db, t.seq, null)).toBeNull();
  expect((await outboxRepo.all(t.db)).map((i) => i.seq)).toEqual(before.map((i) => i.seq));
  expect(await readRegistration(t.db, t.person.key)).not.toBeNull();
});

test("only an item that is waiting for the person can be answered", async () => {
  const t = await suspected();
  await outboxRepo.update(t.db, t.seq, { state: "pending" });
  await expect(confirmSamePerson(t.db, t.seq, EXISTING)).rejects.toThrow("este registro não está aguardando resposta");
  await expect(confirmOtherPerson(t.db, t.seq)).rejects.toThrow("este registro não está aguardando resposta");
});
