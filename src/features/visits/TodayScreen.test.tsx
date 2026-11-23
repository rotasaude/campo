import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { createVisitRules, emptyVisitDraft, type VisitDraft } from "../../rules/homeVisit";
import { createRegistryRules } from "../../rules/registry";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { applyResults } from "../../sync/dispatch";
import type { VectorInspectionBody } from "../../contract";
import { accepted, newUuid, rejected } from "../../sync/testing";
import { relabelVisit } from "./relabel";
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
  const view = await renderWithServices(<TodayScreen onNewVisit={onNewVisit} />, fakeServices({ db, now: () => NOW }));
  return { onNewVisit, view };
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

// Q58: a visit with samples that the server has not accepted yet repeats, on its line, the labels the tubes must carry —
// the current ones, made from the visit's client_uuid now (never stored), so a relabel shows only the new ones.
const OLD = "3f2a9c1e-0000-4000-8000-0000000000a1";
const NEW = "abcdef12-0000-4000-8000-0000000000b2";
const bulletin = (samples: { number: number; deposit_group: string; larvae_collected: number }[]) => ({
  activity: "li", work_type: "routine", situation: "worked", educational_action: true,
  deposits: [{ group: "A1", existing: 2, with_water: 2, with_larvae: 2, eliminated: 0, treated: 0 }], samples,
}) as unknown as VectorInspectionBody;
const TWO = [{ number: 1, deposit_group: "A1", larvae_collected: 3 }, { number: 2, deposit_group: "A1", larvae_collected: 1 }];
const withBulletin = (clientUuid: string, samples = TWO) => ({ ...ctx(), clientUuid, vectorInspection: bulletin(samples) });
const noStale = { onStale: async () => undefined };

test("a visit with samples not yet accepted shows its labels; one without samples shows none", async () => {
  const db = await loadedTablet();
  await saveVisit(db, draft({ time: "09:00", outcome: 1 }), withBulletin(OLD));
  const empty = await saveVisit(db, draft({ time: "10:00", outcome: 1 }), withBulletin(newUuid(), []));
  const plain = await saveVisit(db, draft({ time: "11:00" }), ctx());
  await mount(db);
  expect(await screen.findByText("Etiquete os tubitos: 3F2A9C1E-01, 3F2A9C1E-02")).toBeTruthy();
  expect(visit(OLD).getByText("Etiquete os tubitos: 3F2A9C1E-01, 3F2A9C1E-02")).toBeTruthy();
  expect(visit(empty).queryByText(/Etiquete os tubitos/)).toBeNull();
  expect(visit(plain).queryByText(/Etiquete os tubitos/)).toBeNull();
  // Not stored: the sheet line keeps no sample nor label.
  const [row] = await db.all<{ summary: string }>("SELECT summary FROM local_visits WHERE client_uuid = ?", [OLD]);
  expect(row.summary).not.toMatch(/samples|3f2a9c1e/i);
});

test("after a relabel Hoje shows only the new labels, never the old", async () => {
  const db = await loadedTablet();
  await saveVisit(db, draft({ outcome: 1 }), withBulletin(OLD));
  const item = (await outboxRepo.byClientUuid(db, OLD))!;
  await applyResults(db, [item], [rejected(item, "sample_label_taken", { path: "vector_inspection.samples[0]" })], noStale);
  await relabelVisit(db, item.seq, () => NEW);
  await mount(db);
  expect(await screen.findByText("Etiquete os tubitos: ABCDEF12-01, ABCDEF12-02")).toBeTruthy();
  expect(screen.queryByText(/3F2A9C1E/i)).toBeNull();
});

test("an accepted visit loses the line", async () => {
  const db = await loadedTablet();
  await saveVisit(db, draft({ outcome: 1 }), withBulletin(OLD));
  await mount(db);
  expect(await screen.findByText("Etiquete os tubitos: 3F2A9C1E-01, 3F2A9C1E-02")).toBeTruthy();
  const item = (await outboxRepo.byClientUuid(db, OLD))!;
  await applyResults(db, [item], [accepted(item)], noStale);
  await waitFor(() => expect(visit(OLD).getByText("Enviada")).toBeTruthy());
  expect(screen.queryByText(/Etiquete os tubitos/)).toBeNull();
});

test("reopening the app keeps the line: read again from the database", async () => {
  const db = await loadedTablet();
  await saveVisit(db, draft({ outcome: 1 }), withBulletin(OLD));
  const first = await mount(db);
  expect(await screen.findByText("Etiquete os tubitos: 3F2A9C1E-01, 3F2A9C1E-02")).toBeTruthy();
  await first.view.unmount();
  expect(screen.queryByText(/Etiquete os tubitos/)).toBeNull();
  await mount(db);
  expect(await screen.findByText("Etiquete os tubitos: 3F2A9C1E-01, 3F2A9C1E-02")).toBeTruthy();
});
