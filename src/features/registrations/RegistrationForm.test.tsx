import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { NAME_MESSAGE } from "../../rules/registry";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { READ_ONLY } from "../households/HouseholdForm";
import { AT_THE_DASHBOARD } from "../households/HouseholdScreen";
import { HH, loadedTablet } from "../testing";
import { scrollIntoView } from "../../ui/reveal";
import { CPF_USED_HERE } from "./localDuplicates";
import { LOOKS_LIKE, REFUSED_NOTE, RegistrationForm } from "./RegistrationForm";

// The measuring and the scrolling are the device's: here, that each refusal asks to be brought into sight.
jest.mock("../../ui/reveal", () => ({ ...jest.requireActual<typeof import("../../ui/reveal")>("../../ui/reveal"), scrollIntoView: jest.fn() }));
const revealed = scrollIntoView as jest.MockedFunction<typeof scrollIntoView>;

const NOW = Date.parse("2026-11-14T15:00:00Z");
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
const REG = "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d";

async function mount(o: { db?: Db; registrationKey?: string; familyId?: string | null } = {}) {
  const db = o.db ?? (await loadedTablet());
  const onSaved = jest.fn();
  const onOpenExisting = jest.fn();
  await renderWithServices(
    <RegistrationForm registrationKey={o.registrationKey} householdKey={o.registrationKey ? undefined : HH} familyId={o.familyId ?? null} onSaved={onSaved}
      onOpenExisting={onOpenExisting} />,
    fakeServices({ db, now: () => NOW }));
  await screen.findByRole("button", { name: "Salvar cadastro" });
  return { db, onSaved, onOpenExisting };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const type = (label: string | RegExp, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);
const choose = (key: string, name: string | RegExp) => fireEvent.press(field(key).getByRole("radio", { name }));

async function typePerson(o: { name?: string; birth?: string; sex?: string } = {}) {
  await type("Nome completo", o.name ?? "Benedita Aparecida Rocha");
  await type("Data de nascimento (dd/mm/aaaa)", o.birth ?? "02/05/1948");
  await choose("sex", o.sex ?? "Feminino");
  await type("Nome da mãe", "Maria José Rocha");
  await choose("no_cpf_reason", "Paciente desacordado, sem documentos");
}

test("a new resident, whole: the person typed, race, the sections — one item that the contract accepts", async () => {
  const t = await mount({ familyId: FAMILY });
  await typePerson();
  await type("Nome social", "Dita");
  await choose("race_color", "Parda");
  await choose("nacionalidade_cidadao", "Brasileira");
  await type("Município de nascimento (código IBGE, 7 dígitos)", "4106902");
  await type("Celular (DDD + número)", "41999990000");
  await choose("desconhece_nome_pai", "Sim");
  await choose("status_deseja_informar_orientacao_sexual", "Não");
  await choose("status_deseja_informar_identidade_genero", "Não");
  await choose("status_situacao_rua", "Não");
  await press("Salvar cadastro");

  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await outboxRepo.all(t.db);
  expect(item.type).toBe("individual_registration");
  expect(t.onSaved).toHaveBeenCalledWith(item.target_id);
  expect(item.body).toEqual({
    new_patient: { full_name: "Benedita Aparecida Rocha", social_name: "Dita", birth_date: "1948-05-02", sex: "female", mother_name: "Maria José Rocha", no_cpf_reason: "2" },
    household_id: HH, family_id: FAMILY, is_responsible: false, refused: false,
    patient_demographics: { race_color: "03", ethnicity: null },
    identification: { nacionalidade_cidadao: 1, codigo_ibge_municipio_nascimento: "4106902", telefone_celular: "41999990000", desconhece_nome_pai: true },
    sociodemographic: { status_deseja_informar_orientacao_sexual: false, status_deseja_informar_identidade_genero: false },
    health_conditions: {}, street_situation: { status_situacao_rua: false },
  });
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
});

test("what the api would refuse is written under its field, in the api's order, and nothing is saved", async () => {
  const t = await mount();
  await type("Nome completo", "Benedita");
  await press("Salvar cadastro");
  expect(await field("full_name").findByText(NAME_MESSAGE)).toBeTruthy();
  await typePerson();
  await press("Salvar cadastro");
  expect(await field("race_color").findByText("informe a raça/cor")).toBeTruthy();
  await choose("race_color", "Parda");
  await press("Salvar cadastro");
  expect(await field("nacionalidade_cidadao").findByText("informe a nacionalidade")).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});

// More than ten things are asked of a new person: the refusal may be several screens above the button.
test("each refusal is brought into sight: of the person, of the race and of a section", async () => {
  await mount();
  revealed.mockClear();
  await type("Nome completo", "Benedita");
  await press("Salvar cadastro");
  expect(await field("full_name").findByText(NAME_MESSAGE)).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(1);
  await typePerson();
  await press("Salvar cadastro");
  expect(await field("race_color").findByText("informe a raça/cor")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(2);
  await choose("race_color", "Parda");
  await press("Salvar cadastro");
  expect(await field("nacionalidade_cidadao").findByText("informe a nacionalidade")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(3);
});

test("a refusal takes only the identification: the other sections are not asked and do not travel", async () => {
  const t = await mount();
  await typePerson();
  expect(screen.getByText("Sociodemográfico")).toBeTruthy();
  await choose("refused", "Sim");
  expect(screen.getByText(REFUSED_NOTE)).toBeTruthy();
  expect(screen.queryByText("Sociodemográfico")).toBeNull();
  expect(screen.queryByText("Condições de saúde")).toBeNull();
  await press("Salvar cadastro");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body).toMatchObject({ refused: true, sociodemographic: {}, health_conditions: {} });
  expect("family_id" in item.body).toBe(false);
});

test("'Está gestante' is asked only of a woman between 9 and 60", async () => {
  await mount();
  expect(screen.queryByTestId("field-status_eh_gestante")).toBeNull(); // nobody typed yet
  await typePerson({ birth: "10/01/1990" });
  expect(screen.getByTestId("field-status_eh_gestante")).toBeTruthy();
  await choose("sex", "Masculino");
  expect(screen.queryByTestId("field-status_eh_gestante")).toBeNull();
  await choose("sex", "Feminino");
  await type("Data de nascimento (dd/mm/aaaa)", "02/05/1948");
  expect(screen.queryByTestId("field-status_eh_gestante")).toBeNull();
});

test("somebody who looks like a person already on the tablet: the screen warns and the agent decides", async () => {
  const t = await mount();
  await typePerson({ name: "Joana D'Arc Conceição", birth: "14/03/1961" });
  await type("Nome da mãe", "Maria Conceição");
  await choose("refused", "Sim");
  await press("Salvar cadastro");
  expect(await screen.findByText(LOOKS_LIKE)).toBeTruthy();
  // Q78: the warning names nobody and shows no document; who the look-alike is, is seen in that person's own screen.
  expect(screen.queryByText(/Joana Conceição/)).toBeNull();
  expect(screen.queryByText(/14\/03\/1961/)).toBeNull();
  await press("Ver cadastro parecido");
  expect(t.onOpenExisting).toHaveBeenCalledWith(REG);
  expect(await outboxRepo.all(t.db)).toEqual([]);
  await press("É outra pessoa: salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body.duplicates_reviewed).toBe(true);
});

test("a CPF already typed in another record of this tablet blocks, under the CPF", async () => {
  const db = await loadedTablet();
  await enqueue(db, { type: "patient", body: { new_patient: { full_name: "Outra Pessoa Qualquer", birth_date: "1980-01-01", sex: "male", cpf: "52998224725" } } }, newUuid);
  await mount({ db });
  await typePerson();
  await choose("no_cpf_reason", "Paciente desacordado, sem documentos"); // unmark: the person has a CPF
  await type("CPF", "529.982.247-25");
  await choose("refused", "Sim");
  await press("Salvar cadastro");
  expect(await field("cpf").findByText(CPF_USED_HERE)).toBeTruthy();
  expect(await outboxRepo.all(db)).toHaveLength(1);
});

test("editing: who the person is cannot change here; the sections open as they are and the item carries only what the app edits", async () => {
  const t = await mount({ registrationKey: REG });
  expect(screen.getByText("Joana D'Arc Conceição")).toBeTruthy();
  expect(screen.getByText("Nascimento: 14/03/1961")).toBeTruthy();
  expect(screen.getByText(AT_THE_DASHBOARD)).toBeTruthy();
  expect(screen.queryByLabelText("Nome completo")).toBeNull();
  expect(field("race_color").getByRole("radio", { name: "Parda" }).props.accessibilityState.checked).toBe(true);
  await choose("refused", "Sim");
  await press("Salvar cadastro");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalledWith(REG));
  const [item] = await outboxRepo.all(t.db);
  expect(item.body).toEqual({
    registration_id: REG, is_responsible: true, refused: true, patient_demographics: { race_color: "03", ethnicity: null },
    identification: {}, sociodemographic: {}, health_conditions: {}, street_situation: null,
  });
});

test("who is not the community health agent only reads", async () => {
  const session = example<SessionResponse>("session-acs.json");
  const db = await loadedTablet({ session: { professional: { ...session.professional, cbo: "322255" } } });
  await renderWithServices(<RegistrationForm registrationKey={REG} familyId={null} onSaved={jest.fn()} />, fakeServices({ db, now: () => NOW }));
  expect(await screen.findByText(READ_ONLY)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Salvar cadastro" })).toBeNull();
});
