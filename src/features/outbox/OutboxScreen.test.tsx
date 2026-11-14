import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { createTestDb } from "../../db/testing/sqljsDb";
import type { Db } from "../../db/types";
import { phraseFor } from "../messages/errorPhrases";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { DISCARD_WARNING, OutboxScreen } from "./OutboxScreen";

async function seeded() {
  const db = await createTestDb();
  const patient = await enqueue(db, { type: "patient", body: { new_patient: { full_name: "Maria das Dores" } } }, newUuid);
  const visit = await enqueue(db, { type: "home_visit", body: {}, deps: [{ client_uuid: patient.client_uuid, kind: "cite" }] }, newUuid);
  const household = await enqueue(db, { type: "household", body: {}, targetId: "hh" }, newUuid);
  const waiting = await enqueue(db, { type: "collective_activity", body: {} }, newUuid);
  await outboxRepo.update(db, patient.seq, { state: "needs_attention", error: "invalid_cpf", path: "new_patient.cpf" });
  await outboxRepo.update(db, visit.seq, { state: "blocked" });
  await outboxRepo.update(db, household.seq, { state: "conflict", conflicts: [{ path: "contact_phone", station: "1", tablet: "2" }] });
  return { db, patient, visit, household, waiting };
}
async function mount(db: Db) {
  const nav = { onFix: jest.fn(), onResolve: jest.fn() };
  await renderWithServices(<OutboxScreen {...nav} />, fakeServices({ db }));
  return nav;
}
const row = (seq: number) => screen.getByTestId(`outbox-item-${seq}`);

test("outbox shows the phrase of needs_attention and allows resend", async () => {
  const t = await seeded();
  await mount(t.db);
  const patient = within(await screen.findByTestId(`outbox-item-${t.patient.seq}`));
  expect(patient.getByText("Pessoa")).toBeTruthy();
  expect(patient.getByText("precisa de atenção")).toBeTruthy();
  expect(patient.getByText(phraseFor("invalid_cpf"))).toBeTruthy();
  await fireEvent.press(patient.getByRole("button", { name: "Reenviar" }));
  await waitFor(async () => expect((await outboxRepo.bySeq(t.db, t.patient.seq))!.state).toBe("pending"));
  // What waited for it goes back to the line too, and the screen follows the database.
  await waitFor(() => expect(within(row(t.visit.seq)).getByText("aguardando envio")).toBeTruthy());
  expect((await outboxRepo.bySeq(t.db, t.patient.seq))!.client_uuid).toBe(t.patient.client_uuid);
});

test("each item says its type and state in words; nothing of the body is shown", async () => {
  const t = await seeded();
  await mount(t.db);
  await screen.findByTestId(`outbox-item-${t.patient.seq}`);
  expect(within(row(t.visit.seq)).getByText("Visita domiciliar")).toBeTruthy();
  expect(within(row(t.visit.seq)).getByText("aguardando outro registro")).toBeTruthy();
  expect(within(row(t.household.seq)).getByText("Domicílio")).toBeTruthy();
  expect(within(row(t.household.seq)).getByText("conflito com o posto")).toBeTruthy();
  expect(within(row(t.waiting.seq)).getByText("Atividade coletiva")).toBeTruthy();
  expect(within(row(t.waiting.seq)).getByText("aguardando envio")).toBeTruthy();
  expect(screen.queryByText(/Maria das Dores/)).toBeNull();
  // Only what the person can act on has buttons.
  expect(within(row(t.waiting.seq)).queryByRole("button")).toBeNull();
});

test("Corrigir opens the item's form and Resolver the conflict", async () => {
  const t = await seeded();
  const nav = await mount(t.db);
  await fireEvent.press(within(await screen.findByTestId(`outbox-item-${t.patient.seq}`)).getByRole("button", { name: "Corrigir" }));
  await fireEvent.press(within(row(t.household.seq)).getByRole("button", { name: "Resolver" }));
  expect(nav.onFix).toHaveBeenCalledWith(t.patient.seq);
  expect(nav.onResolve).toHaveBeenCalledWith(t.household.seq);
});

test("discard asks for confirmation and removes dependents", async () => {
  const t = await seeded();
  await mount(t.db);
  const patient = within(await screen.findByTestId(`outbox-item-${t.patient.seq}`));
  await fireEvent.press(patient.getByRole("button", { name: "Descartar" }));
  expect(DISCARD_WARNING).toBe("Este registro nunca chegou ao Rota Saúde e será apagado");
  expect(patient.getByText(DISCARD_WARNING)).toBeTruthy();
  expect(await outboxRepo.count(t.db)).toBe(4); // nothing happens before the confirmation

  await fireEvent.press(patient.getByRole("button", { name: "Cancelar" }));
  expect(within(row(t.patient.seq)).queryByText(DISCARD_WARNING)).toBeNull();

  await fireEvent.press(within(row(t.patient.seq)).getByRole("button", { name: "Descartar" }));
  await fireEvent.press(within(row(t.patient.seq)).getByRole("button", { name: "Confirmar descarte" }));
  await waitFor(async () => expect((await outboxRepo.all(t.db)).map((i) => i.seq)).toEqual([t.household.seq, t.waiting.seq]));
  await waitFor(() => expect(screen.queryByTestId(`outbox-item-${t.visit.seq}`)).toBeNull());
});

test("only needs_attention and blocked can be discarded", async () => {
  const t = await seeded();
  await mount(t.db);
  await screen.findByTestId(`outbox-item-${t.patient.seq}`);
  expect(within(row(t.visit.seq)).getByRole("button", { name: "Descartar" })).toBeTruthy();
  expect(within(row(t.household.seq)).queryByRole("button", { name: "Descartar" })).toBeNull();
  expect(within(row(t.waiting.seq)).queryByRole("button", { name: "Descartar" })).toBeNull();
});

test("an empty queue says so", async () => {
  await mount(await createTestDb());
  expect(await screen.findByText("Nada para enviar: tudo o que você registrou já está no Rota Saúde.")).toBeTruthy();
});
