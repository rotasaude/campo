import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import type { LocationPort } from "../../location/capture";
import { FAMILY_NOTICE } from "../../rules/homeVisit";
import { VISITS_OFF } from "../home/HomeScreen";
import { AREA, HH, endemicTablet, loadedTablet } from "../testing";
import { todayVisits } from "./save";
import { VisitForm } from "./VisitForm";

const NOW = Date.parse("2026-11-14T15:00:00Z"); // 12:00 in the city (UTC−3)
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
const gps = (accuracy: number | "denied"): LocationPort => ({
  permission: async () => ({ granted: accuracy !== "denied", precise: accuracy !== "denied" }),
  current: async () => ({ latitude: -25.428471234, longitude: -49.273254112, accuracy: accuracy === "denied" ? null : accuracy }),
});

async function mount(o: { db?: Db; start?: { householdKey?: string; patientRef?: string; familyId?: string }; location?: LocationPort; uuid?: string } = {}) {
  const db = o.db ?? (await loadedTablet());
  const onSaved = jest.fn();
  const services = fakeServices({ db, now: () => NOW, location: o.location ?? gps("denied") });
  if (o.uuid !== undefined) services.crypto = { ...services.crypto, randomUUID: () => o.uuid as string };
  await renderWithServices(<VisitForm start={o.start} onSaved={onSaved} />, services);
  return { db, onSaved };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const type = (label: string | RegExp, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);
const visitItem = async (db: Db) => (await outboxRepo.all(db)).find((item) => item.type === "home_visit")!;

test("a visit started from a resident: where and who are already there; outcome and reason, and it is saved with the precise position", async () => {
  const t = await mount({ start: { householdKey: HH, patientRef: JOANA }, location: gps(8.46) });
  await screen.findByRole("header", { name: "Nova visita" });
  expect(screen.getByText("RUA das Flores, 120")).toBeTruthy();
  expect(field("patient").getByRole("radio", { name: "Joana Conceição" }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Visita realizada" }));
  await fireEvent.press(screen.getByRole("checkbox", { name: "Pessoa com hipertensão" }));
  await type("pressão sistólica", "138");
  await type("pressão diastólica", "88");
  await type("Observação", "Pediu retorno.");
  await press("Registrar visita");

  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
  const item = await visitItem(t.db);
  expect(item.body).toEqual({
    team_id: TEAM, occurred_at: "2026-11-14T12:00:00-03:00", household_id: HH, subject: "resident", patient_id: JOANA, outcome: 1, reasons: [11], shared: false,
    measurements: { systolic: 138, diastolic: 88 }, note: "Pediu retorno.",
    location: { latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" },
  });
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
});

test("without a precise position the visit is saved all the same, with no position at all", async () => {
  const t = await mount({ start: { householdKey: HH, patientRef: JOANA }, location: gps(120) });
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Ausente" }));
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  expect("location" in (await visitItem(t.db)).body).toBe(false);
});

test("the moment offered is now in the city, corrected by what is known of the tablet's clock", async () => {
  const db = await loadedTablet();
  await db.run("INSERT INTO meta (key, value) VALUES ('clock_skew_ms', '120000') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const t = await mount({ db, start: { householdKey: HH, patientRef: JOANA } });
  await screen.findByRole("header", { name: "Nova visita" });
  expect(screen.getByLabelText("Data (dd/mm/aaaa)").props.value).toBe("14/11/2026");
  expect(screen.getByLabelText("Hora (hh:mm)").props.value).toBe("12:02");
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Ausente" }));
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  expect((await visitItem(db)).body.occurred_at).toBe("2026-11-14T12:02:00-03:00");
});

test("a date before the city's minimum, or later than now, is refused on screen and nothing is saved", async () => {
  const t = await mount({ start: { householdKey: HH, patientRef: JOANA } });
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Ausente" }));
  await type("Data (dd/mm/aaaa)", "30/09/2026");
  await press("Registrar visita");
  expect(await screen.findByText("a data da visita vai de 01/10/2026 até agora")).toBeTruthy();
  await type("Data (dd/mm/aaaa)", "14/11/2026");
  await type("Hora (hh:mm)", "13:30");
  await press("Registrar visita");
  expect(await screen.findByText("a data da visita vai de 01/10/2026 até agora")).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});

test("a visit that was refused takes no reason: what was marked is taken out, and the screen says what", async () => {
  await mount({ start: { householdKey: HH, patientRef: JOANA } });
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Visita realizada" }));
  await fireEvent.press(screen.getByRole("checkbox", { name: "Pessoa com hipertensão" }));
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Visita recusada" }));
  expect(screen.getByText("Retirado por não valer para esta visita: Pessoa com hipertensão.")).toBeTruthy();
  expect(screen.queryByText("Motivos da visita")).toBeNull();
  expect(screen.queryByLabelText("pressão sistólica")).toBeNull();
});

test("a resident with a reason that belongs to the family: the screen says the visit goes to the family (Q43)", async () => {
  await mount({ start: { householdKey: HH, patientRef: JOANA } });
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Visita realizada" }));
  await fireEvent.press(screen.getByRole("checkbox", { name: "Visita periódica" }));
  expect(screen.getByText(FAMILY_NOTICE)).toBeTruthy();
});

test("a place with no registration, by the ACS: micro-area, property type and nobody", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("place_kind").getByRole("radio", { name: "Imóvel sem cadastro" }));
  expect(field("micro_area").getByRole("radio", { name: "Fora de área" })).toBeTruthy();
  // The only micro-area of this agent is already chosen.
  expect(field("micro_area").getByRole("radio", { name: "03 · Vila Nova — rua das Flores" }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(field("property_type").getByRole("radio", { name: "Comércio" }));
  // A shop takes nobody: the question is not asked.
  expect(screen.queryByText("Quem foi visitado")).toBeNull();
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Visita realizada" }));
  await fireEvent.press(screen.getByRole("checkbox", { name: "Ação educativa" }));
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  expect((await visitItem(t.db)).body).toEqual({
    team_id: TEAM, occurred_at: "2026-11-14T12:00:00-03:00", micro_area_id: AREA, property_type: "2", subject: "none", outcome: 1, reasons: [34], shared: false,
  });
});

test("the visit to a family: the family of the household is chosen, and the item names it", async () => {
  const t = await mount({ start: { householdKey: HH, familyId: FAMILY } });
  await screen.findByRole("header", { name: "Nova visita" });
  expect(field("subject").getByRole("radio", { name: "Família — documento do responsável" }).props.accessibilityState.checked).toBe(true);
  expect(field("family").getByRole("radio", { name: "Família de Joana Conceição" }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(field("outcome").getByRole("radio", { name: "Ausente" }));
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  expect((await visitItem(t.db)).body).toMatchObject({ household_id: HH, subject: "family_responsible", family_id: FAMILY, outcome: 3 });
});

test("an agent who only has assigned micro-areas is not offered 'Fora de área'", async () => {
  const db = await loadedTablet({ session: example<SessionResponse>("session-assigned-agent.json") });
  await mount({ db });
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("place_kind").getByRole("radio", { name: "Imóvel sem cadastro" }));
  expect(field("micro_area").getByRole("radio", { name: "07 · Jardim Esperança" })).toBeTruthy();
  expect(field("micro_area").queryByRole("radio", { name: "Fora de área" })).toBeNull();
});

test("with the visit turned off by the city the form does not open", async () => {
  const session = example<SessionResponse>("session-acs.json");
  const db = await loadedTablet({ session: { features: { ...session.features, home_visits: false } } });
  await mount({ db });
  expect(await screen.findByText(VISITS_OFF)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Registrar visita" })).toBeNull();
});

// ── 35a: the endemic agent's visit ──
const plus = async (box: ReturnType<typeof within>, label: string, times: number) => { for (let i = 0; i < times; i += 1) await fireEvent.press(box.getByRole("button", { name: `Aumentar ${label}` })); };

test("ACE visit with inspection saves and shows today's sheet", async () => {
  const uuid = "c0ffee60-0000-4000-8000-000000000060";
  const t = await mount({ db: await endemicTablet(), start: { householdKey: HH, patientRef: JOANA }, location: gps(8.46), uuid });
  await screen.findByRole("header", { name: "Nova visita" });
  // The 24b part does not change: who was visited is still asked.
  expect(field("patient").getByRole("radio", { name: "Joana Conceição" }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(field("vector_inspection.activity").getByRole("radio", { name: "LI+T — Levantamento de índice e tratamento" }));
  await fireEvent.press(field("vector_inspection.situation").getByRole("radio", { name: "Trabalhado" }));
  await type("Entrada (hh:mm)", "11:40");
  await type("Saída (hh:mm)", "12:00");
  await fireEvent.press(field("vector_inspection.deposit_group").getByRole("radio", { name: "A2 — Depósito de armazenamento ao nível do solo" }));
  await press("Adicionar grupo");
  const a2 = within(screen.getByTestId("deposit-A2"));
  await plus(a2, "Existentes", 3); await plus(a2, "Com água", 2); await plus(a2, "Com larva", 1); await plus(a2, "Eliminados", 1); await plus(a2, "Tratados", 1);
  await fireEvent.press(field("vector_inspection.measure_method").getByRole("radio", { name: "Focal (larvicida)" }));
  await press("Adicionar medida");
  const measure = within(screen.getByTestId("measure-1"));
  // The product list is the method's: the adulticide is not offered for focal.
  expect(measure.queryByRole("radio", { name: "Clotianidina + deltametrina PM (adulticida residual)" })).toBeNull();
  await fireEvent.press(measure.getByRole("radio", { name: "Espinosade 7,48% DT (larvicida)" }));
  await fireEvent.changeText(measure.getByLabelText("Cargas"), "2");
  expect(measure.getByText("= 2,00 un")).toBeTruthy();
  await fireEvent.press(field("vector_inspection.sample_group").getByRole("radio", { name: "A2" }));
  await press("Adicionar amostra");
  await plus(within(screen.getByTestId("sample-1")), "Larvas coletadas", 8);
  await fireEvent.press(screen.getByRole("checkbox", { name: "Ação educativa" }));
  await fireEvent.press(field("vector_inspection.risk_class").getByRole("radio", { name: "Vermelho (alto)" }));
  await press("Registrar visita");

  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
  const item = await visitItem(t.db);
  expect(item.client_uuid).toBe(uuid);
  expect(item.body).toEqual({
    team_id: TEAM, occurred_at: "2026-11-14T12:00:00-03:00", household_id: HH, subject: "resident", patient_id: JOANA, outcome: 1, reasons: [], shared: false,
    location: { latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" },
    vector_inspection: {
      activity: "li_t", work_type: "routine", situation: "worked", educational_action: true,
      entered_at: "2026-11-14T11:40:00-03:00", left_at: "2026-11-14T12:00:00-03:00", risk_class: "red",
      deposits: [{ group: "A2", existing: 3, with_water: 2, with_larvae: 1, eliminated: 1, treated: 1 }],
      measures: [{ method: "focal", vector_product_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", charges: 2 }],
      samples: [{ number: 1, deposit_group: "A2", larvae_collected: 8 }],
    },
  });
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
  // Today's sheet has it, with what the bulletin keeps for the screens.
  const sheet = await todayVisits(t.db, NOW);
  expect(sheet.map((v) => [v.clientUuid, v.time, v.state, v.householdKey, v.outcome])).toEqual([[uuid, "12:00", "pending", HH, 1]]);
});

test("reasons 34–37 are not offered while the inspection is on, and the preview lists the derived ones", async () => {
  await mount({ db: await endemicTablet(), start: { householdKey: HH, patientRef: JOANA } });
  await screen.findByRole("header", { name: "Nova visita" });
  await fireEvent.press(field("vector_inspection.situation").getByRole("radio", { name: "Trabalhado" }));
  const DERIVED = ["Ação educativa", "Imóvel com foco", "Ação mecânica", "Tratamento focal"];
  expect(field("reasons").getByRole("checkbox", { name: "Pessoa com hipertensão" })).toBeTruthy();
  for (const name of DERIVED) expect(field("reasons").queryByRole("checkbox", { name })).toBeNull();
  expect(screen.queryByText(/O boletim acrescenta/)).toBeNull();
  await fireEvent.press(screen.getByRole("checkbox", { name: "Ação educativa" }));
  expect(screen.getByText("O boletim acrescenta: 34 Ação educativa")).toBeTruthy();
  await fireEvent.press(field("vector_inspection.deposit_group").getByRole("radio", { name: "B — Depósito móvel" }));
  await press("Adicionar grupo");
  const b = within(screen.getByTestId("deposit-B"));
  await plus(b, "Existentes", 1); await plus(b, "Com água", 1); await plus(b, "Com larva", 1);
  expect(screen.getByText("O boletim acrescenta: 34 Ação educativa, 35 Imóvel com foco")).toBeTruthy();
  // The derived reasons are reasons of the family (Q43): the 24b notice reads them too.
  expect(screen.getByText(FAMILY_NOTICE)).toBeTruthy();

  // Without the bulletin they are offered again, as in the 24b (the outcome stays the one the situation gave).
  await fireEvent.press(screen.getByRole("checkbox", { name: "Registrar boletim" }));
  expect(field("outcome").getByRole("radio", { name: "Visita realizada" }).props.accessibilityState.checked).toBe(true);
  for (const name of DERIVED) expect(field("reasons").getByRole("checkbox", { name })).toBeTruthy();
  expect(screen.queryByText(/O boletim acrescenta/)).toBeNull();
});
