import { fireEvent, screen } from "@testing-library/react-native";
import { SyncContext } from "../../app/sync";
import { fakeServices, renderWithServices } from "../../app/testing";
import { createTestDb } from "../../db/testing/sqljsDb";
import { phraseFor } from "../messages/errorPhrases";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { SuspendedScreen } from "./SuspendedScreen";

test("access suspended: the phrase, how many records are kept, and the two ways out", async () => {
  const db = await createTestDb();
  await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  const run = jest.fn();
  const onScanNew = jest.fn();
  await renderWithServices(
    <SyncContext.Provider value={{ running: false, lastOutcome: { kind: "suspended" }, run }}><SuspendedScreen onScanNew={onScanNew} /></SyncContext.Provider>,
    fakeServices({ db }));
  expect(screen.getByText(phraseFor("device_suspended"))).toBeTruthy();
  expect(await screen.findByText("Há 2 registros guardados neste tablet. Eles serão enviados quando o acesso voltar.")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Ler QR novo" }));
  await fireEvent.press(screen.getByRole("button", { name: "Tentar de novo" }));
  expect([onScanNew.mock.calls.length, run.mock.calls.length]).toEqual([1, 1]);
});

test("with nothing kept the count is not shown; one record is singular", async () => {
  const db = await createTestDb();
  const view = await renderWithServices(<SuspendedScreen onScanNew={jest.fn()} />, fakeServices({ db }));
  expect(screen.queryByText(/guardados? neste tablet/)).toBeNull();
  view.unmount();
  await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  await renderWithServices(<SuspendedScreen onScanNew={jest.fn()} />, fakeServices({ db }));
  expect(await screen.findByText("Há 1 registro guardado neste tablet. Ele será enviado quando o acesso voltar.")).toBeTruthy();
});
