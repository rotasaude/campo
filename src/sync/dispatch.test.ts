import type { ChangesResponse, UploadItem, UploadResponse, UploadResult } from "../contract";
import { example } from "../contract/fixtures";
import { collectOvitrap, installOvitrap } from "../features/ovitraps/save";
import { collectLeish, placeCollar, saveAnimal, vaccinate } from "../features/animals/save";
import { pathLabel } from "../features/conflicts/fieldText";
import { phraseForItem } from "../features/messages/errorPhrases";
import { ZOONOSES_ERRORS, type ZoonosesErrorCode } from "../rules/zoonosesErrors";
import { ANIMAL, HH, JOANA, endemicTablet, zoonosesTablet } from "../features/testing";
import { emptyAnimalDraft, type AnimalDraft } from "../rules/animal";
import { outboxRepo, type OutboxItem } from "../db/repos/outboxRepo";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { MAX_BATCH, applyResults, refreshBlocked, resolveVersion, selectBatch, sendQueue } from "./dispatch";
import { applyPage } from "./download";
import { FieldHttpError } from "./http";
import { discardImpact, enqueue, recoverSending, removeUnsent, resend } from "./outbox";
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

  test("a second edit of a record born on the tablet names it by the server id once the first was accepted", async () => {
    // The schema ties `version` to `household_id` (and to `registration_id`): the second item was written
    // before the server gave the record an id, so its body has neither.
    const db = await createTestDb();
    await insertHousehold(db, HOUSEHOLD.client_uuid, { id: null });
    await enqueue(db, { type: "household", body: HOUSEHOLD.body, targetId: HOUSEHOLD.client_uuid, clientUuid: HOUSEHOLD.client_uuid }, newUuid);
    await enqueue(db, { type: "household", body: { ...HOUSEHOLD.body, contact_phone: "41988880009" }, targetId: HOUSEHOLD.client_uuid }, newUuid);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { version: batches.length })));
    await sendQueue({ db, client, ...noStale });
    expect(batches).toHaveLength(2);
    expect(batches[0][0].body).not.toHaveProperty("household_id");
    expect(batches[1][0].body).toMatchObject({ household_id: SERVER_ID, version: 1, contact_phone: "41988880009" });
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

  // Review I2: what cites an item that was only put back for the next round did nothing wrong either.
  test.each([["too_many_requests"], ["household_changed"], ["internal_error"]])(
    "a dependent of an item deferred by %s in the same batch goes back to the line with it, not to attention", async (code) => {
      const db = await createTestDb();
      const patient = await enqueue(db, { type: "patient", body: { new_patient: { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female", no_cpf_reason: "2" } } }, newUuid);
      const visit = await enqueue(db, {
        type: "home_visit", deps: [{ client_uuid: patient.client_uuid, kind: "cite" }],
        body: { team_id: "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b", occurred_at: "2026-11-14T10:00:00-03:00", subject: "resident", patient_client_uuid: patient.client_uuid, outcome: 3, reasons: [], shared: false, property_type: "1", micro_area_id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d" },
      }, newUuid);
      const sent = (await outboxRepo.all(db)).map((item) => ({ ...item, state: "sending" as const }));
      const signal = await applyResults(db, sent, [rejected(patient, code), rejected(visit, "not_found", { path: "patient_client_uuid" })], noStale);
      const after = await outboxRepo.all(db);
      expect(after.map((item) => [item.type, item.state, item.error])).toEqual([["patient", "pending", null], ["home_visit", "pending", null]]);
      expect(signal.deferred).toEqual(expect.arrayContaining([patient.client_uuid, visit.client_uuid]));
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

// ── 35a: the ovitrap (Task 9) ──
describe("ovitraps", () => {
  const OVITRAP_ID = "c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f";
  const U1 = "c0ffee64-0000-4000-8000-000000000064";
  const NEW_ID = "c0ffee70-0000-4000-8000-000000000070";
  const installed = async () => {
    const db = await endemicTablet();
    await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-08" });
    return db;
  };

  test("accepted installation maps client_ids to result.id and the row gets it", async () => {
    const db = await installed();
    // The id of the installation's result is the ovitrap's (Q7(2)).
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { id: NEW_ID })));
    await sendQueue({ db, client, ...noStale });
    expect(batches[0][0]).toEqual({ client_uuid: U1, type: "ovitrap_installation", body: { household_id: HH, number: "OVT-015", consent: true, installed_on: "2026-11-08" } });
    expect((await outboxRepo.mappedIds(db)).get(U1)).toBe(NEW_ID);
    expect(await db.get("SELECT key, id, client_uuid, number FROM ovitraps WHERE key = ?", [U1])).toEqual({ key: U1, id: NEW_ID, client_uuid: U1, number: "OVT-015" });
  });

  test("accepted and duplicate collections leave the line and show on the row until the download", async () => {
    const db = await installed();
    await collectOvitrap(db, { ovitrapKey: U1, condition: "ok", remove: false, today: "2026-11-14", newUuid });
    await collectOvitrap(db, { ovitrapKey: OVITRAP_ID, condition: "lost", remove: true, today: "2026-11-15", newUuid });
    // The id of a collection's result is the ovitrap's too (Q7(2)).
    const { client, batches } = fakeClient((items) => items.map((i) => ({
      ...accepted(i, { id: i.type === "ovitrap_installation" || "ovitrap_client_uuid" in i.body ? NEW_ID : OVITRAP_ID }),
      status: i.type === "ovitrap_installation" ? "accepted" as const : "duplicate" as const,
    })));
    await sendQueue({ db, client, ...noStale });
    expect(batches.map(byType)).toEqual([["ovitrap_installation", "ovitrap_collection", "ovitrap_collection"]]);
    expect(await outboxRepo.count(db)).toBe(0);
    const rows = await db.all<{ key: string; body: string }>("SELECT key, body FROM ovitraps ORDER BY key");
    // The removed one is gone; the reinstalled one has the paddle opened on the collection's day.
    expect(rows.map((r) => [r.key, (JSON.parse(r.body) as { open_reading: unknown }).open_reading])).toEqual([[U1, { installed_on: "2026-11-14" }]]);
  });

  test("the download of the server ovitrap replaces the tablet-born row by client_ids", async () => {
    const db = await installed();
    // Accepted, the receipt known by client_ids alone (the row without the id): the download still finds the row.
    const [item] = await outboxRepo.all(db);
    await outboxRepo.remove(db, item.seq);
    await outboxRepo.mapClientId(db, U1, "ovitrap_installation", NEW_ID);
    const page = example<ChangesResponse>("changes-vector-page.json");
    const ov = page.items.find((i) => i.type === "ovitrap")!;
    const body = { ...(ov.body as Record<string, unknown>), id: NEW_ID, number: "OVT-015", open_reading: { installed_on: "2026-11-08" }, last_reading: null, version: 1 };
    await applyPage(db, { ...page, items: [{ ...ov, id: NEW_ID, version: 1, body }] } as unknown as ChangesResponse);
    const rows = await db.all<{ key: string; id: string; version: number; body: string }>("SELECT key, id, version, body FROM ovitraps WHERE number = 'OVT-015'");
    expect(rows.map((r) => [r.key, r.id, r.version, JSON.parse(r.body)])).toEqual([[U1, NEW_ID, 1, body]]);
  });
});

describe("animals", () => {
  const NEW_ANIMAL = "c0ffee73-0000-4000-8000-000000000073";
  const draft = (over: Partial<AnimalDraft> = {}): AnimalDraft => ({ ...emptyAnimalDraft(), species: "dog", sex: "female", ...over });

  test("accepted animal maps client_ids, gives the row id and version, and the next edit goes by animal_id", async () => {
    const db = await zoonosesTablet();
    const key = await saveAnimal(db, { householdKey: HH, draft: { ...draft({ name: "Rex", tutorKey: JOANA }), microchip: "985141000123456" }, newUuid });
    const { client, batches } = fakeClient((items, call) => items.map((i) => accepted(i, { id: NEW_ANIMAL, version: call })));
    await sendQueue({ db, client, ...noStale });
    expect(batches[0][0]).toEqual({
      client_uuid: key, type: "animal",
      body: { household_id: HH, species: "dog", sex: "female", name: "Rex", tutor_patient_id: JOANA, community: false, microchip: "985141000123456" },
    });
    expect((await outboxRepo.mappedIds(db)).get(key)).toBe(NEW_ANIMAL);
    const accepted1 = await db.get<{ id: string; version: number; base_version: number; needs_reload: number; body: string }>(
      "SELECT id, version, base_version, needs_reload, body FROM animals WHERE key = ?", [key]);
    expect(accepted1).toMatchObject({ id: NEW_ANIMAL, version: 1, base_version: 1, needs_reload: 0 });
    expect(JSON.parse(accepted1!.body)).toMatchObject({ id: NEW_ANIMAL, version: 1, name: "Rex", has_microchip: true, tutor: { patient_id: JOANA, display_name: "Joana Conceição" } });
    expect(accepted1!.body).not.toContain("985141000123456");

    await saveAnimal(db, { householdKey: HH, animalKey: key, draft: draft({ name: "Rei", tutorKey: JOANA }), newUuid });
    await sendQueue({ db, client, ...noStale });
    expect(batches[1][0].body).toEqual({
      animal_id: NEW_ANIMAL, version: 1, household_id: HH, species: "dog", sex: "female", name: "Rei", tutor_patient_id: JOANA, community: false,
    });
    expect(await db.get("SELECT id, version, base_version FROM animals WHERE key = ?", [key])).toEqual({ id: NEW_ANIMAL, version: 2, base_version: 2 });
  });

  test("an edit made while the creation is on its way waits for its version and then names the animal by its id", async () => {
    const db = await zoonosesTablet();
    const key = await saveAnimal(db, { householdKey: HH, draft: draft({ name: "Rex" }), newUuid });
    const [creation] = await outboxRepo.all(db);
    await outboxRepo.update(db, creation.seq, { state: "sending" });
    await saveAnimal(db, { householdKey: HH, animalKey: key, draft: draft({ name: "Rei" }), newUuid });
    const edit = (await outboxRepo.all(db))[1];
    expect(edit.depends_on).toEqual([{ client_uuid: key, kind: "version" }]);
    expect(edit.body).not.toHaveProperty("animal_id");

    await applyResults(db, [{ ...creation, state: "sending" }], [accepted(creation, { id: NEW_ANIMAL, version: 1 })], noStale);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { id: NEW_ANIMAL, version: 2 })));
    await sendQueue({ db, client, ...noStale });
    expect(batches[0][0].body).toMatchObject({ animal_id: NEW_ANIMAL, version: 1, name: "Rei" });
  });

  test("a duplicate without version marks the animal for reload (Q5)", async () => {
    const db = await zoonosesTablet();
    await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: draft({ name: "Rei" }), newUuid });
    const { client } = fakeClient((items) => items.map((i) => ({ ...accepted(i, { id: ANIMAL }), status: "duplicate" as const })));
    await sendQueue({ db, client, ...noStale });
    expect(await db.get("SELECT needs_reload FROM animals WHERE key = ?", [ANIMAL])).toEqual({ needs_reload: 1 });
  });
});

describe("rabies vaccination and collar", () => {
  const NEW_ANIMAL = "c0ffee73-0000-4000-8000-000000000073";
  const VAR = "e1f2a3b4-c5d6-4e7f-8a9b-1c2d3e4f5a6b";
  const CDT4 = "f2a3b4c5-d6e7-4f8a-9b0c-2d3e4f5a6b7c";
  const TODAY = "2026-11-24";
  const draft = (over: Partial<AnimalDraft> = {}): AnimalDraft => ({ ...emptyAnimalDraft(), species: "dog", sex: "female", ...over });
  const care = async (db: Db, animalKey: string) => {
    await vaccinate(db, { animalKey, productId: VAR, adverseEvent: false, adverseNote: null, today: TODAY, newUuid });
    await placeCollar(db, { animalKey, productId: CDT4, today: TODAY, newUuid });
  };
  const animalRow = async (db: Db, key: string) => {
    const r = await db.get<{ id: string | null; version: number | null; base_version: number | null; body: string }>(
      "SELECT id, version, base_version, body FROM animals WHERE key = ?", [key]);
    return r ? { ...r, body: JSON.parse(r.body) as Record<string, unknown> } : null;
  };

  test("accepted vaccination and collar update the row until the download brings the animal", async () => {
    const db = await zoonosesTablet();
    await care(db, ANIMAL);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { id: newUuid() })));
    await sendQueue({ db, client, ...noStale });
    expect(batches.map(byType)).toEqual([["rabies_vaccination", "collar"]]);
    expect(await outboxRepo.count(db)).toBe(0);
    // The dates change, the version does not (Q29 of 35a): no edit is based on anything new.
    expect(await animalRow(db, ANIMAL)).toMatchObject({
      version: 2, base_version: 2, body: { version: 2, last_rabies_vaccination_on: TODAY, collar_due_on: "2027-05-24" },
    });
    // The download overwrites the row with what the server has (Q20).
    await applyPage(db, example<ChangesResponse>("changes-zoonoses-page.json"));
    expect((await animalRow(db, ANIMAL))!.body).toMatchObject({ last_rabies_vaccination_on: "2026-11-21", collar_due_on: "2026-12-01" });

    // An animal born here: its creation, the vaccine and the collar go in one batch (cite), and its row gets the dates.
    const key = await saveAnimal(db, { householdKey: HH, draft: draft({ name: "Rex" }), newUuid });
    await care(db, key);
    const born = fakeClient((items) => items.map((i) => (i.type === "animal" ? accepted(i, { id: NEW_ANIMAL, version: 1 }) : accepted(i, { id: newUuid() }))));
    await sendQueue({ db, client: born.client, ...noStale });
    expect(born.batches.map(byType)).toEqual([["animal", "rabies_vaccination", "collar"]]);
    expect(born.batches[0][1].body).toMatchObject({ animal_client_uuid: key });
    expect(await animalRow(db, key)).toMatchObject({
      id: NEW_ANIMAL, version: 1, body: { last_rabies_vaccination_on: TODAY, collar_due_on: "2027-05-24" },
    });
  });

  test("an item whose animal row is gone still travels and is accepted", async () => {
    const db = await zoonosesTablet();
    await care(db, ANIMAL);
    await db.run("DELETE FROM animals WHERE key = ?", [ANIMAL]);
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { id: newUuid() })));
    await sendQueue({ db, client, ...noStale });
    expect(batches[0].map((i) => (i.body as Record<string, unknown>).animal_id)).toEqual([ANIMAL, ANIMAL]);
    expect(await outboxRepo.count(db)).toBe(0);
    expect(await animalRow(db, ANIMAL)).toBeNull();
  });

  test("a refused animal blocks its vaccination and collar (selectBatch + refreshBlocked of the 24c)", async () => {
    const db = await zoonosesTablet();
    const key = await saveAnimal(db, { householdKey: HH, draft: draft({ name: "Rex" }), newUuid });
    await care(db, key);
    const { client, batches } = fakeClient((items) => items.map((i) => (i.type === "animal"
      ? rejected(i, "tutor_not_found", { path: "tutor_client_uuid" }) : rejected(i, "not_found", { path: "animal_client_uuid" }))));
    await sendQueue({ db, client, ...noStale });
    expect(await states(db)).toEqual([["animal", "needs_attention"], ["rabies_vaccination", "blocked"], ["collar", "blocked"]]);
    // Held until the animal is fixed: the next round sends nothing.
    await sendQueue({ db, client, ...noStale });
    expect(batches).toHaveLength(1);
    // A creation still waiting holds them from the start, too.
    await outboxRepo.update(db, (await outboxRepo.byClientUuid(db, key))!.seq, { state: "needs_attention" });
    await refreshBlocked(db);
    expect(await states(db)).toEqual([["animal", "needs_attention"], ["rabies_vaccination", "blocked"], ["collar", "blocked"]]);
    // Discarding the animal takes both (doomedBy): the person is told 2 more go.
    expect(await discardImpact(db, key)).toBe(2);
  });

  const COLLAR_ONLY = new Set(["placed_on"]);
  test.each([["campaign_not_open", "campaign_id"], ["already_vaccinated_in_campaign", "campaign_id"], ["animal_not_active", "animal_id"],
    ["animal_not_dog", "animal_id"], ["date_out_of_range", "vaccinated_on"], ["date_out_of_range", "placed_on"]])(
    "server refusal %s at %s goes to attention with its phrase and the field in words", async (code, path) => {
      const db = await zoonosesTablet();
      await care(db, ANIMAL);
      const type = COLLAR_ONLY.has(path) || code === "animal_not_dog" ? "collar" : "rabies_vaccination";
      const { client } = fakeClient((items) => items.map((i) => (i.type === type ? rejected(i, code, { path }) : accepted(i, { id: newUuid() }))));
      await sendQueue({ db, client, ...noStale });
      const [refused] = await outboxRepo.all(db);
      expect(refused).toMatchObject({ type, state: "needs_attention", error: code, path });
      expect(phraseForItem(refused.error, refused)).toBe(ZOONOSES_ERRORS[code as ZoonosesErrorCode]);
      const words = { campaign_id: "Campanha", animal_id: "Animal", vaccinated_on: "Data da vacinação", placed_on: "Data da colocação" }[path];
      expect(pathLabel(refused.type, path)).toBe(words);
    });
});

describe("leishmaniasis collection (Q21)", () => {
  const SURVEY = "f1a2b3c4-d5e6-4f7a-8b8c-0d1e2f3a4b5c";
  const LABEL = "LV-2026-AB12CD-0001";
  const TODAY = "2026-11-24";
  const collect = (db: Db, surveyId: string | null = SURVEY) => collectLeish(db, { animalKey: ANIMAL, surveyId, dppResult: null, today: TODAY, newUuid });
  const line = (db: Db, uuid: string) =>
    db.get<{ label: string | null; state: string; accepted_at: string | null }>("SELECT label, state, accepted_at FROM local_leish_collections WHERE client_uuid = ?", [uuid]);

  test("accepted carries the api's label to the local line; nothing before", async () => {
    const db = await zoonosesTablet({ cbo: "515140" });
    const uuid = await collect(db);
    expect(await line(db, uuid)).toEqual({ label: null, state: "pending", accepted_at: null });
    const { client, batches } = fakeClient((items) => items.map((i) => accepted(i, { id: newUuid(), label: LABEL })));
    await sendQueue({ db, client, ...noStale });
    expect(byType(batches[0])).toEqual(["leish_collection"]);
    expect(batches[0][0].body).not.toHaveProperty("label");
    expect(await outboxRepo.count(db)).toBe(0);
    expect(await line(db, uuid)).toMatchObject({ label: LABEL, state: "accepted" });
    expect((await line(db, uuid))!.accepted_at).not.toBeNull();
  });

  test("duplicate on resend keeps the same label", async () => {
    const db = await zoonosesTablet({ cbo: "515140" });
    const uuid = await collect(db);
    // The first answer is lost (the request fails after the server wrote it); the resend answers duplicate, same label.
    const { client, batches } = fakeClient((items, call) => {
      if (call === 1) throw new FieldHttpError({ kind: "network" });
      return items.map((i) => ({ ...accepted(i, { id: newUuid(), label: LABEL }), status: "duplicate" as const }));
    });
    await sendQueue({ db, client, ...noStale });
    expect(await line(db, uuid)).toMatchObject({ label: null, state: "pending" });
    await sendQueue({ db, client, ...noStale });
    expect(batches).toHaveLength(2);
    expect(await line(db, uuid)).toMatchObject({ label: LABEL, state: "accepted" });
  });

  test("an answer without the label leaves the collection in the line: the resend brings it", async () => {
    const db = await zoonosesTablet({ cbo: "515140" });
    const uuid = await collect(db);
    // Outside the contract (the label is required there), so not through fakeClient, which checks every answer.
    let call = 0;
    const client = { uploads: jest.fn(async (items: UploadItem[]) => {
      call += 1;
      return { results: items.map((i) => accepted(i, { id: newUuid(), ...(call === 1 ? {} : { label: "LV-2026-AVUL-0007" }) })) } as UploadResponse;
    }) };
    await sendQueue({ db, client, ...noStale });
    expect(await states(db)).toEqual([["leish_collection", "pending"]]);
    expect(await line(db, uuid)).toMatchObject({ label: null, state: "pending" });
    await sendQueue({ db, client, ...noStale });
    expect(await line(db, uuid)).toMatchObject({ label: "LV-2026-AVUL-0007", state: "accepted" });
  });

  test.each([["survey_not_open", "leish_survey_id"], ["household_not_in_survey", "leish_survey_id"], ["date_out_of_range", "collected_on"]])(
    "server refusal %s at %s shows its phrase; Descartar removes item and line", async (code, path) => {
      const db = await zoonosesTablet({ cbo: "515140" });
      const uuid = await collect(db);
      // The survey closed or left the agent's scope (out_of_scope, Q21) with the collection in the line: the item stays and goes.
      await applyPage(db, { ...example<ChangesResponse>("changes-zoonoses-page.json"), items: [], removals: [{ type: "leish_survey", id: SURVEY, reason: "out_of_scope" }] } as ChangesResponse);
      expect(await db.get("SELECT id FROM leish_surveys WHERE id = ?", [SURVEY])).toBeNull();
      const { client, batches } = fakeClient((items) => items.map((i) => rejected(i, code, { path })));
      await sendQueue({ db, client, ...noStale });
      expect(batches[0][0].body).toMatchObject({ leish_survey_id: SURVEY });
      const [refused] = await outboxRepo.all(db);
      expect(refused).toMatchObject({ client_uuid: uuid, type: "leish_collection", state: "needs_attention", error: code, path });
      expect(phraseForItem(refused.error, refused)).toBe(ZOONOSES_ERRORS[code as ZoonosesErrorCode]);
      expect(pathLabel(refused.type, path)).toBe({ leish_survey_id: "Inquérito", collected_on: "Data da coleta" }[path]);
      expect(await line(db, uuid)).toMatchObject({ label: null, state: "pending" });
      await removeUnsent(db, uuid);
      expect(await outboxRepo.count(db)).toBe(0);
      expect(await line(db, uuid)).toBeNull();
    });
});
