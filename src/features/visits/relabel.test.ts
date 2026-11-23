import type { VectorInspectionBody } from "../../contract";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { sampleLabel } from "../../rules/vectorInspection";
import { applyResults } from "../../sync/dispatch";
import { enqueue } from "../../sync/outbox";
import { newUuid, rejected } from "../../sync/testing";
import { AREA, HH, loadedTablet } from "../testing";
import { relabelVisit } from "./relabel";
import { saveVisit } from "./save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const OLD = "3f2a9c1e-0000-4000-8000-0000000000a1";
const NEW = "abcdef12-0000-4000-8000-0000000000b2";
const noStale = { onStale: async () => undefined };
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
const draft: VisitDraft = {
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: HH, propertyType: "1", microAreaId: AREA },
  subject: "none", person: null, outcome: 1, reasons: [],
};
const bulletin = {
  activity: "li", work_type: "routine", situation: "worked", educational_action: true,
  deposits: [{ group: "A1", existing: 2, with_water: 2, with_larvae: 2, eliminated: 0, treated: 0 }],
  samples: [{ number: 1, deposit_group: "A1", larvae_collected: 3 }, { number: 2, deposit_group: "A1", larvae_collected: 1 }],
} as unknown as VectorInspectionBody;

const visitRow = (db: Db, uuid: string) => db.get<{ client_uuid: string; summary: string; state: string }>("SELECT client_uuid, summary, state FROM local_visits WHERE client_uuid = ?", [uuid]);

// A visit with a bulletin of two samples refused with `code` (sample_label_taken by default), and an ovitrap installation
// that waits for it (it cites the visit, as installOvitrap does when the bulletin set the block).
async function refusedVisit(code = "sample_label_taken") {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft, { clientUuid: OLD, teamId: TEAM, location: null, visitBody: rules.visitBody, newUuid, now: () => NOW, vectorInspection: bulletin });
  const install = await enqueue(db, { type: "ovitrap_installation", body: { household_id: HH, number: "12", consent: true, installed_on: "2026-11-14" }, deps: [{ client_uuid: uuid, kind: "cite" }] }, newUuid);
  const visit = (await outboxRepo.byClientUuid(db, uuid))!;
  await applyResults(db, [visit], [rejected(visit, code, { path: "vector_inspection.samples[0]" })], noStale);
  return { db, visit, install };
}

test("relabel changes the item uuid, the sheet key and the labels together", async () => {
  const { db, visit, install } = await refusedVisit();
  // A withdrawal in the line naming the visit (none can exist for a visit still in the line today: kept consistent anyway).
  const withdrawal = await enqueue(db, { type: "home_visit_withdrawal", body: { visit_client_uuid: OLD, reason: "Visita registrada por engano." } }, newUuid);
  expect((await outboxRepo.bySeq(db, install.seq))!.state).toBe("blocked");
  const before = await visitRow(db, OLD);

  const result = await relabelVisit(db, visit.seq, () => NEW.toUpperCase());

  expect(result).toEqual({ clientUuid: NEW, labels: ["ABCDEF12-01", "ABCDEF12-02"] });
  const item = (await outboxRepo.bySeq(db, visit.seq))!;
  expect([item.client_uuid, item.state, item.error, item.path, item.attempts]).toEqual([NEW, "pending", null, null, 0]);
  expect(item.body).toEqual(visit.body); // the bulletin itself does not change: the labels come from the uuid
  expect(await outboxRepo.byClientUuid(db, OLD)).toBeNull();
  // The sheet line moves to the new key, with the same summary.
  expect(await visitRow(db, OLD)).toBeNull();
  expect(await visitRow(db, NEW)).toEqual({ ...before, client_uuid: NEW });
  // What cited the old uuid cites the new one, and goes back to the line.
  const waiting = (await outboxRepo.bySeq(db, install.seq))!;
  expect([waiting.depends_on, waiting.state]).toEqual([[{ client_uuid: NEW, kind: "cite" }], "pending"]);
  expect((await outboxRepo.bySeq(db, withdrawal.seq))!.body.visit_client_uuid).toBe(NEW);
});

test("relabel refuses another code, another item type, or an item not in needs_attention", async () => {
  const other = await refusedVisit("cbo_not_allowed");
  await expect(relabelVisit(other.db, other.visit.seq, () => NEW)).rejects.toThrow();
  expect((await outboxRepo.bySeq(other.db, other.visit.seq))!.client_uuid).toBe(OLD);

  // The same code on an item that is not a visit.
  const { db, install } = await refusedVisit();
  await outboxRepo.update(db, install.seq, { state: "needs_attention", error: "sample_label_taken", path: "vector_inspection.samples[0]" });
  await expect(relabelVisit(db, install.seq, () => NEW)).rejects.toThrow();

  // A visit in the line that is not waiting for the person.
  const fresh = await loadedTablet();
  const pending = await saveVisit(fresh, draft, { clientUuid: OLD, teamId: TEAM, location: null, visitBody: rules.visitBody, newUuid, now: () => NOW, vectorInspection: bulletin });
  const item = (await outboxRepo.byClientUuid(fresh, pending))!;
  await expect(relabelVisit(fresh, item.seq, () => NEW)).rejects.toThrow();

  // No item at all (accepted and gone from the line), and an item whose uuid the server already gave an id to.
  await expect(relabelVisit(fresh, 9999, () => NEW)).rejects.toThrow();
  const accepted = await refusedVisit();
  await outboxRepo.mapClientId(accepted.db, OLD, "home_visit", "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f");
  await expect(relabelVisit(accepted.db, accepted.visit.seq, () => NEW)).rejects.toThrow();
  expect(await visitRow(accepted.db, OLD)).not.toBeNull();
  expect((await outboxRepo.bySeq(accepted.db, accepted.visit.seq))!.state).toBe("needs_attention");
});

test("labels after relabel match sampleLabel of the new uuid", async () => {
  const { db, visit } = await refusedVisit();
  // A draw with the same eight first characters would clash again: it is drawn once more.
  const draws = ["3F2A9C1E-1111-4000-8000-0000000000c3", NEW];
  const result = await relabelVisit(db, visit.seq, () => draws.shift()!);
  expect(result.clientUuid).toBe(NEW);
  expect(result.labels).toEqual([sampleLabel(NEW, 1), sampleLabel(NEW, 2)]);
  expect(result.labels.every((label) => !label.startsWith(sampleLabel(OLD, 1).slice(0, 8)))).toBe(true);
});

test("a uuid that is not one, or one already in the tablet, is refused and nothing changes", async () => {
  const { db, visit, install } = await refusedVisit();
  await expect(relabelVisit(db, visit.seq, () => "not-a-uuid")).rejects.toThrow();
  await expect(relabelVisit(db, visit.seq, () => install.client_uuid)).rejects.toThrow();
  expect((await outboxRepo.bySeq(db, visit.seq))!.client_uuid).toBe(OLD);
  expect(await visitRow(db, OLD)).not.toBeNull();
});

test("a sheet line no longer pending is never rekeyed", async () => {
  const { db, visit } = await refusedVisit();
  await db.run("UPDATE local_visits SET state = 'accepted' WHERE client_uuid = ?", [OLD]);
  await expect(relabelVisit(db, visit.seq, () => NEW)).rejects.toThrow();
  expect(await visitRow(db, NEW)).toBeNull();
  expect((await outboxRepo.bySeq(db, visit.seq))!).toMatchObject({ client_uuid: OLD, state: "needs_attention" });
});

test("a new uuid already on the sheet or already given an id by the server is refused", async () => {
  const onSheet = await refusedVisit();
  await onSheet.db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, '2026-11-14', '2026-11-14T09:00:00-03:00', '{}', 'accepted')", [NEW]);
  await expect(relabelVisit(onSheet.db, onSheet.visit.seq, () => NEW)).rejects.toThrow();
  expect((await outboxRepo.bySeq(onSheet.db, onSheet.visit.seq))!.client_uuid).toBe(OLD);
  expect(await visitRow(onSheet.db, OLD)).not.toBeNull();

  const mapped = await refusedVisit();
  await outboxRepo.mapClientId(mapped.db, NEW, "home_visit", "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f");
  await expect(relabelVisit(mapped.db, mapped.visit.seq, () => NEW)).rejects.toThrow();
  expect((await outboxRepo.bySeq(mapped.db, mapped.visit.seq))!.client_uuid).toBe(OLD);
});

test("three draws with the old eight first characters: refused, nothing changes", async () => {
  const { db, visit } = await refusedVisit();
  const draw = jest.fn(() => "3f2a9c1e-2222-4000-8000-0000000000d4");
  await expect(relabelVisit(db, visit.seq, draw)).rejects.toThrow();
  expect(draw).toHaveBeenCalledTimes(3);
  expect((await outboxRepo.bySeq(db, visit.seq))!).toMatchObject({ client_uuid: OLD, state: "needs_attention", error: "sample_label_taken" });
});

// Q56: after the relabel the old labels (the old uuid's eight first characters) are nowhere in the tablet's database —
// not in the line (client_uuid, bodies, dependencies), not on the sheet, not in any other table.
test("after relabel the old uuid and its labels are gone from every table", async () => {
  const { db, visit } = await refusedVisit();
  await enqueue(db, { type: "home_visit_withdrawal", body: { visit_client_uuid: OLD, reason: "Visita registrada por engano." } }, newUuid);
  const prefix = OLD.slice(0, 8);
  const everything = async () => {
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    const dump: string[] = [];
    for (const { name } of tables) dump.push(JSON.stringify(await db.all(`SELECT * FROM "${name}"`)).toLowerCase());
    return dump.join("\n");
  };
  expect(await everything()).toContain(prefix);
  const { labels } = await relabelVisit(db, visit.seq, () => NEW);
  expect(await everything()).not.toContain(prefix);
  expect(labels.some((label) => label.toLowerCase().startsWith(prefix))).toBe(false);
});
