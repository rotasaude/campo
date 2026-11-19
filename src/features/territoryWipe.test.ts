// Review I5: the copy of the territory may be erased (30 days without a full download, a change of scope, a suspension
// followed by a new QR) while the tablet still owes the server what was registered on it. The queue is never touched —
// so what the queue still points to on the tablet must survive too, and nothing may go out malformed meanwhile.
import type { ChangesResponse, UploadItem } from "../contract";
import { example } from "../contract/fixtures";
import { outboxRepo } from "../db/repos/outboxRepo";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../rules/homeVisit";
import { createRegistryRules } from "../rules/registry";
import { registrationDictionaries } from "../rules/testing/dictionaries";
import { wipeTerritory } from "../security/wipe";
import { applyResults, sendQueue } from "../sync/dispatch";
import { applyPage } from "../sync/download";
import { accepted, fakeClient, newUuid } from "../sync/testing";
import { saveFamily } from "./families/save";
import { saveHousehold } from "./households/save";
import { listHouseholds, readHousehold } from "./households/view";
import { saveRegistration, type RegistrationFields } from "./registrations/save";
import { readRegistration } from "./registrations/view";
import { AREA, HH, loadedTablet } from "./testing";
import { saveVisit, todayVisits } from "./visits/save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const REG = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";
const deps = { newUuid, now: () => NOW };
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const noStale = { onStale: async () => { throw new Error("unexpected stale_version"); } };
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, no_cpf_reason: "2" };
const person: RegistrationFields = { is_responsible: false, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const visit = (householdKey: string, time: string): VisitDraft => ({
  ...emptyVisitDraft(), day: "2026-11-14", time, place: { kind: "household", householdId: householdKey, propertyType: "1", microAreaId: AREA }, subject: "none", outcome: 3,
});
const visitCtx = () => ({ clientUuid: newUuid(), teamId: TEAM, location: null, visitBody: rules.visitBody, newUuid, now: () => NOW, vectorInspection: null });

test("erasing the territory keeps what was born on the tablet and is still in the line — and only that", async () => {
  const db = await loadedTablet();
  const home = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const benedita = await saveRegistration(db, { householdKey: home.key, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, deps);
  const sent = await saveVisit(db, visit(HH, "09:00"), visitCtx());
  const [, , accepting] = await outboxRepo.all(db);
  await applyResults(db, [accepting], [accepted(accepting)], noStale);
  const waiting = await saveVisit(db, visit(home.key, "10:30"), visitCtx());

  await wipeTerritory(db);
  // The server's copy is gone…
  expect(await readHousehold(db, HH)).toBeNull();
  expect(await readRegistration(db, REG)).toBeNull();
  expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM micro_areas"))!.n).toBe(0);
  // …what the line still points to is not: the "Corrigir" of a refused creation still has its form.
  expect((await listHouseholds(db)).map((h) => h.key)).toEqual([home.key]);
  expect((await readRegistration(db, benedita.key))!.body.patient.full_name).toBe("Benedita Aparecida Rocha");
  // Today's sheet keeps the visit still to be sent; the one the server has comes back with the next download, not from here.
  expect((await todayVisits(db, NOW)).map((v) => v.clientUuid)).toEqual([waiting]);
  expect(sent).not.toBe(waiting);
  expect(await outboxRepo.count(db)).toBe(3);
});

test("an item that takes its version from a row that is gone waits for the download instead of going out without it", async () => {
  const db = await loadedTablet();
  // A new family in a downloaded household: it travels with the household's version, read from the row when it is sent.
  await saveFamily(db, { householdKey: HH, responsibleKey: REG, fields: { income_band: null, members_count: 1, living_since: null } }, deps);
  await wipeTerritory(db);

  const { client, batches, uploads } = fakeClient((items: UploadItem[]) => items.map((item) => accepted(item, { version: 4 })));
  expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: null });
  expect(uploads).not.toHaveBeenCalled();
  expect((await outboxRepo.all(db)).map((item) => [item.type, item.state])).toEqual([["family", "pending"]]);

  // The download brings the household back: now the item has its version and goes.
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: null });
  expect(batches[0][0]).toMatchObject({ type: "family", body: { household_id: HH, version: 3 } });
  expect(await outboxRepo.count(db)).toBe(0);
});
