import { outboxRepo } from "../../db/repos/outboxRepo";
import { applyResults } from "../../sync/dispatch";
import { newUuid, rejected } from "../../sync/testing";
import { HH, endemicTablet } from "../testing";
import { collectOvitrap, installOvitrap } from "./save";
import { OVITRAP_TABLES, readOvitraps, takenNumbers } from "./view";

const OV = "c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f";
const U1 = "c0ffee64-0000-4000-8000-000000000064";

test("the screens re-read on the ovitraps and the line", () => {
  expect(OVITRAP_TABLES).toEqual(["ovitraps", "outbox"]);
});

test("the row as downloaded, then with the queued collection on top: the next paddle opens on its day", async () => {
  const db = await endemicTablet();
  expect(await readOvitraps(db)).toEqual([{ key: OV, id: OV, number: "OVT-014", householdKey: HH, installedOn: "2026-11-12", waiting: false, held: null }]);
  await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: false, today: "2026-11-16", newUuid });
  expect(await readOvitraps(db, HH)).toEqual([{ key: OV, id: OV, number: "OVT-014", householdKey: HH, installedOn: "2026-11-16", waiting: true, held: null }]);
  expect(await readOvitraps(db, "other-household")).toEqual([]);
});

test("a refused collection still counts until it is fixed or discarded", async () => {
  const db = await endemicTablet();
  await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: true, today: "2026-11-16", newUuid });
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [rejected(item, "collection_out_of_range", { path: "collected_on" })], { onStale: async () => undefined });
  expect(await readOvitraps(db)).toEqual([]);
});

test("takenNumbers: the active ovitraps and the installations in the line, the corrected one left out", async () => {
  const db = await endemicTablet();
  await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-14" });
  expect(await takenNumbers(db)).toEqual(["OVT-014", "OVT-015"]);
  expect(await takenNumbers(db, U1)).toEqual(["OVT-014"]);
  // An ovitrap a queued collection removes frees its number: the api applies the batch in order (Q10).
  await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: true, today: "2026-11-16", newUuid });
  expect(await takenNumbers(db)).toEqual(["OVT-015"]);
});

// Review M2: what waits for the person is not "waiting to be sent".
test("held: a refused item of the ovitrap, or one blocked behind it", async () => {
  const db = await endemicTablet();
  await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-08" });
  await collectOvitrap(db, { ovitrapKey: U1, condition: "ok", remove: false, today: "2026-11-14", newUuid });
  await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: false, today: "2026-11-16", newUuid });
  const [installation, , other] = await outboxRepo.all(db);
  await applyResults(db, [installation, other], [rejected(installation, "ovitrap_number_taken", { path: "number" }), rejected(other, "collection_out_of_range", { path: "collected_on" })], { onStale: async () => undefined });
  const views = new Map((await readOvitraps(db)).map((o) => [o.key, o]));
  expect(views.get(U1)?.held).toBe("needs_attention");
  expect(views.get(OV)?.held).toBe("needs_attention");
  // Only the collection blocked behind the refused installation.
  const db2 = await endemicTablet();
  await installOvitrap(db2, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-08" });
  await collectOvitrap(db2, { ovitrapKey: U1, condition: "ok", remove: false, today: "2026-11-14", newUuid });
  const [inst2] = await outboxRepo.all(db2);
  await applyResults(db2, [inst2], [rejected(inst2, "ovitrap_number_taken", { path: "number" })], { onStale: async () => undefined });
  expect((await readOvitraps(db2)).find((o) => o.key === U1)?.held).toBe("needs_attention");
  await outboxRepo.update(db2, inst2.seq, { state: "pending" });
  expect((await readOvitraps(db2)).find((o) => o.key === U1)?.held).toBe("blocked");
});
