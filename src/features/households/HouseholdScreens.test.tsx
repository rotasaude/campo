import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ChangesResponse, HouseholdBody, HouseholdItemBody, SessionResponse, UploadRequest } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { newUuid } from "../../sync/testing";
import { loadDue } from "../vector/dueData";
import { dueVisitParams, type DueVisitParams } from "../vector/DueScreen";
import { vectorStart } from "../visits/routeStart";
import { VisitForm } from "../visits/VisitForm";
import { AREA, HH, LIRAA_ITEM, TRANSMISSION_BLOCK, endemicTablet, loadedTablet } from "../testing";
import { READ_ONLY } from "./HouseholdForm";
import { HouseholdList, NON_RESIDENTIAL_ONLY, NO_HOUSEHOLDS } from "./HouseholdList";
import { AT_THE_DASHBOARD, HouseholdScreen } from "./HouseholdScreen";
import { AGENT_HAS_RESIDENT, saveHousehold } from "./save";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
function exampleFields(over: Partial<HouseholdItemBody> = {}) {
  const { household_id: _id, version: _version, ...body } = example<UploadRequest>("upload-household-location.json").items[0].body as HouseholdItemBody;
  return { ...body, ...over };
}
const nonAcs = (): Partial<SessionResponse> => {
  const session = example<SessionResponse>("session-acs.json");
  return { professional: { ...session.professional, cbo: "322255" } };
};

async function list(db: Db) {
  const nav = { onOpen: jest.fn(), onNew: jest.fn() };
  const view = await renderWithServices(<HouseholdList {...nav} />, fakeServices({ db, now: () => NOW }));
  return { ...nav, unmount: () => view.unmount() };
}
async function detail(db: Db, key = HH) {
  const nav = { onEdit: jest.fn(), onNewFamily: jest.fn(), onEditFamily: jest.fn(), onNewResident: jest.fn(), onStartVisit: jest.fn(), onOpenResident: jest.fn(), onInstallOvitrap: jest.fn(), onStartPropertyVisit: jest.fn<void, [DueVisitParams]>(), onNewAnimal: jest.fn(), onEditAnimal: jest.fn(), onVaccinateAnimal: jest.fn(), onCollarAnimal: jest.fn() };
  const view = await renderWithServices(<HouseholdScreen householdKey={key} {...nav} />, fakeServices({ db, now: () => NOW }));
  return { ...nav, unmount: () => view.unmount() };
}

test("the list: each micro-area's households by street and number, opening one by a touch", async () => {
  const db = await loadedTablet();
  const nav = await list(db);
  expect(await screen.findByText("03 · Vila Nova — rua das Flores")).toBeTruthy();
  const row = within(screen.getByTestId(`household-${HH}`));
  expect(row.getByText("RUA das Flores, 120")).toBeTruthy();
  expect(row.getByText("Domicílio")).toBeTruthy();
  await fireEvent.press(row.getByRole("button", { name: "Abrir RUA das Flores, 120" }));
  expect(nav.onOpen).toHaveBeenCalledWith(HH);
  await fireEvent.press(screen.getByRole("button", { name: "Novo domicílio" }));
  expect(nav.onNew).toHaveBeenCalled();
  expect(screen.queryByText(NON_RESIDENTIAL_ONLY)).toBeNull();
});

test("the list says which households still wait to be sent, and is searched by street or number", async () => {
  const db = await loadedTablet();
  const born = await saveHousehold(db, { fields: exampleFields({ address: { ...exampleFields().address, street: "dos Pinheiros", number: "7" } }) }, { newUuid, now: () => NOW });
  await list(db);
  expect(await within(await screen.findByTestId(`household-${born.key}`)).findByText("Aguardando envio")).toBeTruthy();
  expect(within(screen.getByTestId(`household-${HH}`)).queryByText("Aguardando envio")).toBeNull();

  await fireEvent.changeText(screen.getByLabelText("Buscar por rua ou número"), "pinheir");
  expect(screen.queryByTestId(`household-${HH}`)).toBeNull();
  expect(screen.getByTestId(`household-${born.key}`)).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("Buscar por rua ou número"), "120");
  expect(screen.getByTestId(`household-${HH}`)).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("Buscar por rua ou número"), "zzz");
  expect(screen.getByText(NO_HOUSEHOLDS)).toBeTruthy();
});

test("the household: address, point, family with its responsible, residents, and what the agent can do from here", async () => {
  const db = await loadedTablet();
  const nav = await detail(db);
  expect(await screen.findByRole("header", { name: "RUA das Flores, 120" })).toBeTruthy();
  expect(screen.getByText("Microárea 03 · Domicílio")).toBeTruthy();
  expect(screen.getByText("Ponto marcado pelo GPS (precisão de 8,5 m)")).toBeTruthy();
  expect(screen.getByText("Telefone: 41999990000")).toBeTruthy();
  const family = within(screen.getByTestId(`family-${FAMILY}`));
  expect(family.getByText("Responsável: Joana Conceição")).toBeTruthy();
  expect(family.getByText("3 pessoas")).toBeTruthy();
  const joana = within(screen.getByTestId(`resident-${JOANA}`));
  expect(joana.getByText("Joana Conceição")).toBeTruthy();
  expect(joana.getByText("Responsável pela família")).toBeTruthy();
  expect(screen.getByText(AT_THE_DASHBOARD)).toBeTruthy();
  expect(AT_THE_DASHBOARD).toBe("Mudança, óbito e correção de nome, nascimento ou documento: faça pelo dashboard.");

  await fireEvent.press(screen.getByRole("button", { name: "Editar domicílio" }));
  expect(nav.onEdit).toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Nova família" }));
  expect(nav.onNewFamily).toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Novo morador" }));
  expect(nav.onNewResident).toHaveBeenCalledWith(null);
  await fireEvent.press(family.getByRole("button", { name: "Novo morador nesta família" }));
  expect(nav.onNewResident).toHaveBeenLastCalledWith(FAMILY);
  await fireEvent.press(family.getByRole("button", { name: "Editar família" }));
  expect(nav.onEditFamily).toHaveBeenCalledWith(FAMILY);
  await fireEvent.press(joana.getByRole("button", { name: "Registrar visita" }));
  expect(nav.onStartVisit).toHaveBeenCalledWith({ patient_id: JOANA, household_id: HH, family_id: FAMILY, micro_area_id: AREA });
});

test("what waits in the line is shown as it was typed, and marked", async () => {
  const db = await loadedTablet();
  await saveHousehold(db, { key: HH, fields: exampleFields({ contact_phone: "41988887777" }) }, { newUuid, now: () => NOW });
  await detail(db);
  expect(await screen.findByText("Telefone: 41988887777")).toBeTruthy();
  expect(screen.getByText("Aguardando envio")).toBeTruthy();
  const [item] = await outboxRepo.all(db);
  await outboxRepo.update(db, item.seq, { state: "conflict", conflicts: [{ field: "contact_phone", base: null, tablet: "41988887777", station: "4130000000" }] as never });
  expect(await screen.findByText("Há um conflito a resolver neste domicílio")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Editar domicílio" })).toBeNull();
});

test("a shop takes no family; a household that refused the registration says so", async () => {
  const db = await loadedTablet();
  const shop = await saveHousehold(db, { fields: exampleFields({ property_type: "2", refused: true }) }, { newUuid, now: () => NOW });
  await detail(db, shop.key);
  expect(await screen.findByText("Microárea 03 · Comércio")).toBeTruthy();
  expect(screen.getByText("Cadastro recusado")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Nova família" })).toBeNull();
  expect(screen.getByText("Nenhuma família")).toBeTruthy();
});

test("who is not the community health agent reads the household and can still register a visit", async () => {
  const db = await loadedTablet({ session: nonAcs() });
  await detail(db);
  expect(await screen.findByText(READ_ONLY)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Editar domicílio" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Nova família" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Novo morador" })).toBeNull();
  expect(within(screen.getByTestId(`resident-${JOANA}`)).getByRole("button", { name: "Registrar visita" })).toBeTruthy();
});

// Q83(4): a visit that would never be sent must not be born — with the visit off there is no way into it from here.
test("with the visit turned off by the city no resident of the household offers a visit; the registry stays", async () => {
  const session = example<SessionResponse>("session-acs.json");
  const db = await loadedTablet({ session: { features: { ...session.features, home_visits: false } } });
  await detail(db);
  const joana = within(await screen.findByTestId(`resident-${JOANA}`));
  expect(joana.getByRole("button", { name: "Abrir cadastro" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Registrar visita" })).toBeNull();
  expect(screen.getByRole("button", { name: "Editar domicílio" })).toBeTruthy();
});

test("the visits made there today, by this tablet, are on the household's screen: the hours only", async () => {
  const db = await loadedTablet();
  await db.run(
    "INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES ('11111111-1111-4111-8111-111111111111', '2026-11-14', '2026-11-14T09:00:00-03:00', ?, 'accepted'), ('22222222-2222-4222-8222-222222222222', '2026-11-14', '2026-11-14T11:15:00-03:00', ?, 'pending'), ('33333333-3333-4333-8333-333333333333', '2026-11-13', '2026-11-13T10:00:00-03:00', ?, 'accepted')",
    [JSON.stringify({ household: HH, subject: "none", outcome: 3 }), JSON.stringify({ household: HH, subject: "none", outcome: 1 }), JSON.stringify({ household: HH, subject: "none", outcome: 1 })]);
  await detail(db);
  expect(await screen.findByText("Visitas de hoje: 09:00, 11:15")).toBeTruthy();
});

test("an unknown household says so", async () => {
  const db = await loadedTablet();
  await detail(db, "00000000-0000-4000-8000-00000000dead");
  expect(await screen.findByText("Domicílio não encontrado neste tablet.")).toBeTruthy();
});

// ── Q13(1): the endemic agent registers non-residential properties, never a family nor a resident ──
test("agent: 'Novo imóvel não residencial' in the list, no family or resident buttons in the detail", async () => {
  const db = await endemicTablet();
  const nav = await list(db);
  await fireEvent.press(await screen.findByRole("button", { name: "Novo imóvel não residencial" }));
  expect(nav.onNew).toHaveBeenCalled();
  // The dashboard's note (TerritoryTeam.tsx, NON_RESIDENTIAL_ONLY), word for word.
  expect(screen.getByText(NON_RESIDENTIAL_ONLY)).toBeTruthy();
  expect(NON_RESIDENTIAL_ONLY).toBe(
    "Nesta microárea você cadastra só imóvel não residencial (ponto estratégico, comércio, terreno baldio, escola, creche, estabelecimento religioso e outros).");
  expect(screen.queryByRole("button", { name: "Novo domicílio" })).toBeNull();
  await nav.unmount();

  // A home: he reads it (Q41 withdrawn: the residents are on screen), and edits nothing in it.
  const home = await detail(db);
  expect(await screen.findByText(READ_ONLY)).toBeTruthy();
  expect(within(screen.getByTestId(`resident-${JOANA}`)).getByText("Joana Conceição")).toBeTruthy();
  for (const name of ["Editar domicílio", "Nova família", "Novo morador", "Editar família", "Novo morador nesta família"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  await home.unmount();

  // His own strategic point: he edits the household, and still no family nor resident.
  const point = await saveHousehold(db, { fields: exampleFields({ micro_area_id: "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", property_type: "4", living_conditions: {} }) }, { newUuid, now: () => NOW });
  const nav2 = await detail(db, point.key);
  await fireEvent.press(await screen.findByRole("button", { name: "Editar domicílio" }));
  expect(nav2.onEdit).toHaveBeenCalled();
  expect(screen.queryByText(READ_ONLY)).toBeNull();
  for (const name of ["Nova família", "Novo morador"]) expect(screen.queryByRole("button", { name })).toBeNull();
  await nav2.unmount();
});

// Review M2: the api refuses the agent's edit of a property with an active resident (SaveHousehold, cbo_not_allowed).
test("agent: a non-residential property with an active resident on the tablet offers no 'Editar domicílio' and says why", async () => {
  const db = await endemicTablet({ household: { property_type: "2", living_conditions: {} } });
  await detail(db);
  expect(await screen.findByText("Microárea 03 · Comércio")).toBeTruthy();
  expect(within(screen.getByTestId(`resident-${JOANA}`)).getByText("Joana Conceição")).toBeTruthy();
  expect(screen.getByText(AGENT_HAS_RESIDENT)).toBeTruthy();
  expect(screen.queryByText(READ_ONLY)).toBeNull();
  expect(screen.queryByRole("button", { name: "Editar domicílio" })).toBeNull();
});

// ── Q59(b): the endemic agent visits an empty property from its detail ──
// HH as a property with nobody in it on the tablet, worked yesterday, with no LIRAa item nor blockade: off the sheet.
// `household`: over that body (its status, its families, its profile).
async function emptyProperty(propertyType: string, o: { session?: Partial<SessionResponse>; domains?: null; household?: Record<string, unknown> } = {}): Promise<Db> {
  const vector = { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: "2026-11-13", last_situation: "worked" };
  const { household, ...rest } = o;
  const db = await endemicTablet({ household: { property_type: propertyType, families: [], living_conditions: {}, vector, ...household }, ...rest });
  await db.run("DELETE FROM registrations");
  await db.run("DELETE FROM liraa_items");
  await db.run("DELETE FROM transmission_blocks");
  return db;
}

test("Q59(b): a commerce with no resident, off the due sheet, offers 'Registrar visita', which opens the visit with the bulletin", async () => {
  const db = await emptyProperty("2");
  expect((await loadDue(db, NOW)).items.map((item) => item.householdKey)).not.toContain(HH);
  const nav = await detail(db);
  await fireEvent.press(await screen.findByRole("button", { name: "Registrar visita" }));
  expect(nav.onStartPropertyVisit).toHaveBeenCalledWith({ household_id: HH });
  expect(nav.onStartVisit).not.toHaveBeenCalled();
  await nav.unmount();

  // The visit route (app/(main)/visits/new.tsx) gives the form the household's key and the bulletin's start.
  const [params] = nav.onStartPropertyVisit.mock.calls[0];
  await renderWithServices(<VisitForm start={{ householdKey: params.household_id, vector: vectorStart(params) }} onSaved={jest.fn()} />, fakeServices({ db, now: () => NOW }));
  expect(await screen.findByRole("header", { name: "Nova visita" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Registrar boletim" }).props.accessibilityState.checked).toBe(true);
  expect(screen.getByText("Boletim do agente de endemias")).toBeTruthy();
  // No person at a property that is not a home: the 24b's subject question is not there.
  expect(screen.queryByTestId("field-subject")).toBeNull();
});

test("Q59(b): a strategic point opens the visit with activity pe", async () => {
  const db = await emptyProperty("4");
  const nav = await detail(db);
  await fireEvent.press(await screen.findByRole("button", { name: "Registrar visita" }));
  const [params] = nav.onStartPropertyVisit.mock.calls[0];
  expect(params).toEqual({ household_id: HH, vector_activity: "pe" });
  await nav.unmount();

  await renderWithServices(<VisitForm start={{ householdKey: params.household_id, vector: vectorStart(params) }} onSaved={jest.fn()} />,
    fakeServices({ db, now: () => NOW }));
  const pe = await within(await screen.findByTestId("field-vector_inspection.activity")).findByRole("radio", { name: "PE — Ponto estratégico" });
  expect(pe.props.accessibilityState.checked).toBe(true);
});

test("Q59(b): a property on the due sheet starts the visit as its card does (the LIRAa link)", async () => {
  const db = await endemicTablet({ household: { property_type: "2", families: [], living_conditions: {} } });
  await db.run("DELETE FROM registrations");
  await db.run("DELETE FROM transmission_blocks");
  const nav = await detail(db);
  await fireEvent.press(await screen.findByRole("button", { name: "Registrar visita" }));
  expect(nav.onStartPropertyVisit).toHaveBeenCalledWith({ household_id: HH, vector_activity: "liraa", liraa_draw_item_id: LIRAA_ITEM });
});

test("Q59(b): a property with an active resident keeps the visit through the resident", async () => {
  const db = await endemicTablet({ household: { property_type: "2", families: [], living_conditions: {} } });
  const nav = await detail(db);
  const joana = within(await screen.findByTestId(`resident-${JOANA}`));
  expect(screen.getAllByRole("button", { name: "Registrar visita" })).toHaveLength(1);
  await fireEvent.press(joana.getByRole("button", { name: "Registrar visita" }));
  expect(nav.onStartVisit).toHaveBeenCalled();
  expect(nav.onStartPropertyVisit).not.toHaveBeenCalled();
});

test("Q59(b): the ACS, the agent without the bulletin and a city with the visit off see no property visit", async () => {
  const acs = await loadedTablet();
  const shop = await saveHousehold(acs, { fields: exampleFields({ property_type: "2", living_conditions: {} }) }, { newUuid, now: () => NOW });
  let nav = await detail(acs, shop.key);
  expect(await screen.findByText("Microárea 03 · Comércio")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Registrar visita" })).toBeNull();
  await nav.unmount();

  const session = example<SessionResponse>("session-endemic-agent.json");
  for (const db of [await emptyProperty("2", { domains: null }), await emptyProperty("2", { session: { features: { ...session.features, home_visits: false } } })]) {
    nav = await detail(db);
    expect(await screen.findByText("Microárea 03 · Comércio")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Registrar visita" })).toBeNull());
    await nav.unmount();
  }
});

// ── Q59(b), review of 54809e5 ──
const VECTOR_PAGE_FAMILIES = (example<ChangesResponse>("changes-vector-page.json").items.find((item) => item.type === "household")!.body as HouseholdBody).families;
const noPropertyVisit = async (db: Db) => {
  const nav = await detail(db);
  expect(await screen.findByText(/^Microárea 03/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Registrar visita" })).toBeNull();
  await nav.unmount();
};

// I1: the api refuses a visit to an inactive household (household_inactive); the due sheet leaves it out too.
test("Q59(b): an inactive commerce with no resident shows no property-level 'Registrar visita'", async () => {
  await noPropertyVisit(await emptyProperty("2", { household: { status: "inactive" } }));
});

// The complement: with an active family the api drops reasons 34–37 from a visit with no person (Q44).
test("Q59(b): an active family in the body and no registration on the tablet → no property-level visit; a family that moved out does not hold it", async () => {
  expect(VECTOR_PAGE_FAMILIES.length).toBeGreaterThan(0);
  expect(VECTOR_PAGE_FAMILIES.every((family) => !family.moved_out)).toBe(true);
  await noPropertyVisit(await emptyProperty("1", { household: { families: VECTOR_PAGE_FAMILIES } }));

  const moved = await emptyProperty("1", { household: { families: VECTOR_PAGE_FAMILIES.map((family) => ({ ...family, moved_out: true })) } });
  const nav = await detail(moved);
  await fireEvent.press(await screen.findByRole("button", { name: "Registrar visita" }));
  expect(nav.onStartPropertyVisit).toHaveBeenCalledWith({ household_id: HH });
});

// M2: through the route's start, saved: a visit with no person and the bulletin's activity.
test("Q59(b): the property's visit, through the route's start and saved, goes with subject none and the bulletin's activity", async () => {
  for (const [type, activity] of [["4", "pe"], ["2", "li"]] as const) {
    const db = await emptyProperty(type);
    const nav = await detail(db);
    await fireEvent.press(await screen.findByRole("button", { name: "Registrar visita" }));
    const [params] = nav.onStartPropertyVisit.mock.calls[0];
    await nav.unmount();

    const view = await renderWithServices(<VisitForm start={{ householdKey: params.household_id, vector: vectorStart(params) }} onSaved={jest.fn()} />,
      fakeServices({ db, now: () => NOW }));
    const activities = within(await screen.findByTestId("field-vector_inspection.activity"));
    if (activity === "li") await fireEvent.press(activities.getByRole("radio", { name: "LI — Levantamento de índice" }));
    await fireEvent.press(within(screen.getByTestId("field-vector_inspection.situation")).getByRole("radio", { name: "Recusado" }));
    await fireEvent.press(screen.getByRole("button", { name: "Registrar visita" }));
    await waitFor(async () => expect(await outboxRepo.all(db)).toHaveLength(1));
    const [item] = await outboxRepo.all(db);
    expect(item.type).toBe("home_visit");
    expect(item.body).toMatchObject({ household_id: HH, subject: "none", vector_inspection: { activity, situation: "refused" } });
    expect("patient_id" in item.body || "family_id" in item.body || "new_patient" in item.body).toBe(false);
    await view.unmount();
  }
});

// M3: on the sheet, the detail starts the visit as the card does.
test("Q59(b): a blocked property and a pending strategic point open from the detail with their due-sheet start", async () => {
  const blocked = await endemicTablet({ household: { property_type: "2", families: [], living_conditions: {} } });
  await blocked.run("DELETE FROM registrations");
  const pending = await emptyProperty("4", {
    household: { vector: { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: "2026-11-13", last_situation: "closed" } },
  });
  const expected = [
    [blocked, { household_id: HH, vector_activity: "transmission_block", transmission_block_id: TRANSMISSION_BLOCK }],
    [pending, { household_id: HH, vector_activity: "pe", work_type: "pending" }],
  ] as const;
  for (const [db, start] of expected) {
    const entry = (await loadDue(db, NOW)).items.find((item) => item.householdKey === HH)!;
    expect(dueVisitParams(entry)).toEqual(start);
    const nav = await detail(db);
    await fireEvent.press(await screen.findByRole("button", { name: "Registrar visita" }));
    expect(nav.onStartPropertyVisit).toHaveBeenCalledWith(start);
    await nav.unmount();
  }
});
