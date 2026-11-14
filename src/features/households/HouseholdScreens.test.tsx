import { fireEvent, screen, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse, UploadRequest, HouseholdItemBody } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { newUuid } from "../../sync/testing";
import { AREA, HH, loadedTablet } from "../testing";
import { READ_ONLY } from "./HouseholdForm";
import { HouseholdList, NO_HOUSEHOLDS } from "./HouseholdList";
import { AT_THE_DASHBOARD, HouseholdScreen } from "./HouseholdScreen";
import { saveHousehold } from "./save";

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
  await renderWithServices(<HouseholdList {...nav} />, fakeServices({ db, now: () => NOW }));
  return nav;
}
async function detail(db: Db, key = HH) {
  const nav = { onEdit: jest.fn(), onNewFamily: jest.fn(), onEditFamily: jest.fn(), onNewResident: jest.fn(), onStartVisit: jest.fn(), onOpenResident: jest.fn() };
  await renderWithServices(<HouseholdScreen householdKey={key} {...nav} />, fakeServices({ db, now: () => NOW }));
  return nav;
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

test("an unknown household says so", async () => {
  const db = await loadedTablet();
  await detail(db, "00000000-0000-4000-8000-00000000dead");
  expect(await screen.findByText("Domicílio não encontrado neste tablet.")).toBeTruthy();
});
