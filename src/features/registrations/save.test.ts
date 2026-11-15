import type { RegistrationBody } from "../../contract";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { applyResults } from "../../sync/dispatch";
import { accepted, newUuid } from "../../sync/testing";
import { saveHousehold } from "../households/save";
import { AREA, HH, loadedTablet, stationChanged } from "../testing";
import { REGISTRATION_CONFLICT_PENDING, saveRegistration, type RegistrationFields } from "./save";
import { readRegistration } from "./view";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const deps = { newUuid, now: () => NOW };
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
const REG = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";
const BENEDITA = { full_name: "Benedita Aparecida Rocha", social_name: "Dita", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2", cns: "702000000000001" };
const fields = (over: Partial<RegistrationFields> = {}): RegistrationFields => ({
  is_responsible: false, refused: false, patient_demographics: { race_color: "01", ethnicity: null },
  identification: {}, sociodemographic: {}, health_conditions: {}, ...over,
});
const wire = (items: { client_uuid: string; type: string; body: Record<string, unknown> }[]) => ({ items: items.map(({ client_uuid, type, body }) => ({ client_uuid, type, body })) });
const row = (db: Db, key: string) => db.get<{ id: string | null; client_uuid: string | null; household_key: string | null; family_id: string | null; version: number | null; base_version: number | null; name_norm: string; birth_date: string | null; mother_norm: string | null }>(
  "SELECT id, client_uuid, household_key, family_id, version, base_version, name_norm, birth_date, mother_norm FROM registrations WHERE key = ?", [key]);

test("a new person is ONE individual_registration item with new_patient and the social name (Q26)", async () => {
  const db = await loadedTablet();
  const saved = await saveRegistration(db, { householdKey: HH, familyId: FAMILY, person: { kind: "new", patient: BENEDITA }, fields: fields() }, deps);
  const items = await outboxRepo.all(db);
  expect(items.map((item) => item.type)).toEqual(["individual_registration"]);
  const [item] = items;
  expect(item.body).toEqual({ new_patient: BENEDITA, household_id: HH, family_id: FAMILY, ...fields() });
  expect([item.client_uuid, item.target_id, item.depends_on, item.edit_base_version]).toEqual([saved.clientUuid, saved.key, [], null]);
  expectValid("upload-request", wire(items));

  // The person is on the tablet at once, findable by the local duplicate check.
  expect(await row(db, saved.key)).toEqual({
    id: null, client_uuid: saved.clientUuid, household_key: HH, family_id: FAMILY, version: null, base_version: null,
    name_norm: "benedita aparecida rocha", birth_date: "1948-05-02", mother_norm: "maria jose rocha",
  });
  const view = (await readRegistration(db, saved.key))!;
  expect([view.bornHere, view.pending, view.body.patient.display_name, view.body.patient.full_name, view.body.patient.id]).toEqual([true, true, "Dita", "Benedita Aparecida Rocha", saved.clientUuid]);
});

test("the agent saw the look-alikes and said it is another person: duplicates_reviewed goes true; otherwise the key is not sent", async () => {
  const db = await loadedTablet();
  await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA, duplicatesReviewed: true }, fields: fields() }, deps);
  const [item] = await outboxRepo.all(db);
  expect(item.body.duplicates_reviewed).toBe(true);
  expect("family_id" in item.body).toBe(false);
  expectValid("upload-request", wire([item]));
});

test("in a household born on the tablet the item cites it by client_uuid and waits for it", async () => {
  const db = await loadedTablet();
  const household = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  await saveRegistration(db, { householdKey: household.key, familyId: null, person: { kind: "new", patient: BENEDITA }, fields: fields() }, deps);
  const items = await outboxRepo.all(db);
  expect(items[1].body).toMatchObject({ household_client_uuid: household.clientUuid });
  expect("household_id" in items[1].body).toBe(false);
  expect(items[1].depends_on).toEqual([{ client_uuid: household.clientUuid, kind: "cite" }]);
  expectValid("upload-request", wire(items));
});

test("a registration for a person the server already knows carries patient_id, not new_patient", async () => {
  const db = await loadedTablet();
  await saveRegistration(db, { householdKey: HH, familyId: FAMILY, person: { kind: "patient", patientId: "1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c", displayName: "Davi Souza" }, fields: fields() }, deps);
  const [item] = await outboxRepo.all(db);
  expect(item.body).toEqual({ patient_id: "1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c", household_id: HH, family_id: FAMILY, ...fields() });
  expectValid("upload-request", wire([item]));
});

test("edit of a downloaded registration: registration_id, the row as target, the row's base, and only what the app edits", async () => {
  const db = await loadedTablet();
  const before = (await row(db, REG))!;
  const saved = await saveRegistration(db, { key: REG, fields: fields({ is_responsible: true, sociodemographic: { status_frequenta_escola: false } }) }, deps);
  const [item] = await outboxRepo.all(db);
  expect([saved.key, item.target_id, item.edit_base_version, item.client_uuid]).toEqual([REG, REG, before.base_version, saved.clientUuid]);
  expect(item.body).toEqual({ registration_id: REG, ...fields({ is_responsible: true, sociodemographic: { status_frequenta_escola: false } }) });
  expect(item.edit_base_body).not.toBeNull();
  const view = (await readRegistration(db, REG))!;
  expect([view.pending, view.bornHere, (view.body.sociodemographic as Record<string, unknown>).status_frequenta_escola]).toEqual([true, false, false]);

  // A second edit while the first waits is the same item.
  const again = await saveRegistration(db, { key: REG, fields: fields({ is_responsible: true, refused: true }) }, deps);
  const items = await outboxRepo.all(db);
  expect([items.length, again.clientUuid, items[0].body.refused]).toEqual([1, saved.clientUuid, true]);
});

test("editing a person born on the tablet before it was sent keeps it one creation, with the person typed", async () => {
  const db = await loadedTablet();
  const born = await saveRegistration(db, { householdKey: HH, familyId: FAMILY, person: { kind: "new", patient: BENEDITA }, fields: fields() }, deps);
  const edit = await saveRegistration(db, { key: born.key, fields: fields({ refused: true }) }, deps);
  let items = await outboxRepo.all(db);
  expect([items.length, edit.clientUuid]).toEqual([1, born.clientUuid]);
  expect(items[0].body).toEqual({ new_patient: BENEDITA, household_id: HH, family_id: FAMILY, ...fields({ refused: true }) });
  expectValid("upload-request", wire(items));

  // Already on its way: the edit is another item, which waits for the creation's answer and creates nobody.
  await outboxRepo.update(db, items[0].seq, { state: "sending" });
  await saveRegistration(db, { key: born.key, fields: fields({ refused: false }) }, deps);
  items = await outboxRepo.all(db);
  expect(items).toHaveLength(2);
  expect(items[1].depends_on).toEqual([{ client_uuid: born.clientUuid, kind: "version" }]);
  expect(items[1].body).toEqual(fields({ refused: false }));

  // The same when the creation is held (what it cites was refused): an edit never becomes a second creation.
  await outboxRepo.remove(db, items[1].seq);
  await outboxRepo.update(db, items[0].seq, { state: "blocked" });
  await saveRegistration(db, { key: born.key, fields: fields({ refused: true }) }, deps);
  items = await outboxRepo.all(db);
  expect("new_patient" in items[1].body).toBe(false);
  expect(items[1].depends_on).toEqual([{ client_uuid: born.clientUuid, kind: "version" }]);
});

test("the edit base is what the form loaded, not what a download wrote on the row meanwhile (Q41)", async () => {
  const db = await loadedTablet();
  const opened = (await readRegistration(db, REG))!;
  expect(opened.base?.version).toBe((await row(db, REG))!.base_version);
  await stationChanged(db, "registration", REG, { refused: true });
  expect((await row(db, REG))!.base_version).toBe(opened.base!.version + 1);
  await saveRegistration(db, { key: REG, fields: fields({ is_responsible: true }), editBase: opened.base }, deps);
  const [item] = await outboxRepo.all(db);
  expect([item.edit_base_version, item.edit_base_body]).toEqual([opened.base!.version, opened.base!.body]);
});

test("a registration with an edit in conflict is not edited again until the conflict is solved", async () => {
  const db = await loadedTablet();
  await saveRegistration(db, { key: REG, fields: fields({ is_responsible: true }) }, deps);
  const [item] = await outboxRepo.all(db);
  await outboxRepo.update(db, item.seq, { state: "conflict", conflicts: [{ field: "refused", base: false, tablet: true, station: false }] as never });
  await expect(saveRegistration(db, { key: REG, fields: fields() }, deps)).rejects.toThrow(REGISTRATION_CONFLICT_PENDING);
  expect(REGISTRATION_CONFLICT_PENDING).toBe("Resolva o conflito deste cadastro antes de editar");
});

test("accepted: the row takes the server's id and version and shows what was accepted", async () => {
  const db = await loadedTablet();
  const saved = await saveRegistration(db, { householdKey: HH, familyId: FAMILY, person: { kind: "new", patient: BENEDITA }, fields: fields({ refused: true }) }, deps);
  const [item] = await outboxRepo.all(db);
  const NEW_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
  await applyResults(db, [item], [accepted(item, { id: NEW_ID, version: 1 })], { onStale: async () => undefined });
  const after = (await row(db, saved.key))!;
  expect([after.id, after.version, after.base_version]).toEqual([NEW_ID, 1, 1]);
  const view = (await readRegistration(db, saved.key))!;
  expect([view.id, view.pending, view.body.id, view.body.version, view.body.refused]).toEqual([NEW_ID, false, NEW_ID, 1, true]);
  expect((view.body as RegistrationBody).patient.full_name).toBe("Benedita Aparecida Rocha");
});
