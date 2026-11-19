import type {
  ChangesResponse, CityBlockBody, HouseholdBody, LiraaItemBody, OvitrapBody, RegistrationBody, TransmissionBlockBody, UploadResponse, WhoToVisit,
} from "../contract";
import { example } from "../contract/fixtures";
import { expectValid } from "../contract/validate";
import { outboxRepo } from "../db/repos/outboxRepo";
import { territoryRepo } from "../db/repos/territoryRepo";
import { dbEvents } from "../db/events";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import * as logModule from "../log";
import { sendQueue } from "./dispatch";
import { applyPage, downloadAll } from "./download";
import { householdEditable } from "./editable";
import { FieldHttpError } from "./http";
import { enqueue } from "./outbox";
import { handleStale } from "./stale";
import { accepted, fakeClient, newUuid } from "./testing";
import { HIGH_WATER_KEY } from "./trustedTime";

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

// Q6(3): a page may bring a type this version of the app does not know (a newer contract, a switch turned on before
// the update). It is skipped and the rest of the page, the cursor included, is applied — or every round fails the same.
describe("change types the app does not know", () => {
  const lastPage = LAST;
  const UUID_A = "a0a0a0a0-0000-4000-8000-0000000000a1";
  let db: Db;
  let logged: unknown[][];
  beforeEach(async () => {
    db = await createTestDb();
    logged = [];
    jest.spyOn(logModule, "log").mockImplementation((...args) => { logged.push(args); });
  });
  afterEach(() => jest.restoreAllMocks());

  test("an unknown change type is skipped and the cursor moves on", async () => {
    const page = { ...example<ChangesResponse>("changes-last-page.json"),
      items: [...lastPage.items, { type: "lighthouse", id: UUID_A, version: 1, body: { id: UUID_A } }] } as unknown as ChangesResponse;
    await applyPage(db, page);
    expect(await territoryRepo.getMeta(db, "cursor")).toBe(page.next_cursor);
    expect(await db.get("SELECT key FROM registrations WHERE key = ?", [UUID_A])).toBeNull();
    expect(logged).toContainEqual(["sync.change.skipped", { type: "lighthouse" }]);
  });

  test("an unknown removal type is skipped", async () => {
    await applyPage(db, FIRST);
    const page = withPage(REMOVALS, {
      next_cursor: "after-the-lighthouse",
      removals: [{ type: "lighthouse", id: HH.id, reason: "moved" }] as unknown as ChangesResponse["removals"],
    });
    await applyPage(db, page);
    expect([await count(db, "micro_areas"), await count(db, "households"), await count(db, "families"), await count(db, "registrations")]).toEqual([1, 1, 1, 1]);
    expect(await territoryRepo.getMeta(db, "cursor")).toBe("after-the-lighthouse");
    expect(logged).toContainEqual(["sync.change.skipped", { type: "lighthouse" }]);
  });

  test("known items of the same page are still applied", async () => {
    const unknown = { type: "lighthouse", id: UUID_A, version: 1, body: { id: UUID_A } };
    const page = { ...FIRST, items: [unknown, ...FIRST.items, unknown] } as unknown as ChangesResponse;
    await applyPage(db, page);
    expect(await db.get("SELECT id FROM micro_areas")).toEqual({ id: FIRST.items[0].id });
    expect(await db.get("SELECT key, version FROM households")).toEqual({ key: HH.id, version: 3 });
    expect(await db.get("SELECT key, version FROM registrations")).toEqual({ key: REG.id, version: 2 });
    expect(await territoryRepo.getMeta(db, "cursor")).toBe(FIRST.next_cursor);
    expect(logged.filter(([event]) => event === "sync.change.skipped")).toEqual([
      ["sync.change.skipped", { type: "lighthouse" }], ["sync.change.skipped", { type: "lighthouse" }],
    ]);
  });
});

// 35a: the four vector control entities and the household's profile (v1.3.0). Q29: each receipt overwrites, whatever
// the version; the end comes by the status, never by a removal.
describe("vector control entities", () => {
  const valid = (body: ChangesResponse): ChangesResponse => { expectValid("changes-response", body); return body; };
  const VECTOR = page("changes-vector-page.json"); // household with vector, city_block, ovitrap active, liraa_item pending, transmission_block active
  const CLOSED = page("changes-vector-closed.json"); // household vector null, ovitrap removed, liraa_item closed, transmission_block closed
  const itemOf = (p: ChangesResponse, type: string) => p.items.find((i) => i.type === type)!;
  const bodyOf = <T,>(p: ChangesResponse, type: string) => itemOf(p, type).body as unknown as T;
  const BLOCK = bodyOf<CityBlockBody>(VECTOR, "city_block");
  const OV = bodyOf<OvitrapBody>(VECTOR, "ovitrap");
  const LI = bodyOf<LiraaItemBody>(VECTOR, "liraa_item");
  const TB = bodyOf<TransmissionBlockBody>(VECTOR, "transmission_block");
  const VHH = bodyOf<HouseholdBody>(VECTOR, "household");
  // The same page with one entity's body changed.
  const withBody = (type: string, over: Record<string, unknown>): ChangesResponse => valid({
    ...VECTOR,
    items: VECTOR.items.map((i) => (i.type === type ? { ...i, body: { ...i.body, ...over } as Record<string, never> } : i)),
  });
  const outboxItem = (db: Db, clientUuid: string, type: string, body: object) => db.run(
    "INSERT INTO outbox (client_uuid, type, body, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', 't', 't')",
    [clientUuid, type, JSON.stringify(body)]);
  const tabletOvitrap = (db: Db, key: string, householdKey: string, number: string) => db.run(
    "INSERT INTO ovitraps (key, id, client_uuid, household_key, number, status, body) VALUES (?, NULL, ?, ?, ?, 'active', '{}')",
    [key, key, householdKey, number]);

  test("a page with city blocks, ovitraps, LIRAa items and a transmission block is stored", async () => {
    const db = await createTestDb();
    // Whatever order the server sends: the household is written before what is filed under it.
    await applyPage(db, valid({ ...VECTOR, items: [...VECTOR.items].reverse() }));
    const block = await db.get<{ body: string }>("SELECT id, neighborhood_id, number, active, version, body FROM city_blocks");
    expect({ ...block, body: JSON.parse(block!.body) }).toEqual({ id: BLOCK.id, neighborhood_id: BLOCK.neighborhood_id, number: "12A", active: 1, version: 2, body: BLOCK });
    const ovitrap = await db.get<{ body: string }>("SELECT key, id, client_uuid, household_key, number, status, version, body FROM ovitraps");
    expect({ ...ovitrap, body: JSON.parse(ovitrap!.body) }).toEqual({
      key: OV.id, id: OV.id, client_uuid: null, household_key: VHH.id, number: "OVT-014", status: "active", version: 5, body: OV,
    });
    const item = await db.get<{ body: string }>("SELECT id, survey_id, household_id, city_block_id, status, version, body FROM liraa_items");
    expect({ ...item, body: JSON.parse(item!.body) }).toEqual({
      id: LI.id, survey_id: LI.survey_id, household_id: VHH.id, city_block_id: BLOCK.id, status: "pending", version: 1, body: LI,
    });
    const blockade = await db.get<{ body: string }>("SELECT id, status, version, body FROM transmission_blocks");
    expect({ ...blockade, body: JSON.parse(blockade!.body) }).toEqual({ id: TB.id, status: "active", version: 3, body: TB });
    expect(await meta(db, "cursor")).toBe(VECTOR.next_cursor);
  });

  test("household vector: present is kept, null means no profile, absent means the switch is off (Q6)", async () => {
    const db = await createTestDb();
    const stored = async () => JSON.parse((await householdRow(db, VHH.id))!.body) as HouseholdBody;
    await applyPage(db, VECTOR);
    expect((await stored()).vector).toEqual(VHH.vector);
    // Read only: never part of what the tablet edits and sends (CV-10).
    expect(JSON.parse((await householdRow(db, VHH.id))!.base_body)).not.toHaveProperty("vector");
    await applyPage(db, CLOSED);
    expect(await stored()).toHaveProperty("vector", null);
    await applyPage(db, FIRST); // the 24c household, without the key
    expect(await stored()).not.toHaveProperty("vector");
  });

  test("ovitrap filed under the tablet-born row by client_ids after its installation was accepted", async () => {
    const db = await createTestDb();
    const born = "c0ffee50-0000-4000-8000-000000000050";
    await tabletOvitrap(db, born, VHH.id, OV.number);
    await outboxRepo.mapClientId(db, born, "ovitrap_installation", OV.id);
    await outboxRepo.mapClientId(db, "c0ffee51-0000-4000-8000-000000000051", "household", OV.id); // another type's map must not match
    await applyPage(db, VECTOR);
    expect(await db.all("SELECT key, id, client_uuid, household_key, status, version FROM ovitraps")).toEqual([
      { key: born, id: OV.id, client_uuid: born, household_key: VHH.id, status: "active", version: 5 },
    ]);
    expect(JSON.parse((await db.get<{ body: string }>("SELECT body FROM ovitraps"))!.body)).toEqual(OV);
  });

  test("an ovitrap of a household born on the tablet is filed under the household's local key", async () => {
    const db = await createTestDb();
    const born = "c0ffee30-0000-4000-8000-000000000030";
    await db.run("INSERT INTO households (key, id, client_uuid, micro_area_id, body, street_norm, number) VALUES (?, NULL, ?, ?, '{}', 'x', '1')", [born, born, VHH.micro_area.id]);
    await outboxRepo.mapClientId(db, born, "household", VHH.id);
    await applyPage(db, valid({ ...VECTOR, items: VECTOR.items.filter((i) => i.type === "ovitrap") }));
    expect(await db.get("SELECT household_key FROM ovitraps")).toEqual({ household_key: born });
  });

  test("liraa_item with status closed deletes the row; inspected and substituted too", async () => {
    for (const status of ["closed", "inspected", "substituted"]) {
      const db = await createTestDb();
      await applyPage(db, VECTOR);
      expect(await count(db, "liraa_items")).toBe(1);
      await applyPage(db, status === "closed" ? CLOSED : withBody("liraa_item", { status }));
      expect([status, await count(db, "liraa_items")]).toEqual([status, 0]);
    }
  });

  test("transmission_block closed deletes the row and never stores a case", async () => {
    const db = await createTestDb();
    await applyPage(db, VECTOR);
    const stored = JSON.parse((await db.get<{ body: string }>("SELECT body FROM transmission_blocks"))!.body) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain("cases");
    expect(Object.keys(stored).sort()).toEqual(["block_ids", "cycles", "id", "status", "version"]);
    await applyPage(db, CLOSED);
    expect(await count(db, "transmission_blocks")).toBe(0);
  });

  test("ovitrap removed or lost deletes the row", async () => {
    for (const status of ["removed", "lost"]) {
      const db = await createTestDb();
      await applyPage(db, VECTOR);
      expect(await count(db, "ovitraps")).toBe(1);
      await applyPage(db, status === "removed" ? CLOSED : withBody("ovitrap", { status, open_reading: null }));
      expect([status, await count(db, "ovitraps")]).toEqual([status, 0]);
    }
  });

  test("an inactive city block stays: it is still a neighbour and history", async () => {
    const db = await createTestDb();
    await applyPage(db, VECTOR);
    await applyPage(db, withBody("city_block", { active: false }));
    expect(await db.all("SELECT id, active FROM city_blocks")).toEqual([{ id: BLOCK.id, active: 0 }]);
  });

  test("moved household takes its ovitraps and LIRAa items with it, but not an ovitrap the queue still collects", async () => {
    const db = await createTestDb();
    await applyPage(db, VECTOR);
    await tabletOvitrap(db, "collecting", VHH.id, "OVT-020"); // installation accepted, its collection still in the line
    await outboxItem(db, "co1", "ovitrap_collection", { ovitrap_client_uuid: "collecting", collected_on: "2026-11-17", condition: "ok" });
    await tabletOvitrap(db, "installing", VHH.id, "OVT-021"); // its installation still in the line
    await outboxItem(db, "installing", "ovitrap_installation", { household_id: VHH.id, number: "OVT-021", consent: true, installed_on: "2026-11-17" });
    await tabletOvitrap(db, "elsewhere", "another-household", "OVT-022");
    await db.run("INSERT INTO liraa_items (id, survey_id, household_id, city_block_id, status, version, body) VALUES ('li-other', 's', 'another-household', 'b', 'pending', 1, '{}')");
    await applyPage(db, withPage(REMOVALS, { removals: [{ type: "household", id: VHH.id, reason: "moved" }] }));
    expect(await count(db, "households")).toBe(0);
    expect(await db.all("SELECT key FROM ovitraps ORDER BY key")).toEqual([{ key: "collecting" }, { key: "elsewhere" }, { key: "installing" }]);
    expect(await db.all("SELECT id FROM liraa_items")).toEqual([{ id: "li-other" }]);
    // Not filed under a household: they stay.
    expect([await count(db, "city_blocks"), await count(db, "transmission_blocks")]).toEqual([1, 1]);
  });

  test("the reset that comes when the switch toggles empties the vector tables and refills them (Q6)", async () => {
    const db = await createTestDb();
    await applyPage(db, VECTOR);
    const other = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
    const otherBlock = { ...BLOCK, id: other, number: "13", neighbor_ids: [BLOCK.id] };
    await applyPage(db, valid({ ...VECTOR, reset: true, items: [{ type: "city_block", id: other, version: 1, body: { ...otherBlock, version: 1 } as unknown as Record<string, never> }] }));
    expect(await db.all("SELECT id FROM city_blocks")).toEqual([{ id: other }]);
    for (const table of ["ovitraps", "liraa_items", "transmission_blocks", "households"]) expect([table, await count(db, table)]).toEqual([table, 0]);
    await applyPage(db, { ...VECTOR, reset: true });
    expect([await count(db, "city_blocks"), await count(db, "ovitraps"), await count(db, "liraa_items"), await count(db, "transmission_blocks")]).toEqual([1, 1, 1, 1]);
    expect(JSON.parse((await householdRow(db, VHH.id))!.body).vector).toEqual(VHH.vector);
  });
});

// Q42: a download that starts without a cursor (a tablet migrated to v2, a first load, after the 30 days) applies its
// first page as a reset — whatever the tablet had from another scope goes. Never before the request: a failure leaves
// the territory as it was.
describe("first page of a download without a cursor", () => {
  const OLD_AREA = "01d0a7ea-0000-4000-8000-000000000001";
  const seedOldScope = async (db: Db) => {
    await db.run("INSERT INTO micro_areas (id, body, team_id) VALUES (?, '{}', 't')", [OLD_AREA]);
    await db.run("INSERT INTO households (key, id, micro_area_id, body, street_norm, number) VALUES ('old-hh', 'old-hh', ?, '{}', 'x', '1')", [OLD_AREA]);
    await db.run("INSERT INTO registrations (key, id, household_key, body, name_norm) VALUES ('old-rg', 'old-rg', 'old-hh', '{}', 'x')");
    await db.run("INSERT INTO meta (key, value) VALUES ('last_download_ok_at', '2026-11-10T12:00:00.000Z')"); // migrated: downloaded before
  };

  test("a migrated tablet's micro-area outside the new scope goes with its households and registrations, then the page is applied", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    const pages = [FIRST, LAST];
    await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => Date.parse("2026-11-19T12:00:00Z") });
    expect(await db.all("SELECT id FROM micro_areas")).toEqual([{ id: FIRST.items[0].id }]);
    expect(await db.all("SELECT key FROM households")).toEqual([{ key: HH.id }]);
    expect(await db.all("SELECT key FROM registrations")).toEqual([{ key: REG.id }]);
    // The second page has a cursor: applied on top, nothing wiped.
    expect(await count(db, "who_to_visit")).toBe(WHO.micro_areas.length);
    expect(await meta(db, "cursor")).toBe(LAST.next_cursor);
  });

  test("a network failure on the first page leaves the territory intact", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    const client = { changes: jest.fn().mockRejectedValueOnce(new FieldHttpError({ kind: "network" })) };
    await expect(downloadAll({ db, client, now: () => 0 })).rejects.toBeInstanceOf(FieldHttpError);
    expect([await count(db, "micro_areas"), await count(db, "households"), await count(db, "registrations")]).toEqual([1, 1, 1]);
    expect(await meta(db, "last_download_ok_at")).toBe("2026-11-10T12:00:00.000Z");
    expect(await meta(db, "cursor")).toBeNull();
  });

  test("a download that starts with a cursor does not wipe", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    await territoryRepo.setMeta(db, "cursor", "from-before");
    const pages = [FIRST, LAST];
    await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => 0 });
    expect((await db.all<{ id: string }>("SELECT id FROM micro_areas ORDER BY id")).map((r) => r.id)).toEqual([OLD_AREA, FIRST.items[0].id].sort());
    expect([await count(db, "households"), await count(db, "registrations")]).toEqual([2, 2]);
  });

  // Q42 (b): only the territory goes. What the person did today and the server already accepted keeps its mark.
  test("the accepted visits and activities survive the start-over", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    await db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('v-today', '2026-11-19', 't', '{}', 'accepted')");
    await db.run("INSERT INTO local_activities (client_uuid, held_on, summary, state) VALUES ('a-today', '2026-11-19', '{}', 'accepted')");
    const pages = [FIRST, LAST];
    await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => 0 });
    expect(await db.all("SELECT key FROM households")).toEqual([{ key: HH.id }]);
    expect(await db.all("SELECT client_uuid FROM local_visits")).toEqual([{ client_uuid: "v-today" }]);
    expect(await db.all("SELECT client_uuid FROM local_activities")).toEqual([{ client_uuid: "a-today" }]);
  });

  // The restart stopped after page 1 (review I1): the territory is half there, but the tablet is not a first load —
  // last_download_ok_at stays, so Q13(4) and the gate still see a tablet that downloaded before.
  test("a restart that fails after its first page keeps the last download mark", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    const client = { changes: jest.fn().mockResolvedValueOnce(FIRST).mockRejectedValueOnce(new FieldHttpError({ kind: "network" })) };
    await expect(downloadAll({ db, client, now: () => 0 })).rejects.toBeInstanceOf(FieldHttpError);
    expect(await db.all("SELECT key FROM households")).toEqual([{ key: HH.id }]);
    expect(await meta(db, "cursor")).toBe(FIRST.next_cursor);
    expect(await meta(db, "last_download_ok_at")).toBe("2026-11-10T12:00:00.000Z");
  });

  // A server reset that stops after its page forgets the mark, as in the 24c.
  test("a server reset that fails after its page forgets the last download mark, as before", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    await territoryRepo.setMeta(db, "cursor", "from-before");
    const client = { changes: jest.fn().mockResolvedValueOnce(RESET).mockRejectedValueOnce(new FieldHttpError({ kind: "network" })) };
    await expect(downloadAll({ db, client, now: () => 0 })).rejects.toBeInstanceOf(FieldHttpError);
    expect(await meta(db, "last_download_ok_at")).toBeNull();
  });

  // The 24c's scope change is unchanged: a server reset takes the accepted visits too.
  test("server reset still wipes the accepted visits", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    await territoryRepo.setMeta(db, "cursor", "from-before");
    await db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('v-today', '2026-11-19', 't', '{}', 'accepted')");
    await db.run("INSERT INTO local_activities (client_uuid, held_on, summary, state) VALUES ('a-today', '2026-11-19', '{}', 'accepted')");
    const pending = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
    await db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, '2026-11-19', 't', '{}', 'pending')", [pending.client_uuid]);
    const pages = [RESET, LAST];
    await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => 0 });
    expect(await count(db, "households")).toBe(0);
    expect(await db.all("SELECT client_uuid FROM local_visits")).toEqual([{ client_uuid: pending.client_uuid }]);
    expect(await count(db, "local_activities")).toBe(0);
  });

  test("the queue and the trusted clock survive the reset", async () => {
    const db = await createTestDb();
    await seedOldScope(db);
    const pending = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
    await territoryRepo.setMeta(db, HIGH_WATER_KEY, "1763553600000");
    await territoryRepo.setMeta(db, "clock_skew_ms", "-5000");
    const pages = [FIRST, LAST];
    await downloadAll({ db, client: { changes: async () => pages.shift()! }, now: () => 0 });
    expect(await count(db, "households")).toBe(1);
    expect((await outboxRepo.all(db)).map((i) => i.client_uuid)).toEqual([pending.client_uuid]);
    expect(await meta(db, HIGH_WATER_KEY)).toBe("1763553600000");
    expect(await meta(db, "clock_skew_ms")).toBe("-5000");
  });
});
