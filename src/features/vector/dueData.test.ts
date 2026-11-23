import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { applyResults } from "../../sync/dispatch";
import { applyPage } from "../../sync/download";
import { accepted, newUuid, rejected } from "../../sync/testing";
import { AREA, BLOCK, HH, LIRAA_ITEM, NEIGHBORHOOD, TRANSMISSION_BLOCK, endemicTablet, loadedTablet } from "../testing";
import { saveVisit } from "../visits/save";
import { loadDue } from "./dueData";

const NOW = Date.parse("2026-11-14T15:00:00Z"); // 12:00 of 2026-11-14 in the city (-180)
const NEVER = "11111111-0000-4000-8000-000000000001";
const FRESH = "11111111-0000-4000-8000-000000000002";
const GONE = "11111111-0000-4000-8000-000000000003";
const PE = "11111111-0000-4000-8000-000000000004";
const NO_PROFILE = { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: null, last_situation: null };

const page = () => example<ChangesResponse>("changes-vector-page.json");
// A household of the scope as the server sends it: HH's body with another id, number and profile.
async function household(db: Db, id: string, number: string, o: Record<string, unknown>): Promise<void> {
  const hh = page().items.find((item) => item.type === "household")!;
  const body = hh.body as Record<string, unknown>;
  const address = { ...(body.address as Record<string, unknown>), number, neighborhood_id: NEIGHBORHOOD };
  await applyPage(db, { ...page(), items: [{ ...hh, id, body: { ...body, id, address, ...o } }] } as unknown as ChangesResponse);
}
async function closeBlockade(db: Db): Promise<void> {
  const tb = page().items.find((item) => item.type === "transmission_block")!;
  await applyPage(db, { ...page(), items: [{ ...tb, version: 9, body: { ...(tb.body as Record<string, unknown>), status: "closed", version: 9 } }] } as unknown as ChangesResponse);
}

async function sheet(): Promise<Db> {
  const db = await endemicTablet();
  await household(db, NEVER, "200", { vector: null });
  await household(db, FRESH, "210", { vector: { ...NO_PROFILE, last_worked_on: "2026-11-10", last_situation: "worked" } });
  await household(db, GONE, "220", { vector: null, status: "inactive" });
  // A strategic point worked 15 days ago: the reference's (city, PE) 15.
  await household(db, PE, "230", { property_type: "4", vector: { ...NO_PROFILE, last_worked_on: "2026-10-30", last_situation: "worked" } });
  return db;
}

const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const save = (db: Db, key: string, inspection: Record<string, unknown>) => saveVisit(db, {
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: key, propertyType: "1", microAreaId: AREA }, subject: "none", outcome: 1,
} as VisitDraft, {
  clientUuid: newUuid(), teamId: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", location: null, visitBody: rules.visitBody, newUuid, now: () => NOW,
  vectorInspection: { activity: "li", work_type: "routine", situation: "worked", educational_action: false, ...inspection } as never,
});
const reasons = async (db: Db) => (await loadDue(db, NOW)).items.map((i) => [i.householdKey, i.reason, i.dueSince]);

test("the agent's sheet: one reason per active household, in the api's order, with the block and the address", async () => {
  const db = await sheet();
  const { items } = await loadDue(db, NOW);
  expect(items.map((i) => [i.householdKey, i.reason, i.dueSince])).toEqual([
    [HH, "transmission_block", "2027-01-02"], [NEVER, "due", null], [PE, "due", "2026-11-14"],
  ]);
  expect(items[0]).toMatchObject({
    block: { id: BLOCK, number: "12A" }, riskClass: "yellow", lastWorkedOn: "2026-11-03", propertyType: "1",
    transmissionBlockId: TRANSMISSION_BLOCK, liraaDrawItemId: null,
  });
  // The api's address_short: street type and street, number; never the complement (free text, review M4).
  expect(items[0].address).toBe("Rua das Flores, 120");
  expect(items[1]).toMatchObject({ block: null, riskClass: null, lastWorkedOn: null });
  expect(items[2].propertyType).toBe("4");
  // Never a person: the tablet has HH's resident, and nothing of her reaches the sheet.
  const people = await db.all<{ body: string }>("SELECT body FROM registrations");
  expect(people.length).toBeGreaterThan(0);
  const text = JSON.stringify(items);
  for (const row of people) {
    const patient = (JSON.parse(row.body) as { patient: { display_name: string; full_name: string } }).patient;
    expect(text).not.toContain(patient.display_name);
    expect(text).not.toContain(patient.full_name);
  }
});

test("with the blockade closed the pending LIRAa item is the reason, with its link", async () => {
  const db = await sheet();
  await closeBlockade(db);
  const { items } = await loadDue(db, NOW);
  expect(items[0]).toMatchObject({ householdKey: HH, reason: "liraa", liraaDrawItemId: LIRAA_ITEM, transmissionBlockId: null });
});

test("an inspection saved today on the tablet takes the household out of the list", async () => {
  const db = await sheet();
  await closeBlockade(db);
  await save(db, NEVER, { situation: "worked" });
  await save(db, HH, { activity: "liraa", liraa_draw_item_id: LIRAA_ITEM, situation: "worked" });
  expect(await reasons(db)).toEqual([[PE, "due", "2026-11-14"]]);

  // Accepted and not downloaded yet: still out.
  const [first] = await outboxRepo.all(db);
  await applyResults(db, [first], [accepted(first)], { onStale: async () => undefined });
  expect(await reasons(db)).toEqual([[PE, "due", "2026-11-14"]]);

  // Refused by the server: it counts for nothing, the LIRAa item is back.
  const liraa = (await outboxRepo.all(db)).find((i) => i.type === "home_visit")!;
  await applyResults(db, [liraa], [rejected(liraa, "liraa_item_not_found", { path: "vector_inspection.liraa_draw_item_id" })], { onStale: async () => undefined });
  expect((await reasons(db))[0]).toEqual([HH, "liraa", "2027-01-02"]);
});

test("a closed or refused visit saved today makes the household pending", async () => {
  const db = await sheet();
  await save(db, PE, { activity: "pe", situation: "closed" });
  expect(await reasons(db)).toContainEqual([PE, "pending", "2026-11-14"]);
  // A later worked visit of the same day: out.
  await save(db, PE, { activity: "pe", situation: "worked" });
  expect((await reasons(db)).map(([key]) => key)).not.toContain(PE);
});

test("the ACS, a tablet without the vector domains and a city with the visit off have no sheet", async () => {
  expect((await loadDue(await loadedTablet(), NOW)).items).toEqual([]);
  expect((await loadDue(await endemicTablet({ domains: null }), NOW)).items).toEqual([]);
  // Review M6: the bulletin goes inside the visit.
  const off = await endemicTablet({ session: { features: { home_visits: false, collective_activities: false, territory_registry: true, vector_control: true } } });
  expect((await loadDue(off, NOW)).items).toEqual([]);
});

test("the address is the api's short one: no complement, S/N, no street", async () => {
  const db = await endemicTablet();
  const address = (page().items.find((item) => item.type === "household")!.body as { address: Record<string, unknown> }).address;
  await household(db, NEVER, "200", { vector: null, address: { ...address, complement: "casa da Dona Maria", neighborhood_id: NEIGHBORHOOD } });
  await household(db, FRESH, "x", { vector: null, address: { ...address, no_number: true, number: null, neighborhood_id: NEIGHBORHOOD } });
  await household(db, PE, "x", { vector: null, address: { ...address, street_type: null, street: null, neighborhood_id: NEIGHBORHOOD } });
  const byKey = new Map((await loadDue(db, NOW)).items.map((i) => [i.householdKey, i.address]));
  expect(byKey.get(NEVER)).toBe("Rua das Flores, 120");
  expect(byKey.get(FRESH)).toBe("Rua das Flores, S/N");
  expect(byKey.get(PE)).toBe("Sem endereço");
});

// Review I1: the api's situation is that of the latest inspection. An accepted bulletin newer than the last good download
// sets it, as a queued one does; one at or before that download only fills what the download left null.
async function acceptAll(db: Db, acceptedAt: string, lastOk: string | null): Promise<void> {
  for (const item of await outboxRepo.all(db)) await applyResults(db, [item], [accepted(item)], { onStale: async () => undefined });
  await db.run("UPDATE local_visits SET accepted_at = ?", [acceptedAt]);
  await db.run("DELETE FROM meta WHERE key = 'last_download_ok_at'");
  if (lastOk !== null) await db.run("INSERT INTO meta (key, value) VALUES ('last_download_ok_at', ?)", [lastOk]);
}

test("A: downloaded closed, worked today and accepted, the download failed → out of the list", async () => {
  const db = await endemicTablet();
  await household(db, NEVER, "200", { vector: { ...NO_PROFILE, last_worked_on: "2026-08-01", last_situation: "closed" } });
  expect(await reasons(db)).toContainEqual([NEVER, "pending", "2026-09-30"]);
  await save(db, NEVER, { situation: "worked" });
  await acceptAll(db, "2026-11-14T13:00:00.000Z", "2026-11-14T12:00:00.000Z");
  expect((await reasons(db)).map(([key]) => key)).not.toContain(NEVER);
  // A download after the acceptance speaks for the server: it said closed again (an inspection after this one).
  await household(db, NEVER, "200", { vector: { ...NO_PROFILE, last_worked_on: "2026-11-14", last_situation: "closed" } });
  await acceptAll(db, "2026-11-14T13:00:00.000Z", "2026-11-14T14:00:00.000Z");
  expect(await reasons(db)).toContainEqual([NEVER, "pending", "2027-01-13"]);
});

test("B: downloaded as recently worked, closed today and accepted → pending", async () => {
  const db = await endemicTablet();
  await household(db, NEVER, "200", { vector: { ...NO_PROFILE, last_worked_on: "2026-11-01", last_situation: "worked" } });
  expect((await reasons(db)).map(([key]) => key)).not.toContain(NEVER);
  await save(db, NEVER, { situation: "closed" });
  await acceptAll(db, "2026-11-14T13:00:00.000Z", "2026-11-14T12:00:00.000Z");
  expect(await reasons(db)).toContainEqual([NEVER, "pending", "2026-12-31"]);
  // No good download yet: the acceptance is the newest there is.
  await acceptAll(db, "2026-11-14T13:00:00.000Z", null);
  expect(await reasons(db)).toContainEqual([NEVER, "pending", "2026-12-31"]);
  // At or before the last good download: the download's worked stays.
  await acceptAll(db, "2026-11-14T13:00:00.000Z", "2026-11-14T13:00:00.000Z");
  expect((await reasons(db)).map(([key]) => key)).not.toContain(NEVER);
});

// Q47(b): the summary of the visit keeps the LIRAa item, so an accepted bulletin the last good download cannot have
// brought consumes it as a queued one does.
test("an accepted LIRAa bulletin with the next download failing does not bring the household back as LIRAa", async () => {
  const db = await sheet();
  await closeBlockade(db);
  await save(db, HH, { activity: "liraa", liraa_draw_item_id: LIRAA_ITEM, situation: "closed" });
  const row = await db.get<{ summary: string }>("SELECT summary FROM local_visits");
  expect(JSON.parse(row!.summary).vector).toEqual({ activity: "liraa", situation: "closed", liraa_draw_item_id: LIRAA_ITEM });
  await acceptAll(db, "2026-11-14T13:00:00.000Z", "2026-11-14T12:00:00.000Z");
  expect((await reasons(db))[0]).toEqual([HH, "pending", "2027-01-02"]);
});

test("an accepted LIRAa bulletin at or before the last good download does not consume the item", async () => {
  const db = await sheet();
  await closeBlockade(db);
  await save(db, HH, { activity: "liraa", liraa_draw_item_id: LIRAA_ITEM, situation: "closed" });
  // The download after the acceptance still has the item pending: it speaks for the server.
  await acceptAll(db, "2026-11-14T13:00:00.000Z", "2026-11-14T13:00:00.000Z");
  expect((await reasons(db))[0]).toEqual([HH, "liraa", "2027-01-02"]);
});
