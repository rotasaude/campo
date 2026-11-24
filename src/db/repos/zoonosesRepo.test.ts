import type { AnimalBody } from "../../contract";
import { createTestDb } from "../testing/sqljsDb";
import { zoonosesRepo } from "./zoonosesRepo";

const animal = (id: string, name: string | null, over: Partial<AnimalBody> = {}): AnimalBody => ({
  id, version: 1, household_id: "h1", species: "dog", name, sex: "female", size: null, coat: null, breed: null, birth_estimate_on: null,
  status: "active", neutered: false, tutor: null, community: true, last_rabies_vaccination_on: null, collar_due_on: null, has_microchip: false, ...over,
});

test("animalsOf orders by name without case, then by key, and keeps a household apart", async () => {
  const db = await createTestDb();
  for (const a of [animal("k3", "bolinha"), animal("k2", "Bolinha"), animal("k1", "Zeca"), animal("k0", "Ágata"), animal("k4", null)]) await zoonosesRepo.putAnimal(db, a);
  await zoonosesRepo.putAnimal(db, animal("k9", "Alfa", { household_id: "h2" }));
  expect((await zoonosesRepo.animalsOf(db, "h1")).map((r) => r.key)).toEqual(["k4", "k0", "k2", "k3", "k1"]);
  expect((await zoonosesRepo.animalsOf(db, "h2")).map((r) => r.key)).toEqual(["k9"]);
  expect(await zoonosesRepo.animalsOf(db, "nobody")).toEqual([]);
});

test("an AnimalRow carries the columns and the parsed body", async () => {
  const db = await createTestDb();
  const a = animal("k1", "Pipoca", { version: 4 });
  await zoonosesRepo.putAnimal(db, a);
  expect(await zoonosesRepo.animalsOf(db, "h1")).toEqual([
    { key: "k1", id: "k1", client_uuid: null, household_key: "h1", species: "dog", status: "active", version: 4, body: a },
  ]);
});
