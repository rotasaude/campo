import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { UploadResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { emptyActivityDraft } from "../../rules/collectiveActivity";
import { applyResults } from "../../sync/dispatch";
import { enqueue } from "../../sync/outbox";
import { loadReference } from "../../sync/reference";
import { newUuid, rejected } from "../../sync/testing";
import { saveActivity } from "../activities/save";
import { pathLabel } from "../conflicts/fieldText";
import { saveHousehold } from "../households/save";
import { phraseFor } from "../messages/errorPhrases";
import { saveRegistration, type RegistrationFields } from "../registrations/save";
import { AREA, HH, loadedTablet } from "../testing";
import { AttentionScreen, EXISTING_NOT_HERE, NOT_WAITING_FOR_YOU, NO_FORM_FOR_THIS } from "./AttentionScreen";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const REG = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";
const deps = { newUuid, now: () => NOW };
const noStale = { onStale: async () => undefined };
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2" };
const fields: RegistrationFields = { is_responsible: false, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const answer = (file: string) => example<UploadResponse>(file).results[0];

async function mount(db: Db, seq: number) {
  const nav = { onFix: jest.fn(), onOpenRegistration: jest.fn(), onDone: jest.fn() };
  await renderWithServices(<AttentionScreen seq={seq} {...nav} />, fakeServices({ db, now: () => NOW }));
  return nav;
}
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));

test("the field a refusal points to is named in words", () => {
  expect(pathLabel("household", "address.zip")).toBe("CEP");
  expect(pathLabel("household", "location.latitude")).toBe("Ponto do imóvel");
  expect(pathLabel("household", "living_conditions.nu_moradores")).toBe("Número de moradores");
  expect(pathLabel("individual_registration", "new_patient.full_name")).toBe("Nome completo");
  expect(pathLabel("collective_activity", "participants[1].new_patient.cpf")).toBe("Participante 2: CPF");
  expect(pathLabel("collective_activity", "participants[0]")).toBe("Participante 1");
  expect(pathLabel("home_visit", "reasons[2]")).toBe("Motivos da visita");
  expect(pathLabel("home_visit", "measurements.weight_kg")).toBe("Medidas");
  expect(pathLabel("home_visit", "campo_novo")).toBe("campo_novo");
});

test("a refused household: the sentence of the refusal, the field it points to, and the ways out", async () => {
  const db = await loadedTablet();
  await saveHousehold(db, { key: HH, fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [rejected(item, "invalid_location", { path: "location.latitude" })], noStale);
  const nav = await mount(db, item.seq);
  expect(await screen.findByText("Domicílio")).toBeTruthy();
  expect(screen.getByText(phraseFor("invalid_location"))).toBeTruthy();
  expect(screen.getByText("Campo: Ponto do imóvel")).toBeTruthy();
  await press("Corrigir");
  expect(nav.onFix).toHaveBeenCalledWith({ type: "household", targetId: HH, familyId: null });
  await press("Reenviar");
  await waitFor(() => expect(nav.onDone).toHaveBeenCalled());
  expect((await outboxRepo.bySeq(db, item.seq))!.state).toBe("pending");
});

test("the server suspects a duplicate: its candidates are shown, and 'É esta pessoa' gives the typed person up for the patient", async () => {
  const db = await loadedTablet();
  const person = await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields }, deps);
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [{ ...answer("upload-response-duplicate-suspected.json"), client_uuid: item.client_uuid, type: "individual_registration" }], noStale);
  const nav = await mount(db, item.seq);
  const first = within(await screen.findByTestId("candidate-1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c"));
  expect(first.getByText("Benedita Rocha")).toBeTruthy();
  expect(first.getByText("Nascimento: 02/05/1948 · sem CPF · com CNS")).toBeTruthy();
  expect(screen.getByTestId("candidate-2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Corrigir" })).toBeNull();
  await fireEvent.press(first.getByRole("button", { name: "É esta pessoa" }));
  await waitFor(() => expect(nav.onDone).toHaveBeenCalled());
  const after = (await outboxRepo.bySeq(db, item.seq))!;
  expect([after.state, after.body.patient_id, "new_patient" in after.body]).toEqual(["pending", "1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c", false]);
  expect(person.clientUuid).toBe(after.client_uuid);
});

test("'É outra pessoa' sends the same record again, saying the candidates were seen", async () => {
  const db = await loadedTablet();
  await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields }, deps);
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [{ ...answer("upload-response-duplicate-suspected.json"), client_uuid: item.client_uuid, type: "individual_registration" }], noStale);
  const nav = await mount(db, item.seq);
  await fireEvent.press(await screen.findByRole("button", { name: "É outra pessoa" }));
  await waitFor(() => expect(nav.onDone).toHaveBeenCalled());
  const after = (await outboxRepo.bySeq(db, item.seq))!;
  expect([after.state, after.body.duplicates_reviewed, after.body.new_patient]).toEqual(["pending", true, BENEDITA]);
});

test("the person already has a registration on this tablet: it is opened, and the duplicate leaves the line", async () => {
  const db = await loadedTablet();
  await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields }, deps);
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [{ ...answer("upload-response-already-registered-with-id.json"), client_uuid: item.client_uuid }], noStale);
  const nav = await mount(db, item.seq);
  await fireEvent.press(await screen.findByRole("button", { name: "Abrir o cadastro existente" }));
  await waitFor(() => expect(nav.onOpenRegistration).toHaveBeenCalledWith(REG));
  expect(await outboxRepo.all(db)).toEqual([]);
});

test("the existing registration is not on this tablet: the screen says so and nothing is thrown away by itself", async () => {
  const db = await loadedTablet();
  await saveRegistration(db, { householdKey: HH, familyId: null, person: { kind: "new", patient: BENEDITA }, fields }, deps);
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [rejected(item, "already_registered")], noStale);
  const nav = await mount(db, item.seq);
  expect(await screen.findByText(EXISTING_NOT_HERE)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Abrir o cadastro existente" })).toBeNull();
  expect(await outboxRepo.all(db)).toHaveLength(1);
  // The way out is the ordinary discard, which says what goes with it.
  await press("Descartar");
  await press("Confirmar descarte");
  await waitFor(() => expect(nav.onDone).toHaveBeenCalled());
  expect(await outboxRepo.all(db)).toEqual([]);
});

test("a participant the server takes for a repetition: 'É outra pessoa' only when the answer says it can be confirmed", async () => {
  const db = await loadedTablet();
  const domains = (await loadReference(db))!.collectiveDomains;
  const twins = [BENEDITA, BENEDITA].map((patient) => ({ kind: "new" as const, patient, duplicatesReviewed: false, altered: false, weight: "", height: "", smoking: null }));
  await saveActivity(db, {
    ...emptyActivityDraft("2026-11-14"), teamId: TEAM, heldOn: "2026-11-14", shift: 2, activityType: 4, place: { kind: "text", text: "Salão" }, participantsCount: "2",
    targetAudience: [12], healthTopics: [1], participants: twins,
  }, { domains, ...deps });
  const [item] = await outboxRepo.all(db);
  await applyResults(db, [item], [{ ...answer("upload-response-duplicate-participant.json"), client_uuid: item.client_uuid }], noStale);
  const nav = await mount(db, item.seq);
  expect(await screen.findByText("Campo: Participante 2")).toBeTruthy();
  await press("É outra pessoa");
  await waitFor(() => expect(nav.onDone).toHaveBeenCalled());
  const after = (await outboxRepo.bySeq(db, item.seq))!;
  const participants = after.body.participants as Record<string, unknown>[];
  expect([after.state, participants[0].duplicates_reviewed, participants[1].duplicates_reviewed]).toEqual(["pending", undefined, true]);

  // The same person twice (same document): it cannot be confirmed away.
  await outboxRepo.update(db, item.seq, { state: "needs_attention", error: "duplicate_participant", path: "participants[1]", confirmable: false });
  await mount(db, item.seq);
  await waitFor(() => expect(screen.getAllByText(phraseFor("duplicate_participant")).length).toBeGreaterThan(0));
  expect(screen.queryByRole("button", { name: "É outra pessoa" })).toBeNull();
});

test("a refused visit has no form to go back to: the screen says to discard it and register again", async () => {
  const db = await loadedTablet();
  const visit = await enqueue(db, { type: "home_visit", body: { team_id: TEAM, occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "none", outcome: 3, reasons: [], shared: false } }, newUuid);
  await applyResults(db, [visit], [rejected(visit, "visit_date_out_of_range", { path: "occurred_at" })], noStale);
  await mount(db, visit.seq);
  expect(await screen.findByText(NO_FORM_FOR_THIS)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Corrigir" })).toBeNull();
  await press("Descartar");
  await press("Confirmar descarte");
  await waitFor(async () => expect(await outboxRepo.all(db)).toEqual([]));
});

test("an item that is not waiting for the person says so", async () => {
  const db = await loadedTablet();
  await saveHousehold(db, { key: HH, fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const [item] = await outboxRepo.all(db);
  await mount(db, item.seq);
  expect(await screen.findByText(NOT_WAITING_FOR_YOU)).toBeTruthy();
});
