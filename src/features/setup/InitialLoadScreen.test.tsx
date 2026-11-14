import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { SyncContext, type SyncState } from "../../app/sync";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { territoryRepo } from "../../db/repos/territoryRepo";
import { createTestDb } from "../../db/testing/sqljsDb";
import type { Db } from "../../db/types";
import { applyPage } from "../../sync/download";
import { InitialLoadScreen } from "./InitialLoadScreen";

async function mount(db: Db, sync: Partial<SyncState> = {}) {
  const state: SyncState = { running: false, lastOutcome: null, run: jest.fn(), ...sync };
  const onDone = jest.fn();
  await renderWithServices(<SyncContext.Provider value={state}><InitialLoadScreen onDone={onDone} /></SyncContext.Provider>, fakeServices({ db }));
  return { state, onDone };
}

test("while the first load runs it shows what already arrived", async () => {
  const db = await createTestDb();
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await mount(db, { running: true });
  expect(await screen.findByText("Baixando o território: 1 domicílio e 1 cadastro até agora.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continuar" })).toBeNull();
});

test("without wifi it explains and offers mobile data, which is remembered and starts the load", async () => {
  const db = await createTestDb();
  const t = await mount(db, { lastOutcome: { kind: "skipped", reason: "needs_wifi" } });
  expect(await screen.findByText("A primeira carga é grande e espera o Wi-Fi.")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Usar dados móveis agora" }));
  await waitFor(async () => expect(await territoryRepo.getMeta(db, "mobile_data")).toBe("1"));
  await waitFor(() => expect(t.state.run).toHaveBeenCalledTimes(1));
});

test("a load that stopped can be tried again", async () => {
  const db = await createTestDb();
  const t = await mount(db, { lastOutcome: { kind: "stopped", reason: "network" } });
  expect(await screen.findByText("Sem conexão: nada foi perdido. O tablet tenta de novo sozinho.")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Tentar de novo" }));
  expect(t.state.run).toHaveBeenCalledTimes(1);
});

test("when the load is complete it says so and lets the person go on", async () => {
  const db = await createTestDb();
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await territoryRepo.setMeta(db, "last_download_ok_at", "2026-11-14T15:00:00.000Z");
  const t = await mount(db);
  expect(await screen.findByText("Carga concluída: 1 domicílio e 1 cadastro neste tablet.")).toBeTruthy();
  expect(screen.getByText("Mapa ainda não baixado")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Continuar" }));
  expect(t.onDone).toHaveBeenCalledTimes(1);
});
