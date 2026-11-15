import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { emptyActivityDraft, type ActivityDraft, type ParticipantDraft } from "../../rules/collectiveActivity";
import { applyResults } from "../../sync/dispatch";
import { loadReference } from "../../sync/reference";
import { accepted, newUuid } from "../../sync/testing";
import { saveRegistration, type RegistrationFields } from "../registrations/save";
import { HH, loadedTablet } from "../testing";
import { saveActivity } from "./save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const PROFESSIONAL = "5d6e7f8a-9b0c-4d1e-9f2a-3b4c5d6e7f8a";
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2" };
const person: RegistrationFields = { is_responsible: false, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const participant = (o: Partial<ParticipantDraft> & { patientId: string }): ParticipantDraft =>
  ({ kind: "patient", displayName: "x", hasCpf: true, hasCns: false, altered: false, weight: "", height: "", smoking: null, ...o }) as ParticipantDraft;
const draft = (o: Partial<ActivityDraft> = {}): ActivityDraft => ({
  ...emptyActivityDraft("2026-11-14"), teamId: TEAM, heldOn: "2026-11-11", shift: 2, activityType: 5, place: { kind: "text", text: " Salão da Associação " },
  participantsCount: "12", targetAudience: [12], healthTopics: [4], healthPractices: [20], professionals: [PROFESSIONAL], ...o,
});
const wire = (items: { client_uuid: string; type: string; body: Record<string, unknown> }[]) => ({ items: items.map(({ client_uuid, type, body }) => ({ client_uuid, type, body })) });

async function setup() {
  const db = await loadedTablet();
  const domains = (await loadReference(db))!.collectiveDomains;
  return { db, ctx: { domains, newUuid, now: () => NOW } };
}

test("an activity with a downloaded resident: the item as the contract shows it, and a line among the tablet's activities", async () => {
  const { db, ctx } = await setup();
  const uuid = await saveActivity(db, draft({ participants: [participant({ patientId: JOANA, altered: true, weight: "81,5", height: "162" })] }), ctx);
  const [item] = await outboxRepo.all(db);
  expect([item.type, item.client_uuid, item.depends_on]).toEqual(["collective_activity", uuid, []]);
  expect(item.body).toEqual({
    team_id: TEAM, held_on: "2026-11-11", shift: 2, activity_type: 5, place_text: "Salão da Associação", participants_count: 12,
    meeting_topics: [], target_audience: [12], health_topics: [4], health_practices: [20],
    professionals: [{ professional_id: PROFESSIONAL }],
    participants: [{ patient_id: JOANA, altered_evaluation: true, measurements: { weight_kg: 81.5, height_cm: 162 } }],
  });
  expectValid("upload-request", wire([item]));
  expect(await db.all("SELECT client_uuid, held_on, summary, state FROM local_activities")).toEqual([
    { client_uuid: uuid, held_on: "2026-11-11", state: "pending", summary: JSON.stringify({ activity_type: 5, shift: 2, participants_count: 12 }) },
  ]);
});

test("a participant registered on this tablet is cited by the client_uuid of that registration, and the activity waits for it (Q26)", async () => {
  const { db, ctx } = await setup();
  const benedita = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, { newUuid, now: () => NOW });
  await saveActivity(db, draft({ participants: [participant({ patientId: JOANA }), participant({ patientId: benedita.clientUuid })] }), ctx);
  const items = await outboxRepo.all(db);
  const activity = items.find((i) => i.type === "collective_activity")!;
  expect(activity.body.participants).toEqual([{ patient_id: JOANA }, { patient_client_uuid: benedita.clientUuid }]);
  expect(activity.depends_on).toEqual([{ client_uuid: benedita.clientUuid, kind: "cite" }]);
  expectValid("upload-request", wire(items));
});

test("a participant registered here whose registration was accepted but not downloaded yet is still cited by client_uuid (review I1)", async () => {
  const { db, ctx } = await setup();
  const benedita = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: person }, { newUuid, now: () => NOW });
  const [registration] = await outboxRepo.all(db);
  await applyResults(db, [registration], [accepted(registration, { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", version: 1 })], { onStale: async () => undefined });
  await saveActivity(db, draft({ participants: [participant({ patientId: benedita.clientUuid })] }), ctx);
  const [activity] = await outboxRepo.all(db);
  expect(activity.body.participants).toEqual([{ patient_client_uuid: benedita.clientUuid }]);
  expect(activity.depends_on).toEqual([]);
});

test("a person typed in the activity travels inside the participant, with duplicates_reviewed only when the look-alikes were seen", async () => {
  const { db, ctx } = await setup();
  await saveActivity(db, draft({
    participants: [
      { kind: "new", patient: BENEDITA, duplicatesReviewed: false, altered: false, weight: "", height: "", smoking: null },
      { kind: "new", patient: { ...BENEDITA, full_name: "Sebastiana Aparecida Rocha" }, duplicatesReviewed: true, altered: true, weight: "", height: "", smoking: null },
    ],
  }), ctx);
  const [item] = await outboxRepo.all(db);
  expect(item.body.participants).toEqual([
    { new_patient: BENEDITA },
    { new_patient: { ...BENEDITA, full_name: "Sebastiana Aparecida Rocha" }, duplicates_reviewed: true, altered_evaluation: true },
  ]);
  expect(item.depends_on).toEqual([]);
  expectValid("upload-request", wire([item]));
});

test("in a health unit of the reference the item names the unit, never a text", async () => {
  const { db, ctx } = await setup();
  const unit = (await loadReference(db))!.healthUnits.find((u) => u.cnes !== null)!;
  await saveActivity(db, draft({ place: { kind: "unit", unitId: unit.id }, activityType: 4, healthPractices: [], participants: [] }), ctx);
  const [item] = await outboxRepo.all(db);
  expect(item.body.place_health_unit_id).toBe(unit.id);
  expect("place_text" in item.body).toBe(false);
  expectValid("upload-request", wire([item]));
});

test("accepted: the line of the activity says so", async () => {
  const { db, ctx } = await setup();
  const uuid = await saveActivity(db, draft({ participants: [participant({ patientId: JOANA })] }), ctx);
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [accepted(item)], { onStale: async () => undefined });
  expect(await db.get("SELECT state FROM local_activities WHERE client_uuid = ?", [uuid])).toEqual({ state: "accepted" });
});
