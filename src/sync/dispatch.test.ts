import type { UploadItem, UploadResult } from "../contract";
import { outboxRepo, type OutboxItem } from "../db/repos/outboxRepo";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { MAX_BATCH, applyResults, refreshBlocked, resolveVersion, selectBatch, sendQueue } from "./dispatch";
import { FieldHttpError } from "./http";
import { enqueue, recoverSending, resend } from "./outbox";
import { SERVER_ID, accepted, exampleItems, fakeClient, insertHousehold, insertRegistration, newUuid, rejected } from "./testing";

const VISIT = exampleItems("upload-home-visit-resident.json")[0];
const EDIT = exampleItems("upload-household-update.json")[0];
// patient → household (new) → individual_registration citing both by client_uuid.
const [PATIENT, HOUSEHOLD, REGISTRATION] = exampleItems("upload-registration-same-batch.json");
// household (new) → patient → registration → family citing the household by client_uuid.
const FAMILY_NEW = exampleItems("upload-family-new.json");

const noStale = { onStale: async () => { throw new Error("unexpected stale_version"); } };
const states = async (db: Db) => (await outboxRepo.all(db)).map((item) => [item.type, item.state]);
const byType = (items: UploadItem[]) => items.map((item) => item.type);
const row = <T>(db: Db, table: string, key: string) => db.get<T>(`SELECT * FROM ${table} WHERE key = ?`, [key]);

const item = (o: Partial<OutboxItem> & Pick<OutboxItem, "seq">): OutboxItem => ({
  client_uuid: `u${o.seq}`, type: "home_visit", body: {}, target_id: null, edit_base_version: null, edit_base_body: null, depends_on: [],
  state: "pending", error: null, path: null, candidates: null, confirmable: null, conflicts: null, sent_version: null, attempts: 0,
  created_at: "t", updated_at: "t", ...o,
});

describe("selectBatch", () => {
  test("keeps creation order and sends at most 50", () => {
    const queue = Array.from({ length: 60 }, (_, i) => item({ seq: i + 1 }));
    const batch = selectBatch(queue);
    expect(batch).toHaveLength(MAX_BATCH);
    expect(batch.map((i) => i.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(selectBatch(queue, 3).map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  test("only pending items travel", () => {
    const queue = (["pending", "sending", "needs_attention", "conflict", "blocked", "pending"] as const).map((state, i) => item({ seq: i + 1, state }));
    expect(selectBatch(queue).map((i) => i.seq)).toEqual([1, 6]);
  });

  test("cite dependency may travel in the same batch after its target", () => {
    const queue = [item({ seq: 1, type: "patient" }), item({ seq: 2, type: "individual_registration", depends_on: [{ client_uuid: "u1", kind: "cite" }] })];
    expect(selectBatch(queue).map((i) => i.seq)).toEqual([1, 2]);
    // The target did not fit, is held or is not travelling: the one that cites it waits.
    expect(selectBatch(queue, 1).map((i) => i.seq)).toEqual([1]);
    expect(selectBatch([{ ...queue[0], state: "needs_attention" }, queue[1]])).toEqual([]);
    // The target already left the queue: nothing to wait for.
    expect(selectBatch([queue[1]]).map((i) => i.seq)).toEqual([2]);
  });

  test("version dependency never shares a batch", () => {
    const queue = [
      item({ seq: 1, type: "household", target_id: "h" }),
      item({ seq: 2, type: "family", target_id: "h2", depends_on: [{ client_uuid: "u1", kind: "version" }] }),
    ];
    expect(selectBatch(queue).map((i) => i.seq)).toEqual([1]);
    expect(selectBatch([queue[1]]).map((i) => i.seq)).toEqual([2]);
  });

  test("two items on the same target go in successive batches", () => {
    const queue = [item({ seq: 1, type: "household", target_id: "h" }), item({ seq: 2, type: "household", target_id: "h" }), item({ seq: 3, type: "household", target_id: "k" })];
    expect(selectBatch(queue).map((i) => i.seq)).toEqual([1, 3]);
  });

  test("items the round already put back are skipped, and what cites them waits", () => {
    const queue = [item({ seq: 1, type: "patient" }), item({ seq: 2, depends_on: [{ client_uuid: "u1", kind: "cite" }] }), item({ seq: 3 })];
    expect(selectBatch(queue, MAX_BATCH, new Set(["u1"])).map((i) => i.seq)).toEqual([3]);
  });
});

test("resolveVersion: the edit's own base, or the row's when the edit has none (Q41)", () => {
  expect(resolveVersion(item({ seq: 1, type: "household", target_id: "h", edit_base_version: 3 }), 4)).toBe(3);
  expect(resolveVersion(item({ seq: 1, type: "family", target_id: "h" }), 4)).toBe(4);
  expect(resolveVersion(item({ seq: 1, type: "household", target_id: "h" }), null)).toBeNull();
});

describe("sendQueue", () => {
  test("sends 60 visits in creation order, 50 and then 10", async () => {
    const db = await createTestDb();
    const uuids: string[] = [];
    for (let i = 0; i < 60; i++) uuids.push((await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid)).client_uuid);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i)));
    expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: null });
    expect(batches.map((b) => b.length)).toEqual([50, 10]);
    expect(batches.flat().map((i) => i.client_uuid)).toEqual(uuids);
    expect(await outboxRepo.count(db)).toBe(0);
  });

  test("accepted removes, maps client_uuid → id and fills base_version from result.version", async () => {
    const db = await createTestDb();
    await insertHousehold(db, "hh-key", { baseVersion: 3 });
    const edit = await enqueue(db, { type: "household", body: EDIT.body, targetId: "hh-key", editBase: { version: 3, body: {} }, clientUuid: EDIT.client_uuid }, newUuid);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { version: 4 })));
    await sendQueue({ db, client, ...noStale });
    expect(batches[0][0]).toEqual({ client_uuid: edit.client_uuid, type: "household", body: { ...EDIT.body, version: 3 } });
    expect(await outboxRepo.count(db)).toBe(0);
    expect(await outboxRepo.mappedIds(db)).toEqual(new Map([[edit.client_uuid, SERVER_ID]]));
    const hh = await row<{ id: string; base_version: number; base_body: string; needs_reload: number }>(db, "households", "hh-key");
    expect([hh!.id, hh!.base_version, hh!.needs_reload]).toEqual([SERVER_ID, 4, 0]);
    expect(JSON.parse(hh!.base_body)).toEqual(EDIT.body); // the projection sent, without the version
  });

  test("duplicate leaves the queue like accepted", async () => {
    const db = await createTestDb();
    await insertRegistration(db, "rg-key", { baseVersion: 1 });
    // An edit of a registration names it: the schema ties `version` to `registration_id`.
    const body = { ...exampleItems("upload-individual-registration.json")[0].body, registration_id: SERVER_ID };
    const edit = await enqueue(db, { type: "individual_registration", body, targetId: "rg-key", editBase: { version: 1, body: {} } }, newUuid);
    const { client } = fakeClient((items) => items.map((i) => ({ ...accepted(i, { version: 2 }), status: "duplicate" as const })));
    await sendQueue({ db, client, ...noStale });
    expect(await outboxRepo.count(db)).toBe(0);
    expect((await outboxRepo.mappedIds(db)).get(edit.client_uuid)).toBe(SERVER_ID);
    expect((await row<{ base_version: number }>(db, "registrations", "rg-key"))!.base_version).toBe(2);
  });

  test("duplicate without version marks the row for reload, no merge (Q5)", async () => {
    const db = await createTestDb();
    await insertHousehold(db, "hh-key", { baseVersion: 3 });
    await db.run("UPDATE households SET base_body = '{\"contact_phone\":\"4100\"}' WHERE key = 'hh-key'");
    const edit = await enqueue(db, { type: "household", body: EDIT.body, targetId: "hh-key", editBase: { version: 3, body: {} } }, newUuid);
    const stale = jest.fn();
    const { client } = fakeClient((items) => items.map((i) => ({ client_uuid: i.client_uuid, status: "duplicate", type: i.type, id: SERVER_ID })));
    await sendQueue({ db, client, onStale: stale });
    expect(stale).not.toHaveBeenCalled();
    expect(await outboxRepo.count(db)).toBe(0);
    expect((await outboxRepo.mappedIds(db)).get(edit.client_uuid)).toBe(SERVER_ID);
    const hh = await row<{ base_version: number; base_body: string; needs_reload: number }>(db, "households", "hh-key");
    expect([hh!.base_version, hh!.base_body, hh!.needs_reload]).toEqual([3, '{"contact_phone":"4100"}', 1]);
  });

  test("a new household is sent without version; its family waits for the accepted version and then carries it", async () => {
    const db = await createTestDb();
    const [household, , , family] = FAMILY_NEW;
    await insertHousehold(db, household.client_uuid, { id: null });
    await enqueue(db, { type: "household", body: household.body, targetId: household.client_uuid, clientUuid: household.client_uuid }, newUuid);
    const { responsible: _responsible, ...familyBody } = family.body;
    await enqueue(db, {
      type: "family", body: { ...familyBody, responsible: { patient_id: "3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d6e" } }, targetId: household.client_uuid,
      deps: [{ client_uuid: household.client_uuid, kind: "version" }], clientUuid: family.client_uuid,
    }, newUuid);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { version: i.type === "household" ? 1 : 2 })));
    await sendQueue({ db, client, ...noStale });
    expect(batches.map(byType)).toEqual([["household"], ["family"]]);
    expect(batches[0][0].body).not.toHaveProperty("version");
    expect((batches[1][0].body as { version: number }).version).toBe(1);
    const hh = await row<{ id: string; base_version: number }>(db, "households", household.client_uuid);
    // The family's accepted answer moves the household's version, not its id.
    expect([hh!.id, hh!.base_version]).toEqual([SERVER_ID, 2]);
  });

  test("sends the edit base version after a newer download", async () => {
    const db = await createTestDb();
    await insertHousehold(db, "hh-key", { baseVersion: 3 });
    await enqueue(db, { type: "household", body: EDIT.body, targetId: "hh-key", editBase: { version: 3, body: {} } }, newUuid);
    // The download brought v4 for the row and did not touch the item.
    await db.run("UPDATE households SET version = 4, base_version = 4 WHERE key = 'hh-key'");
    const stale = jest.fn(async (i: OutboxItem) => { await outboxRepo.update(db, i.seq, { state: "conflict" }); });
    const { client, batches } = fakeClient((items) => items.map((i) => ({ client_uuid: i.client_uuid, status: "stale_version", type: i.type, id: SERVER_ID, current_version: 4, current: CURRENT })));
    await sendQueue({ db, client, onStale: stale });
    expect((batches[0][0].body as { version: number }).version).toBe(3);
    expect(stale).toHaveBeenCalledTimes(1);
    expect(stale.mock.calls[0][0]).toMatchObject({ target_id: "hh-key", sent_version: 3, state: "sending" });
    expect(await states(db)).toEqual([["household", "conflict"]]);
  });

  test("later edit on top of an accepted one is rebased to the accepted version", async () => {
    const db = await createTestDb();
    await insertHousehold(db, "hh-key", { baseVersion: 3 });
    await enqueue(db, { type: "household", body: { ...EDIT.body, contact_phone: "41988880001" }, targetId: "hh-key", editBase: { version: 3, body: {} } }, newUuid);
    await enqueue(db, { type: "household", body: { ...EDIT.body, contact_phone: "41988880002" }, targetId: "hh-key", editBase: { version: 3, body: {} } }, newUuid);
    let version = 3;
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { version: ++version })));
    await sendQueue({ db, client, ...noStale });
    expect(batches.map((b) => b.map((i) => (i.body as { version: number }).version))).toEqual([[3], [4]]);
    expect((await row<{ base_version: number }>(db, "households", "hh-key"))!.base_version).toBe(5);
  });

  test("an edit based on another version is not rebased: it will go through the merge", async () => {
    const db = await createTestDb();
    await insertHousehold(db, "hh-key", { baseVersion: 3 });
    const first = await enqueue(db, { type: "household", body: EDIT.body, targetId: "hh-key", editBase: { version: 3, body: {} } }, newUuid);
    const second = await enqueue(db, { type: "household", body: EDIT.body, targetId: "hh-key", editBase: { version: 2, body: {} } }, newUuid);
    await applyResults(db, [{ ...first, state: "sending", sent_version: 3 }], [accepted(first, { version: 4 })], noStale);
    expect((await outboxRepo.bySeq(db, second.seq))!.edit_base_version).toBe(2);
  });

  test("visit, withdrawal and activity update their local rows", async () => {
    const db = await createTestDb();
    const visit = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const gone = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const withdrawal = await enqueue(db, { type: "home_visit_withdrawal", body: { visit_client_uuid: gone.client_uuid, reason: "Registro feito no domicílio errado" } }, newUuid);
    const activity = await enqueue(db, { type: "collective_activity", body: exampleItems("upload-collective-activity.json")[0].body }, newUuid);
    for (const uuid of [visit.client_uuid, gone.client_uuid]) {
      await db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, '2026-11-14', 't', '{}', 'pending')", [uuid]);
    }
    await db.run("INSERT INTO local_activities (client_uuid, held_on, summary, state) VALUES (?, '2026-11-14', '{}', 'pending')", [activity.client_uuid]);
    const { client } = fakeClient((items) => items.map((i) => accepted(i)));
    await sendQueue({ db, client, ...noStale });
    expect(await db.all("SELECT client_uuid, state, server_id FROM local_visits ORDER BY rowid")).toEqual([
      { client_uuid: visit.client_uuid, state: "accepted", server_id: SERVER_ID },
      { client_uuid: gone.client_uuid, state: "withdrawn", server_id: SERVER_ID },
    ]);
    expect(await db.get("SELECT state, server_id FROM local_activities")).toEqual({ state: "accepted", server_id: SERVER_ID });
    expect(withdrawal.type).toBe("home_visit_withdrawal");
  });

  test("household_changed goes back to pending twice and needs attention on the third round (Q45)", async () => {
    const db = await createTestDb();
    await insertRegistration(db, "rg-key", { id: null });
    const reg = await enqueue(db, { type: "individual_registration", body: exampleItems("upload-individual-registration.json")[0].body, targetId: "rg-key" }, newUuid);
    const { client, uploads } = fakeClient((items) => items.map((i) => rejected(i, "household_changed", { path: "household_id" })));
    for (const attempts of [1, 2]) {
      expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: null });
      expect(await outboxRepo.bySeq(db, reg.seq)).toMatchObject({ state: "pending", attempts, error: null });
    }
    await sendQueue({ db, client, ...noStale });
    expect(await outboxRepo.bySeq(db, reg.seq)).toMatchObject({ state: "needs_attention", error: "household_changed", path: "household_id" });
    expect(uploads).toHaveBeenCalledTimes(3); // once per round, never twice in the same one
  });

  test("rejected stays as needs_attention with phrase code and path; dependents become blocked", async () => {
    const db = await createTestDb();
    await insertHousehold(db, HOUSEHOLD.client_uuid, { id: null });
    await insertRegistration(db, REGISTRATION.client_uuid, { id: null });
    const cite = (uuid: string) => ({ client_uuid: uuid, kind: "cite" as const });
    await enqueue(db, { type: "patient", body: PATIENT.body, clientUuid: PATIENT.client_uuid }, newUuid);
    await enqueue(db, { type: "household", body: HOUSEHOLD.body, targetId: HOUSEHOLD.client_uuid, clientUuid: HOUSEHOLD.client_uuid }, newUuid);
    await enqueue(db, {
      type: "individual_registration", body: REGISTRATION.body, targetId: REGISTRATION.client_uuid, clientUuid: REGISTRATION.client_uuid,
      deps: [cite(PATIENT.client_uuid), cite(HOUSEHOLD.client_uuid)],
    }, newUuid);
    const later = await enqueue(db, { type: "home_visit", body: VISIT.body, deps: [cite(REGISTRATION.client_uuid)] }, newUuid);
    const { client, batches } = fakeClient((items) => items.map((i): UploadResult => {
      if (i.type === "patient") return rejected(i, "invalid_cpf", { path: "new_patient.cpf" });
      if (i.type === "individual_registration") return rejected(i, "not_found", { path: "patient_client_uuid" });
      if (i.type === "home_visit") return rejected(i, "not_found", { path: "patient_client_uuid" });
      return accepted(i, { version: 1 });
    }));
    await sendQueue({ db, client, ...noStale });
    expect(batches.map(byType)).toEqual([["patient", "household", "individual_registration", "home_visit"]]);
    expect(await states(db)).toEqual([["patient", "needs_attention"], ["individual_registration", "blocked"], ["home_visit", "blocked"]]);
    expect(await outboxRepo.byClientUuid(db, PATIENT.client_uuid)).toMatchObject({ error: "invalid_cpf", path: "new_patient.cpf" });
    expect(await outboxRepo.byClientUuid(db, REGISTRATION.client_uuid)).toMatchObject({ error: null });
    expect(later.seq).toBe(4);
  });

  test("resend after fix keeps the same client_uuid and sends what was blocked behind it", async () => {
    const db = await createTestDb();
    const patient = await enqueue(db, { type: "patient", body: PATIENT.body, clientUuid: PATIENT.client_uuid }, newUuid);
    const visit = await enqueue(db, { type: "home_visit", body: VISIT.body, deps: [{ client_uuid: patient.client_uuid, kind: "cite" }] }, newUuid);
    let round = 0;
    const { client, batches } = fakeClient((items) => {
      round += 1;
      return items.map((i): UploadResult => (round === 1
        ? (i.type === "patient" ? rejected(i, "invalid_cpf", { path: "new_patient.cpf" }) : rejected(i, "not_found", { path: "patient_client_uuid" }))
        : accepted(i)));
    });
    await sendQueue({ db, client, ...noStale });
    expect(await states(db)).toEqual([["patient", "needs_attention"], ["home_visit", "blocked"]]);
    // Nothing travels while the person has not fixed it.
    await sendQueue({ db, client, ...noStale });
    expect(batches).toHaveLength(1);

    await resend(db, patient.seq, PATIENT.body);
    await sendQueue({ db, client, ...noStale });
    expect(batches[1].map((i) => i.client_uuid)).toEqual([patient.client_uuid, visit.client_uuid]);
    expect(await outboxRepo.count(db)).toBe(0);
  });

  test("too_many_requests puts the refused back to pending and stops the round", async () => {
    const db = await createTestDb();
    const a = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const b = await enqueue(db, { type: "patient", body: PATIENT.body }, newUuid);
    const c = await enqueue(db, { type: "patient", body: PATIENT.body }, newUuid);
    const { client, uploads } = fakeClient((items) => items.map((i) => (i.type === "patient" ? rejected(i, "too_many_requests") : accepted(i))));
    expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: "rate_limited" });
    expect(uploads).toHaveBeenCalledTimes(1);
    expect((await outboxRepo.all(db)).map((i) => [i.client_uuid, i.state, i.attempts])).toEqual([[b.client_uuid, "pending", 1], [c.client_uuid, "pending", 1]]);
    expect(a.seq).toBe(1);
  });

  test("feature_disabled keeps the record waiting, without counting attempts and without asking for attention", async () => {
    const db = await createTestDb();
    const visit = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const { client, uploads } = fakeClient((items) => items.map((i) => rejected(i, "feature_disabled")));
    expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: null });
    expect(uploads).toHaveBeenCalledTimes(1);
    expect(await outboxRepo.bySeq(db, visit.seq)).toMatchObject({ state: "pending", attempts: 0, error: null });
  });

  test("recoverSending turns sending into pending after a crash, and the resend accepts duplicate", async () => {
    const db = await createTestDb();
    const visit = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    await outboxRepo.update(db, visit.seq, { state: "sending" }); // the app died after the POST left
    const { client, batches } = fakeClient((items) => items.map((i) => ({ ...accepted(i), status: "duplicate" as const })));
    await sendQueue({ db, client, ...noStale });
    expect(batches).toHaveLength(0); // an item in flight is never picked again by itself
    expect(await recoverSending(db)).toBe(1);
    await sendQueue({ db, client, ...noStale });
    expect(batches[0][0].client_uuid).toBe(visit.client_uuid);
    expect(await outboxRepo.count(db)).toBe(0);
  });

  test("an HTTP failure puts the batch back and reports the failure; nothing is lost", async () => {
    const db = await createTestDb();
    const visit = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const client = { uploads: jest.fn(async () => { throw new FieldHttpError({ kind: "network" }); }) };
    expect(await sendQueue({ db, client, ...noStale })).toEqual({ stop: "http", failure: { kind: "network" } });
    expect(await outboxRepo.bySeq(db, visit.seq)).toMatchObject({ state: "pending", attempts: 0 });
  });

  test("a result without client_uuid is judged by position; an item the answer forgot goes back to the line", async () => {
    const db = await createTestDb();
    const a = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const b = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
    const sent = (await outboxRepo.all(db)).map((i) => ({ ...i, state: "sending" as const }));
    for (const i of sent) await outboxRepo.update(db, i.seq, { state: "sending" });
    const signal = await applyResults(db, sent, [{ client_uuid: null, status: "rejected", error: "invalid_request" }], noStale);
    expect(signal).toEqual({ stop: null, progressed: true, deferred: [b.client_uuid] });
    expect(await outboxRepo.bySeq(db, a.seq)).toMatchObject({ state: "needs_attention", error: "invalid_request" });
    expect(await outboxRepo.bySeq(db, b.seq)).toMatchObject({ state: "pending" });
  });
});

test("refreshBlocked holds what depends on a held item, through any depth, and frees it when the cause is gone", async () => {
  const db = await createTestDb();
  const a = await enqueue(db, { type: "patient", body: {} }, newUuid);
  const b = await enqueue(db, { type: "individual_registration", body: {}, deps: [{ client_uuid: a.client_uuid, kind: "cite" }] }, newUuid);
  const c = await enqueue(db, { type: "home_visit", body: {}, deps: [{ client_uuid: b.client_uuid, kind: "cite" }] }, newUuid);
  const d = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  await outboxRepo.update(db, a.seq, { state: "conflict" });
  await refreshBlocked(db);
  expect((await outboxRepo.all(db)).map((i) => i.state)).toEqual(["conflict", "blocked", "blocked", "pending"]);
  await outboxRepo.update(db, a.seq, { state: "pending" });
  await refreshBlocked(db);
  expect((await outboxRepo.all(db)).map((i) => i.state)).toEqual(["pending", "pending", "pending", "pending"]);
  expect([c.seq, d.seq]).toEqual([3, 4]);
});

const CURRENT = (() => {
  const response = require("../../contracts/field-sync/examples/upload-response-stale-household.json") as { results: { current: Record<string, unknown> }[] };
  return response.results[0].current;
})();
