import type { AnimalBody } from "../../contract";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { emptyAnimalDraft, type AnimalDraft } from "../../rules/animal";
import { enqueue } from "../../sync/outbox";
import { insertHousehold, newUuid } from "../../sync/testing";
import { ANIMAL, HH, JOANA, bornResident, zoonosesTablet } from "../testing";
import { saveAnimal } from "./save";
import { readAnimal } from "./view";

const CHIP = "985141000123456";
const BORN_HH = "c0ffee70-0000-4000-8000-000000000070";
const BENEDITA = "c0ffee71-0000-4000-8000-000000000071";
const TODAY = "2026-11-24";

const draft = (over: Partial<AnimalDraft> = {}): AnimalDraft => ({ ...emptyAnimalDraft(), species: "dog", sex: "female", ...over });
const animalItems = async (db: Db) => (await outboxRepo.all(db)).filter((item) => item.type === "animal");
const rowOf = async (db: Db, key: string) => {
  const row = await db.get<{ id: string | null; client_uuid: string | null; household_key: string; status: string; version: number | null; body: string }>(
    "SELECT id, client_uuid, household_key, status, version, body FROM animals WHERE key = ?", [key]);
  return row ? { ...row, body: JSON.parse(row.body) as AnimalBody } : null;
};
// The body as it travels: the version is filled at send time, with animal_id (sendQueue's wireBody).
const wire = (clientUuid: string, body: Record<string, unknown>, version?: number) =>
  ({ client_uuid: clientUuid, type: "animal", body: version === undefined ? body : { ...body, version } });

test("new animal in a household born on the tablet cites household_client_uuid", async () => {
  const db = await zoonosesTablet();
  await insertHousehold(db, BORN_HH, { id: null });
  await db.run("UPDATE households SET client_uuid = ? WHERE key = ?", [BORN_HH, BORN_HH]);
  await enqueue(db, { type: "household", body: { property_type: "01" }, targetId: BORN_HH, clientUuid: BORN_HH }, newUuid);

  const key = await saveAnimal(db, { householdKey: BORN_HH, draft: draft({ name: "Pipoca" }), newUuid });
  const [item] = await animalItems(db);
  expect(item).toMatchObject({ client_uuid: key, target_id: key, depends_on: [{ client_uuid: BORN_HH, kind: "cite" }], edit_base_version: null });
  expect(item.body).toEqual({ household_client_uuid: BORN_HH, species: "dog", sex: "female", name: "Pipoca", community: false });
  expect(await rowOf(db, key)).toMatchObject({ id: null, client_uuid: key, household_key: BORN_HH, status: "active", version: null });
});

test("tutor known by the server goes by tutor_patient_id, without dependency", async () => {
  const db = await zoonosesTablet();
  const key = await saveAnimal(db, { householdKey: HH, draft: draft({ tutorKey: JOANA }), newUuid });
  const [item] = await animalItems(db);
  expect(item.depends_on).toEqual([]);
  expect(item.body).toEqual({ household_id: HH, species: "dog", sex: "female", tutor_patient_id: JOANA, community: false });
  expect((await rowOf(db, key))!.body.tutor).toEqual({ patient_id: JOANA, display_name: "Joana Conceição" });
});

test("no tutor and no community is saved as is (Q22); community true drops the tutor", async () => {
  const db = await zoonosesTablet();
  await saveAnimal(db, { householdKey: HH, draft: draft(), newUuid });
  await saveAnimal(db, { householdKey: HH, draft: draft({ tutorKey: JOANA, community: true }), newUuid });
  const [unknownTutor, community] = await animalItems(db);
  expect(unknownTutor.body).toEqual({ household_id: HH, species: "dog", sex: "female", community: false });
  expect(community.body).toEqual({ household_id: HH, species: "dog", sex: "female", community: true });
  expect((await rowOf(db, community.client_uuid))!.body).toMatchObject({ tutor: null, community: true });
});

// Q29 (N1 resolved): the tutor born on the tablet is the individual_registration's client_uuid, cited while it is in the line.
test("a resident registered on the tablet as tutor follows N1", async () => {
  const db = await zoonosesTablet();
  await bornResident(db, { key: BENEDITA, name: "Benedita Rocha" });
  const key = await saveAnimal(db, { householdKey: HH, draft: draft({ tutorKey: BENEDITA }), newUuid });
  const [item] = await animalItems(db);
  expect(item.body).toMatchObject({ tutor_client_uuid: BENEDITA, community: false });
  expect(item.body).not.toHaveProperty("tutor_patient_id");
  expect(item.depends_on).toEqual([{ client_uuid: BENEDITA, kind: "cite" }]);
  expect((await rowOf(db, key))!.body.tutor).toEqual({ patient_id: BENEDITA, display_name: "Benedita Rocha" });

  // Accepted and not yet downloaded: still by its client_uuid, with nothing to wait for.
  await outboxRepo.remove(db, (await outboxRepo.byClientUuid(db, BENEDITA))!.seq);
  await saveAnimal(db, { householdKey: HH, draft: draft({ tutorKey: BENEDITA }), newUuid });
  const later = (await animalItems(db))[1];
  expect(later.body).toMatchObject({ tutor_client_uuid: BENEDITA });
  expect(later.depends_on).toEqual([]);

  // Downloaded: the registration has the patient's own id, and the tutor goes by it.
  await db.run("UPDATE registrations SET patient_id = ? WHERE key = ?", ["c0ffee72-0000-4000-8000-000000000072", BENEDITA]);
  await saveAnimal(db, { householdKey: HH, draft: draft({ tutorKey: BENEDITA }), newUuid });
  expect((await animalItems(db))[2].body).toMatchObject({ tutor_patient_id: "c0ffee72-0000-4000-8000-000000000072" });
});

test("the local row has has_microchip true and no microchip anywhere in animals", async () => {
  const db = await zoonosesTablet();
  const key = await saveAnimal(db, { householdKey: HH, draft: { ...draft(), microchip: CHIP }, newUuid });
  expect(JSON.stringify(await db.all("SELECT * FROM animals"))).not.toContain(CHIP);
  expect((await rowOf(db, key))!.body.has_microchip).toBe(true);
  // The number goes in the creation's body only.
  expect((await animalItems(db))[0].body.microchip).toBe(CHIP);
  // Blank is absent.
  const blank = await saveAnimal(db, { householdKey: HH, draft: { ...draft(), microchip: "  " }, newUuid });
  expect((await animalItems(db))[1].body).not.toHaveProperty("microchip");
  expect((await rowOf(db, blank))!.body.has_microchip).toBe(false);
});

// A situation that stays is not sent: the schema ties status to status_on, the day of the change (Q37).
test("edit carries the whole body with animal_id, version and status, never microchip; status never back to active", async () => {
  const db = await zoonosesTablet();
  const before = await readAnimal(db, ANIMAL);
  await saveAnimal(db, {
    householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Pipoca", tutorKey: JOANA, microchip: CHIP }), status: "missing", today: TODAY,
    editBase: before!.base, newUuid,
  });
  const [item] = await animalItems(db);
  expect(item).toMatchObject({ target_id: ANIMAL, edit_base_version: 2 });
  expect(item.edit_base_body).toEqual(before!.base!.body);
  expect(item.body).toEqual({
    animal_id: ANIMAL, household_id: HH, species: "dog", sex: "female", name: "Pipoca", tutor_patient_id: JOANA, community: false,
    status: "missing", status_on: TODAY,
  });
  expect(JSON.stringify(await db.all("SELECT * FROM outbox"))).not.toContain(CHIP);

  // The pending edit is read on top of the row: the form opens on what was typed.
  const edited = await readAnimal(db, ANIMAL);
  expect(edited!.body).toMatchObject({ status: "missing", name: "Pipoca" });
  // A second edit is the same item; the situation stays, and it never goes back to active (Q20).
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Pipa", tutorKey: JOANA }), today: TODAY, newUuid });
  const again = await animalItems(db);
  expect(again).toHaveLength(1);
  expect(again[0].body).toMatchObject({ name: "Pipa", status: "missing", status_on: TODAY });
  await expect(saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft(), status: "active", today: TODAY, newUuid })).rejects.toThrow();
  expect((await animalItems(db))[0].body).toMatchObject({ name: "Pipa", status: "missing" });

  // Without a change of situation, no status at all.
  const other = await zoonosesTablet();
  await saveAnimal(other, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Pipa" }), status: "active", today: TODAY, newUuid });
  const [kept] = await animalItems(other);
  expect(kept.body).toMatchObject({ animal_id: ANIMAL, name: "Pipa" });
  expect(kept.body).not.toHaveProperty("status");
  expect(kept.body).not.toHaveProperty("status_on");
});

// The reset erases a server animal that is only edited in the line (it comes back with the next download): the edit
// is still there to be read and corrected.
test("an edit whose row the reset erased is still read and corrected from the line", async () => {
  const db = await zoonosesTablet();
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Rex" }), newUuid });
  await db.run("DELETE FROM animals WHERE key = ?", [ANIMAL]);
  const view = await readAnimal(db, ANIMAL);
  expect(view).toMatchObject({ key: ANIMAL, id: ANIMAL, householdKey: HH });
  expect(view!.body).toMatchObject({ name: "Rex", has_microchip: true, version: 2 });
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Rei" }), newUuid });
  const items = await animalItems(db);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ edit_base_version: 2, body: { animal_id: ANIMAL, name: "Rei" } });
  expect(items[0].body).not.toHaveProperty("status");
});

test("edit of an animal still waiting in the line rewrites its creation body", async () => {
  const db = await zoonosesTablet();
  const key = await saveAnimal(db, { householdKey: HH, draft: { ...draft({ name: "Pipoca" }), microchip: CHIP }, newUuid });
  await saveAnimal(db, { householdKey: HH, animalKey: key, draft: draft({ name: "Pipa", size: "small" }), newUuid });
  const items = await animalItems(db);
  expect(items).toHaveLength(1);
  // Still a creation: no animal_id and no status, and the number typed at the creation stays in it.
  expect(items[0]).toMatchObject({ client_uuid: key, target_id: key });
  expect(items[0].body).toEqual({ household_id: HH, species: "dog", sex: "female", size: "small", name: "Pipa", community: false, microchip: CHIP });
  expect((await rowOf(db, key))!.body).toMatchObject({ name: "Pipoca", has_microchip: true });
  expect((await readAnimal(db, key))!.body).toMatchObject({ name: "Pipa", size: "small", has_microchip: true });

  // A tutor registered on the tablet, chosen in the edit: the waiting item now cites it.
  await bornResident(db, { key: BENEDITA, name: "Benedita Rocha" });
  await saveAnimal(db, { householdKey: HH, animalKey: key, draft: draft({ name: "Pipa", tutorKey: BENEDITA }), newUuid });
  const [cited] = await animalItems(db);
  expect(cited.body).toMatchObject({ tutor_client_uuid: BENEDITA, microchip: CHIP });
  expect(cited.depends_on).toEqual([{ client_uuid: BENEDITA, kind: "cite" }]);
});

test("animal bodies validate against upload-request-v1.json; birth goes as birth_estimate_month", async () => {
  const db = await zoonosesTablet();
  const full = await saveAnimal(db, {
    householdKey: HH, newUuid,
    draft: { ...draft({ name: "Pipoca", size: "medium", coat: "Caramelo", breed: "SRD", birthEstimateMonth: "2022-03", tutorKey: JOANA }), microchip: CHIP },
  });
  await saveAnimal(db, { householdKey: HH, draft: draft({ sex: "unknown", community: true }), newUuid });
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ species: "dog", birthEstimateMonth: "2022-04" }), status: "deceased", today: TODAY, newUuid });
  const [created, community, edit] = await animalItems(db);
  expect(created.body).toMatchObject({ birth_estimate_month: "2022-03" });
  expect(created.body).not.toHaveProperty("birth_estimate_on");
  expect((await rowOf(db, full))!.body.birth_estimate_on).toBe("2022-03-01");
  expectValid("upload-request", { items: [wire(created.client_uuid, created.body), wire(community.client_uuid, community.body), wire(edit.client_uuid, edit.body, 2)] });
  for (const item of [created, community, edit]) expect(item.body).not.toHaveProperty("neutered");
});
