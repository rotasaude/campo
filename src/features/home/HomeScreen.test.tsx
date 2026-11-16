import { fireEvent, screen } from "@testing-library/react-native";
import { SyncContext, type SyncState } from "../../app/sync";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { createTestDb } from "../../db/testing/sqljsDb";
import type { Db } from "../../db/types";
import { enqueue } from "../../sync/outbox";
import { APP_UPDATE_NOTICE } from "../../sync/reference";
import { newUuid } from "../../sync/testing";
import { HomeScreen } from "./HomeScreen";

const SESSION = example<SessionResponse>("session-acs.json");
const NOW = Date.parse("2026-11-14T15:00:00Z");

async function seeded(session: SessionResponse = SESSION): Promise<Db> {
  const db = await createTestDb();
  await db.run("INSERT INTO session (id, body, fetched_at) VALUES (1, ?, 't')", [JSON.stringify(session)]);
  await db.run("INSERT INTO meta (key, value) VALUES ('city_offset_min', '-180'), ('last_download_ok_at', '2026-10-18T15:00:00.000Z')");
  await db.run("INSERT INTO who_to_visit (micro_area_id, people, generated_at) VALUES ('ma', ?, 't')", [JSON.stringify([{}, {}, {}])]);
  const attention = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  await outboxRepo.update(db, attention.seq, { state: "needs_attention", error: "invalid_home_visit" });
  await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  return db;
}
async function mount(db: Db, sync: Partial<SyncState> = {}) {
  const state: SyncState = { running: false, lastOutcome: null, run: jest.fn(), ...sync };
  const nav = { onOpenWho: jest.fn(), onOpenToday: jest.fn(), onNewActivity: jest.fn(), onOpenHouseholds: jest.fn(), onOpenMap: jest.fn(), onOpenOutbox: jest.fn(), onOpenAbout: jest.fn() };
  await renderWithServices(<SyncContext.Provider value={state}><HomeScreen {...nav} /></SyncContext.Provider>, fakeServices({ db, now: () => NOW }));
  return { state, nav };
}

test("home shows counters, last sync and the day-25 warning", async () => {
  await mount(await seeded());
  expect(await screen.findByText("A visitar: 3")).toBeTruthy();
  expect(screen.getByText("Pendentes de envio: 1")).toBeTruthy();
  expect(screen.getByText("Precisam de atenção: 1")).toBeTruthy();
  expect(screen.getByText("Conflitos: 0")).toBeTruthy();
  expect(screen.getByText("Última sincronização: 18/10/2026 12:00")).toBeTruthy();
  expect(screen.getByText("Sincronize até 17/11/2026: depois disso o território some do tablet")).toBeTruthy();
  for (const area of SESSION.teams[0].micro_areas) expect(screen.getByText(`${area.code} · ${area.name}`)).toBeTruthy();
});

test("the Sync button starts a round; while one runs it says so and cannot be pressed again", async () => {
  const idle = await mount(await seeded());
  await fireEvent.press(await screen.findByRole("button", { name: "Sincronizar" }));
  expect(idle.state.run).toHaveBeenCalledTimes(1);
});

test("while a round runs the button is disabled", async () => {
  await mount(await seeded(), { running: true });
  expect(await screen.findByRole("button", { name: "Sincronizando…" })).toBeDisabled();
});

// Q82(3e): each part of the home follows its own switch of the city.
test("home with home_visits off has no way into the visit; households and the map follow the registry", async () => {
  await mount(await seeded({ ...SESSION, features: { ...SESSION.features, home_visits: false, territory_registry: true } }));
  expect(await screen.findByText("Visita desligada pela secretaria")).toBeTruthy();
  expect(screen.getByText("Pendentes de envio: 1")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sincronizar" })).toBeTruthy();
  expect(screen.queryByText(/A visitar/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Quem visitar" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Minhas visitas de hoje" })).toBeNull();
  expect(screen.getByRole("button", { name: "Domicílios" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Mapa" })).toBeTruthy();
});

test("with territory_registry off the home has no way into the households nor the map; the visit stays", async () => {
  await mount(await seeded({ ...SESSION, features: { ...SESSION.features, home_visits: true, territory_registry: false } }));
  expect(await screen.findByRole("button", { name: "Quem visitar" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Minhas visitas de hoje" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Domicílios" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Mapa" })).toBeNull();
});

test("the collective activity is offered only where the city has it on", async () => {
  const on = await mount(await seeded());
  await fireEvent.press(await screen.findByRole("button", { name: "Nova atividade coletiva" }));
  expect(on.nav.onNewActivity).toHaveBeenCalled();
});

test("with collective_activities off the home has no way into the activity", async () => {
  await mount(await seeded({ ...SESSION, features: { ...SESSION.features, collective_activities: false } }));
  await screen.findByRole("button", { name: "Sincronizar" });
  expect(screen.queryByRole("button", { name: "Nova atividade coletiva" })).toBeNull();
});

test("home shows the app update notice while the reference is refused (Q71)", async () => {
  const db = await seeded();
  await mount(db);
  expect(screen.queryByText(APP_UPDATE_NOTICE)).toBeNull();
  await db.run("INSERT INTO meta (key, value) VALUES ('reference_refused_version', 'x')");
  await mount(db);
  expect(await screen.findByText(APP_UPDATE_NOTICE)).toBeTruthy();
});

test("the last round's outcome is said in words when it did not finish", async () => {
  await mount(await seeded(), { lastOutcome: { kind: "stopped", reason: "network" } });
  expect(await screen.findByText("Sem conexão: nada foi perdido. O tablet tenta de novo sozinho.")).toBeTruthy();
});

test("the shortcuts open who to visit, the outbox and about", async () => {
  const t = await mount(await seeded());
  await fireEvent.press(await screen.findByRole("button", { name: "Quem visitar" }));
  await fireEvent.press(screen.getByRole("button", { name: "Ver envios" }));
  await fireEvent.press(screen.getByRole("button", { name: "Sobre" }));
  expect([t.nav.onOpenWho.mock.calls.length, t.nav.onOpenOutbox.mock.calls.length, t.nav.onOpenAbout.mock.calls.length]).toEqual([1, 1, 1]);
});
