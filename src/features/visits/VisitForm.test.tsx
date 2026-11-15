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
import { AREA, HH, loadedTablet } from "../testing";
import { VisitForm } from "./VisitForm";

const NOW = Date.parse("2026-11-14T15:00:00Z"); // 12:00 in the city (UTC−3)
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
const gps = (accuracy: number | "denied"): LocationPort => ({
  permission: async () => ({ granted: accuracy !== "denied", precise: accuracy !== "denied" }),
  current: async () => ({ latitude: -25.428471234, longitude: -49.273254112, accuracy: accuracy === "denied" ? null : accuracy }),
});

async function mount(o: { db?: Db; start?: { householdKey?: string; patientRef?: string; familyId?: string }; location?: LocationPort } = {}) {
  const db = o.db ?? (await loadedTablet());
  const onSaved = jest.fn();
  await renderWithServices(<VisitForm start={o.start} onSaved={onSaved} />, fakeServices({ db, now: () => NOW, location: o.location ?? gps("denied") }));
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
