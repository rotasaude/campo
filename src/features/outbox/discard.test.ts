// Review C2: discarding a record the server never accepted takes with it what only existed because of it — and nothing of
// it may be left on the tablet looking as if it had been sent.
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { emptyActivityDraft } from "../../rules/collectiveActivity";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { discardImpact, removeUnsent } from "../../sync/outbox";
import { loadReference } from "../../sync/reference";
import { newUuid } from "../../sync/testing";
import { saveActivity } from "../activities/save";
import { saveFamily } from "../families/save";
import { saveHousehold } from "../households/save";
import { listHouseholds, readHousehold } from "../households/view";
import { loadMapData } from "../map/mapData";
import { saveRegistration, type RegistrationFields } from "../registrations/save";
import { readRegistration } from "../registrations/view";
import { AREA, HH, loadedTablet } from "../testing";
import { saveVisit, todayVisits } from "../visits/save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const deps = { newUuid, now: () => NOW };
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2" };
const person: RegistrationFields = { is_responsible: true, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const visitTo = (householdKey: string, patientRef: string): VisitDraft => ({
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: householdKey, propertyType: "1", microAreaId: AREA },
  subject: "resident", person: { kind: "patient", patientId: patientRef, sex: "female" }, outcome: 3,
});
const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

// A whole afternoon offline: a new home, a new person in it heading a new family, a visit to her and a group she took part in.
async function afternoon() {
  const db = await loadedTablet();
  const household = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1", location: { latitude: -25.5, longitude: -49.3, accuracy_m: 9, source: "gps" } } }, deps);
  const benedita = await saveRegistration(db, { householdKey: household.key, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, deps);
  const family = await saveFamily(db, { householdKey: household.key, responsibleKey: benedita.key, fields: { income_band: null, members_count: 1, living_since: null } }, deps);
  const visit = await saveVisit(db, visitTo(household.key, benedita.clientUuid), { clientUuid: newUuid(), teamId: TEAM, location: null, visitBody: rules.visitBody, newUuid, now: () => NOW, vectorInspection: null });
  const domains = (await loadReference(db))!.collectiveDomains;
  const activity = await saveActivity(db, {
    ...emptyActivityDraft("2026-11-14"), teamId: TEAM, heldOn: "2026-11-14", shift: 2, activityType: 4, place: { kind: "text", text: "Salão" }, participantsCount: "1",
    targetAudience: [12], healthTopics: [1],
    participants: [{ kind: "patient", patientId: benedita.clientUuid, displayName: "x", hasCpf: false, hasCns: false, altered: false, weight: "", height: "", smoking: null }],
  }, { domains, ...deps });
  return { db, household, benedita, family, visit, activity };
}

test("how many other records go with the one being discarded is known before the person confirms", async () => {
  const t = await afternoon();
  // The person: her family, the visit to her and the group she was in.
  expect(await discardImpact(t.db, t.benedita.clientUuid)).toBe(3);
  // The home: everything that happened in it.
  expect(await discardImpact(t.db, t.household.clientUuid)).toBe(4);
  expect(await discardImpact(t.db, t.visit)).toBe(0);
});

test("discarding the person takes her family, her visit and the activity — from the line and from the tablet's own lists", async () => {
  const t = await afternoon();
  await removeUnsent(t.db, t.benedita.clientUuid);
  expect((await outboxRepo.all(t.db)).map((item) => item.type)).toEqual(["household"]);
  // Nothing is left that would read as sent.
  expect(await todayVisits(t.db, NOW)).toEqual([]);
  expect(await count(t.db, "local_activities")).toBe(0);
  expect(await readRegistration(t.db, t.benedita.key)).toBeNull();
  expect((await readHousehold(t.db, t.household.key))!.body.families).toEqual([]);
  // The home she lived in is still there, waiting to be sent, and is not painted as visited.
  const points = (await loadMapData(t.db, NOW)).points.features;
  expect(points.find((f) => f.properties.key === t.household.key)?.properties.status).toBe("registered");
});

test("discarding the home takes everything that only existed in it, and the home leaves the lists", async () => {
  const t = await afternoon();
  await removeUnsent(t.db, t.household.clientUuid);
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(await readHousehold(t.db, t.household.key)).toBeNull();
  expect((await listHouseholds(t.db)).map((h) => h.key)).toEqual([HH]);
  expect(await readRegistration(t.db, t.benedita.key)).toBeNull();
  expect(await count(t.db, "local_visits")).toBe(0);
  expect(await count(t.db, "families")).toBe(1); // only the downloaded household's
});

test("an edit that was waiting for the creation's answer goes with the creation: it is never sent as a creation of its own", async () => {
  const db = await loadedTablet();
  const born = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const [creation] = await outboxRepo.all(db);
  await outboxRepo.update(db, creation.seq, { state: "sending" });
  await saveHousehold(db, { key: born.key, fields: { micro_area_id: AREA, property_type: "2" } }, deps);
  await outboxRepo.update(db, creation.seq, { state: "needs_attention", error: "invalid_household" });
  expect(await discardImpact(db, born.clientUuid)).toBe(1);
  await removeUnsent(db, born.clientUuid);
  expect(await outboxRepo.all(db)).toEqual([]);
});

test("discarding an edit of a downloaded record takes nothing else and leaves the record as the server has it", async () => {
  const db = await loadedTablet();
  await saveHousehold(db, { key: HH, fields: { micro_area_id: AREA, property_type: "1", contact_phone: "41988887777" } }, deps);
  const [edit] = await outboxRepo.all(db);
  await outboxRepo.update(db, edit.seq, { state: "needs_attention", error: "invalid_household" });
  await removeUnsent(db, edit.client_uuid);
  const view = (await readHousehold(db, HH))!;
  expect([view.pending, view.body.contact_phone]).toEqual([false, "41999990000"]);
});
