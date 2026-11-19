import { outboxRepo } from "../../db/repos/outboxRepo";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { applyResults } from "../../sync/dispatch";
import { applyPage } from "../../sync/download";
import { accepted, newUuid, rejected } from "../../sync/testing";
import { AREA, BLOCK, HH, NEIGHBORHOOD, endemicTablet, loadedTablet } from "../testing";
import { saveVisit, withdrawVisit } from "../visits/save";
import { readInspectionFacts, readProfile } from "./profile";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const visit = (o: Partial<VisitDraft> = {}): VisitDraft => ({
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: HH, propertyType: "1", microAreaId: AREA },
  subject: "none", outcome: 1, ...o,
});
const NO_PROFILE = { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: null, last_situation: null };
const save = (db: Awaited<ReturnType<typeof loadedTablet>>, inspection: Record<string, unknown>, o: Partial<VisitDraft> = {}) => saveVisit(db, visit(o), {
  clientUuid: newUuid(), teamId: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", location: null, visitBody: rules.visitBody, newUuid, now: () => NOW,
  vectorInspection: { activity: "li", work_type: "routine", situation: "worked", educational_action: false, ...inspection } as never,
});

test("a queued inspection that sets the block shows it in the profile before the download", async () => {
  const db = await endemicTablet({ household: { vector: NO_PROFILE, address: { zip: "80010000", street_type: "081", street: "das Flores", number: "120", no_number: false, complement: null, neighborhood_id: NEIGHBORHOOD, district: "Centro", reference: null } } });
  expect(await readProfile(db, HH)).toEqual({ city_block_id: null, risk_class: null, last_worked_on: null, last_situation: null });

  await save(db, { city_block_id: BLOCK, risk_class: "red" });
  expect(await readProfile(db, HH)).toEqual({ city_block_id: BLOCK, risk_class: "red", last_worked_on: null, last_situation: null });
  // Accepted and not downloaded yet: still the block and the risk it set; a later visit reclassifies the risk only.
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [accepted(item)], { onStale: async () => undefined });
  await save(db, { risk_class: "green" }, { time: "11:00" });
  expect(await readProfile(db, HH)).toMatchObject({ city_block_id: BLOCK, risk_class: "green" });
  // A visit erased from the line no longer counts.
  const second = (await outboxRepo.all(db)).find((i) => i.type === "home_visit")!;
  await withdrawVisit(db, second.client_uuid, "", { newUuid });
  expect(await readProfile(db, HH)).toMatchObject({ city_block_id: BLOCK, risk_class: "red" });
});

test("vector absent or null → no profile", async () => {
  // The ACS tablet: the gate is off in the city and the household has no `vector`.
  const acs = await loadedTablet();
  expect(await readProfile(acs, HH)).toBeNull();
  const none = await endemicTablet({ household: { vector: null } });
  expect(await readProfile(none, HH)).toBeNull();
  expect(await readProfile(none, "no-such-household")).toBeNull();
  // With a profile, as the download brought it.
  expect(await readProfile(await endemicTablet(), HH)).toEqual({ city_block_id: BLOCK, risk_class: "yellow", last_worked_on: "2026-11-03", last_situation: "worked" });
});

// Review I1: only what still waits in the line overlays; an accepted bulletin only fills what the download left null.
const WITH_NEIGHBORHOOD = { vector: NO_PROFILE, address: { zip: "80010000", street_type: "081", street: "das Flores", number: "120", no_number: false, complement: null, neighborhood_id: NEIGHBORHOOD, district: "Centro", reference: null } };
const OTHER_BLOCK = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
// The station's household HH as the next download brings it, with this profile.
async function downloaded(db: Awaited<ReturnType<typeof loadedTablet>>, vector: Record<string, unknown>) {
  const page = example<ChangesResponse>("changes-vector-page.json");
  const items = page.items.filter((item) => item.type === "household").map((item) => ({ ...item, version: 4, body: { ...item.body, ...WITH_NEIGHBORHOOD, vector, version: 4 } }));
  await applyPage(db, { ...page, items } as unknown as ChangesResponse);
}

test("a pending bulletin overlays the downloaded profile", async () => {
  const db = await endemicTablet({ household: WITH_NEIGHBORHOOD });
  await save(db, { city_block_id: BLOCK, risk_class: "red" });
  expect(await readProfile(db, HH)).toMatchObject({ city_block_id: BLOCK, risk_class: "red" });
  // Waiting behind what it cites, it still waits.
  const [item] = await outboxRepo.all(db);
  await outboxRepo.update(db, item.seq, { state: "blocked" });
  expect(await readProfile(db, HH)).toMatchObject({ city_block_id: BLOCK, risk_class: "red" });
  expect((await readInspectionFacts(db, HH)).blocks).toBeNull();
});

test("a refused bulletin does not claim the household has a block in its profile", async () => {
  const db = await endemicTablet({ household: WITH_NEIGHBORHOOD });
  await save(db, { city_block_id: BLOCK, risk_class: "red" });
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [rejected(item, "block_not_in_household_neighborhood", { path: "vector_inspection.city_block_id" })], { onStale: async () => undefined });
  expect(await readProfile(db, HH)).toEqual({ city_block_id: null, risk_class: null, last_worked_on: null, last_situation: null });
  // So the next visit offers the block again.
  expect((await readInspectionFacts(db, HH)).blocks?.map((b) => b.id)).toEqual([BLOCK]);
});

test("an accepted bulletin does not override a newer download; it only fills what the download left null", async () => {
  const db = await endemicTablet({ household: WITH_NEIGHBORHOOD });
  await save(db, { city_block_id: BLOCK, risk_class: "red" });
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [accepted(item)], { onStale: async () => undefined });
  // The coordination moved the household to another block and reclassified it, after the acceptance.
  await downloaded(db, { ...NO_PROFILE, city_block_id: OTHER_BLOCK, risk_class: "yellow" });
  expect(await readProfile(db, HH)).toMatchObject({ city_block_id: OTHER_BLOCK, risk_class: "yellow" });
  // A download that has not caught up yet (null): the accepted bulletin fills it.
  await downloaded(db, { ...NO_PROFILE, risk_class: "green" });
  expect(await readProfile(db, HH)).toMatchObject({ city_block_id: BLOCK, risk_class: "green" });
});
