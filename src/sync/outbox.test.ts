import { outboxRepo } from "../db/repos/outboxRepo";
import { createTestDb } from "../db/testing/sqljsDb";
import { coalesceOrEnqueue, enqueue, pendingCount, recoverSending, removeUnsent, resend, targetTable } from "./outbox";
import { exampleItems, newUuid } from "./testing";

const VISIT = exampleItems("upload-home-visit-resident.json")[0];
const EDIT = exampleItems("upload-household-update.json")[0];
const BASE = { version: 3, body: { contact_phone: "4100" } };

test("targetTable: household and family live in households, the registration in registrations, the rest nowhere", () => {
  expect(targetTable("household")).toBe("households");
  expect(targetTable("family")).toBe("households");
  expect(targetTable("individual_registration")).toBe("registrations");
  for (const type of ["home_visit", "home_visit_withdrawal", "collective_activity", "patient"] as const) expect(targetTable(type)).toBeNull();
});

test("enqueue stores the item as written, pending, with a lowercase client_uuid", async () => {
  const db = await createTestDb();
  const item = await enqueue(db, { type: "household", body: EDIT.body, targetId: "hh1", editBase: BASE, deps: [{ client_uuid: VISIT.client_uuid, kind: "cite" }] }, newUuid);
  expect(item.client_uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(item).toMatchObject({
    seq: 1, type: "household", body: EDIT.body, target_id: "hh1", edit_base_version: 3, edit_base_body: BASE.body, state: "pending",
    depends_on: [{ client_uuid: VISIT.client_uuid, kind: "cite" }], error: null, path: null, candidates: null, confirmable: null, conflicts: null,
    sent_version: null, attempts: 0,
  });
  const given = await enqueue(db, { type: "home_visit", body: VISIT.body, clientUuid: "C0FFEE01-0000-4000-8000-000000000001" }, newUuid);
  expect(given.client_uuid).toBe("c0ffee01-0000-4000-8000-000000000001");
  expect(given.target_id).toBeNull();
  expect(await pendingCount(db)).toBe(2);
  await expect(enqueue(db, { type: "home_visit", body: VISIT.body, clientUuid: "not-a-uuid" }, newUuid)).rejects.toThrow();
  await expect(enqueue(db, { type: "home_visit", body: VISIT.body, clientUuid: given.client_uuid }, newUuid)).rejects.toThrow(); // unique
});

test("coalesce: a second edit of a pending creation replaces its body, same client_uuid", async () => {
  const db = await createTestDb();
  const first = await coalesceOrEnqueue(db, { type: "household", body: { ...EDIT.body, contact_phone: "1" }, targetId: "hh1", editBase: BASE }, newUuid);
  const second = await coalesceOrEnqueue(db, { type: "household", body: { ...EDIT.body, contact_phone: "2" }, targetId: "hh1", editBase: { version: 4, body: {} } }, newUuid);
  expect(second.seq).toBe(first.seq);
  expect(second.client_uuid).toBe(first.client_uuid);
  expect(second.body.contact_phone).toBe("2");
  // The base stays the one the person first saw.
  expect([second.edit_base_version, second.edit_base_body]).toEqual([3, BASE.body]);
  expect(await pendingCount(db)).toBe(1);
});

test("coalesce: an item that needs attention is fixed in place; another type, another target or one in flight is a new item", async () => {
  const db = await createTestDb();
  const first = await coalesceOrEnqueue(db, { type: "household", body: EDIT.body, targetId: "hh1", editBase: BASE }, newUuid);
  await outboxRepo.update(db, first.seq, { state: "needs_attention", error: "invalid_household", path: "address.zip" });
  const fixed = await coalesceOrEnqueue(db, { type: "household", body: { ...EDIT.body, contact_phone: "9" }, targetId: "hh1", editBase: BASE }, newUuid);
  expect(fixed).toMatchObject({ seq: first.seq, state: "pending", error: null, path: null });

  expect((await coalesceOrEnqueue(db, { type: "family", body: {}, targetId: "hh1" }, newUuid)).seq).not.toBe(first.seq);
  expect((await coalesceOrEnqueue(db, { type: "household", body: EDIT.body, targetId: "hh2", editBase: BASE }, newUuid)).seq).not.toBe(first.seq);
  await outboxRepo.update(db, first.seq, { state: "sending" });
  expect((await coalesceOrEnqueue(db, { type: "household", body: EDIT.body, targetId: "hh1", editBase: BASE }, newUuid)).seq).not.toBe(first.seq);
  // Without a target there is nothing to coalesce with.
  const a = await coalesceOrEnqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
  const b = await coalesceOrEnqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
  expect(b.seq).not.toBe(a.seq);
});

test("recoverSending turns sending into pending after a crash", async () => {
  const db = await createTestDb();
  const a = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
  const b = await enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);
  await outboxRepo.update(db, a.seq, { state: "sending" });
  await outboxRepo.update(db, b.seq, { state: "needs_attention", error: "invalid_home_visit" });
  expect(await recoverSending(db)).toBe(1);
  expect((await outboxRepo.all(db)).map((i) => [i.client_uuid, i.state])).toEqual([[a.client_uuid, "pending"], [b.client_uuid, "needs_attention"]]);
  expect(await recoverSending(db)).toBe(0);
});

test("removeUnsent discards the item and everything that cites it, never what is in flight or in conflict", async () => {
  const db = await createTestDb();
  const patient = await enqueue(db, { type: "patient", body: {} }, newUuid);
  const registration = await enqueue(db, { type: "individual_registration", body: {}, deps: [{ client_uuid: patient.client_uuid, kind: "cite" }] }, newUuid);
  const visit = await enqueue(db, { type: "home_visit", body: {}, deps: [{ client_uuid: registration.client_uuid, kind: "cite" }] }, newUuid);
  const household = await enqueue(db, { type: "household", body: {}, targetId: "h" }, newUuid);
  const family = await enqueue(db, { type: "family", body: {}, targetId: "h", deps: [{ client_uuid: household.client_uuid, kind: "version" }] }, newUuid);
  const other = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  await outboxRepo.update(db, patient.seq, { state: "needs_attention", error: "invalid_cpf" });

  await removeUnsent(db, patient.client_uuid);
  expect((await outboxRepo.all(db)).map((i) => i.client_uuid)).toEqual([household.client_uuid, family.client_uuid, other.client_uuid]);
  expect(visit.seq).toBe(3);

  await outboxRepo.update(db, other.seq, { state: "sending" });
  await removeUnsent(db, other.client_uuid);
  await outboxRepo.update(db, household.seq, { state: "conflict" });
  await removeUnsent(db, household.client_uuid);
  await removeUnsent(db, "00000000-0000-4000-8000-ffffffffffff");
  expect(await pendingCount(db)).toBe(3);
});

test("resend after fix keeps the same client_uuid and frees what waited for it", async () => {
  const db = await createTestDb();
  const patient = await enqueue(db, { type: "patient", body: { new_patient: { full_name: "x" } } }, newUuid);
  const visit = await enqueue(db, { type: "home_visit", body: {}, deps: [{ client_uuid: patient.client_uuid, kind: "cite" }] }, newUuid);
  await outboxRepo.update(db, patient.seq, { state: "needs_attention", error: "invalid_cpf", path: "new_patient.cpf", attempts: 2 });
  await outboxRepo.update(db, visit.seq, { state: "blocked" });

  await resend(db, patient.seq, { new_patient: { full_name: "y" } });
  const [fixed, freed] = await outboxRepo.all(db);
  expect(fixed).toMatchObject({ client_uuid: patient.client_uuid, state: "pending", error: null, path: null, attempts: 0, body: { new_patient: { full_name: "y" } } });
  expect(freed.state).toBe("pending");

  // Only what needs attention is resent: a pending item is left as it is.
  await resend(db, visit.seq, { changed: true });
  expect((await outboxRepo.bySeq(db, visit.seq))!.body).toEqual({});
});
