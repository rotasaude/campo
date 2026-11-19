import { fireEvent, screen, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { applyResults } from "../../sync/dispatch";
import { accepted, newUuid } from "../../sync/testing";
import { AREA, HH, loadedTablet } from "../testing";
import { NOT_SENT_WILL_BE_ERASED, saveVisit } from "./save";
import { NO_VISITS_TODAY, TodayScreen } from "./TodayScreen";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const TEAM = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const rules = createVisitRules({ offsetMin: -180, newPatientProblem: createRegistryRules(registrationDictionaries()).newPatientProblem });
// The client_uuid is the form's (fixed when it opened): one per visit.
const ctx = () => ({ clientUuid: newUuid(), teamId: TEAM, location: null, visitBody: rules.visitBody, newUuid, now: () => NOW, vectorInspection: null });
const draft = (o: Partial<VisitDraft> = {}): VisitDraft => ({
  ...emptyVisitDraft(), day: "2026-11-14", time: "10:30", place: { kind: "household", householdId: HH, propertyType: "1", microAreaId: AREA },
  subject: "none", outcome: 3, ...o,
});
async function mount(db: Db) {
  const onNewVisit = jest.fn();
  await renderWithServices(<TodayScreen onNewVisit={onNewVisit} />, fakeServices({ db, now: () => NOW }));
  return { onNewVisit };
}
const visit = (uuid: string) => within(screen.getByTestId(`visit-${uuid}`));

test("no visit today: the screen says so and offers to register one", async () => {
  const t = await mount(await loadedTablet());
  expect(await screen.findByText(NO_VISITS_TODAY)).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Nova visita" }));
  expect(t.onNewVisit).toHaveBeenCalled();
});

test("today's visits in order: the hour, where, the outcome and where each one stands", async () => {
  const db = await loadedTablet();
  const first = await saveVisit(db, draft({ time: "09:00", outcome: 1, reasons: [1] }), ctx());
  const second = await saveVisit(db, draft({ time: "11:15", place: { kind: "no_household", propertyType: "2", microAreaId: AREA, outOfArea: false } }), ctx());
  await saveVisit(db, draft({ day: "2026-11-13" }), ctx());
  const [sent] = await outboxRepo.all(db);
  await applyResults(db, [sent], [accepted(sent)], { onStale: async () => undefined });
  await mount(db);
  await screen.findByTestId(`visit-${first}`);
  expect(screen.getAllByTestId(/^visit-/).map((node) => node.props.testID)).toEqual([`visit-${first}`, `visit-${second}`]);
  expect(visit(first).getByText("09:00 · RUA das Flores, 120")).toBeTruthy();
  expect(visit(first).getByText("Visita realizada")).toBeTruthy();
  expect(visit(first).getByText("Enviada")).toBeTruthy();
  expect(visit(second).getByText("11:15 · Imóvel sem cadastro")).toBeTruthy();
  expect(visit(second).getByText("Ausente")).toBeTruthy();
  expect(visit(second).getByText("Aguardando envio")).toBeTruthy();
});

test("withdrawing a visit never sent asks first, then erases it", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft(), ctx());
  await mount(db);
  await fireEvent.press(await visit(uuid).findByRole("button", { name: "Retirar" }));
  expect(visit(uuid).getByText(NOT_SENT_WILL_BE_ERASED)).toBeTruthy();
  expect(await outboxRepo.all(db)).toHaveLength(1); // nothing yet
  await fireEvent.press(visit(uuid).getByRole("button", { name: "Apagar visita" }));
  expect(await screen.findByText(NO_VISITS_TODAY)).toBeTruthy();
  expect(await outboxRepo.all(db)).toEqual([]);
});

test("withdrawing a visit the server has asks for the reason; a short one is refused; then it waits to be sent", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft(), ctx());
  const [sent] = await outboxRepo.all(db);
  await applyResults(db, [sent], [accepted(sent)], { onStale: async () => undefined });
  await mount(db);
  await fireEvent.press(await visit(uuid).findByRole("button", { name: "Retirar" }));
  await fireEvent.changeText(visit(uuid).getByLabelText("Motivo da retirada"), "errei");
  await fireEvent.press(visit(uuid).getByRole("button", { name: "Retirar visita" }));
  expect(await visit(uuid).findByText("escreva de 10 a 500 caracteres")).toBeTruthy();
  await fireEvent.changeText(visit(uuid).getByLabelText("Motivo da retirada"), "Visita registrada no domicílio errado.");
  await fireEvent.press(visit(uuid).getByRole("button", { name: "Retirar visita" }));
  expect(await visit(uuid).findByText("Retirada aguardando envio")).toBeTruthy();
  expect(visit(uuid).queryByRole("button", { name: "Retirar" })).toBeNull();
  expect((await outboxRepo.all(db)).map((i) => i.type)).toEqual(["home_visit_withdrawal"]);
});

// Review C2: "sent" is what the server accepted — never the mere absence of the item in the line.
test("a visit whose item is gone from the line without having been accepted is not called sent, and taking it back only erases it", async () => {
  const db = await loadedTablet();
  const uuid = await saveVisit(db, draft(), ctx());
  await db.run("DELETE FROM outbox WHERE client_uuid = ?", [uuid]);
  await mount(db);
  expect(await visit(uuid).findByText("Aguardando envio")).toBeTruthy();
  expect(visit(uuid).queryByText("Enviada")).toBeNull();
  await fireEvent.press(visit(uuid).getByRole("button", { name: "Retirar" }));
  await fireEvent.press(visit(uuid).getByRole("button", { name: "Apagar visita" }));
  expect(await screen.findByText(NO_VISITS_TODAY)).toBeTruthy();
  expect(await outboxRepo.all(db)).toEqual([]); // no withdrawal of a visit the server never had
});
