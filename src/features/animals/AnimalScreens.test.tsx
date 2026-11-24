import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import type { UploadResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { fakeServices, renderWithServices } from "../../app/testing";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { emptyAnimalDraft } from "../../rules/animal";
import { ZOONOSES_ERRORS } from "../../rules/zoonosesErrors";
import { handleStale } from "../../sync/stale";
import { newUuid } from "../../sync/testing";
import { AttentionScreen } from "../attention/AttentionScreen";
import { WAITING } from "../households/HouseholdList";
import { HouseholdScreen } from "../households/HouseholdScreen";
import { ANIMAL, COMMUNITY_ANIMAL, HH, JOANA, bornResident, zoonosesTablet } from "../testing";
import { OutboxScreen } from "../outbox/OutboxScreen";
import { AnimalForm } from "./AnimalForm";
import { CollarForm } from "./CollarForm";
import { placeCollar, saveAnimal, vaccinate } from "./save";
import { EATAV_REMINDER, VaccinateForm } from "./VaccinateForm";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const CHIP = "985141000123456";
const BENEDITA = "c0ffee71-0000-4000-8000-000000000071";
const services = (db: Db) => fakeServices({ db, now: () => NOW });
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const field = (path: string) => within(screen.getByTestId(`field-${path}`));
const choose = (path: string, option: string) => fireEvent.press(field(path).getByRole("radio", { name: option }));
const options = (path: string) => field(path).getAllByRole("radio").map((radio) => radio.props.accessibilityLabel as string);
// The first screen of a worker loads React Native, which takes seconds in the test container.
const FIRST = { timeout: 10000 };
const animalItems = async (db: Db) => (await outboxRepo.all(db)).filter((item) => item.type === "animal");

async function household(db: Db) {
  const nav = {
    onEdit: jest.fn(), onNewFamily: jest.fn(), onEditFamily: jest.fn(), onNewResident: jest.fn(), onStartVisit: jest.fn(), onOpenResident: jest.fn(),
    onInstallOvitrap: jest.fn(), onStartPropertyVisit: jest.fn(), onNewAnimal: jest.fn(), onEditAnimal: jest.fn(), onVaccinateAnimal: jest.fn(),
    onCollarAnimal: jest.fn(),
  };
  const view = await renderWithServices(<HouseholdScreen householdKey={HH} {...nav} />, services(db));
  await screen.findByText(/Microárea/, {}, FIRST);
  return { ...nav, unmount: () => view.unmount() };
}
async function form(db: Db, animalKey?: string) {
  const onSaved = jest.fn();
  const view = await renderWithServices(<AnimalForm householdKey={HH} animalKey={animalKey} onSaved={onSaved} />, services(db));
  await screen.findByTestId("field-sex", {}, FIRST);
  return { onSaved, unmount: () => view.unmount() };
}

test("Animais shows for 515140 and 515105 with zoonoses, never for another CBO or with the switch off", async () => {
  for (const cbo of ["515140", "515105"]) {
    const nav = await household(await zoonosesTablet({ cbo }));
    expect(screen.getByText("Animais")).toBeTruthy();
    const card = await screen.findByTestId(`animal-${ANIMAL}`);
    expect(within(card).getByText("Cão · Pipoca")).toBeTruthy();
    expect(within(card).getByText("Tutor: Joana Conceição")).toBeTruthy();
    expect(within(card).getByText("Tem microchip")).toBeTruthy();
    expect(within(screen.getByTestId(`animal-${COMMUNITY_ANIMAL}`)).getByText("Comunitário")).toBeTruthy();
    await press("Cadastrar animal");
    expect(nav.onNewAnimal).toHaveBeenCalledTimes(1);
    await fireEvent.press(within(card).getByRole("button", { name: "Editar" }));
    expect(nav.onEditAnimal).toHaveBeenCalledWith(ANIMAL);
    await nav.unmount();
  }
  for (const db of [await zoonosesTablet({ cbo: "223505" }), await zoonosesTablet({ zoonoses: false }), await zoonosesTablet({ domains: null })]) {
    const nav = await household(db);
    expect(screen.queryByText("Animais")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cadastrar animal" })).toBeNull();
    await nav.unmount();
  }
  // Only in an active household.
  const inactive = await zoonosesTablet();
  await inactive.run("UPDATE households SET body = json_set(body, '$.status', 'inactive') WHERE key = ?", [HH]);
  await household(inactive);
  expect(screen.queryByText("Animais")).toBeNull();
});

test("after saving, the card says the animal has a microchip and the number is nowhere on screen", async () => {
  const db = await zoonosesTablet();
  const created = await form(db);
  expect(screen.queryByTestId("field-status")).toBeNull();
  await choose("species", "Gato");
  await choose("sex", "Macho");
  await fireEvent.changeText(screen.getByLabelText("Nome"), "Mingau");
  await fireEvent.changeText(screen.getByLabelText("Microchip (15 dígitos)"), CHIP);
  await press("Cadastrar animal");
  await waitFor(() => expect(created.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await animalItems(db);
  expect(item.body).toMatchObject({ species: "cat", sex: "male", name: "Mingau", microchip: CHIP, household_id: HH });
  await created.unmount();

  const hh = await household(db);
  const card = await screen.findByTestId(`animal-${item.client_uuid}`);
  expect(within(card).getByText("Gato · Mingau")).toBeTruthy();
  expect(within(card).getByText("Tem microchip")).toBeTruthy();
  expect(within(card).getByText(WAITING)).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toContain(CHIP);
  await hh.unmount();

  // The edit says only that it has one: no field, no number.
  await form(db, item.client_uuid);
  expect(screen.getByText("Tem microchip")).toBeTruthy();
  expect(screen.queryByLabelText(/Microchip/)).toBeNull();
  expect(JSON.stringify(screen.toJSON())).not.toContain(CHIP);
});

test("tutor list is the residents the tablet has in the household; no tutor is allowed", async () => {
  const db = await zoonosesTablet();
  await bornResident(db, { key: BENEDITA, name: "Benedita Rocha" });
  await bornResident(db, { key: "c0ffee74-0000-4000-8000-000000000074", name: "Zulmira Alves", householdKey: "another-household" });
  const created = await form(db);
  expect(options("tutor_patient_id")).toEqual(["Benedita Rocha", "Joana Conceição"]);
  await choose("species", "Cão");
  await choose("sex", "Fêmea");
  await press("Cadastrar animal");
  await waitFor(() => expect(created.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await animalItems(db);
  expect(item.body).toEqual({ household_id: HH, species: "dog", sex: "female", community: false });
  await created.unmount();

  // The resident born on the tablet follows N1; "Animal comunitário" takes the tutor off.
  const second = await form(db);
  await choose("species", "Cão");
  await choose("sex", "Fêmea");
  await choose("tutor_patient_id", "Benedita Rocha");
  await fireEvent.press(screen.getByRole("checkbox", { name: "Animal comunitário" }));
  expect(field("tutor_patient_id").getByRole("radio", { name: "Benedita Rocha" }).props.accessibilityState.checked).toBe(false);
  await fireEvent.press(screen.getByRole("checkbox", { name: "Animal comunitário" }));
  await choose("tutor_patient_id", "Benedita Rocha");
  await press("Cadastrar animal");
  await waitFor(() => expect(second.onSaved).toHaveBeenCalledTimes(1));
  expect((await animalItems(db))[1].body).toMatchObject({ tutor_client_uuid: BENEDITA, community: false });
});

test("a refusal of the screen is shown at its field and nothing is saved", async () => {
  const db = await zoonosesTablet();
  const created = await form(db);
  await fireEvent.changeText(screen.getByLabelText("Microchip (15 dígitos)"), "123");
  await press("Cadastrar animal");
  expect(await within(screen.getByTestId("field-species")).findByText("escolha a espécie")).toBeTruthy();
  expect(within(screen.getByTestId("field-sex")).getByText("escolha o sexo")).toBeTruthy();
  expect(within(screen.getByTestId("field-microchip")).getByText("microchip: 15 dígitos, sem espaço")).toBeTruthy();
  expect(created.onSaved).not.toHaveBeenCalled();
  expect(await animalItems(db)).toEqual([]);
});

test("the edit opens on the animal, offers its situation and never back to Ativo once it left it", async () => {
  const db = await zoonosesTablet();
  const edit = await form(db, ANIMAL);
  expect(screen.getByLabelText("Nome").props.value).toBe("Pipoca");
  expect(screen.getByText("Espécie: Cão")).toBeTruthy();
  expect(options("status")).toEqual(["Ativo", "Óbito", "Desaparecido", "Transferido"]);
  await choose("status", "Desaparecido");
  await press("Salvar alterações");
  await waitFor(() => expect(edit.onSaved).toHaveBeenCalledTimes(1));
  expect((await animalItems(db))[0].body).toMatchObject({ animal_id: ANIMAL, status: "missing", status_on: "2026-11-24", tutor_patient_id: JOANA });
  await edit.unmount();

  await form(db, ANIMAL);
  expect(options("status")).toEqual(["Óbito", "Desaparecido", "Transferido"]);
});

test("an animal changed at the station needs attention with the dashboard's phrase; Corrigir opens the animal form", async () => {
  const db = await zoonosesTablet();
  await saveAnimal(db, { householdKey: HH, animalKey: ANIMAL, draft: { ...emptyAnimalDraft(), species: "dog", sex: "female", name: "Rex" }, newUuid });
  const [item] = await outboxRepo.all(db);
  await handleStale(db, item, example<UploadResponse>("upload-response-stale-animal.json").results[0]);
  const onFix = jest.fn();
  await renderWithServices(<AttentionScreen seq={item.seq} onFix={onFix} onOpenRegistration={jest.fn()} onDone={jest.fn()} />, services(db));
  expect(await screen.findByText(ZOONOSES_ERRORS.animal_changed, {}, FIRST)).toBeTruthy();
  await press("Corrigir");
  expect(onFix).toHaveBeenCalledWith({ type: "animal", targetId: ANIMAL, familyId: null });
  expect(screen.getByRole("button", { name: "Descartar" })).toBeTruthy();
});

// ── Task 7: "Vacinar" and "Colocar coleira" ──
const VAR = "e1f2a3b4-c5d6-4e7f-8a9b-1c2d3e4f5a6b";
const CDT4 = "f2a3b4c5-d6e7-4f8a-9b0c-2d3e4f5a6b7c";
const careItems = async (db: Db, type: string) => (await outboxRepo.all(db)).filter((item) => item.type === type);
const card = (key: string) => within(screen.getByTestId(`animal-${key}`));
const born = (db: Db, species: string, name: string) =>
  saveAnimal(db, { householdKey: HH, draft: { ...emptyAnimalDraft(), species, sex: "male", name }, newUuid });
async function vaccinateForm(db: Db, animalKey: string) {
  const onSaved = jest.fn();
  const view = await renderWithServices(<VaccinateForm animalKey={animalKey} onSaved={onSaved} />, services(db));
  await screen.findByTestId("field-vector_product_id", {}, FIRST);
  return { onSaved, unmount: () => view.unmount() };
}
async function collarForm(db: Db, animalKey: string) {
  const onSaved = jest.fn();
  const view = await renderWithServices(<CollarForm animalKey={animalKey} onSaved={onSaved} />, services(db));
  await screen.findByTestId("field-vector_product_id", {}, FIRST);
  return { onSaved, unmount: () => view.unmount() };
}

test("adverse event on shows the EATAV reminder", async () => {
  const db = await zoonosesTablet();
  const form = await vaccinateForm(db, ANIMAL);
  expect(screen.getByText("Última vacina antirrábica: 21/11/2026")).toBeTruthy();
  // One vaccine product in the reference: it comes chosen.
  expect(field("vector_product_id").getByRole("radio", { name: "Vacina antirrábica animal" }).props.accessibilityState.checked).toBe(true);
  expect(screen.queryByText(EATAV_REMINDER)).toBeNull();
  expect(screen.queryByLabelText("Nota do evento adverso")).toBeNull();
  await fireEvent.press(screen.getByRole("checkbox", { name: "Evento adverso" }));
  expect(screen.getByText("Notifique o evento adverso no formulário do Ministério da Saúde (EATAV).")).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("Nota do evento adverso"), "Inchou");
  await press("Vacinar");
  expect(await field("adverse_note").findByText("escreva de 10 a 500 caracteres")).toBeTruthy();
  expect(await careItems(db, "rabies_vaccination")).toEqual([]);
  await fireEvent.changeText(screen.getByLabelText("Nota do evento adverso"), "Inchaço no local da aplicação.");
  await press("Vacinar");
  await waitFor(() => expect(form.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await careItems(db, "rabies_vaccination");
  expect(item.body).toMatchObject({ animal_id: ANIMAL, vaccinated_on: "2026-11-24", vector_product_id: VAR, adverse_event: true, adverse_note: "Inchaço no local da aplicação." });
});

test("no open campaign: no Vacinar button", async () => {
  const db = await zoonosesTablet();
  const cat = await born(db, "cat", "Mingau");
  const other = await born(db, "other", "Loro");
  // An animal whose edit in the line takes it out of "active".
  await saveAnimal(db, { householdKey: HH, animalKey: COMMUNITY_ANIMAL, draft: { ...emptyAnimalDraft(), species: "dog", sex: "female", community: true }, status: "missing", today: "2026-11-24", newUuid });
  const nav = await household(db);
  await screen.findByTestId(`animal-${ANIMAL}`);
  expect(card(ANIMAL).getByRole("button", { name: "Vacinar" })).toBeTruthy();
  expect(card(cat).getByRole("button", { name: "Vacinar" })).toBeTruthy();
  expect(card(other).queryByRole("button", { name: "Vacinar" })).toBeNull();
  expect(card(COMMUNITY_ANIMAL).queryByRole("button", { name: "Vacinar" })).toBeNull();
  await fireEvent.press(card(cat).getByRole("button", { name: "Vacinar" }));
  expect(nav.onVaccinateAnimal).toHaveBeenCalledWith(cat);
  await vaccinate(db, { animalKey: ANIMAL, productId: VAR, adverseEvent: false, adverseNote: null, today: "2026-11-24", newUuid });
  await nav.unmount();

  // The campaign closed in the reference: the button goes, the vaccine already in the line stays (Review Focus 5).
  await db.run("UPDATE reference SET body = json_set(body, '$.zoonoses_domains.open_campaign', json('null'))");
  await household(db);
  await screen.findByTestId(`animal-${ANIMAL}`);
  expect(screen.queryByRole("button", { name: "Vacinar" })).toBeNull();
  expect(card(ANIMAL).getByRole("button", { name: "Colocar coleira" })).toBeTruthy();
  expect(await careItems(db, "rabies_vaccination")).toHaveLength(1);
});

test("a second vaccination of the same campaign is offered; the api decides (Q19)", async () => {
  const db = await zoonosesTablet();
  await vaccinate(db, { animalKey: ANIMAL, productId: VAR, adverseEvent: false, adverseNote: null, today: "2026-11-24", newUuid });
  const nav = await household(db);
  await screen.findByTestId(`animal-${ANIMAL}`);
  expect(card(ANIMAL).getByRole("button", { name: "Vacinar" })).toBeTruthy();
  await nav.unmount();
  const form = await vaccinateForm(db, ANIMAL);
  expect(screen.getByText("Última vacina antirrábica: 24/11/2026")).toBeTruthy();
  await press("Vacinar");
  await waitFor(() => expect(form.onSaved).toHaveBeenCalledTimes(1));
  expect(await careItems(db, "rabies_vaccination")).toHaveLength(2);
});

test("collar only for an active dog; a cat has no Colocar coleira", async () => {
  const db = await zoonosesTablet();
  const cat = await born(db, "cat", "Mingau");
  const dog = await born(db, "dog", "Rex");
  const nav = await household(db);
  await screen.findByTestId(`animal-${dog}`);
  expect(card(cat).queryByRole("button", { name: "Colocar coleira" })).toBeNull();
  expect(card(ANIMAL).getByRole("button", { name: "Colocar coleira" })).toBeTruthy();
  await fireEvent.press(card(dog).getByRole("button", { name: "Colocar coleira" }));
  expect(nav.onCollarAnimal).toHaveBeenCalledWith(dog);
  await nav.unmount();

  const form = await collarForm(db, dog);
  expect(field("vector_product_id").getByRole("radio", { name: "Coleira deltametrina 4%" }).props.accessibilityState.checked).toBe(true);
  // Touching the chosen one clears it: the dashboard's phrase, nothing saved.
  await choose("vector_product_id", "Coleira deltametrina 4%");
  await press("Colocar coleira");
  expect(await field("vector_product_id").findByText("escolha a coleira")).toBeTruthy();
  expect(await careItems(db, "collar")).toEqual([]);
  await choose("vector_product_id", "Coleira deltametrina 4%");
  await press("Colocar coleira");
  await waitFor(() => expect(form.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await careItems(db, "collar");
  expect(item).toMatchObject({ depends_on: [{ client_uuid: dog, kind: "cite" }], body: { animal_client_uuid: dog, vector_product_id: CDT4, placed_on: "2026-11-24" } });
  await form.unmount();

  // The collar form of a cat refuses with the api's phrase, as the dashboard.
  await collarForm(db, cat);
  await press("Colocar coleira");
  expect(await field("animal_id").findByText(ZOONOSES_ERRORS.animal_not_dog)).toBeTruthy();
  expect(await careItems(db, "collar")).toHaveLength(1);
});

test("a vaccine whose animal row is gone is still in the line, on Envio", async () => {
  const db = await zoonosesTablet();
  await placeCollar(db, { animalKey: ANIMAL, productId: CDT4, today: "2026-11-24", newUuid });
  await db.run("DELETE FROM animals WHERE key = ?", [ANIMAL]);
  await renderWithServices(<OutboxScreen onFix={jest.fn()} onResolve={jest.fn()} />, services(db));
  expect(await screen.findByText("Coleira", {}, FIRST)).toBeTruthy();
});
