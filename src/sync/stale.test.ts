import type { AnimalBody, HouseholdBody, RegistrationBody, UploadResponse, UploadResult } from "../contract";
import { example } from "../contract/fixtures";
import { outboxRepo } from "../db/repos/outboxRepo";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { familyEditable, householdEditable, registrationEditable } from "./editable";
import { MissingChoiceError } from "./merge";
import { enqueue } from "./outbox";
import { handleStale, resolveConflict } from "./stale";
import { insertHousehold, insertRegistration, newUuid } from "./testing";
import { saveAnimal } from "../features/animals/save";
import { phraseForItem } from "../features/messages/errorPhrases";
import { ANIMAL, HH as ZOO_HH, JOANA, zoonosesTablet } from "../features/testing";
import { emptyAnimalDraft } from "../rules/animal";
import { ZOONOSES_ERRORS } from "../rules/zoonosesErrors";

const result = (file: string) => example<UploadResponse>(file).results[0];
const STALE_HOUSEHOLD = result("upload-response-stale-household.json");
const STALE_FAMILY = result("upload-response-stale-family.json");
const STALE_REGISTRATION = result("upload-response-stale-registration.json");
const HH = STALE_HOUSEHOLD.current as unknown as HouseholdBody; // the station's household, version 4
const HH5 = STALE_FAMILY.current as unknown as HouseholdBody; // the same household at version 5
const REG = STALE_REGISTRATION.current as unknown as RegistrationBody; // version 3
const FAMILY_ID = HH5.families[0].id;

const rowOf = <T>(db: Db, table: string, key: string) => db.get<T>(`SELECT * FROM ${table} WHERE key = ?`, [key]);
type Row = { body: string; version: number; base_version: number; base_body: string; needs_reload: number };

// What the person saw when the edit began: the station's body with other values in the fields under test.
const baseOf = (over: Record<string, unknown>) => ({ ...householdEditable(HH), ...over });

async function staleHousehold(local: Record<string, unknown>, base: Record<string, unknown>) {
  const db = await createTestDb();
  await insertHousehold(db, "hh-key", { id: HH.id, baseVersion: 3 });
  await db.run("UPDATE households SET needs_reload = 1 WHERE key = 'hh-key'");
  const item = await enqueue(db, {
    type: "household", targetId: "hh-key", editBase: { version: 3, body: base },
    body: { household_id: HH.id, micro_area_id: HH.micro_area.id, property_type: HH.property_type, refused: false, address: HH.address, living_conditions: {}, ...local },
  }, newUuid);
  await outboxRepo.update(db, item.seq, { state: "sending", sent_version: 3 });
  await handleStale(db, (await outboxRepo.bySeq(db, item.seq))!, STALE_HOUSEHOLD);
  return { db, item, after: (await outboxRepo.bySeq(db, item.seq))! };
}

test("household without conflict goes back to pending on the current version, same client_uuid", async () => {
  // The tablet changed the phone (the station still has the base's); the station changed the property type (the base had another).
  const { db, item, after } = await staleHousehold({ contact_phone: "41988887777" }, baseOf({ property_type: "2" }));
  expect(after).toMatchObject({ client_uuid: item.client_uuid, state: "pending", edit_base_version: 4, conflicts: null, error: null });
  expect(after.body).toMatchObject({ household_id: HH.id, contact_phone: "41988887777", property_type: HH.property_type });
  expect(after.body).not.toHaveProperty("version"); // filled at send time
  expect(after.edit_base_body).toEqual(householdEditable(HH));
  // The row is now the station's.
  const row = (await rowOf<Row>(db, "households", "hh-key"))!;
  expect([row.version, row.base_version, row.needs_reload]).toEqual([4, 4, 0]);
  expect(JSON.parse(row.body)).toEqual(HH);
  expect(JSON.parse(row.base_body)).toEqual(householdEditable(HH));
});

test("a field the tablet does not send is never a conflict and is not sent back", async () => {
  // The item has no `status` and no `location`; the station has both. Absent in the upload means "keep".
  const { after } = await staleHousehold({ contact_phone: "41988887777" }, baseOf({ location: null, status: "inactive" }));
  expect(after.state).toBe("pending");
  expect(Object.keys(after.body).sort()).toEqual(["address", "contact_phone", "household_id", "living_conditions", "micro_area_id", "property_type", "refused"]);
});

test("the station changed only a key the tablet does not send: nobody is asked and the station's value stays (Q69)", async () => {
  // The person saw the household inactive and without a point; the station reactivated it and marked the point.
  // The item sends neither `status` nor `location`, and what it does send is what the station still has.
  const { db, after } = await staleHousehold({ contact_phone: HH.contact_phone }, baseOf({ status: "inactive", location: null }));
  expect(after).toMatchObject({ state: "pending", conflicts: null, error: null, edit_base_version: 4 });
  expect(after.body).not.toHaveProperty("status");
  expect(after.body).not.toHaveProperty("location");
  const row = JSON.parse((await rowOf<Row>(db, "households", "hh-key"))!.body) as HouseholdBody;
  expect([row.status, row.location]).toEqual([HH.status, HH.location]);
  expect(JSON.parse((await rowOf<Row>(db, "households", "hh-key"))!.base_body)).toMatchObject({ status: HH.status, location: HH.location });
});

test("household with conflict waits for the person, carrying both values", async () => {
  const { after } = await staleHousehold({ contact_phone: "41988887777" }, baseOf({ contact_phone: "4100" }));
  expect(after.state).toBe("conflict");
  expect(after.conflicts).toEqual([{ path: "contact_phone", station: HH.contact_phone, tablet: "41988887777" }]);
  expect(after.edit_base_version).toBe(4);
});

test("resolveConflict needs a choice for every field and then sends the chosen side", async () => {
  const { db, item } = await staleHousehold({ contact_phone: "41988887777" }, baseOf({ contact_phone: "4100" }));
  await expect(resolveConflict(db, item.seq, {})).rejects.toBeInstanceOf(MissingChoiceError);
  expect((await outboxRepo.bySeq(db, item.seq))!.state).toBe("conflict");

  await resolveConflict(db, item.seq, { contact_phone: "tablet" });
  const resolved = (await outboxRepo.bySeq(db, item.seq))!;
  expect(resolved).toMatchObject({ state: "pending", conflicts: null, client_uuid: item.client_uuid, edit_base_version: 4 });
  expect(resolved.body).toMatchObject({ household_id: HH.id, contact_phone: "41988887777" });

  const again = await staleHousehold({ contact_phone: "41988887777" }, baseOf({ contact_phone: "4100" }));
  await resolveConflict(again.db, again.item.seq, { contact_phone: "station" });
  expect((await outboxRepo.bySeq(again.db, again.item.seq))!.body.contact_phone).toBe(HH.contact_phone);
  // Only an item in conflict is resolved.
  await expect(resolveConflict(again.db, again.item.seq, { contact_phone: "tablet" })).rejects.toThrow();
});

async function staleFamily(body: Record<string, unknown>, base: Record<string, unknown> | null) {
  const db = await createTestDb();
  await insertHousehold(db, "hh-key", { id: HH5.id, baseVersion: 4 });
  const item = await enqueue(db, { type: "family", targetId: "hh-key", body, ...(base ? { editBase: { version: 4, body: base } } : {}) }, newUuid);
  await outboxRepo.update(db, item.seq, { state: "sending", sent_version: 4 });
  await handleStale(db, (await outboxRepo.bySeq(db, item.seq))!, STALE_FAMILY);
  return { db, item, after: (await outboxRepo.bySeq(db, item.seq))! };
}

test("existing family merges the family's own fields against the family inside the current household", async () => {
  const station = familyEditable(HH5, FAMILY_ID)!;
  const { db, after } = await staleFamily(
    { household_id: HH5.id, family_id: FAMILY_ID, income_band: "5", members_count: station.members_count, living_since: station.living_since, moved_out: false },
    { ...station, income_band: "1" });
  // Both changed the income band, differently.
  expect(after.state).toBe("conflict");
  expect(after.conflicts).toEqual([{ path: "income_band", station: station.income_band, tablet: "5" }]);
  expect(after.edit_base_body).toEqual(station);
  expect(after.body).toMatchObject({ household_id: HH5.id, family_id: FAMILY_ID });
  // The id of a family's stale answer is the household (Q4): the row is the household's.
  const row = (await rowOf<Row>(db, "households", "hh-key"))!;
  expect([row.version, row.base_version]).toEqual([5, 5]);
  expect(JSON.parse(row.base_body)).toEqual(householdEditable(HH5));
});

test("existing family without conflict goes back to pending with the merged fields", async () => {
  const station = familyEditable(HH5, FAMILY_ID)!;
  const { after } = await staleFamily(
    { household_id: HH5.id, family_id: FAMILY_ID, income_band: station.income_band, members_count: 9, living_since: station.living_since, moved_out: false },
    // The tablet changed the members (the station still has the base's); the station changed the income band (the base had another).
    { ...station, income_band: "1" });
  expect(after).toMatchObject({ state: "pending", edit_base_version: 5 });
  expect(after.body).toMatchObject({ members_count: 9, income_band: station.income_band });
});

test("new family only moves to the household's current version", async () => {
  const body = { household_id: HH5.id, responsible: { patient_id: HH5.families[0].responsible.patient_id }, income_band: "2", members_count: 2, living_since: "2026-11" };
  const { after } = await staleFamily(body, null);
  expect(after).toMatchObject({ state: "pending", edit_base_version: 5, body });
});

test("family that is no longer in the household needs attention: family_not_found (Q43)", async () => {
  const { db, after } = await staleFamily(
    { household_id: HH5.id, family_id: "00000000-0000-4000-8000-00000000dead", income_band: "5", members_count: 1, living_since: null, moved_out: false },
    { income_band: "1", members_count: 1, living_since: null, moved_out: false });
  expect(after).toMatchObject({ state: "needs_attention", error: "family_not_found", path: "family_id" });
  expect((await rowOf<Row>(db, "households", "hh-key"))!.version).toBe(5); // the row still receives the current household
});

test("registration merges section by section and keeps who it is about", async () => {
  const db = await createTestDb();
  await insertRegistration(db, "rg-key", { id: REG.id, baseVersion: 2 });
  const base = { ...registrationEditable(REG), is_responsible: false, patient_demographics: { race_color: "01", ethnicity: null } };
  const item = await enqueue(db, {
    type: "individual_registration", targetId: "rg-key", editBase: { version: 2, body: base },
    body: { registration_id: REG.id, patient_id: REG.patient.id, ...registrationEditable(REG), is_responsible: false, patient_demographics: { race_color: "04", ethnicity: null } },
  }, newUuid);
  await outboxRepo.update(db, item.seq, { state: "sending", sent_version: 2 });
  await handleStale(db, (await outboxRepo.bySeq(db, item.seq))!, STALE_REGISTRATION);
  const after = (await outboxRepo.bySeq(db, item.seq))!;
  // The station changed is_responsible (the tablet did not): no conflict there. Both changed race_color: one conflict, on the whole field.
  expect(after.state).toBe("conflict");
  expect(after.conflicts).toEqual([{ path: "patient_demographics", station: REG.patient_demographics, tablet: { race_color: "04", ethnicity: null } }]);
  expect(after.body).toMatchObject({ registration_id: REG.id, patient_id: REG.patient.id, is_responsible: REG.is_responsible });
  const row = (await rowOf<Row>(db, "registrations", "rg-key"))!;
  expect([row.version, row.base_version, row.needs_reload]).toEqual([3, 3, 0]);
  expect(JSON.parse(row.base_body)).toEqual(registrationEditable(REG));
});

test("an answer without the current record cannot be merged: the item asks for attention instead of guessing", async () => {
  const db = await createTestDb();
  await insertHousehold(db, "hh-key", { baseVersion: 3 });
  const item = await enqueue(db, { type: "household", targetId: "hh-key", editBase: { version: 3, body: {} }, body: { household_id: HH.id } }, newUuid);
  const broken = { client_uuid: item.client_uuid, status: "stale_version", type: "household", id: HH.id } as UploadResult;
  await handleStale(db, item, broken);
  expect(await outboxRepo.bySeq(db, item.seq)).toMatchObject({ state: "needs_attention", error: "invalid_request" });
});

describe("animal (Q20: no merge)", () => {
  const STALE_ANIMAL = result("upload-response-stale-animal.json");
  const CURRENT = STALE_ANIMAL.current as unknown as AnimalBody; // the station's animal, version 3

  test("stale_version on an animal replaces the row by current, keeps the tablet body, no merge, needs attention on current_version", async () => {
    const db = await zoonosesTablet();
    await saveAnimal(db, {
      householdKey: ZOO_HH, animalKey: ANIMAL, newUuid,
      draft: { ...emptyAnimalDraft(), species: "dog", sex: "female", name: "Rex", tutorKey: JOANA }, status: "missing", today: "2026-11-24",
    });
    const [item] = await outboxRepo.all(db);
    await outboxRepo.update(db, item.seq, { state: "sending", sent_version: 2 });
    await handleStale(db, (await outboxRepo.bySeq(db, item.seq))!, STALE_ANIMAL);

    const row = await db.get<{ version: number; base_version: number; body: string }>("SELECT version, base_version, body FROM animals WHERE key = ?", [ANIMAL]);
    expect(row).toMatchObject({ version: 3, base_version: 3 });
    expect(JSON.parse(row!.body)).toEqual(CURRENT);
    const after = (await outboxRepo.bySeq(db, item.seq))!;
    expect(after).toMatchObject({
      client_uuid: item.client_uuid, state: "needs_attention", error: "animal_changed", path: null, edit_base_version: 3, conflicts: null,
    });
    expect(after.edit_base_body).toEqual(CURRENT);
    // The tablet's body as it was typed: nothing of the station's is merged into it.
    expect(after.body).toEqual(item.body);
    expect(phraseForItem(after.error, after)).toBe(ZOONOSES_ERRORS.animal_changed);
  });

  test("the current record never brings a microchip number into the row or the edit base", async () => {
    const db = await zoonosesTablet();
    await saveAnimal(db, { householdKey: ZOO_HH, animalKey: ANIMAL, newUuid, draft: { ...emptyAnimalDraft(), species: "dog", sex: "female" } });
    const [item] = await outboxRepo.all(db);
    const leaky = { ...STALE_ANIMAL, current: { ...CURRENT, microchip: "985141000123456", registry_number: "R-1" } } as unknown as UploadResult;
    await handleStale(db, item, leaky);
    expect(JSON.stringify(await db.all("SELECT * FROM animals"))).not.toContain("985141000123456");
    expect(JSON.stringify(await db.all("SELECT * FROM outbox"))).not.toContain("985141000123456");
    expect(JSON.stringify(await db.all("SELECT * FROM outbox"))).not.toContain("R-1");
  });

  test("stale_version on a household still merges as in the 24c", async () => {
    const { db, item, after } = await staleHousehold({ contact_phone: "41999990000" }, baseOf({}));
    expect(after).toMatchObject({ client_uuid: item.client_uuid, state: "pending", edit_base_version: 4, conflicts: null, error: null });
    expect(after.body.contact_phone).toBe("41999990000");
    expect(after.edit_base_body).toEqual(householdEditable(HH));
    expect(await rowOf<Row>(db, "households", "hh-key")).toMatchObject({ version: 4, needs_reload: 0 });
  });
});
