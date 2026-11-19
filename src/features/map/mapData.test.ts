import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { createTestDb } from "../../db/testing/sqljsDb";
import { applyPage, downloadAll } from "../../sync/download";
import { newUuid } from "../../sync/testing";
import { saveHousehold } from "../households/save";
import { readHousehold } from "../households/view";
import { loadMapData } from "./mapData";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const HH1 = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";

async function territory() {
  const db = await createTestDb();
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await applyPage(db, example<ChangesResponse>("changes-last-page.json"));
  return db;
}

test("no map file yet → file is null and the points are still read", async () => {
  const db = await territory();
  const data = await loadMapData(db, NOW);
  expect(data.file).toBeNull();
  expect(data.points.features.length).toBeGreaterThan(0);
});

test("the map file is the one proved good by the download", async () => {
  const db = await territory();
  await db.run("INSERT INTO map_file (id, version, sha256, size_bytes, path) VALUES (1, '2026-11-01', ?, 41234567, 'map/2026-11-01-abababababab.pmtiles')", ["ab".repeat(32)]);
  expect((await loadMapData(db, NOW)).file?.path).toBe("map/2026-11-01-abababababab.pmtiles");
});

test("only households with a location become points, with key and status and nothing else", async () => {
  const db = await territory();
  const located = await db.all<{ key: string }>("SELECT key FROM households WHERE has_location = 1");
  const { points } = await loadMapData(db, NOW);
  expect(points.features.map((f) => f.properties.key).sort()).toEqual(located.map((row) => row.key).sort());
  for (const feature of points.features) expect(Object.keys(feature.properties).sort()).toEqual(["key", "status"]);
  expect(JSON.stringify(points)).not.toMatch(/Joana|Flores|cpf|cns/i);
});

test("a household somebody on the list lives in is to visit; one visited today is visited today", async () => {
  const db = await territory();
  const who = await db.all<{ people: string }>("SELECT people FROM who_to_visit");
  const listed = who.flatMap((row) => JSON.parse(row.people) as { household: { id: string } | null }[]).map((p) => p.household?.id);
  expect(listed).toContain(HH1);
  const status = async () => (await loadMapData(db, NOW)).points.features.find((f) => f.properties.key === HH1)?.properties.status;
  expect(await status()).toBe("to_visit");

  // 12:00 in the city (UTC−3) on 2026-11-14.
  await db.run("INSERT INTO meta (key, value) VALUES ('city_offset_min', '-180') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await db.run(
    "INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('11111111-1111-4111-8111-111111111111', '2026-11-14', '2026-11-14T10:30:00-03:00', ?, 'pending')",
    [JSON.stringify({ household: HH1 })]);
  expect(await status()).toBe("visited_today");
});

// Q42 (b): the app updated to v2 lost its cursor, so its first download starts over. The visit the server already
// accepted today keeps its mark: the territory comes back, "Visitado hoje" stays.
test("the visited-today mark stays on the day sheet after the update", async () => {
  const db = await territory();
  await db.run("DELETE FROM meta WHERE key = 'cursor'"); // what the migration 1 → 2 leaves (Q6)
  await db.run("INSERT INTO meta (key, value) VALUES ('city_offset_min', '-180') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await db.run(
    "INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state, server_id, accepted_at) VALUES ('11111111-1111-4111-8111-111111111111', '2026-11-14', '2026-11-14T10:30:00-03:00', ?, 'accepted', 's', '2026-11-14T13:31:00Z')",
    [JSON.stringify({ household: HH1 })]);
  const pages = [example<ChangesResponse>("changes-first-page.json"), example<ChangesResponse>("changes-last-page.json")];
  await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => NOW });
  expect((await loadMapData(db, NOW)).points.features.find((f) => f.properties.key === HH1)?.properties.status).toBe("visited_today");
});

test("a visit of another day, or one withdrawn, does not paint the point", async () => {
  const db = await territory();
  await db.run("INSERT INTO meta (key, value) VALUES ('city_offset_min', '-180') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await db.run(
    "INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('11111111-1111-4111-8111-111111111111', '2026-11-13', '2026-11-13T10:30:00-03:00', ?, 'accepted')",
    [JSON.stringify({ household: HH1 })]);
  await db.run(
    "INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('22222222-2222-4222-8222-222222222222', '2026-11-14', '2026-11-14T09:00:00-03:00', ?, 'withdrawn')",
    [JSON.stringify({ household: HH1 })]);
  expect((await loadMapData(db, NOW)).points.features.find((f) => f.properties.key === HH1)?.properties.status).toBe("to_visit");
});

test("a point marked on the tablet and not yet sent is the one drawn", async () => {
  const db = await territory();
  const view = (await readHousehold(db, HH1))!;
  await saveHousehold(db, {
    key: HH1,
    fields: { micro_area_id: view.body.micro_area.id, property_type: view.body.property_type, location: { latitude: -25.5, longitude: -49.3, accuracy_m: 12.3, source: "map" } },
  }, { newUuid, now: () => NOW });
  expect((await loadMapData(db, NOW)).points.features.find((f) => f.properties.key === HH1)?.geometry.coordinates).toEqual([-49.3, -25.5]);
});
