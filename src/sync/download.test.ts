import type { ChangesResponse, HouseholdBody, RegistrationBody, UploadResponse, WhoToVisit } from "../contract";
import { example } from "../contract/fixtures";
import { expectValid } from "../contract/validate";
import { outboxRepo } from "../db/repos/outboxRepo";
import { territoryRepo } from "../db/repos/territoryRepo";
import { dbEvents } from "../db/events";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { sendQueue } from "./dispatch";
import { applyPage, downloadAll } from "./download";
import { householdEditable } from "./editable";
import { FieldHttpError } from "./http";
import { enqueue } from "./outbox";
import { handleStale } from "./stale";
import { accepted, fakeClient, newUuid } from "./testing";

const page = (file: string): ChangesResponse => {
  const body = example<ChangesResponse>(file);
  expectValid("changes-response", body);
  return body;
};
const FIRST = page("changes-first-page.json"); // micro_area, household v3, registration v2
const LAST = page("changes-last-page.json"); // who_to_visit, has_more false
const RESET = page("changes-reset.json");
const REMOVALS = page("changes-removals.json");
const HH = FIRST.items[1].body as unknown as HouseholdBody;
const REG = FIRST.items[2].body as unknown as RegistrationBody;
const WHO = LAST.who_to_visit as unknown as WhoToVisit;

const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const meta = async (db: Db, key: string) => (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? null;
const householdRow = (db: Db, key: string) => db.get<{
  key: string; id: string | null; micro_area_id: string; version: number; body: string; base_version: number; base_body: string;
  needs_reload: number; street_norm: string; number: string; has_location: number;
}>("SELECT * FROM households WHERE key = ?", [key]);
const withPage = (base: ChangesResponse, over: Partial<ChangesResponse>): ChangesResponse => ({ ...base, ...over });
const householdItem = (body: HouseholdBody) => ({ type: "household" as const, id: body.id, version: body.version, body });

test("full load from changes-first-page + changes-last-page", async () => {
  const db = await createTestDb();
  const pages = [FIRST, LAST];
  const cursors: (string | null)[] = [];
  const client = { changes: jest.fn(async (cursor: string | null) => { cursors.push(cursor); return pages.shift()!; }) };
  const now = Date.parse("2026-11-14T18:00:00Z");
  expect(await downloadAll({ db, client, now: () => now })).toEqual({ complete: true });
  expect(cursors).toEqual([null, FIRST.next_cursor]);

  expect(await db.get("SELECT id, team_id FROM micro_areas")).toEqual({ id: FIRST.items[0].id, team_id: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b" });
  const hh = (await householdRow(db, HH.id))!;
  expect([hh.id, hh.micro_area_id, hh.version, hh.base_version, hh.needs_reload]).toEqual([HH.id, HH.micro_area.id, 3, 3, 0]);
  expect(JSON.parse(hh.body)).toEqual(HH);
  expect(JSON.parse(hh.base_body)).toEqual(householdEditable(HH));
  expect([hh.street_norm, hh.number, hh.has_location]).toEqual(["das flores", "120", HH.location ? 1 : 0]);
  expect(await db.all("SELECT id, household_key, responsible_patient_id FROM families")).toEqual([
    { id: HH.families[0].id, household_key: HH.id, responsible_patient_id: HH.families[0].responsible.patient_id },
  ]);
  expect(await db.get("SELECT key, id, household_key, family_id, patient_id, version, name_norm, birth_date, mother_norm FROM registrations")).toEqual({
    key: REG.id, id: REG.id, household_key: HH.id, family_id: REG.family_id, patient_id: REG.patient.id, version: 2,
    name_norm: "joana d'arc conceicao", birth_date: "1961-03-14", mother_norm: "maria conceicao",
  });
  expect(await count(db, "who_to_visit")).toBe(WHO.micro_areas.length);
  expect(await meta(db, "cursor")).toBe(LAST.next_cursor);
  expect(await meta(db, "last_download_ok_at")).toBe("2026-11-14T18:00:00.000Z");
});

// campo#2: the moment of the last full download is the server's, so a tablet clock fixed later does not move the 30 days.
test("the last full download is written in the server's time", async () => {
  const db = await createTestDb();
  await db.run("UPDATE meta SET value = ? WHERE key = 'clock_skew_ms'", [String(10 * 86_400_000)]); // the tablet is 10 days behind
  const pages = [FIRST, LAST];
  const client = { changes: jest.fn(async () => pages.shift()!) };
  await downloadAll({ db, client, now: () => Date.parse("2026-11-04T18:00:00Z") });
  expect(await meta(db, "last_download_ok_at")).toBe("2026-11-14T18:00:00.000Z");
});

// The pages tell the screens about the territory before the download is complete: the moment of the last full download
// is written after them, and the screens that show it are told then — or the home shows the round before (Task 26).
test("a complete download tells the screens about meta once the moment of the last full download is written", async () => {
  const db = await createTestDb();
  const seen: (string | null)[] = [];
  const stop = dbEvents.on("meta", () => { void meta(db, "last_download_ok_at").then((value) => seen.push(value)); });
  const pages = [FIRST, LAST];
  await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => Date.parse("2026-11-16T12:00:00Z") });
  stop();
  await new Promise((resolve) => setImmediate(resolve));
  expect(seen.at(-1)).toBe("2026-11-16T12:00:00.000Z");
});

test("an HTTP failure in the middle keeps what was applied and does not claim a full download", async () => {
  const db = await createTestDb();
  const client = { changes: jest.fn().mockResolvedValueOnce(FIRST).mockRejectedValueOnce(new FieldHttpError({ kind: "network" })) };
  await expect(downloadAll({ db, client, now: () => 0 })).rejects.toBeInstanceOf(FieldHttpError);
  expect(await count(db, "households")).toBe(1);
  expect(await meta(db, "cursor")).toBe(FIRST.next_cursor);
  expect(await meta(db, "last_download_ok_at")).toBeNull();
});

test("reset wipes territory but never the outbox", async () => {
  const db = await createTestDb();
  await applyPage(db, FIRST);
  await applyPage(db, LAST);
  const pending = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  await db.run("INSERT INTO client_ids (client_uuid, type, id) VALUES ('c', 'household', 'h')");
  await applyPage(db, RESET);
  expect([await count(db, "households"), await count(db, "registrations"), await count(db, "families"), await count(db, "who_to_visit")]).toEqual([0, 0, 0, 0]);
  expect(await count(db, "micro_areas")).toBe(1); // the page's own item, applied after the wipe
  expect((await outboxRepo.all(db)).map((i) => i.client_uuid)).toEqual([pending.client_uuid]);
  expect(await count(db, "client_ids")).toBe(1);
  expect(await meta(db, "cursor")).toBe(RESET.next_cursor);
});

test("moved removal deletes the household and its registrations", async () => {
  const db = await createTestDb();
  await applyPage(db, FIRST);
  await applyPage(db, withPage(REMOVALS, { removals: [{ type: "household", id: HH.id, reason: "moved" }] }));
  expect([await count(db, "households"), await count(db, "families"), await count(db, "registrations")]).toEqual([0, 0, 0]);
  expect(await count(db, "micro_areas")).toBe(1);
});

test("erased and out_of_scope are handled like moved", async () => {
  for (const reason of ["erased", "out_of_scope"] as const) {
    const db = await createTestDb();
    await applyPage(db, FIRST);
    await applyPage(db, withPage(REMOVALS, { removals: [{ type: "registration", id: REG.id, reason }] }));
    expect([reason, await count(db, "registrations"), await count(db, "households")]).toEqual([reason, 0, 1]);
  }
  // The contract's own example (ids the tablet never had) is applied without error.
  const db = await createTestDb();
  await applyPage(db, REMOVALS);
  expect(await meta(db, "cursor")).toBe(REMOVALS.next_cursor);
});

test("who_to_visit null on middle pages keeps the old list; last page replaces it", async () => {
  const db = await createTestDb();
  await db.run("INSERT INTO who_to_visit (micro_area_id, people, generated_at) VALUES ('old-area', '[]', '2026-01-01T00:00:00Z')");
  await applyPage(db, FIRST);
  expect(await db.all("SELECT micro_area_id FROM who_to_visit")).toEqual([{ micro_area_id: "old-area" }]);
  await applyPage(db, LAST);
  const rows = await db.all<{ micro_area_id: string; people: string; generated_at: string }>("SELECT * FROM who_to_visit");
  expect(rows.map((r) => r.micro_area_id)).toEqual(WHO.micro_areas.map((m) => m.micro_area_id));
  expect(JSON.parse(rows[0].people)).toEqual(WHO.micro_areas[0].people);
  expect(rows[0].generated_at).toBe(WHO.generated_at);
});

test("item with pending local edit: row updates, outbox item and its edit base untouched (Q41)", async () => {
  const db = await createTestDb();
  await applyPage(db, FIRST);
  const base = householdEditable(HH);
  const edit = await enqueue(db, {
    type: "household", targetId: HH.id, editBase: { version: 3, body: base as unknown as Record<string, unknown> },
    body: { household_id: HH.id, micro_area_id: HH.micro_area.id, property_type: HH.property_type, contact_phone: "41988887777" },
  }, newUuid);
  const before = await outboxRepo.bySeq(db, edit.seq);

  const newer: HouseholdBody = { ...HH, version: 4, property_type: "2" };
  await applyPage(db, withPage(FIRST, { items: [householdItem(newer)] }));
  const row = (await householdRow(db, HH.id))!;
  expect([row.version, row.base_version]).toEqual([4, 4]);
  expect(JSON.parse(row.body).property_type).toBe("2");
  expect(await outboxRepo.bySeq(db, edit.seq)).toEqual(before);
});

test("download brings a station change on a key the tablet does not send: the edit goes through without asking (Q69)", async () => {
  const db = await createTestDb();
  await applyPage(db, FIRST);
  const edit = await enqueue(db, {
    type: "household", targetId: HH.id, editBase: { version: 3, body: householdEditable(HH) as unknown as Record<string, unknown> },
    body: { household_id: HH.id, micro_area_id: HH.micro_area.id, property_type: HH.property_type, contact_phone: "41988887777" },
  }, newUuid);
  // The station inactivated the household: `status` is not in the item.
  const newer: HouseholdBody = { ...HH, version: 4, status: "inactive" };
  await applyPage(db, withPage(FIRST, { items: [householdItem(newer)] }));

  const { client, batches } = fakeClient((items, call) => items.map((i) => (call === 1
    ? { client_uuid: i.client_uuid, status: "stale_version" as const, type: i.type, id: HH.id, current_version: 4, current: newer as unknown as Record<string, never> }
    : accepted(i, { id: HH.id, version: 5 }))));
  await sendQueue({ db, client, onStale: (item, result) => handleStale(db, item, result) });
  expect(batches.map((b) => (b[0].body as { version: number }).version)).toEqual([3, 4]); // its own base first (Q41), then the station's
  expect(batches[1][0].client_uuid).toBe(edit.client_uuid);
  expect(batches[1][0].body).not.toHaveProperty("status");
  expect(await outboxRepo.count(db)).toBe(0); // never stopped at "conflict"
  const row = (await householdRow(db, HH.id))!;
  expect(JSON.parse(row.body).status).toBe("inactive");
  expect(row.base_version).toBe(5);
});

test("row marked needs_reload is replaced and unmarked when the item arrives (Q5)", async () => {
  const db = await createTestDb();
  await applyPage(db, FIRST);
  await db.run("UPDATE households SET needs_reload = 1, base_body = '{\"old\":true}' WHERE key = ?", [HH.id]);
  await applyPage(db, withPage(FIRST, { items: [householdItem({ ...HH, version: 6 })] }));
  const row = (await householdRow(db, HH.id))!;
  expect([row.needs_reload, row.version, row.base_version]).toEqual([0, 6, 6]);
  expect(JSON.parse(row.base_body)).toEqual(householdEditable(HH));
});

test("server item that was born on the tablet replaces the local-born row by client_ids", async () => {
  const db = await createTestDb();
  const born = "c0ffee30-0000-4000-8000-000000000030";
  await db.run("INSERT INTO households (key, id, client_uuid, micro_area_id, body, street_norm, number) VALUES (?, NULL, ?, ?, '{}', 'x', '1')", [born, born, HH.micro_area.id]);
  await db.run("INSERT INTO registrations (key, client_uuid, household_key, body, name_norm) VALUES ('rg-born', 'rg-born', ?, '{}', 'x')", [born]);
  await outboxRepo.mapClientId(db, born, "household", HH.id);
  await applyPage(db, FIRST);
  expect(await count(db, "households")).toBe(1);
  const row = (await householdRow(db, born))!; // same key: what points to it (registrations, the outbox) stays valid
  expect([row.id, row.version, row.street_norm]).toEqual([HH.id, 3, "das flores"]);
  expect(await db.all("SELECT household_key FROM families")).toEqual([{ household_key: born }]);
  // The registration that arrived names the household by its server id; it is filed under the local key.
  expect(await db.get("SELECT household_key FROM registrations WHERE key = ?", [REG.id])).toEqual({ household_key: born });
});

// A household born on the tablet and already accepted: its key is the client_uuid; the server id is only known
// through client_ids (and, once the accepted answer brought it, in the row's `id`).
async function bornAndAccepted(db: Db, o: { idOnRow: boolean }) {
  const born = "c0ffee30-0000-4000-8000-000000000030";
  await db.run("INSERT INTO households (key, id, client_uuid, micro_area_id, body, street_norm, number) VALUES (?, ?, ?, ?, '{}', 'x', '1')",
    [born, o.idOnRow ? HH.id : null, born, HH.micro_area.id]);
  await db.run("INSERT INTO families (id, household_key) VALUES ('fa-born', ?)", [born]);
  await db.run("INSERT INTO registrations (key, client_uuid, household_key, body, name_norm) VALUES ('rg-born', 'rg-born', ?, '{}', 'x')", [born]);
  await outboxRepo.mapClientId(db, born, "household", HH.id);
  return born;
}

test.each([[true], [false]])("removal of a household born on the tablet and already accepted (id on the row: %s) is found by its local key (Q70)", async (idOnRow) => {
  const db = await createTestDb();
  const born = await bornAndAccepted(db, { idOnRow });
  await db.run("INSERT INTO households (key, id, micro_area_id, body, street_norm, number) VALUES ('other', 'other', ?, '{}', 'y', '2')", [HH.micro_area.id]);
  await applyPage(db, withPage(REMOVALS, { removals: [{ type: "household", id: HH.id, reason: "moved" }] }));
  expect(await householdRow(db, born)).toBeNull();
  expect(await db.all("SELECT key FROM households")).toEqual([{ key: "other" }]);
  expect([await count(db, "families"), await count(db, "registrations")]).toEqual([0, 0]);
  // The map stays: an item still in the line may cite the record by its client_uuid.
  expect(await outboxRepo.mappedIds(db)).toEqual(new Map([[born, HH.id]]));
});

test("removal of a registration born on the tablet and already accepted is found by client_ids (Q70)", async () => {
  const db = await createTestDb();
  await db.run("INSERT INTO registrations (key, id, client_uuid, body, name_norm) VALUES ('rg-born', NULL, 'rg-born', '{}', 'x')");
  await outboxRepo.mapClientId(db, "rg-born", "individual_registration", REG.id);
  // The same server id mapped for another type must not match.
  await db.run("INSERT INTO households (key, id, client_uuid, micro_area_id, body, street_norm, number) VALUES ('hh-x', NULL, 'hh-x', 'ma', '{}', 'x', '1')");
  await applyPage(db, withPage(REMOVALS, { removals: [{ type: "registration", id: REG.id, reason: "moved" }] }));
  expect([await count(db, "registrations"), await count(db, "households")]).toEqual([0, 1]);
});

test("reset wipes a household born on the tablet and already accepted, and keeps the client_ids map (Q70)", async () => {
  const db = await createTestDb();
  const born = await bornAndAccepted(db, { idOnRow: false });
  await applyPage(db, RESET);
  expect([await count(db, "households"), await count(db, "families"), await count(db, "registrations")]).toEqual([0, 0, 0]);
  expect(await outboxRepo.mappedIds(db)).toEqual(new Map([[born, HH.id]]));
  // When the scope brings the record back, it is filed under its server id: the local-born row is gone for good.
  await applyPage(db, FIRST);
  expect((await db.all<{ key: string }>("SELECT key FROM households")).map((r) => r.key)).toEqual([HH.id]);
});

test("page failing midway applies nothing and keeps the previous cursor", async () => {
  const db = await createTestDb();
  await db.run("INSERT INTO meta (key, value) VALUES ('cursor', 'previous')");
  let runs = 0;
  // The failure is put on whichever handle the page is written through — inside a transaction, the transaction's own.
  const failingOver = (inner: Db): Db => ({
    ...inner,
    run: async (sql, params) => { if (/INSERT INTO registrations|UPDATE registrations/.test(sql) && ++runs === 1) throw new Error("disk full"); return inner.run(sql, params); },
    tx: (fn) => inner.tx((tx) => fn(failingOver(tx))),
  });
  const failing = failingOver(db);
  await expect(applyPage(failing, FIRST)).rejects.toThrow("disk full");
  expect([await count(db, "micro_areas"), await count(db, "households"), await count(db, "families"), await count(db, "registrations")]).toEqual([0, 0, 0, 0]);
  expect(await meta(db, "cursor")).toBe("previous");
});

test("next_cursor is stored even on the last page", async () => {
  const db = await createTestDb();
  await applyPage(db, withPage(LAST, { next_cursor: "the-last-one" }));
  expect(await meta(db, "cursor")).toBe("the-last-one");
});

test("member whose family is missing (Q66) is shown without family, no error", async () => {
  const db = await createTestDb();
  const orphan: RegistrationBody = { ...REG, id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", family_id: "00000000-0000-4000-8000-00000000dead", is_responsible: false };
  await applyPage(db, withPage(FIRST, { items: [...FIRST.items, { type: "registration", id: orphan.id, version: 1, body: orphan as unknown as Record<string, never> }] }));
  const residents = await territoryRepo.residentsOf(db, HH.id);
  expect(residents.map((r) => [r.registration.id, r.family?.id ?? null])).toEqual([[REG.id, HH.families[0].id], [orphan.id, null]]);
});

test("household without point: has_location 0; the contract's example with location null is applied", async () => {
  const db = await createTestDb();
  await applyPage(db, page("changes-household-location-null.json"));
  expect((await db.all<{ has_location: number }>("SELECT has_location FROM households")).map((r) => r.has_location)).toEqual([0]);
});

test("stale version rewrites the row through the same path: search fields follow the station's record", async () => {
  const db = await createTestDb();
  await applyPage(db, FIRST);
  const edit = await enqueue(db, { type: "household", targetId: HH.id, editBase: { version: 3, body: {} }, body: { household_id: HH.id, contact_phone: "1" } }, newUuid);
  const current: HouseholdBody = { ...HH, version: 4, address: { ...HH.address, street: "São João", number: "77" }, location: null };
  const stale = (example<UploadResponse>("upload-response-stale-household.json")).results[0];
  await handleStale(db, edit, { ...stale, current_version: 4, current: current as unknown as Record<string, never> });
  const row = (await householdRow(db, HH.id))!;
  expect([row.street_norm, row.number, row.has_location, row.version]).toEqual(["sao joao", "77", 0, 4]);
});
