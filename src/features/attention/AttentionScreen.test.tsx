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
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { ERROR_PHRASES, phraseFor } from "../messages/errorPhrases";
import { saveRegistration, type RegistrationFields } from "../registrations/save";
import { AREA, HH, loadedTablet } from "../testing";
import { sampleLabel } from "../../rules/vectorInspection";
import * as relabelModule from "../visits/relabel";
import { AttentionScreen, EXISTING_NOT_HERE, NOT_WAITING_FOR_YOU, NO_FORM_FOR_THIS } from "./AttentionScreen";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const REG = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";
const deps = { newUuid, now: () => NOW };
const noStale = { onStale: async () => undefined };
const BENEDITA = { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female" as const, mother_name: "Maria José Rocha", no_cpf_reason: "2" };
const fields: RegistrationFields = { is_responsible: false, refused: true, patient_demographics: { race_color: null, ethnicity: null }, identification: {}, sociodemographic: {}, health_conditions: {} };
const answer = (file: string) => example<UploadResponse>(file).results[0];

let view: Awaited<ReturnType<typeof renderWithServices>> | null = null;
async function mount(db: Db, seq: number, over: Partial<Parameters<typeof fakeServices>[0]> = {}) {
  const nav = { onFix: jest.fn(), onOpenRegistration: jest.fn(), onDone: jest.fn() };
  view = await renderWithServices(<AttentionScreen seq={seq} {...nav} />, fakeServices({ db, now: () => NOW, ...over }));
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

// M5 of the Task 7 review: the bulletin's paths with the section's own labels; an index reads "Amostra n" / "Medida n".
test("a path inside the bulletin is named by the labels of its section", () => {
  const cases: [string, string][] = [
    ["vector_inspection", "Boletim do agente de endemias"], ["vector_inspection.activity", "Atividade"],
    ["vector_inspection.liraa_draw_item_id", "Atividade"], ["vector_inspection.transmission_block_id", "Atividade"],
    ["vector_inspection.work_type", "Tipo de trabalho"], ["vector_inspection.situation", "Situação do imóvel"],
    ["vector_inspection.entered_at", "Entrada (hh:mm)"], ["vector_inspection.left_at", "Saída (hh:mm)"],
    ["vector_inspection.deposits", "Depósitos"], ["vector_inspection.deposits[2].with_larvae", "Depósitos: Com larva"],
    ["vector_inspection.deposits[0].group", "Depósitos: Grupo do depósito"], ["vector_inspection.deposits[0]", "Depósitos"],
    ["vector_inspection.measures", "Medidas de controle"], ["vector_inspection.measures[1]", "Medida 2"],
    ["vector_inspection.measures[0].vector_product_id", "Medida 1: Produto"], ["vector_inspection.measures[0].charges", "Medida 1: Cargas"],
    ["vector_inspection.measures[0].method", "Medida 1: Método"],
    ["vector_inspection.samples", "Amostras"], ["vector_inspection.samples[0]", "Amostra 1"],
    ["vector_inspection.samples[3].larvae_collected", "Amostra 4: Larvas coletadas"], ["vector_inspection.samples[0].deposit_group", "Amostra 1: Grupo da amostra"],
    ["vector_inspection.educational_action", "Ação educativa"], ["vector_inspection.city_block_id", "Quarteirão"],
    ["vector_inspection.risk_class", "Risco do imóvel"],
  ];
  for (const [path, label] of cases) expect([path, pathLabel("home_visit", path)]).toEqual([path, label]);
  // Unknown under the bulletin: the section's name, never a raw path.
  expect(pathLabel("home_visit", "vector_inspection.campo_novo")).toBe("Boletim do agente de endemias");
  // Outside the bulletin nothing changes.
  expect(pathLabel("home_visit", "reasons[2]")).toBe("Motivos da visita");
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

// Review Focus 3: the bulletin the server refused waits for the person with the dashboard's phrase, the visit kept; the
// 24b's refusal of the same code, with no path, keeps the 24c's.
test("a visit refused at its bulletin says the VECTOR_ERRORS phrase; the same code with no path, the 24c one", async () => {
  const db = await loadedTablet();
  const body = { team_id: TEAM, occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "none", outcome: 3, reasons: [], shared: false };
  const bulletin = await enqueue(db, { type: "home_visit", body: { ...body, vector_inspection: { activity: "li", work_type: "routine", situation: "closed", educational_action: false } } }, newUuid);
  const plain = await enqueue(db, { type: "home_visit", body }, newUuid);
  await applyResults(db, [bulletin, plain], [rejected(bulletin, "cbo_not_allowed", { path: "vector_inspection" }), rejected(plain, "cbo_not_allowed")], noStale);
  await mount(db, bulletin.seq);
  expect(await screen.findByText(VECTOR_ERRORS.cbo_not_allowed)).toBeTruthy();
  expect(screen.queryByText(ERROR_PHRASES.cbo_not_allowed)).toBeNull();
  expect((await outboxRepo.bySeq(db, bulletin.seq))!.body.vector_inspection).toBeTruthy();
  await view?.unmount();
  await mount(db, plain.seq);
  expect(await screen.findByText(ERROR_PHRASES.cbo_not_allowed)).toBeTruthy();
});

test("an item that is not waiting for the person says so", async () => {
  const db = await loadedTablet();
  await saveHousehold(db, { key: HH, fields: { micro_area_id: AREA, property_type: "1" } }, deps);
  const [item] = await outboxRepo.all(db);
  await mount(db, item.seq);
  expect(await screen.findByText(NOT_WAITING_FOR_YOU)).toBeTruthy();
});

// Q7(1): the label of a sample is already taken in the city. The screen says so with the old labels and waits for the
// agent's tap; the new labels are shown at once, in the dashboard's words after the 201 ("Etiquete os tubitos: …").
test("the attention screen shows old and new labels and never relabels by itself", async () => {
  const db = await loadedTablet();
  const OLD = "3f2a9c1e-0000-4000-8000-0000000000a1";
  const NEW = "abcdef12-0000-4000-8000-0000000000b2";
  const body = { team_id: TEAM, occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "none", outcome: 1, reasons: [], shared: false };
  const samples = [{ number: 1, deposit_group: "A1", larvae_collected: 3 }, { number: 2, deposit_group: "A1", larvae_collected: 1 }];
  const visit = await enqueue(db, { type: "home_visit", clientUuid: OLD, body: { ...body, vector_inspection: { activity: "li", work_type: "routine", situation: "worked", educational_action: true, samples } } }, newUuid);
  await db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, '2026-11-14', ?, '{}', 'pending')", [OLD, body.occurred_at]);
  await applyResults(db, [visit], [rejected(visit, "sample_label_taken", { path: "vector_inspection.samples[0]" })], noStale);
  const randomUUID = jest.fn(() => NEW);
  const nav = await mount(db, visit.seq, { crypto: { digestHex: async () => "", randomUUID } });

  expect(await screen.findByText(VECTOR_ERRORS.sample_label_taken)).toBeTruthy();
  expect(screen.getByText("Campo: Amostra 1")).toBeTruthy();
  expect(screen.getByText(`${sampleLabel(OLD, 1)}, ${sampleLabel(OLD, 2)}`)).toBeTruthy();
  // Sending it again would clash again, and there is no form: only the new labels or the discard.
  expect(screen.queryByRole("button", { name: "Reenviar" })).toBeNull();
  expect(screen.queryByText(NO_FORM_FOR_THIS)).toBeNull();
  expect(screen.getByRole("button", { name: "Descartar" })).toBeTruthy();
  // Nothing changes until the tap.
  expect(randomUUID).not.toHaveBeenCalled();
  expect((await outboxRepo.bySeq(db, visit.seq))!.client_uuid).toBe(OLD);

  await press("Gerar etiquetas novas");
  expect(await screen.findByText("Etiquete os tubitos: ABCDEF12-01, ABCDEF12-02")).toBeTruthy();
  const after = (await outboxRepo.bySeq(db, visit.seq))!;
  expect([after.client_uuid, after.state]).toEqual([NEW, "pending"]);
  expect(randomUUID).toHaveBeenCalledTimes(1);
  // The agent reads the labels before leaving: the screen does not close by itself.
  expect(nav.onDone).not.toHaveBeenCalled();
  expect(screen.queryByText(NOT_WAITING_FOR_YOU)).toBeNull();
});

test("'Gerar etiquetas novas' is offered only for sample_label_taken on a visit", async () => {
  const db = await loadedTablet();
  const body = { team_id: TEAM, occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "none", outcome: 1, reasons: [], shared: false };
  const visit = await enqueue(db, { type: "home_visit", body: { ...body, vector_inspection: { activity: "li", work_type: "routine", situation: "worked", educational_action: true } } }, newUuid);
  await applyResults(db, [visit], [rejected(visit, "samples_exceed_larvae", { path: "vector_inspection.samples[0]" })], noStale);
  await mount(db, visit.seq);
  expect(await screen.findByText(VECTOR_ERRORS.samples_exceed_larvae)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Gerar etiquetas novas" })).toBeNull();
});

const LABEL_OLD = "3f2a9c1e-0000-4000-8000-0000000000a1";
const LABEL_NEW = "abcdef12-0000-4000-8000-0000000000b2";
// A visit whose bulletin has two samples, refused with sample_label_taken, on the sheet.
async function clashedVisit(db: Db) {
  const body = { team_id: TEAM, occurred_at: "2026-11-14T10:00:00-03:00", household_id: HH, subject: "none", outcome: 1, reasons: [], shared: false };
  const samples = [{ number: 1, deposit_group: "A1", larvae_collected: 3 }, { number: 2, deposit_group: "A1", larvae_collected: 1 }];
  const visit = await enqueue(db, { type: "home_visit", clientUuid: LABEL_OLD, body: { ...body, vector_inspection: { activity: "li", work_type: "routine", situation: "worked", educational_action: true, samples } } }, newUuid);
  await db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, '2026-11-14', ?, '{}', 'pending')", [LABEL_OLD, body.occurred_at]);
  await applyResults(db, [visit], [rejected(visit, "sample_label_taken", { path: "vector_inspection.samples[0]" })], noStale);
  return visit;
}

// I1 of the Task 10 review: a second tap while the first runs never relabels again and never hides the new labels.
test("two taps on 'Gerar etiquetas novas' relabel once and show the new labels", async () => {
  const db = await loadedTablet();
  const visit = await clashedVisit(db);
  // The first relabel is held until both taps happened: the second one lands while the first still runs.
  const real = relabelModule.relabelVisit;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = jest.spyOn(relabelModule, "relabelVisit").mockImplementation(async (...args) => { await gate; return real(...args); });
  try {
    const randomUUID = jest.fn(() => LABEL_NEW);
    await mount(db, visit.seq, { crypto: { digestHex: async () => "", randomUUID } });
    await screen.findByText(VECTOR_ERRORS.sample_label_taken);
    await press("Gerar etiquetas novas");
    await press("Gerar etiquetas novas");
    release();
    expect(await screen.findByText("Etiquete os tubitos: ABCDEF12-01, ABCDEF12-02")).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect((await outboxRepo.bySeq(db, visit.seq))!.client_uuid).toBe(LABEL_NEW);
    expect(screen.queryByText("Não foi possível concluir. Volte e tente de novo.")).toBeNull();
  } finally {
    spy.mockRestore();
  }
});

// Q56: once relabelled, the old labels are on no screen of the visit — the attention screen now, and opened again.
test("after the relabel the old labels are on no screen", async () => {
  const db = await loadedTablet();
  const visit = await clashedVisit(db);
  await mount(db, visit.seq, { crypto: { digestHex: async () => "", randomUUID: () => LABEL_NEW } });
  expect(await screen.findByText(`${sampleLabel(LABEL_OLD, 1)}, ${sampleLabel(LABEL_OLD, 2)}`)).toBeTruthy();
  await press("Gerar etiquetas novas");
  await screen.findByText("Etiquete os tubitos: ABCDEF12-01, ABCDEF12-02");
  expect(screen.queryByText(/3F2A9C1E/i)).toBeNull();
  await view?.unmount();
  await mount(db, visit.seq);
  expect(await screen.findByText(NOT_WAITING_FOR_YOU)).toBeTruthy();
  expect(screen.queryByText(/3F2A9C1E/i)).toBeNull();
});

test("a relabel that fails says so and leaves the visit waiting, with its labels", async () => {
  const db = await loadedTablet();
  const visit = await clashedVisit(db);
  await mount(db, visit.seq, { crypto: { digestHex: async () => "", randomUUID: () => "not-a-uuid" } });
  await screen.findByText(VECTOR_ERRORS.sample_label_taken);
  await press("Gerar etiquetas novas");
  expect(await screen.findByText("Não foi possível concluir. Volte e tente de novo.")).toBeTruthy();
  expect(screen.queryByText(/Etiquete os tubitos/)).toBeNull();
  expect((await outboxRepo.bySeq(db, visit.seq))!).toMatchObject({ client_uuid: LABEL_OLD, state: "needs_attention", error: "sample_label_taken" });
});
