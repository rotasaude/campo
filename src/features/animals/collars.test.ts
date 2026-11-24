import type { Db } from "../../db/types";
import { loadDue } from "../vector/dueData";
import { ANIMAL, COMMUNITY_ANIMAL, HH, zoonosesTablet } from "../testing";
import { newUuid } from "../../sync/testing";
import { COLLAR_DUE_DAYS, COLLARS_TABLES, loadCollarsDue } from "./collars";
import { placeCollar } from "./save";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const CDT4 = "f2a3b4c5-d6e7-4f8a-9b0c-2d3e4f5a6b7c";

// Changes the animal row the download left (the server's receipt).
async function setAnimal(db: Db, key: string, change: Record<string, unknown>): Promise<void> {
  const row = await db.get<{ body: string }>("SELECT body FROM animals WHERE key = ?", [key]);
  const body = { ...JSON.parse(row!.body), ...change };
  await db.run("UPDATE animals SET body = ?, species = ?, status = ? WHERE key = ?", [JSON.stringify(body), body.species, body.status, key]);
}

test("the constants are the contract's", () => {
  expect(COLLAR_DUE_DAYS).toBe(15);
  expect(COLLARS_TABLES).toEqual(["animals", "outbox", "households", "reference", "session"]);
});

test("dog with collar due in 15 days is listed; due in 16 is not; overdue still is", async () => {
  const db = await zoonosesTablet();
  expect(await loadCollarsDue(db, NOW)).toEqual([
    { animalKey: ANIMAL, animalName: "Pipoca", householdKey: HH, address: expect.stringContaining("Flores"), dueOn: "2026-12-01" },
  ]);
  await setAnimal(db, ANIMAL, { collar_due_on: "2026-12-09" });
  expect((await loadCollarsDue(db, NOW)).map((c) => c.animalKey)).toEqual([ANIMAL]);
  await setAnimal(db, ANIMAL, { collar_due_on: "2026-12-10" });
  expect(await loadCollarsDue(db, NOW)).toEqual([]);
  await setAnimal(db, ANIMAL, { collar_due_on: "2026-10-01" });
  expect((await loadCollarsDue(db, NOW)).map((c) => c.dueOn)).toEqual(["2026-10-01"]);
});

test("ordered by due date, then by key; the tutor's name is not in the entry", async () => {
  const db = await zoonosesTablet();
  await setAnimal(db, COMMUNITY_ANIMAL, { species: "dog", collar_due_on: "2026-12-01" });
  const list = await loadCollarsDue(db, NOW);
  expect(list.map((c) => c.animalKey)).toEqual([ANIMAL, COMMUNITY_ANIMAL].sort());
  await setAnimal(db, ANIMAL, { collar_due_on: "2026-12-05" });
  expect((await loadCollarsDue(db, NOW)).map((c) => c.animalKey)).toEqual([COMMUNITY_ANIMAL, ANIMAL]);
  expect(JSON.stringify(list)).not.toContain("Joana");
  expect(Object.keys(list[0]).sort()).toEqual(["address", "animalKey", "animalName", "dueOn", "householdKey"]);
});

test("a queued collar takes the dog out of the list", async () => {
  const db = await zoonosesTablet();
  expect(await loadCollarsDue(db, NOW)).toHaveLength(1);
  await placeCollar(db, { animalKey: ANIMAL, productId: CDT4, today: "2026-11-24", newUuid });
  expect(await loadCollarsDue(db, NOW)).toEqual([]);
});

test("cats and inactive animals never appear", async () => {
  const db = await zoonosesTablet();
  await setAnimal(db, ANIMAL, { species: "cat" });
  expect(await loadCollarsDue(db, NOW)).toEqual([]);
  await setAnimal(db, ANIMAL, { species: "dog", status: "dead" });
  expect(await loadCollarsDue(db, NOW)).toEqual([]);
  await setAnimal(db, ANIMAL, { status: "active" });
  expect(await loadCollarsDue(db, NOW)).toHaveLength(1);
});

test("515105 and 515140 with zoonoses see the list; vector_control off changes nothing; another CBO sees nothing", async () => {
  expect(await loadCollarsDue(await zoonosesTablet({ cbo: "515105" }), NOW)).toHaveLength(1);
  expect(await loadCollarsDue(await zoonosesTablet({ cbo: "515140" }), NOW)).toHaveLength(1);
  const db = await zoonosesTablet({ cbo: "515140" });
  const row = await db.get<{ body: string }>("SELECT body FROM session WHERE id = 1");
  const session = JSON.parse(row!.body);
  await db.run("UPDATE session SET body = ?", [JSON.stringify({ ...session, features: { ...session.features, vector_control: false } })]);
  expect(await loadCollarsDue(db, NOW)).toHaveLength(1);
  expect(await loadCollarsDue(await zoonosesTablet({ cbo: "225125" }), NOW)).toEqual([]);
  expect(await loadCollarsDue(await zoonosesTablet({ zoonoses: false }), NOW)).toEqual([]);
  expect(await loadCollarsDue(await zoonosesTablet({ domains: null }), NOW)).toEqual([]);
});

test("Imóveis a visitar is untouched: a dog with collar due adds nothing to loadDue", async () => {
  const db = await zoonosesTablet({ cbo: "515140" });
  const before = (await loadDue(db, NOW)).items;
  await setAnimal(db, ANIMAL, { collar_due_on: "2026-11-01" });
  expect((await loadDue(db, NOW)).items).toEqual(before);
});
