import { outboxRepo } from "../../db/repos/outboxRepo";
import { emptyAnimalDraft, type AnimalDraft } from "../../rules/animal";
import { newUuid } from "../../sync/testing";
import { ANIMAL, COMMUNITY_ANIMAL, HH, JOANA, zoonosesTablet } from "../testing";
import { placeCollar, saveAnimal, vaccinate } from "./save";
import { ANIMAL_TABLES, readAnimal, readAnimals } from "./view";

const CHIP = "985141000123456";
const draft = (over: Partial<AnimalDraft> = {}): AnimalDraft => ({ ...emptyAnimalDraft(), species: "dog", sex: "female", ...over });

test("ANIMAL_TABLES are the animals, the line and the collections", () => {
  expect(ANIMAL_TABLES).toEqual(["animals", "outbox", "local_leish_collections"]);
});

test("the household's animals as the download brought them, by name", async () => {
  const db = await zoonosesTablet();
  const views = await readAnimals(db, HH);
  expect(views.map((v) => v.key)).toEqual([COMMUNITY_ANIMAL, ANIMAL]);
  expect(views[1]).toEqual({
    key: ANIMAL, id: ANIMAL, species: "dog", name: "Pipoca", sexLabel: "Fêmea", status: "active", tutorName: "Joana Conceição", community: false,
    hasMicrochip: true, lastVaccinationOn: "2026-11-21", collarDueOn: "2026-12-01", waiting: false, held: null, collections: [],
  });
  expect(views[0]).toMatchObject({ name: null, tutorName: null, community: true, hasMicrochip: false });
  expect(await readAnimals(db, "another-household")).toEqual([]);
});

test("the line goes on top: the creation and the edit are shown as typed, waiting, and held when refused", async () => {
  const db = await zoonosesTablet();
  const born = await saveAnimal(db, { householdKey: HH, draft: { ...draft({ name: "Mingau", species: "cat", sex: "male" }), microchip: CHIP }, newUuid });
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Pipa", tutorKey: JOANA }), status: "missing", today: "2026-11-24", newUuid });
  const views = await readAnimals(db, HH);
  expect(views.find((v) => v.key === born)).toMatchObject({ id: null, species: "cat", name: "Mingau", sexLabel: "Macho", hasMicrochip: true, waiting: true, held: null });
  expect(views.find((v) => v.key === ANIMAL)).toMatchObject({ name: "Pipa", status: "missing", hasMicrochip: true, waiting: true });
  expect(JSON.stringify(views)).not.toContain(CHIP);
  expect(JSON.stringify(await readAnimal(db, born))).not.toContain(CHIP);

  const edit = (await outboxRepo.all(db)).find((item) => item.target_id === ANIMAL)!;
  await outboxRepo.update(db, edit.seq, { state: "needs_attention", error: "date_out_of_range", path: "status_on" });
  expect((await readAnimals(db, HH)).find((v) => v.key === ANIMAL)).toMatchObject({ held: "needs_attention", name: "Pipa" });
});

test("an edit sent back as animal_changed is not shown on top: the form opens on the current version (Q20)", async () => {
  const db = await zoonosesTablet();
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Pipa", tutorKey: JOANA }), newUuid });
  const edit = (await outboxRepo.all(db))[0];
  await outboxRepo.update(db, edit.seq, { state: "needs_attention", error: "animal_changed" });
  expect((await readAnimals(db, HH)).find((v) => v.key === ANIMAL)).toMatchObject({ name: "Pipoca", held: "needs_attention", waiting: true });
  expect((await readAnimal(db, ANIMAL))!.body.name).toBe("Pipoca");
});

// ── Task 7: the vaccine and the collar in the line go on top ──
const VAR = "e1f2a3b4-c5d6-4e7f-8a9b-1c2d3e4f5a6b";
const CDT4 = "f2a3b4c5-d6e7-4f8a-9b0c-2d3e4f5a6b7c";

test("queued collar shows the new due date: placed 2026-08-31 with 6 months → 2027-02-28", async () => {
  const db = await zoonosesTablet();
  await placeCollar(db, { animalKey: ANIMAL, productId: CDT4, today: "2026-08-31", newUuid });
  expect((await readAnimals(db, HH)).find((v) => v.key === ANIMAL)).toMatchObject({ collarDueOn: "2027-02-28", lastVaccinationOn: "2026-11-21", waiting: true, held: null });
  // The row itself keeps the server's dates and version until an acceptance or the download.
  const row = await db.get<{ version: number; body: string }>("SELECT version, body FROM animals WHERE key = ?", [ANIMAL]);
  expect(row!.version).toBe(2);
  expect(JSON.parse(row!.body)).toMatchObject({ collar_due_on: "2026-12-01" });
});

test("a queued vaccine puts its day on top, for the card and the form; a refused one marks the card", async () => {
  const db = await zoonosesTablet();
  const born = await saveAnimal(db, { householdKey: HH, draft: draft({ name: "Mingau", species: "cat", sex: "male" }), newUuid });
  await vaccinate(db, { animalKey: born, productId: VAR, adverseEvent: false, adverseNote: null, today: "2026-11-24", newUuid });
  await vaccinate(db, { animalKey: ANIMAL, productId: VAR, adverseEvent: false, adverseNote: null, today: "2026-11-24", newUuid });
  const views = await readAnimals(db, HH);
  expect(views.find((v) => v.key === born)).toMatchObject({ lastVaccinationOn: "2026-11-24", collarDueOn: null, waiting: true });
  expect(views.find((v) => v.key === ANIMAL)).toMatchObject({ lastVaccinationOn: "2026-11-24", collarDueOn: "2026-12-01", waiting: true });
  expect((await readAnimal(db, ANIMAL))!.body.last_rabies_vaccination_on).toBe("2026-11-24");
  // The other animal of the household is not touched.
  expect(views.find((v) => v.key === COMMUNITY_ANIMAL)).toMatchObject({ lastVaccinationOn: null, waiting: false });

  const vaccination = (await outboxRepo.all(db)).find((item) => item.type === "rabies_vaccination" && item.body.animal_id === ANIMAL)!;
  await outboxRepo.update(db, vaccination.seq, { state: "needs_attention", error: "already_vaccinated_in_campaign", path: "campaign_id" });
  expect((await readAnimals(db, HH)).find((v) => v.key === ANIMAL)).toMatchObject({ held: "needs_attention" });
});
