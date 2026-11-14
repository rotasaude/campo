import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { applyResults } from "../../sync/dispatch";
import { accepted, newUuid } from "../../sync/testing";
import { saveHousehold } from "../households/save";
import { readHousehold } from "../households/view";
import { saveRegistration, type RegistrationFields } from "../registrations/save";
import { readRegistration } from "../registrations/view";
import { AREA, HH, loadedTablet } from "../testing";
import { FAMILY_CONFLICT_PENDING, responsibleOptions, saveFamily } from "./save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const deps = { newUuid, now: () => NOW };
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2", cns: "702000000000001" };
const person: RegistrationFields = { is_responsible: true, refused: false, patient_demographics: { race_color: "01", ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const wire = (items: { client_uuid: string; type: string; body: Record<string, unknown> }[], versions: Record<string, number> = {}) =>
  ({ items: items.map(({ client_uuid, type, body }) => ({ client_uuid, type, body: client_uuid in versions ? { ...body, version: versions[client_uuid] } : body })) });
const baseVersion = async (db: Db, key: string) => (await db.get<{ base_version: number | null }>("SELECT base_version FROM households WHERE key = ?", [key]))!.base_version;

test("edit of a family: family_id, the household as target and the family as the server has it as the edit base", async () => {
  const db = await loadedTablet();
  const saved = await saveFamily(db, { householdKey: HH, familyId: FAMILY, fields: { income_band: "4", members_count: 4, living_since: "2019-03", moved_out: false } }, deps);
  const [item] = await outboxRepo.all(db);
  expect([item.type, item.target_id, item.client_uuid, item.edit_base_version]).toEqual(["family", HH, saved.clientUuid, await baseVersion(db, HH)]);
  expect(item.body).toEqual({ household_id: HH, family_id: FAMILY, income_band: "4", members_count: 4, living_since: "2019-03", moved_out: false });
  // "Since" is compared as a month on every side (the download gives a day, the upload takes a month).
  expect(item.edit_base_body).toEqual({ income_band: "3", members_count: 3, living_since: "2019-03", moved_out: false });
  expectValid("upload-request", wire([item], { [item.client_uuid]: 3 }));
  // On screen at once, inside its household.
  const family = (await readHousehold(db, HH))!.body.families.find((f) => f.id === FAMILY)!;
  expect([family.income_band, family.members_count, family.responsible.display_name]).toEqual(["4", 4, "Joana Conceição"]);
  expect((await readHousehold(db, HH))!.pending).toBe(true);

  // A second edit while the first waits is the same item.
  const again = await saveFamily(db, { householdKey: HH, familyId: FAMILY, fields: { income_band: "5", members_count: 4, living_since: "2019-03", moved_out: false } }, deps);
  const items = await outboxRepo.all(db);
  expect([items.length, again.clientUuid, items[0].body.income_band]).toEqual([1, saved.clientUuid, "5"]);
});

test("the responsible of a new family is chosen among the residents of the household: downloaded or registered on this tablet", async () => {
  const db = await loadedTablet();
  const born = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, deps);
  const options = await responsibleOptions(db, HH);
  expect(options).toEqual(expect.arrayContaining([
    { registrationKey: "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d", name: "Joana Conceição", patientId: JOANA, bornHere: false },
    { registrationKey: born.key, name: "Benedita Aparecida Rocha", patientId: null, bornHere: true },
  ]));
  // Nobody of another household.
  const other = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  expect(await responsibleOptions(db, other.key)).toEqual([]);
});

test("a new family headed by a downloaded resident: responsible.patient_id, nested (Q1)", async () => {
  const db = await loadedTablet();
  const saved = await saveFamily(db, { householdKey: HH, responsibleKey: "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d", fields: { income_band: "3", members_count: 2, living_since: "2026-11" } }, deps);
  const [item] = await outboxRepo.all(db);
  expect(item.body).toEqual({ household_id: HH, responsible: { patient_id: JOANA }, income_band: "3", members_count: 2, living_since: "2026-11" });
  expect([item.target_id, item.depends_on, item.edit_base_body]).toEqual([HH, [], null]);
  expectValid("upload-request", wire([item], { [item.client_uuid]: 3 }));
  const families = (await readHousehold(db, HH))!.body.families;
  expect(families.map((f) => f.id)).toEqual([FAMILY, saved.clientUuid]);
  expect(families[1]).toMatchObject({ responsible: { patient_id: JOANA, display_name: "Joana Conceição" }, members_count: 2, moved_out: false });
});

test("household, person and family all born on the tablet: the family cites both and the batch is what the contract shows", async () => {
  const db = await loadedTablet();
  const household = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const benedita = await saveRegistration(db, { householdKey: household.key, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, deps);
  const family = await saveFamily(db, { householdKey: household.key, responsibleKey: benedita.key, fields: { income_band: "3", members_count: 1, living_since: "2026-11" } }, deps);
  const items = await outboxRepo.all(db);
  expect(items.map((i) => i.type)).toEqual(["household", "individual_registration", "family"]);
  expect(items[2].body).toEqual({
    household_client_uuid: household.clientUuid, responsible: { patient_client_uuid: benedita.clientUuid }, income_band: "3", members_count: 1, living_since: "2026-11",
  });
  // It waits for the household's version (the creation's answer) and cites the person's registration.
  expect(items[2].depends_on).toEqual([{ client_uuid: household.clientUuid, kind: "version" }, { client_uuid: benedita.clientUuid, kind: "cite" }]);
  expect(items[2].target_id).toBe(household.key);
  expectValid("upload-request", wire(items, { [family.clientUuid]: 1 }));

  // On screen: the family with its responsible by name, and the person now in that family as its responsible.
  const view = (await readHousehold(db, household.key))!;
  expect(view.body.families).toEqual([expect.objectContaining({ id: family.clientUuid, responsible: { patient_id: benedita.clientUuid, display_name: "Benedita Aparecida Rocha" }, members_count: 1 })]);
  const registration = (await readRegistration(db, benedita.key))!;
  expect([registration.body.family_id, registration.body.is_responsible]).toEqual([family.clientUuid, true]);
});

test("accepted: the family takes the server's id inside its household, and so do the people who were in it", async () => {
  const db = await loadedTablet();
  const benedita = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, deps);
  const family = await saveFamily(db, { householdKey: HH, responsibleKey: benedita.key, fields: { income_band: "3", members_count: 1, living_since: "2026-11" } }, deps);
  const item = (await outboxRepo.all(db)).find((i) => i.type === "family")!;
  const NEW_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
  await applyResults(db, [{ ...item, sent_version: 3 }], [accepted(item, { id: NEW_ID, version: 4 })], { onStale: async () => undefined });

  expect(await baseVersion(db, HH)).toBe(4);
  const view = (await readHousehold(db, HH))!;
  expect(view.body.families.map((f) => f.id)).toEqual([FAMILY, NEW_ID]);
  expect(view.body.version).toBe(4);
  expect((await readRegistration(db, benedita.key))!.body.family_id).toBe(NEW_ID);
  expect(await db.get("SELECT household_key FROM families WHERE id = ?", [NEW_ID])).toEqual({ household_key: HH });
  expect(await db.get("SELECT id FROM families WHERE id = ?", [family.clientUuid])).toBeNull();
});

test("a household with something in conflict takes no family edit until the conflict is solved", async () => {
  const db = await loadedTablet();
  await saveFamily(db, { householdKey: HH, familyId: FAMILY, fields: { income_band: "4", members_count: 4, living_since: "2019-03", moved_out: false } }, deps);
  const [item] = await outboxRepo.all(db);
  await outboxRepo.update(db, item.seq, { state: "conflict", conflicts: [{ field: "income_band", base: "3", tablet: "4", station: "5" }] as never });
  await expect(saveFamily(db, { householdKey: HH, familyId: FAMILY, fields: { income_band: "6", members_count: 4, living_since: "2019-03", moved_out: false } }, deps))
    .rejects.toThrow(FAMILY_CONFLICT_PENDING);
});

test("the responsible must be somebody of that household", async () => {
  const db = await loadedTablet();
  const other = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  await expect(saveFamily(db, { householdKey: other.key, responsibleKey: "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d", fields: { income_band: null, members_count: 1, living_since: null } }, deps))
    .rejects.toThrow("o responsável não mora neste domicílio");
});
