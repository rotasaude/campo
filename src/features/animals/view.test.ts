import { outboxRepo } from "../../db/repos/outboxRepo";
import { emptyAnimalDraft, type AnimalDraft } from "../../rules/animal";
import { newUuid } from "../../sync/testing";
import { ANIMAL, COMMUNITY_ANIMAL, HH, JOANA, zoonosesTablet } from "../testing";
import { saveAnimal } from "./save";
import { ANIMAL_TABLES, readAnimal, readAnimals } from "./view";

const CHIP = "985141000123456";
const draft = (over: Partial<AnimalDraft> = {}): AnimalDraft => ({ ...emptyAnimalDraft(), species: "dog", sex: "female", ...over });

test("ANIMAL_TABLES are the animals and the line", () => {
  expect(ANIMAL_TABLES).toEqual(["animals", "outbox"]);
});

test("the household's animals as the download brought them, by name", async () => {
  const db = await zoonosesTablet();
  const views = await readAnimals(db, HH);
  expect(views.map((v) => v.key)).toEqual([COMMUNITY_ANIMAL, ANIMAL]);
  expect(views[1]).toEqual({
    key: ANIMAL, id: ANIMAL, species: "dog", name: "Pipoca", sexLabel: "Fêmea", status: "active", tutorName: "Joana Conceição", community: false,
    hasMicrochip: true, lastVaccinationOn: "2026-11-21", collarDueOn: "2026-12-01", waiting: false, held: null,
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
