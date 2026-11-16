import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { applyResults } from "../../sync/dispatch";
import { accepted, newUuid } from "../../sync/testing";
import { saveFamily } from "../families/save";
import { saveHousehold } from "../households/save";
import { saveRegistration, type RegistrationFields } from "../registrations/save";
import { AREA, HH, loadedTablet } from "../testing";
import { NOT_SENT_WILL_BE_ERASED, VISIT_BEING_SENT, saveVisit, todayVisits, withdrawVisit } from "./save";

const NOW = Date.parse("2026-11-14T15:00:00Z"); // 12:00 in the city (UTC−3)
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const ctx = (over: Partial<Parameters<typeof saveVisit>[2]> = {}) => ({ teamId: TEAM, location: null, visitBody: rules.visitBody, newUuid, now: () => NOW, ...over });
const GPS = { latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" as const };
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2" };
const person: RegistrationFields = { is_responsible: true, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const draft = (o: Partial<VisitDraft> = {}): VisitDraft => ({
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: HH, propertyType: "1", microAreaId: AREA },
  subject: "resident", person: { kind: "patient", patientId: JOANA, sex: "female" }, outcome: 1, reasons: [11], ...o,
});
const wire = (items: { client_uuid: string; type: string; body: Record<string, unknown> }[], versions: Record<string, number> = {}) =>
  ({ items: items.map(({ client_uuid, type, body }) => ({ client_uuid, type, body: client_uuid in versions ? { ...body, version: versions[client_uuid] } : body })) });
const local = (db: Db) => db.all<{ client_uuid: string; city_day: string; occurred_at: string; summary: string; state: string }>(
  "SELECT client_uuid, city_day, occurred_at, summary, state FROM local_visits ORDER BY occurred_at");

test("a visit to a resident: the item, with the team and the moment in the city's clock, and the visit on today's sheet", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft({ note: " Pediu retorno. ", shared: true }), ctx());
  const [item] = await outboxRepo.all(db);
  expect([item.type, item.client_uuid, item.target_id, item.depends_on]).toEqual(["home_visit", uuid, null, []]);
  expect(item.body).toEqual({
    team_id: TEAM, occurred_at: "2026-11-14T10:30:00-03:00", household_id: HH, subject: "resident", patient_id: JOANA, outcome: 1, reasons: [11], shared: true,
    note: "Pediu retorno.",
  });
  expect("location" in item.body).toBe(false); // never null (Q3)
  expectValid("upload-request", wire([item]));
  // On the sheet: when and where, and nothing of what was said in the house.
  expect(await local(db)).toEqual([{ client_uuid: uuid, city_day: "2026-11-14", occurred_at: "2026-11-14T10:30:00-03:00", state: "pending", summary: JSON.stringify({ household: HH, subject: "resident", outcome: 1 }) }]);
});

test("with a precise position the visit carries it as gps, with accuracy_m; and the contract accepts it", async () => {
  const db = await loadedTablet();
  await saveVisit(db, draft(), ctx({ location: GPS }));
  const [item] = await outboxRepo.all(db);
  expect(item.body.location).toEqual(GPS);
  expectValid("upload-request", wire([item]));
});

test("household, person and family born on the tablet are cited by client_uuid, and the visit waits for them (Q26)", async () => {
  const db = await loadedTablet();
  const deps = { newUuid, now: () => NOW };
  const household = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const benedita = await saveRegistration(db, { householdKey: household.key, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, deps);
  const family = await saveFamily(db, { householdKey: household.key, responsibleKey: benedita.key, fields: { income_band: null, members_count: 1, living_since: null } }, deps);

  const toPerson = await saveVisit(db, draft({ place: { kind: "household", householdId: household.key, propertyType: "1", microAreaId: AREA }, person: { kind: "patient", patientId: benedita.clientUuid, sex: "female" } }), ctx());
  const toFamily = await saveVisit(db, draft({
    place: { kind: "household", householdId: household.key, propertyType: "1", microAreaId: AREA }, subject: "family_responsible", person: null, familyId: family.clientUuid, time: "11:00",
  }), ctx());
  const items = await outboxRepo.all(db);
  const first = items.find((i) => i.client_uuid === toPerson)!;
  expect(first.body).toMatchObject({ household_client_uuid: household.clientUuid, patient_client_uuid: benedita.clientUuid });
  expect(["household_id" in first.body, "patient_id" in first.body]).toEqual([false, false]);
  expect(first.depends_on).toEqual([{ client_uuid: household.clientUuid, kind: "cite" }, { client_uuid: benedita.clientUuid, kind: "cite" }]);
  const second = items.find((i) => i.client_uuid === toFamily)!;
  expect(second.body).toMatchObject({ household_client_uuid: household.clientUuid, subject: "family_responsible", family_client_uuid: family.clientUuid });
  expect("family_id" in second.body).toBe(false);
  expect(second.depends_on).toEqual([{ client_uuid: household.clientUuid, kind: "cite" }, { client_uuid: family.clientUuid, kind: "cite" }]);
  expectValid("upload-request", wire(items, { [family.clientUuid]: 1 }));
  // The sheet files the visit under the household's local key.
  expect(JSON.parse((await local(db))[0].summary).household).toBe(household.key);
});

// Review I1: once the registration was accepted the tablet knows the registration's id, not the patient's — until the
// next download. The person is still named by the client_uuid of the registration, which the server resolves.
test("a person registered here whose registration was accepted but not downloaded yet is still cited by client_uuid, with nothing to wait for", async () => {
  const db = await loadedTablet();
  const benedita = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, { newUuid, now: () => NOW });
  const [registration] = await outboxRepo.all(db);
  await applyResults(db, [registration], [accepted(registration, { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", version: 1 })], { onStale: async () => undefined });
  await saveVisit(db, draft({ person: { kind: "patient", patientId: benedita.clientUuid, sex: "female" } }), ctx());
  const [visit] = await outboxRepo.all(db);
  expect(visit.body.patient_client_uuid).toBe(benedita.clientUuid);
  expect("patient_id" in visit.body).toBe(false);
  expect(visit.depends_on).toEqual([]);
  expectValid("upload-request", wire([visit]));
});

test("a person typed in the visit itself is a patient item, and the visit cites it", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft({ person: { kind: "new", patient: BENEDITA, duplicatesReviewed: true } }), ctx());
  const items = await outboxRepo.all(db);
  expect(items.map((i) => i.type)).toEqual(["patient", "home_visit"]);
  expect(items[0].body).toEqual({ new_patient: BENEDITA, duplicates_reviewed: true });
  expect(items[1].client_uuid).toBe(uuid);
  expect(items[1].body.patient_client_uuid).toBe(items[0].client_uuid);
  expect("new_patient" in items[1].body).toBe(false);
  expect(items[1].depends_on).toEqual([{ client_uuid: items[0].client_uuid, kind: "cite" }]);
  expectValid("upload-request", wire(items));
});

test("a place with no registration: property type and micro-area, nobody, and the sheet has no household", async () => {
  const db = await loadedTablet();
  await saveVisit(db, draft({ place: { kind: "no_household", propertyType: "4", microAreaId: AREA, outOfArea: false }, subject: "none", person: null, reasons: [34, 37] }), ctx());
  const [item] = await outboxRepo.all(db);
  expect(item.body).toEqual({ team_id: TEAM, occurred_at: "2026-11-14T10:30:00-03:00", micro_area_id: AREA, property_type: "4", subject: "none", outcome: 1, reasons: [34, 37], shared: false });
  expectValid("upload-request", wire([item]));
  expect(JSON.parse((await local(db))[0].summary)).toEqual({ household: null, subject: "none", outcome: 1 });
});

test("today's sheet: the visits of the city's day, in order, with where they stand", async () => {
  const db = await loadedTablet();
  const first = await saveVisit(db, draft({ time: "09:00" }), ctx());
  const second = await saveVisit(db, draft({ time: "11:15", outcome: 3, reasons: [] }), ctx());
  await saveVisit(db, draft({ day: "2026-11-13", time: "16:00" }), ctx());
  const [sent] = await outboxRepo.all(db);
  await applyResults(db, [sent], [accepted(sent)], { onStale: async () => undefined });
  const sheet = await todayVisits(db, NOW);
  expect(sheet.map((v) => [v.clientUuid, v.time, v.state, v.householdKey, v.outcome])).toEqual([[first, "09:00", "accepted", HH, 1], [second, "11:15", "pending", HH, 3]]);
});

test("withdrawing a visit that was never sent erases it from the line and from the sheet", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft(), ctx());
  expect(NOT_SENT_WILL_BE_ERASED).toBe("Esta visita ainda não foi enviada e será apagada");
  expect(await withdrawVisit(db, uuid, "", { newUuid })).toBe("erased");
  expect(await outboxRepo.all(db)).toEqual([]);
  expect(await local(db)).toEqual([]);
});

test("withdrawing a visit the server accepted is a withdrawal item with the reason; the sheet changes only when it is accepted", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft(), ctx());
  const [visit] = await outboxRepo.all(db);
  await applyResults(db, [visit], [accepted(visit)], { onStale: async () => undefined });

  await expect(withdrawVisit(db, uuid, "errei", { newUuid })).rejects.toThrow("escreva de 10 a 500 caracteres");
  expect(await withdrawVisit(db, uuid, "  Visita registrada no domicílio errado.  ", { newUuid })).toBe("queued");
  const [item] = await outboxRepo.all(db);
  expect([item.type, item.body]).toEqual(["home_visit_withdrawal", { visit_client_uuid: uuid, reason: "Visita registrada no domicílio errado." }]);
  expectValid("upload-request", wire([item]));
  expect((await local(db))[0].state).toBe("accepted");
  // Asking twice does not queue two.
  expect(await withdrawVisit(db, uuid, "Visita registrada no domicílio errado.", { newUuid })).toBe("queued");
  expect(await outboxRepo.all(db)).toHaveLength(1);
  await applyResults(db, [item], [accepted(item)], { onStale: async () => undefined });
  expect((await local(db))[0].state).toBe("withdrawn");
});

// The database with one statement that fails: the nth run whose SQL matches. Inside a transaction too.
function failingOn(db: Db, sql: RegExp, nth: number): Db {
  let seen = 0;
  const wrap = (inner: Db): Db => ({
    exec: (text) => inner.exec(text),
    run: async (text, params) => {
      if (sql.test(text) && ++seen === nth) throw new Error("disk I/O error");
      return inner.run(text, params);
    },
    all: (text, params) => inner.all(text, params),
    get: (text, params) => inner.get(text, params),
    tx: (fn) => inner.tx((handle) => fn(wrap(handle))),
    close: () => inner.close(),
  });
  return wrap(db);
}

// Q82(3c): erasing a visit takes the visit's item, the person typed only for it and the line of the sheet. Half of
// it would leave that person in the line to be created at the station for a visit that no longer exists.
test("erasing a visit that was never sent is all or nothing: a failure in the middle leaves the line and the sheet as they were", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft({ person: { kind: "new", patient: BENEDITA, duplicatesReviewed: true } }), ctx());
  const before = (await outboxRepo.all(db)).map((item) => [item.type, item.client_uuid]);
  expect(before.map(([type]) => type)).toEqual(["patient", "home_visit"]);

  // The visit's item leaves the line; taking the typed person fails.
  await expect(withdrawVisit(failingOn(db, /^DELETE FROM outbox WHERE seq/, 2), uuid, "", { newUuid })).rejects.toThrow("disk I/O error");
  expect((await outboxRepo.all(db)).map((item) => [item.type, item.client_uuid])).toEqual(before);
  expect((await local(db)).map((row) => row.client_uuid)).toEqual([uuid]);

  // And whole when nothing fails.
  expect(await withdrawVisit(db, uuid, "", { newUuid })).toBe("erased");
  expect(await outboxRepo.all(db)).toEqual([]);
  expect(await local(db)).toEqual([]);
});

test("a visit on its way to the server cannot be erased: the screen says to try again", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft(), ctx());
  const [item] = await outboxRepo.all(db);
  await outboxRepo.update(db, item.seq, { state: "sending" });
  await expect(withdrawVisit(db, uuid, "", { newUuid })).rejects.toThrow(VISIT_BEING_SENT);
  expect(await local(db)).toHaveLength(1);
});
