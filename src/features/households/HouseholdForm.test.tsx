import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { Text } from "react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import type { LocationPort } from "../../location/capture";
import type { MapCanvasProps } from "../../map/canvas";
import { AREA, HH, NEIGHBORHOOD, endemicTablet, loadedTablet, stationChanged } from "../testing";
import { scrollIntoView } from "../../ui/reveal";
import { newUuid } from "../../sync/testing";
import { AGENT_CBO_NOT_ALLOWED, ERROR_PHRASES } from "../messages/errorPhrases";
import { HouseholdForm, NO_FIX_MARK_ON_MAP, READ_ONLY } from "./HouseholdForm";
import { AGENT_HAS_RESIDENT, saveHousehold } from "./save";

// The measuring and the scrolling are the device's: here, that each refusal asks to be brought into sight.
jest.mock("../../ui/reveal", () => ({ ...jest.requireActual<typeof import("../../ui/reveal")>("../../ui/reveal"), scrollIntoView: jest.fn() }));
const revealed = scrollIntoView as jest.MockedFunction<typeof scrollIntoView>;

// A drawing that lets the test touch the map.
function Canvas(props: MapCanvasProps) {
  return <Text onPress={() => props.onPressMap?.({ latitude: -25.4285, longitude: -49.2733, zoom: 18 })}>tocar no mapa</Text>;
}
const map = { Canvas, readHead: async () => new Uint8Array(0) };
const gps = (accuracy: number): LocationPort => ({
  permission: async () => ({ granted: true, precise: true }),
  current: async () => ({ latitude: -25.428471234, longitude: -49.273254112, accuracy }),
});

// Android's Back button: who is listening answers true to keep the press from the navigator.
function backButton() {
  const handlers = new Set<() => boolean>();
  return {
    onPress: (handler: () => boolean) => { handlers.add(handler); return { remove: () => { handlers.delete(handler); } }; },
    press: () => [...handlers].some((handler) => handler()),
  };
}

async function mount(o: { db?: Db; householdKey?: string; location?: LocationPort } = {}) {
  const db = o.db ?? (await loadedTablet());
  if (o.db === undefined) await db.run("INSERT INTO map_file (id, version, sha256, size_bytes, path) VALUES (1, '2026-11-01', ?, 1, 'map/x.pmtiles')", ["ab".repeat(32)]);
  const onSaved = jest.fn();
  const back = backButton();
  await renderWithServices(<HouseholdForm householdKey={o.householdKey} map={map} back={back} onSaved={onSaved} />, fakeServices({ db, ...(o.location ? { location: o.location } : {}) }));
  await screen.findByRole("button", { name: "Salvar" });
  return { db, onSaved, back };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));
const type = (label: string | RegExp, text: string) => fireEvent.changeText(screen.getByLabelText(label), text);
const choose = (key: string, name: string | RegExp) => fireEvent.press(field(key).getByRole("radio", { name }));

// A home at a street of the list of the city, as an agent fills it standing at the gate.
async function fillAddress() {
  await type("CEP", "80010000");
  await type("Buscar em Tipo de logradouro", "rua");
  await choose("street_type", "RUA");
  await type("Logradouro", "das Flores");
  await type("Número", "45");
  await choose("neighborhood_id", "Vila Nova");
}

test("a new home: address, type and living conditions become one household item that the contract accepts", async () => {
  const t = await mount();
  await fillAddress();
  await choose("property_type", "Domicílio");
  await type("Telefone de contato (com DDD)", "(41) 99999-0000");
  await fireEvent.press(field("localizacao").getByRole("radio", { name: /^Urbana/ }));
  await fireEvent.press(field("situacao_moradia_posse_terra").getByRole("radio", { name: /^Próprio/ }));
  await press("Salvar");

  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await outboxRepo.all(t.db);
  expect(item.type).toBe("household");
  expect(t.onSaved).toHaveBeenCalledWith(item.target_id);
  expect(item.body).toEqual({
    micro_area_id: AREA, property_type: "1", refused: false, contact_phone: "41999990000",
    address: { zip: "80010000", street_type: "081", street: "das Flores", number: "45", no_number: false, complement: null, neighborhood_id: NEIGHBORHOOD, district: null, reference: null },
    living_conditions: { localizacao: 83, situacao_moradia_posse_terra: 75 },
  });
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
});

test("what the api would refuse is refused on screen, under its field, and nothing is saved", async () => {
  const t = await mount();
  await choose("property_type", "Domicílio");
  await press("Salvar");
  expect(await field("zip").findByText("CEP com 8 dígitos")).toBeTruthy();
  await fillAddress();
  await type("Logradouro", "Rua das Flores");
  await press("Salvar");
  expect(await field("street").findByText("o nome do logradouro não repete o tipo (RUA)")).toBeTruthy();
  await type("Logradouro", "das Flores");
  // Living conditions begun must be whole: a home's ask for the kind of tenure.
  await fireEvent.press(field("localizacao").getByRole("radio", { name: /^Urbana/ }));
  await press("Salvar");
  expect(await field("situacao_moradia_posse_terra").findByText("informe a situação de moradia")).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});

// The CEP is at the top and the button at the end of a long form: without this the person presses Salvar and sees nothing.
test("each refusal is brought into sight: under its own field and in the living conditions, and again when saved without fixing", async () => {
  await mount();
  revealed.mockClear();
  await choose("property_type", "Domicílio");
  await press("Salvar");
  expect(await field("zip").findByText("CEP com 8 dígitos")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(1);
  await press("Salvar");
  expect(revealed).toHaveBeenCalledTimes(2);

  await fillAddress();
  await fireEvent.press(field("localizacao").getByRole("radio", { name: /^Urbana/ }));
  revealed.mockClear();
  await press("Salvar");
  expect(await field("situacao_moradia_posse_terra").findByText("informe a situação de moradia")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(1);
});

test("a shop has no living conditions: the questions are not there and the item carries none", async () => {
  const t = await mount();
  await choose("property_type", "Domicílio");
  expect(screen.getByTestId("field-localizacao")).toBeTruthy();
  await fireEvent.press(field("localizacao").getByRole("radio", { name: /^Urbana/ }));
  await choose("property_type", "Comércio");
  expect(screen.queryByTestId("field-localizacao")).toBeNull();
  await fillAddress();
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect([item.body.property_type, item.body.living_conditions]).toEqual(["2", {}]);
});

test("the point by the GPS: a precise reading goes in the item; a bad one is never used", async () => {
  const t = await mount({ location: gps(8.46) });
  await fillAddress();
  await choose("property_type", "Comércio");
  await press("Usar o GPS aqui na frente");
  expect(await screen.findByText("Ponto marcado pelo GPS (precisão de 8,5 m)")).toBeTruthy();
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body.location).toEqual({ latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" });
});

test("no precise position: the screen says to mark on the map, and the map gives the point", async () => {
  const t = await mount({ location: gps(120) });
  await fillAddress();
  await choose("property_type", "Comércio");
  await press("Usar o GPS aqui na frente");
  expect(await screen.findByText(NO_FIX_MARK_ON_MAP)).toBeTruthy();
  expect(NO_FIX_MARK_ON_MAP).toBe("Sem posição precisa. Marque no mapa.");

  await press("Marcar no mapa");
  expect(await screen.findByRole("header", { name: "Marcar o ponto do imóvel" })).toBeTruthy();
  await fireEvent.press(await screen.findByText("tocar no mapa"));
  await press("Usar este ponto");
  // Back in the form, with everything that was typed.
  expect(await screen.findByText("Ponto marcado no mapa")).toBeTruthy();
  expect(screen.getByLabelText("Logradouro").props.value).toBe("das Flores");
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body.location).toMatchObject({ latitude: -25.4285, longitude: -49.2733, source: "map" });
  expect(JSON.stringify(item.body.location)).toMatch(/"accuracy_m":\d/);
});

// The map is opened from the end of the form. Were the form taken off the screen for it, it would come back at its top,
// with the point just marked and the Salvar button several screens below.
test("the form stays where it was under the map: there, out of sight and out of reach, and back when the map closes", async () => {
  await mount();
  await fillAddress();
  await press("Marcar no mapa");
  expect(await screen.findByRole("header", { name: "Marcar o ponto do imóvel" })).toBeTruthy();
  // Not on the screen for whoever sees or touches it…
  expect(screen.queryByLabelText("Logradouro")).toBeNull();
  expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
  // …and still there, with what was typed.
  expect(screen.getByLabelText("Logradouro", { includeHiddenElements: true }).props.value).toBe("das Flores");

  await fireEvent.press(await screen.findByText("tocar no mapa"));
  await press("Usar este ponto");
  expect(await screen.findByText("Ponto marcado no mapa")).toBeTruthy();
  expect(screen.getByLabelText("Logradouro").props.value).toBe("das Flores");
  expect(screen.queryByRole("header", { name: "Marcar o ponto do imóvel" })).toBeNull();
});

// A marked point adds "Tirar o ponto" above the button: on a tablet that pushes Salvar under the taskbar, and saving is
// what the person does next.
test("marking the point, on the map or by the GPS, brings the Salvar button into sight; taking the point off does not", async () => {
  await mount({ location: gps(8.5) });
  await fillAddress();
  revealed.mockClear();
  await press("Marcar no mapa");
  await fireEvent.press(await screen.findByText("tocar no mapa"));
  await press("Usar este ponto");
  expect(await screen.findByText("Ponto marcado no mapa")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(1);
  expect(revealed.mock.calls[0][1]).not.toBeNull();

  await press("Tirar o ponto");
  expect(revealed).toHaveBeenCalledTimes(1);

  await press("Usar o GPS aqui na frente");
  expect(await screen.findByText("Ponto marcado pelo GPS (precisão de 8,5 m)")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(2);
});

test("Back with the map open closes the map only: the form is there with what was typed, and Back then belongs to the navigator", async () => {
  const t = await mount();
  await fillAddress();
  // On the form nobody holds the press: the navigator leaves the screen, as everywhere else.
  expect(t.back.press()).toBe(false);

  await press("Marcar no mapa");
  expect(await screen.findByRole("header", { name: "Marcar o ponto do imóvel" })).toBeTruthy();
  await fireEvent.press(await screen.findByText("tocar no mapa"));
  let held = false;
  await act(async () => { held = t.back.press(); });
  expect(held).toBe(true);

  expect(await screen.findByRole("button", { name: "Salvar" })).toBeTruthy();
  expect(screen.getByLabelText("Logradouro").props.value).toBe("das Flores");
  // The point touched and not confirmed is not the household's.
  expect(screen.queryByText("Ponto marcado no mapa")).toBeNull();
  expect(t.back.press()).toBe(false);
});

test("editing: the form opens with what the household has; untouched, the point is not in the item; taken off, it goes as null", async () => {
  const db = await loadedTablet();
  // From field-sync-v1.3.0 the example's street type is the code the api stores ("081"): the form opens with it chosen.
  const t = await mount({ db, householdKey: HH });
  expect(screen.getByLabelText("CEP").props.value).toBe("80010000");
  expect(screen.getByLabelText("Logradouro").props.value).toBe("das Flores");
  expect(screen.getByLabelText("Telefone de contato (com DDD)").props.value).toBe("41999990000");
  expect(screen.getByText("Ponto marcado pelo GPS (precisão de 8,5 m)")).toBeTruthy();
  await type("Bairro (se não está na lista)", "Centro");
  await fireEvent.press(field("localizacao").getByRole("radio", { name: /^Urbana/ }));
  await fireEvent.press(field("situacao_moradia_posse_terra").getByRole("radio", { name: /^Próprio/ }));
  await type("Telefone de contato (com DDD)", "41988887777");
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalledWith(HH));
  let [item] = await outboxRepo.all(db);
  expect(item.body).toMatchObject({ household_id: HH, contact_phone: "41988887777" });
  expect("location" in item.body).toBe(false);
  expect(item.target_id).toBe(HH);

  await press("Tirar o ponto");
  expect(await screen.findByText("Sem ponto no mapa")).toBeTruthy();
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(2));
  [item] = await outboxRepo.all(db);
  expect(item.body.location).toBeNull();
});

test("a round that downloads a newer version while the form is open does not make the tablet overwrite it: the item says what the person saw", async () => {
  const db = await loadedTablet();
  const t = await mount({ db, householdKey: HH });
  // The station changes the phone and a round brings version 4 while the agent is still typing.
  await stationChanged(db, "household", HH, { contact_phone: "4130000000" });
  await type("Complemento", "fundos");
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(db);
  // Sent on version 3: the server answers stale_version and the merge keeps the station's phone.
  expect(item.edit_base_version).toBe(3);
  expect((item.edit_base_body as { contact_phone: string }).contact_phone).toBe("41999990000");
});

test("who is not the community health agent, or a city with the registry off, only reads", async () => {
  const session = example<SessionResponse>("session-acs.json");
  for (const over of [{ professional: { ...session.professional, cbo: "322255" } }, { features: { ...session.features, territory_registry: false } }]) {
    const db = await loadedTablet({ session: over });
    const view = await renderWithServices(<HouseholdForm householdKey={HH} map={map} back={backButton()} onSaved={jest.fn()} />, fakeServices({ db }));
    expect(await screen.findByText(READ_ONLY)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(screen.queryByLabelText("CEP")).toBeNull();
    await view.unmount();
  }
});

// ── Q13(1): the endemic agent registers the non-residential properties of the micro-areas assigned to him ──
const AGENT_AREA = "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e";

test("agent sees only the seven non-residential types and no living conditions", async () => {
  const t = await mount({ db: await endemicTablet() });
  expect(field("property_type").getAllByRole("radio")).toHaveLength(7);
  for (const name of ["Comércio", "Terreno baldio", /^Ponto Estratégico/, "Escola", "Creche", "Estabelecimento religioso", "CASAI"]) {
    expect(field("property_type").getByRole("radio", { name })).toBeTruthy();
  }
  expect(field("property_type").queryByRole("radio", { name: "Domicílio" })).toBeNull();
  expect(field("property_type").queryByRole("radio", { name: "Abrigo" })).toBeNull();
  expect(field("property_type").queryByRole("radio", { name: "Outros" })).toBeNull();

  await choose("property_type", /^Ponto Estratégico/);
  expect(screen.queryByText("Condições de moradia")).toBeNull();
  expect(screen.queryByTestId("field-localizacao")).toBeNull();
  await fillAddress();
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
  const [item] = await outboxRepo.all(t.db);
  // The micro-area is the one of his session, chosen for him when it is the only one.
  expect([item.type, item.body.property_type, item.body.micro_area_id, item.body.living_conditions]).toEqual(["household", "4", AGENT_AREA, {}]);
  expectValid("upload-request", { items: [{ client_uuid: item.client_uuid, type: item.type, body: item.body }] });
});

test("agent opens a residential household read-only", async () => {
  const db = await endemicTablet();
  await renderWithServices(<HouseholdForm householdKey={HH} map={map} back={backButton()} onSaved={jest.fn()} />, fakeServices({ db }));
  expect(await screen.findByText(READ_ONLY)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
  expect(screen.queryByLabelText("CEP")).toBeNull();
});

// The agent's session with HH's area (03) assigned to him too.
function agentWithHomeArea(): Partial<SessionResponse> {
  const session = example<SessionResponse>("session-endemic-agent.json");
  const [team] = session.teams;
  return { teams: [{ ...team, micro_areas: [...team.micro_areas, { ...team.micro_areas[0], id: AREA, code: "03", name: "Vila Nova" }] }] };
}
const NOW = Date.parse("2026-11-14T15:00:00Z");
const shop = { micro_area_id: AGENT_AREA, property_type: "4", refused: false, contact_phone: null, living_conditions: {},
  address: { zip: "80010000", street_type: "081", street: "das Flores", number: "45", no_number: false, complement: null, neighborhood_id: NEIGHBORHOOD, district: null, reference: null } };

test("agent edits his own non-residential property through the form: the seven types, his type chosen, the same item", async () => {
  const db = await endemicTablet();
  const point = await saveHousehold(db, { fields: shop as never }, { newUuid, now: () => NOW });
  const t = await mount({ db, householdKey: point.key });
  expect(field("property_type").getAllByRole("radio")).toHaveLength(7);
  expect(field("property_type").getByRole("radio", { name: /^Ponto Estratégico/ }).props.accessibilityState).toMatchObject({ checked: true });
  await type("Telefone de contato (com DDD)", "41988887777");
  await press("Salvar");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalledWith(point.key));
  const items = await outboxRepo.all(db);
  expect(items).toHaveLength(1);
  expect([items[0].client_uuid, items[0].body.property_type, items[0].body.contact_phone]).toEqual([point.clientUuid, "4", "41988887777"]);
});

test("agent: a download that turns the property residential while the form is open is refused under the type", async () => {
  const db = await endemicTablet({ session: agentWithHomeArea(), household: { property_type: "2", living_conditions: {}, families: [] } });
  await db.run("DELETE FROM registrations"); // no resident: the type is what refuses
  await mount({ db, householdKey: HH });
  await stationChanged(db, "household", HH, { property_type: "1", families: [] });
  await press("Salvar");
  expect(await field("property_type").findByText(AGENT_CBO_NOT_ALLOWED)).toBeTruthy();
  expect(await outboxRepo.all(db)).toEqual([]);
});

test("agent: his draft in a micro area that is no longer his is refused under Microárea (out_of_scope)", async () => {
  const db = await endemicTablet();
  const point = await saveHousehold(db, { fields: shop as never }, { newUuid, now: () => NOW });
  const [creation] = await outboxRepo.all(db);
  const session = example<SessionResponse>("session-endemic-agent.json");
  const [team] = session.teams;
  await db.run("UPDATE session SET body = ? WHERE id = 1", [JSON.stringify({ ...session, teams: [{ ...team, micro_areas: [{ ...team.micro_areas[0], id: "9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0", code: "08" }] }] })]);
  await mount({ db, householdKey: point.key });
  await type("Complemento", "fundos");
  await press("Salvar");
  expect(await field("micro_area_id").findByText(ERROR_PHRASES.out_of_scope)).toBeTruthy();
  expect(await outboxRepo.all(db)).toEqual([creation]);
});

// "Corrigir" in "precisa de atenção" opens the form without the household's screen: the save guards it too (review M2).
test("agent: saving a non-residential property with an active resident says the dashboard's phrase and enqueues nothing", async () => {
  const db = await endemicTablet({ session: agentWithHomeArea(), household: { property_type: "2", living_conditions: {}, families: [] } });
  const t = await mount({ db, householdKey: HH });
  await press("Salvar");
  expect(await screen.findByText(AGENT_HAS_RESIDENT)).toBeTruthy();
  expect(await outboxRepo.all(db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});
