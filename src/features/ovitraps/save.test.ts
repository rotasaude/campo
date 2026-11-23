import type { HouseholdItemBody, UploadRequest } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { vectorRepo } from "../../db/repos/vectorRepo";
import type { Db } from "../../db/types";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { applyResults, refreshBlocked, selectBatch } from "../../sync/dispatch";
import { removeUnsent } from "../../sync/outbox";
import { newUuid, rejected } from "../../sync/testing";
import { saveHousehold } from "../households/save";
import { AREA, BLOCK, HH, NEIGHBORHOOD, endemicTablet } from "../testing";
import { saveVisit } from "../visits/save";
import { collectOvitrap, correctNumber, installOvitrap } from "./save";
import { readOvitraps } from "./view";

const NOW = Date.parse("2026-11-14T15:00:00Z");
// The server's ovitrap of the vector page (OVT-014 at HH, paddle open since 2026-11-12).
const OV = "c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f";
const U1 = "c0ffee64-0000-4000-8000-000000000064";
const noStale = { onStale: async () => undefined };
const all = (db: Db) => outboxRepo.all(db);

test("install then collect offline: the collection cites ovitrap_client_uuid with a cite dependency", async () => {
  const db = await endemicTablet();
  expect(await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-12" })).toBe(U1);
  const [installation] = await all(db);
  expect([installation.type, installation.client_uuid, installation.body, installation.depends_on])
    .toEqual(["ovitrap_installation", U1, { household_id: HH, number: "OVT-015", consent: true, installed_on: "2026-11-12" }, []]);
  // The local row, in the same transaction: under the client_uuid, active, the paddle open on the installation's day.
  const [row] = (await vectorRepo.ovitrapsOf(db)).filter((o) => o.key === U1);
  expect([row.id, row.client_uuid, row.household_key, row.number, row.status, row.body.open_reading]).toEqual([null, U1, HH, "OVT-015", "active", { installed_on: "2026-11-12" }]);

  await collectOvitrap(db, { ovitrapKey: U1, condition: "ok", remove: false, today: "2026-11-17", newUuid });
  const collection = (await all(db))[1];
  expect(collection.type).toBe("ovitrap_collection");
  expect(collection.body).toEqual({ ovitrap_client_uuid: U1, collected_on: "2026-11-17", condition: "ok", reinstall: true, remove: false });
  expect(collection.depends_on).toEqual([{ client_uuid: U1, kind: "cite" }]);
  // Installation and collection travel in the same batch, the collection after the one it cites.
  expect(selectBatch(await all(db)).map((i) => i.type)).toEqual(["ovitrap_installation", "ovitrap_collection"]);
});

test("two queued collections of the same ovitrap: the second depends on the first", async () => {
  const db = await endemicTablet();
  const first = await collectOvitrap(db, { ovitrapKey: OV, condition: "dry", remove: false, today: "2026-11-15", newUuid });
  await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: false, today: "2026-11-19", newUuid });
  const [a, b] = await all(db);
  expect([a.body.ovitrap_id, a.depends_on]).toEqual([OV, []]);
  expect([b.body.ovitrap_id, b.depends_on]).toEqual([OV, [{ client_uuid: first, kind: "cite" }]]);
  // The list opens the next paddle on the latest collection's day.
  expect((await readOvitraps(db)).find((o) => o.key === OV)?.installedOn).toBe("2026-11-19");
});

test("held installation blocks its collection", async () => {
  const db = await endemicTablet();
  await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-08" });
  await collectOvitrap(db, { ovitrapKey: U1, condition: "ok", remove: false, today: "2026-11-14", newUuid });
  const [installation] = await all(db);
  await applyResults(db, [installation], [rejected(installation, "ovitrap_number_taken", { path: "number" })], noStale);
  expect((await all(db)).map((i) => [i.type, i.state])).toEqual([["ovitrap_installation", "needs_attention"], ["ovitrap_collection", "blocked"]]);
  expect(selectBatch(await all(db))).toEqual([]);
  // Discarding the installation takes its collection and the local row with it.
  await removeUnsent(db, U1);
  await refreshBlocked(db);
  expect(await all(db)).toEqual([]);
  expect((await vectorRepo.ovitrapsOf(db)).map((o) => o.key)).toEqual([OV]);
});

test("remove sends reinstall false; the ovitrap leaves the list at once", async () => {
  const db = await endemicTablet();
  expect((await readOvitraps(db)).map((o) => o.key)).toEqual([OV]);
  await collectOvitrap(db, { ovitrapKey: OV, condition: "lost", remove: true, today: "2026-11-15", newUuid });
  expect((await all(db))[0].body).toEqual({ ovitrap_id: OV, collected_on: "2026-11-15", condition: "lost", reinstall: false, remove: true });
  expect(await readOvitraps(db)).toEqual([]);
  expect(await readOvitraps(db, HH)).toEqual([]);
});

const draft = (o: Partial<VisitDraft> = {}): VisitDraft => ({
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: HH, propertyType: "1", microAreaId: AREA },
  subject: "none", outcome: 1, ...o,
});
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const NO_PROFILE = { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: null, last_situation: null };
const ADDRESS = { zip: "80010000", street_type: "081", street: "das Flores", number: "120", no_number: false, complement: null, neighborhood_id: NEIGHBORHOOD, district: "Centro", reference: null };

test("the installation cites the queued bulletin that gave the household its block (Q10)", async () => {
  const db = await endemicTablet({ household: { vector: NO_PROFILE, address: ADDRESS } });
  const visit = await saveVisit(db, draft(), {
    clientUuid: newUuid(), teamId: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", location: null, visitBody: rules.visitBody, newUuid, now: () => NOW,
    vectorInspection: { activity: "li", work_type: "routine", situation: "worked", educational_action: false, city_block_id: BLOCK } as never,
  });
  await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-14" });
  expect((await all(db)).find((i) => i.type === "ovitrap_installation")?.depends_on).toEqual([{ client_uuid: visit, kind: "cite" }]);
});

test("the installation in a household born on the tablet cites it by client_uuid", async () => {
  const db = await endemicTablet();
  const { household_id: _id, version: _version, ...fields } = example<UploadRequest>("upload-household-location.json").items[0].body as HouseholdItemBody;
  const born = await saveHousehold(db, { fields: fields as never }, { newUuid, now: () => NOW });
  await installOvitrap(db, { householdKey: born.key, number: "OVT-015", clientUuid: U1, today: "2026-11-14" });
  const installation = (await all(db)).find((i) => i.type === "ovitrap_installation")!;
  expect(installation.body).toEqual({ household_client_uuid: born.clientUuid, number: "OVT-015", consent: true, installed_on: "2026-11-14" });
  expect(installation.depends_on).toEqual([{ client_uuid: born.clientUuid, kind: "cite" }]);
  expect((await readOvitraps(db, born.key)).map((o) => o.number)).toEqual(["OVT-015"]);
});

test("installation and collection bodies validate against upload-request-v1.json", async () => {
  const db = await endemicTablet();
  await installOvitrap(db, { householdKey: HH, number: "OV-12", clientUuid: U1, today: "2026-11-08" });
  await collectOvitrap(db, { ovitrapKey: U1, condition: "damaged", remove: false, today: "2026-11-14", newUuid });
  await collectOvitrap(db, { ovitrapKey: OV, condition: "lost", remove: true, today: "2026-11-15", newUuid });
  const items = (await all(db)).map((i) => ({ client_uuid: i.client_uuid, type: i.type, body: i.body }));
  expect(items.map((i) => i.type)).toEqual(["ovitrap_installation", "ovitrap_collection", "ovitrap_collection"]);
  expectValid("upload-request", { items });
});

test("correctNumber: the same client_uuid back in the line with the new number, and the row renumbered", async () => {
  const db = await endemicTablet();
  await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-14" });
  const [installation] = await all(db);
  await applyResults(db, [installation], [rejected(installation, "ovitrap_number_taken", { path: "number" })], noStale);
  await correctNumber(db, installation.seq, "OVT-016");
  const [again] = await all(db);
  expect([again.client_uuid, again.state, again.error, again.body.number]).toEqual([U1, "pending", null, "OVT-016"]);
  expect((await readOvitraps(db)).find((o) => o.key === U1)?.number).toBe("OVT-016");
});
