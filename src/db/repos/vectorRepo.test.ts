import type { ChangesResponse, CityBlockBody, LiraaItemBody, OvitrapBody, TransmissionBlockBody } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { createTestDb } from "../testing/sqljsDb";
import type { Db } from "../types";
import { vectorRepo } from "./vectorRepo";

const VECTOR = example<ChangesResponse>("changes-vector-page.json");
expectValid("changes-response", VECTOR);
const bodyOf = <T,>(type: string) => VECTOR.items.find((i) => i.type === type)!.body as unknown as T;
const BLOCK = bodyOf<CityBlockBody>("city_block");
const OV = bodyOf<OvitrapBody>("ovitrap");
const LI = bodyOf<LiraaItemBody>("liraa_item");
const TB = bodyOf<TransmissionBlockBody>("transmission_block");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bodyIn = async <T,>(db: Db, table: string) => JSON.parse((await db.get<{ body: string }>(`SELECT body FROM ${table}`))!.body) as T;
const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

// Q29: the api re-emits with the same version when another row changed (egg count of the reading, the survey closed,
// a new UBV cycle) or when the entity enters the scope: every receipt overwrites, whatever the version.
test("every entity is overwritten on each receipt, whatever its version (Q29)", async () => {
  const db = await createTestDb();
  await vectorRepo.putCityBlock(db, BLOCK);
  await vectorRepo.putCityBlock(db, { ...BLOCK, neighbor_ids: [], version: 1 });
  await vectorRepo.putOvitrap(db, OV);
  await vectorRepo.putOvitrap(db, { ...OV, last_reading: { ...OV.last_reading!, egg_count: 41 } });
  await vectorRepo.putLiraaItem(db, LI);
  await vectorRepo.putLiraaItem(db, { ...LI, survey_name: "LIRAa renomeado", version: 1 });
  await vectorRepo.putTransmissionBlock(db, TB);
  await vectorRepo.putTransmissionBlock(db, { ...TB, cycles: [TB.cycles[0]!, { number: 2, starts_on: "2026-11-17", ends_on: "2026-11-21" }], version: 2 });
  expect((await vectorRepo.blocksOf(db, BLOCK.neighborhood_id))[0]).toEqual({ ...BLOCK, neighbor_ids: [], version: 1 });
  expect((await vectorRepo.ovitrapsOf(db))[0].body.last_reading?.egg_count).toBe(41);
  expect((await bodyIn<LiraaItemBody>(db, "liraa_items")).survey_name).toBe("LIRAa renomeado");
  expect((await bodyIn<TransmissionBlockBody>(db, "transmission_blocks")).cycles).toHaveLength(2);
  for (const table of ["city_blocks", "ovitraps", "liraa_items", "transmission_blocks"]) expect([table, await count(db, table)]).toEqual([table, 1]);
});

test("blocksOf: the active blocks of the neighbourhood, in natural order of number", async () => {
  const db = await createTestDb();
  const block = (n: number, number: string, over: Partial<CityBlockBody> = {}) => vectorRepo.putCityBlock(db, { ...BLOCK, id: uuid(n), number, ...over });
  await block(1, "12A");
  await block(2, "2");
  await block(3, "12");
  await block(4, "100");
  await block(5, "3", { active: false });
  await block(6, "1", { neighborhood_id: uuid(99) });
  expect((await vectorRepo.blocksOf(db, BLOCK.neighborhood_id)).map((b) => b.number)).toEqual(["2", "12", "12A", "100"]);
  expect((await vectorRepo.blocksOf(db, uuid(99))).map((b) => b.number)).toEqual(["1"]);
  expect(await vectorRepo.blocksOf(db, uuid(98))).toEqual([]);
});

test("ovitrapsOf: every ovitrap, or the household's, by number", async () => {
  const db = await createTestDb();
  await vectorRepo.putOvitrap(db, { ...OV, id: uuid(1), number: "OVT-10" });
  await vectorRepo.putOvitrap(db, { ...OV, id: uuid(2), number: "OVT-9" });
  await vectorRepo.putOvitrap(db, { ...OV, id: uuid(3), number: "OVT-1", household_id: uuid(50) });
  expect((await vectorRepo.ovitrapsOf(db)).map((o) => o.number)).toEqual(["OVT-1", "OVT-9", "OVT-10"]);
  const mine = await vectorRepo.ovitrapsOf(db, OV.household_id);
  expect(mine.map((o) => [o.key, o.household_key, o.status])).toEqual([[uuid(2), OV.household_id, "active"], [uuid(1), OV.household_id, "active"]]);
  expect(mine[0].body).toEqual({ ...OV, id: uuid(2), number: "OVT-9" });
});

test("an ovitrap that is not active, a LIRAa item that is not pending and a closed blockade the tablet never had are not written", async () => {
  const db = await createTestDb();
  await vectorRepo.putOvitrap(db, { ...OV, status: "lost" });
  await vectorRepo.putLiraaItem(db, { ...LI, status: "closed" });
  await vectorRepo.putTransmissionBlock(db, { ...TB, status: "closed" });
  for (const table of ["ovitraps", "liraa_items", "transmission_blocks"]) expect([table, await count(db, table)]).toEqual([table, 0]);
});

// ── Task 9: the ovitrap installed on the tablet ──
const U1 = "c0ffee64-0000-4000-8000-000000000064";
const installed = (db: Db) => vectorRepo.putInstalled(db, { clientUuid: U1, householdKey: OV.household_id, householdId: OV.household_id, number: "OVT-015", installedOn: "2026-11-08" });
const rowsOf = (db: Db) => db.all<{ key: string; id: string | null; client_uuid: string | null; body: string }>("SELECT key, id, client_uuid, body FROM ovitraps ORDER BY key");

test("acceptInstallation: the row takes the server id in the column and in the body (review M6)", async () => {
  const db = await createTestDb();
  await installed(db);
  expect(JSON.parse((await rowsOf(db))[0].body).id).toBe(U1);
  await vectorRepo.acceptInstallation(db, U1, uuid(70));
  const [row] = await rowsOf(db);
  expect([row.key, row.id, row.client_uuid, (JSON.parse(row.body) as OvitrapBody).id]).toEqual([U1, uuid(70), U1, uuid(70)]);
});

test("acceptInstallation after a download already brought the ovitrap: the tablet-born row goes, the server's keeps the client_uuid (review M1)", async () => {
  const db = await createTestDb();
  await installed(db);
  await vectorRepo.putOvitrap(db, { ...OV, id: uuid(70), number: "OVT-015" });
  expect((await rowsOf(db)).map((r) => r.key)).toEqual([uuid(70), U1]);
  await vectorRepo.acceptInstallation(db, U1, uuid(70));
  expect((await rowsOf(db)).map((r) => [r.key, r.id, r.client_uuid])).toEqual([[uuid(70), uuid(70), U1]]);
  // A collection still naming it by the installation's client_uuid finds the server's row.
  await vectorRepo.acceptCollection(db, { ovitrap_client_uuid: U1, collected_on: "2026-11-14", condition: "ok", reinstall: true, remove: false });
  expect((JSON.parse((await rowsOf(db))[0].body) as OvitrapBody).open_reading).toEqual({ installed_on: "2026-11-14" });
});
