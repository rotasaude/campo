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
import { AnimalForm } from "./AnimalForm";
import { saveAnimal } from "./save";

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
    onInstallOvitrap: jest.fn(), onStartPropertyVisit: jest.fn(), onNewAnimal: jest.fn(), onEditAnimal: jest.fn(),
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
