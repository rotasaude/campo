import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { SyncContext } from "../../app/sync";
import { fakeServices, renderWithServices } from "../../app/testing";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { applyResults } from "../../sync/dispatch";
import { ITEM_STATE_LABEL } from "../outbox/OutboxScreen";
import { newUuid, rejected } from "../../sync/testing";
import { AttentionScreen } from "../attention/AttentionScreen";
import { pathLabel } from "../conflicts/fieldText";
import { HomeScreen } from "../home/HomeScreen";
import { HouseholdScreen } from "../households/HouseholdScreen";
import { HH, endemicTablet, loadedTablet } from "../testing";
import { CollectForm, LOST_ON_REMOVE, REINSTALL_NOTE } from "./CollectForm";
import { InstallForm, NOT_FOR_YOU, TCLE_LABEL } from "./InstallForm";
import { OvitrapList } from "./OvitrapList";
import { collectOvitrap, installOvitrap } from "./save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const OV = "c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f";
const U1 = "c0ffee64-0000-4000-8000-000000000064";
const NO_PROFILE = { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: null, last_situation: null };
const services = (db: Db) => fakeServices({ db, now: () => NOW });
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const items = (db: Db) => outboxRepo.all(db);

async function household(db: Db) {
  const nav = { onEdit: jest.fn(), onNewFamily: jest.fn(), onEditFamily: jest.fn(), onNewResident: jest.fn(), onStartVisit: jest.fn(), onOpenResident: jest.fn(), onInstallOvitrap: jest.fn(), onStartPropertyVisit: jest.fn(), onNewAnimal: jest.fn(), onEditAnimal: jest.fn(), onVaccinateAnimal: jest.fn(), onCollarAnimal: jest.fn() };
  const view = await renderWithServices(<HouseholdScreen householdKey={HH} {...nav} />, services(db));
  await screen.findByText(/Microárea/);
  return { ...nav, unmount: () => view.unmount() };
}
async function home(db: Db) {
  const nav = { onOpenWho: jest.fn(), onOpenToday: jest.fn(), onOpenDue: jest.fn(), onOpenOvitraps: jest.fn(), onNewActivity: jest.fn(), onOpenHouseholds: jest.fn(), onOpenMap: jest.fn(), onOpenOutbox: jest.fn(), onOpenAbout: jest.fn() };
  const state = { running: false, lastOutcome: null, run: jest.fn() } as never;
  const view = await renderWithServices(<SyncContext.Provider value={state}><HomeScreen {...nav} /></SyncContext.Provider>, services(db));
  await screen.findByText(/Pendentes de envio/);
  return { ...nav, unmount: () => view.unmount() };
}

test("ACS sees no ovitrap button", async () => {
  const db = await loadedTablet();
  const view = await household(db);
  expect(screen.queryByRole("button", { name: "Instalar ovitrampa" })).toBeNull();
  await view.unmount();
  await home(db);
  expect(screen.queryByRole("button", { name: "Ovitrampas" })).toBeNull();
});

test("the endemic agent: \"Ovitrampas\" on the home and \"Instalar ovitrampa\" on the household", async () => {
  const db = await endemicTablet();
  const nav = await household(db);
  await press("Instalar ovitrampa");
  expect(nav.onInstallOvitrap).toHaveBeenCalledTimes(1);
  await nav.unmount();
  const homeNav = await home(db);
  await press("Ovitrampas");
  expect(homeNav.onOpenOvitraps).toHaveBeenCalledTimes(1);
});

test("without a block the household says why and the button is off", async () => {
  const nav = await household(await endemicTablet({ household: { vector: NO_PROFILE } }));
  expect(screen.getByText(VECTOR_ERRORS.household_without_block)).toBeTruthy();
  await press("Instalar ovitrampa");
  expect(nav.onInstallOvitrap).not.toHaveBeenCalled();
});

// Review M4: the api installs only in an active household (not_found on household_id otherwise).
test("an inactive household offers no \"Instalar ovitrampa\"", async () => {
  await household(await endemicTablet({ household: { status: "inactive" } }));
  expect(screen.queryByRole("button", { name: "Instalar ovitrampa" })).toBeNull();
  expect(screen.queryByText(VECTOR_ERRORS.household_without_block)).toBeNull();
});

describe("InstallForm", () => {
  async function form(db: Db) {
    const onSaved = jest.fn();
    await renderWithServices(<InstallForm householdKey={HH} onSaved={onSaved} />, services(db));
    await screen.findByLabelText("Número");
    return onSaved;
  }

  test("number and TCLE: the item and the local row, installed today", async () => {
    const db = await endemicTablet();
    const onSaved = await form(db);
    expect(screen.getByText("Rua das Flores, 120")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Número"), "OVT-015");
    await fireEvent.press(screen.getByRole("checkbox", { name: TCLE_LABEL }));
    await press("Instalar");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [item] = await items(db);
    expect([item.type, item.body]).toEqual(["ovitrap_installation", { household_id: HH, number: "OVT-015", consent: true, installed_on: "2026-11-14" }]);
  });

  test("refused before saving: the shape, the consent, a number the tablet knows (any case)", async () => {
    const db = await endemicTablet();
    const onSaved = await form(db);
    await fireEvent.changeText(screen.getByLabelText("Número"), "OV 15");
    await press("Instalar");
    expect(await within(screen.getByTestId("field-number")).findByText("número da ovitrampa: de 1 a 12 letras, dígitos ou hífen, sem espaço")).toBeTruthy();
    expect(within(screen.getByTestId("field-consent")).getByText(VECTOR_ERRORS.consent_required)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Número"), "ovt-014");
    await fireEvent.press(screen.getByRole("checkbox", { name: TCLE_LABEL }));
    await press("Instalar");
    expect(await within(screen.getByTestId("field-number")).findByText(VECTOR_ERRORS.ovitrap_number_taken)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(await items(db)).toEqual([]);
  });

  test("without a block: the phrase and no installation", async () => {
    const db = await endemicTablet({ household: { vector: NO_PROFILE } });
    const onSaved = await form(db);
    expect(screen.getByText(VECTOR_ERRORS.household_without_block)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Número"), "OVT-015");
    await fireEvent.press(screen.getByRole("checkbox", { name: TCLE_LABEL }));
    await press("Instalar");
    expect(onSaved).not.toHaveBeenCalled();
    expect(await items(db)).toEqual([]);
  });
});

describe("OvitrapList and CollectForm", () => {
  test("the list: number, household, the paddle's window and \"Coletar palheta\"; never a resident", async () => {
    const db = await endemicTablet();
    const onCollect = jest.fn();
    await renderWithServices(<OvitrapList onCollect={onCollect} />, services(db));
    const card = within(await screen.findByTestId(`ovitrap-${OV}`));
    expect(card.getByText("Ovitrampa OVT-014")).toBeTruthy();
    expect(card.getByText("Rua das Flores, 120")).toBeTruthy();
    expect(card.getByText("palheta desde 12/11/2026 — colete entre 15/11 e 22/11 (ideal 17/11)")).toBeTruthy();
    expect(screen.queryByText(/Joana/)).toBeNull();
    expect(screen.queryByText(/ovos/)).toBeNull();
    await fireEvent.press(card.getByRole("button", { name: "Coletar palheta" }));
    expect(onCollect).toHaveBeenCalledWith(OV);
  });

  async function collect(db: Db, key: string) {
    const onSaved = jest.fn();
    await renderWithServices(<CollectForm ovitrapKey={key} onSaved={onSaved} />, services(db));
    await screen.findByText(/Coletar palheta — ovitrampa/);
    return onSaved;
  }

  test("collect with reinstall: the condition, the note, the item", async () => {
    const db = await endemicTablet();
    await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-08" });
    const onSaved = await collect(db, U1);
    expect(screen.getByText(REINSTALL_NOTE)).toBeTruthy();
    await fireEvent.press(screen.getByRole("radio", { name: "avariada" }));
    await press("Registrar coleta");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const collection = (await items(db))[1];
    expect(collection.body).toEqual({ ovitrap_client_uuid: U1, collected_on: "2026-11-14", condition: "damaged", reinstall: true, remove: false });
  });

  test("remove, lost: the ovitrap leaves as lost", async () => {
    const db = await endemicTablet();
    await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-08" });
    const onSaved = await collect(db, U1);
    await fireEvent.press(screen.getByRole("checkbox", { name: "Retirar a ovitrampa" }));
    await fireEvent.press(screen.getByRole("radio", { name: "perdida" }));
    expect(screen.getByText(LOST_ON_REMOVE)).toBeTruthy();
    await press("Registrar coleta");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect((await items(db))[1].body).toMatchObject({ condition: "lost", reinstall: false, remove: true });
  });

  test("out of the paddle's window: refused before saving with the phrase under the date", async () => {
    const db = await endemicTablet();
    // OVT-014's paddle opened on 2026-11-12: two days.
    const onSaved = await collect(db, OV);
    await fireEvent.press(screen.getByRole("radio", { name: "em bom estado" }));
    await press("Registrar coleta");
    expect(await within(screen.getByTestId("field-collected_on")).findByText(VECTOR_ERRORS.collection_out_of_range)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(await items(db)).toEqual([]);
  });
});

describe("precisa de atenção", () => {
  async function attention(db: Db, seq: number) {
    const onDone = jest.fn();
    await renderWithServices(<AttentionScreen seq={seq} onFix={jest.fn()} onOpenRegistration={jest.fn()} onDone={onDone} />, services(db));
    await screen.findByText(/Campo:/);
    return onDone;
  }

  test("'Corrigir número' resends the same client_uuid with the new number", async () => {
    const db = await endemicTablet();
    await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-14" });
    const [item] = await items(db);
    await applyResults(db, [item], [rejected(item, "ovitrap_number_taken", { path: "number" })], { onStale: async () => undefined });
    const onDone = await attention(db, item.seq);
    expect(screen.getByText(VECTOR_ERRORS.ovitrap_number_taken)).toBeTruthy();
    expect(screen.getByText("Campo: Número")).toBeTruthy();
    // A number the tablet knows is refused here.
    await fireEvent.changeText(screen.getByLabelText("Número"), "OVT-014");
    await press("Reenviar");
    expect(await screen.findAllByText(VECTOR_ERRORS.ovitrap_number_taken)).toHaveLength(2);
    await fireEvent.changeText(screen.getByLabelText("Número"), "OVT-016");
    await press("Reenviar");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [again] = await items(db);
    expect([again.client_uuid, again.state, again.body.number]).toEqual([U1, "pending", "OVT-016"]);
    expect((await db.get<{ number: string }>("SELECT number FROM ovitraps WHERE key = ?", [U1]))?.number).toBe("OVT-016");
  });

  test.each([["household_without_block", "household_id"], ["consent_required", "consent"], ["ovitrap_number_taken", "number"], ["reading_not_open", "ovitrap_id"], ["ovitrap_not_active", "ovitrap_id"], ["collection_out_of_range", "collected_on"]] as const)(
    "server refusal %s at %s shows its phrase and the field in words (Q13(2))", async (code, path) => {
      const db = await endemicTablet();
      const installation = ["household_without_block", "consent_required", "ovitrap_number_taken"].includes(code);
      if (installation) await installOvitrap(db, { householdKey: HH, number: "OVT-015", clientUuid: U1, today: "2026-11-14" });
      else await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: false, today: "2026-11-14", newUuid });
      const [item] = await items(db);
      await applyResults(db, [item], [rejected(item, code, { path })], { onStale: async () => undefined });
      await attention(db, item.seq);
      expect(screen.getByText(VECTOR_ERRORS[code])).toBeTruthy();
      const label = { household_id: "Imóvel", consent: "Termo (TCLE)", number: "Número", ovitrap_id: "Ovitrampa", collected_on: "Data da coleta" }[path];
      expect(pathLabel(item.type, path)).toBe(label);
      expect(screen.getByText(`Campo: ${label}`)).toBeTruthy();
    });
});

// Review M3 and M5(c): the list checks access as the forms do; the agent with the switch off gets nothing.
describe("access", () => {
  const OFF = { features: { home_visits: true, collective_activities: false, territory_registry: true, vector_control: false } };
  async function list(db: Db) {
    await renderWithServices(<OvitrapList onCollect={jest.fn()} />, services(db));
  }

  test("the ACS opening the list by a link gets the screen's phrase and no ovitrap", async () => {
    await list(await loadedTablet());
    expect(await screen.findByText(NOT_FOR_YOU)).toBeTruthy();
    expect(screen.queryByText(/Ovitrampa /)).toBeNull();
  });

  test("the endemic agent with the switch off: no button on the household or the home, and the list refuses", async () => {
    const db = await endemicTablet({ session: OFF });
    const view = await household(db);
    expect(screen.queryByRole("button", { name: "Instalar ovitrampa" })).toBeNull();
    await view.unmount();
    const homeView = await home(db);
    expect(screen.queryByRole("button", { name: "Ovitrampas" })).toBeNull();
    await homeView.unmount();
    await list(db);
    expect(await screen.findByText(NOT_FOR_YOU)).toBeTruthy();
    expect(screen.queryByText("Ovitrampa OVT-014")).toBeNull();
  });
});

// Review M2: an ovitrap waiting for the person says so and offers no collection.
test("a refused collection: the card says it needs attention and offers no collection", async () => {
  const db = await endemicTablet();
  await collectOvitrap(db, { ovitrapKey: OV, condition: "ok", remove: false, today: "2026-11-16", newUuid });
  const [item] = await items(db);
  await applyResults(db, [item], [rejected(item, "collection_out_of_range", { path: "collected_on" })], { onStale: async () => undefined });
  await renderWithServices(<OvitrapList onCollect={jest.fn()} />, services(db));
  const card = within(await screen.findByTestId(`ovitrap-${OV}`));
  expect(card.getByText(ITEM_STATE_LABEL.needs_attention)).toBeTruthy();
  expect(card.queryByText("Aguardando envio")).toBeNull();
  expect(card.queryByRole("button", { name: "Coletar palheta" })).toBeNull();
});
