import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ReferenceResponse, SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { IDENTIFIER_WARNING } from "../../rules/collectiveActivity";
import { loadedTablet } from "../testing";
import { ActivityForm, COLLECTIVE_DISABLED } from "./ActivityForm";

const NOW = Date.parse("2026-11-14T15:00:00Z"); // 12:00 in the city: afternoon
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const CARLA = "5d6e7f8a-9b0c-4d1e-9f2a-3b4c5d6e7f8a";
const UBS = "6e7f8a9b-0c1d-4e2f-8a3b-4c5d6e7f8a9b";

async function mount(db?: Db) {
  const tablet = db ?? (await loadedTablet());
  const onSaved = jest.fn();
  await renderWithServices(<ActivityForm onSaved={onSaved} />, fakeServices({ db: tablet, now: () => NOW }));
  return { db: tablet, onSaved };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const type = (label: string | RegExp, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);
const check = (name: string) => fireEvent.press(screen.getByRole("checkbox", { name }));
const activity = async (db: Db) => (await outboxRepo.all(db)).find((item) => item.type === "collective_activity")!;

// Health education at the unit, for people with chronic diseases.
async function educationAtTheUnit() {
  await fireEvent.press(field("activity_type").getByRole("radio", { name: "Educação em saúde" }));
  await fireEvent.press(field("place_kind").getByRole("radio", { name: "Unidade" }));
  await fireEvent.press(field("unit").getByRole("radio", { name: "UBS Vila Nova" }));
  await type("Número de participantes", "12");
  await check("Pessoas com doenças crônicas");
  await check("Alimentação saudável");
}

test("with the collective activity turned off by the city the form does not open", async () => {
  const session = example<SessionResponse>("session-acs.json");
  await mount(await loadedTablet({ session: { features: { ...session.features, collective_activities: false } } }));
  expect(await screen.findByText(COLLECTIVE_DISABLED)).toBeTruthy();
  expect(COLLECTIVE_DISABLED).toBe("a atividade coletiva está desligada nesta cidade");
  expect(screen.queryByRole("button", { name: "Registrar atividade" })).toBeNull();
});

test("health education at the unit: only what that type takes is asked, and the item is what the contract shows", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova atividade coletiva" });
  expect(screen.getByLabelText("Data da atividade (dd/mm/aaaa)").props.value).toBe("14/11/2026");
  expect(field("shift").getByRole("radio", { name: "Tarde" }).props.accessibilityState.checked).toBe(true);
  await educationAtTheUnit();
  // Health education takes an audience and health topics; no meeting topics, no practices.
  expect(screen.queryByText(/^Temas para reunião/)).toBeNull();
  expect(screen.queryByText(/^Práticas em saúde/)).toBeNull();
  expect(screen.getByText("Público-alvo (obrigatório)")).toBeTruthy();
  await check("Carla Mendes");
  await press("Registrar atividade");

  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
  const item = await activity(t.db);
  expect(item.body).toEqual({
    team_id: TEAM, held_on: "2026-11-14", shift: 2, activity_type: 4, place_health_unit_id: UBS, participants_count: 12,
    meeting_topics: [], target_audience: [12], health_topics: [1], health_practices: [], professionals: [{ professional_id: CARLA }], participants: [],
  });
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
});

test("a group session (type 5) with nobody on the list is refused, with every other refusal, and nothing is saved", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova atividade coletiva" });
  await fireEvent.press(field("activity_type").getByRole("radio", { name: "Atendimento em grupo" }));
  expect(screen.getByText("Participantes (obrigatório)")).toBeTruthy();
  await press("Registrar atividade");
  expect(await screen.findByText("inclua ao menos um participante")).toBeTruthy();
  expect(screen.getByText("informe o número de participantes, de 1 a 999")).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});

// campo#5: whoever registers is already the activity's header — the api refuses them in the list. The reference carries
// the whole team, the person using the tablet included; the dashboard takes them out on the server.
test("the person using the tablet is not offered among the professionals who took part", async () => {
  const db = await loadedTablet();
  const me = example<SessionResponse>("session-acs.json").professional.id;
  const row = (await db.get<{ body: string }>("SELECT body FROM reference WHERE id = 1"))!;
  const reference = JSON.parse(row.body) as ReferenceResponse;
  reference.team_professionals = [...reference.team_professionals, { team_id: TEAM, professional_id: me, name: "Eu Mesma Agente", cbo: "515105", has_cns: true }];
  await db.run("UPDATE reference SET body = ? WHERE id = 1", [JSON.stringify(reference)]);
  await mount(db);
  await screen.findByRole("header", { name: "Nova atividade coletiva" });
  await educationAtTheUnit();
  expect(screen.queryByRole("checkbox", { name: /Eu Mesma Agente/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Carla Mendes" })).toBeTruthy();
});

test("a unit without CNES and a professional without CNS are refused with the dashboard's sentences (Q6)", async () => {
  const db = await loadedTablet();
  const row = (await db.get<{ body: string }>("SELECT body FROM reference WHERE id = 1"))!;
  const reference = JSON.parse(row.body) as ReferenceResponse;
  reference.team_professionals = reference.team_professionals.map((p) => (p.name === "Bruno Lima" ? { ...p, has_cns: false } : p));
  await db.run("UPDATE reference SET body = ? WHERE id = 1", [JSON.stringify(reference)]);
  const t = await mount(db);
  await screen.findByRole("header", { name: "Nova atividade coletiva" });
  await educationAtTheUnit();
  await fireEvent.press(field("unit").getByRole("radio", { name: "Ponto de apoio Jardim Esperança" }));
  await check("Bruno Lima — sem CNS no cadastro");
  await press("Registrar atividade");
  expect(await screen.findByText("a unidade escolhida não tem CNES — escolha outra ou escreva o local")).toBeTruthy();
  expect(screen.getByText("este profissional não tem CNS no cadastro")).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
});

test("participants are found by name among the people on the tablet; each one takes the evaluation and the measures", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova atividade coletiva" });
  await educationAtTheUnit();
  await type("Buscar participante pelo nome", "joan");
  await press("Adicionar Joana Conceição");
  const joana = within(screen.getByTestId("participant-0"));
  expect(joana.getByText("Joana Conceição")).toBeTruthy();
  await fireEvent.press(within(joana.getByTestId("field-altered-0")).getByRole("radio", { name: "Sim" }));
  await fireEvent.changeText(joana.getByLabelText("Peso (kg)"), "81,5");
  expect(screen.getByText("Avaliações alteradas (calculado pela lista): 1")).toBeTruthy();
  // Already on the list: not offered again.
  await type("Buscar participante pelo nome", "joan");
  expect(screen.queryByRole("button", { name: "Adicionar Joana Conceição" })).toBeNull();
  await press("Registrar atividade");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  expect((await activity(t.db)).body.participants).toEqual([{ patient_id: JOANA, altered_evaluation: true, measurements: { weight_kg: 81.5 } }]);
});

test("a person with no registration is typed right there and travels inside the participant; without a document the screen warns and does not block", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova atividade coletiva" });
  await educationAtTheUnit();
  await press("Pessoa sem cadastro");
  await press("Adicionar à lista");
  expect(await screen.findByText(/^nome de 3 a 70 letras/)).toBeTruthy();
  await type("Nome completo", "Benedita Aparecida Rocha");
  await type("Data de nascimento (dd/mm/aaaa)", "02/05/1948");
  await fireEvent.press(field("quick-sex").getByRole("radio", { name: "Feminino" }));
  await fireEvent.press(field("quick-no_cpf_reason").getByRole("radio", { name: "Paciente desacordado, sem documentos" }));
  await press("Adicionar à lista");
  const benedita = within(await screen.findByTestId("participant-0"));
  expect(benedita.getByText("Benedita Aparecida Rocha")).toBeTruthy();
  expect(benedita.getByText(IDENTIFIER_WARNING)).toBeTruthy();
  expect(screen.queryByLabelText("Nome completo")).toBeNull(); // the little form closed
  await press("Registrar atividade");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const item = await activity(t.db);
  expect(item.body.participants).toEqual([{ new_patient: { full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female", no_cpf_reason: "2" } }]);
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
});
