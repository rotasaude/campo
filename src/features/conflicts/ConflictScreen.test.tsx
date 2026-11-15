import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ChangesResponse, HouseholdBody } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { handleStale } from "../../sync/stale";
import { newUuid } from "../../sync/testing";
import { saveHousehold, type HouseholdFields } from "../households/save";
import { readHousehold } from "../households/view";
import { AREA, HH, loadedTablet } from "../testing";
import { ConflictScreen, NOT_IN_CONFLICT } from "./ConflictScreen";
import { fieldLabel, valueText } from "./fieldText";

const NOW = Date.parse("2026-11-14T15:00:00Z");
const DICT = registrationDictionaries();

// The agent edited the household; meanwhile the station changed the same fields to something else.
async function conflicted(tablet: Partial<HouseholdFields>, station: Partial<HouseholdBody>) {
  const db = await loadedTablet();
  const view = (await readHousehold(db, HH))!;
  await saveHousehold(db, { key: HH, fields: { micro_area_id: AREA, property_type: view.body.property_type, ...tablet } }, { newUuid, now: () => NOW });
  const [item] = await outboxRepo.all(db);
  const current = { ...(example<ChangesResponse>("changes-first-page.json").items.find((i) => i.type === "household")!.body as HouseholdBody), version: 4, ...station };
  await handleStale(db, item, { client_uuid: item.client_uuid, status: "stale_version", type: "household", id: HH, current_version: 4, current } as never);
  return { db, seq: item.seq };
}
async function mount(db: Db, seq: number) {
  const onDone = jest.fn();
  await renderWithServices(<ConflictScreen seq={seq} onDone={onDone} />, fakeServices({ db, now: () => NOW }));
  return { onDone };
}
const field = (path: string) => within(screen.getByTestId(`conflict-${path}`));

test("the name of each field and its values, by the labels of the dictionary — never a raw code", () => {
  expect(fieldLabel("household", "address")).toBe("Endereço");
  expect(fieldLabel("household", "location")).toBe("Ponto do imóvel");
  expect(fieldLabel("household", "living_conditions.nu_moradores")).toBe("Número de moradores");
  expect(fieldLabel("family", "income_band")).toBe("Renda familiar");
  expect(fieldLabel("individual_registration", "sociodemographic")).toBe("Sociodemográfico");
  expect(fieldLabel("household", "campo_novo")).toBe("campo_novo");

  const text = (type: "household" | "family" | "individual_registration", path: string, value: unknown) => valueText(type, path, value, DICT);
  expect(text("household", "property_type", "2")).toBe("Comércio");
  expect(text("household", "refused", true)).toBe("Sim");
  expect(text("household", "contact_phone", null)).toBe("não informado");
  expect(text("household", "contact_phone", undefined)).toBe("não informado");
  expect(text("household", "living_conditions.localizacao", 83)).toBe("Urbana");
  expect(text("household", "living_conditions.animais_no_domicilio", [DICT.domains.animal_no_domicilio[0].code, DICT.domains.animal_no_domicilio[1].code]))
    .toBe(`${DICT.domains.animal_no_domicilio[0].label}, ${DICT.domains.animal_no_domicilio[1].label}`);
  expect(text("household", "address", { street_type: "081", street: "das Flores", number: "120", zip: "80010000", district: "Centro" })).toBe("RUA das Flores, 120 · Centro · CEP 80010000");
  // The point is told in words: the coordinates are never written on the screen.
  expect(text("household", "location", { latitude: -25.4, longitude: -49.2, accuracy_m: 8.5, source: "gps" })).toBe("Ponto marcado pelo GPS (precisão de 8,5 m)");
  expect(text("household", "location", null)).toBe("Sem ponto no mapa");
  expect(text("family", "income_band", "3")).toBe("Um salário mínimo");
  expect(text("family", "living_since", "2019-03")).toBe("03/2019");
  expect(text("individual_registration", "patient_demographics", { race_color: "03", ethnicity: null })).toBe("Parda");
  expect(text("individual_registration", "identification.dt_naturalizacao", "2001-03-05")).toBe("05/03/2001");
});

test("each field in conflict shows what the station has and what the tablet has, with the labels of the dictionary", async () => {
  const t = await conflicted({ contact_phone: "41988887777", property_type: "2" }, { contact_phone: "4130000000", property_type: "3" });
  await mount(t.db, t.seq);
  await screen.findByRole("header", { name: "Resolver conflito" });
  expect(field("contact_phone").getByText("Telefone de contato")).toBeTruthy();
  expect(field("contact_phone").getByRole("radio", { name: "No posto: 4130000000" })).toBeTruthy();
  expect(field("contact_phone").getByRole("radio", { name: "No tablet: 41988887777" })).toBeTruthy();
  expect(field("property_type").getByRole("radio", { name: "No posto: Terreno baldio" })).toBeTruthy();
  expect(field("property_type").getByRole("radio", { name: "No tablet: Comércio" })).toBeTruthy();
});

test("'Enviar' stays disabled until every field has a side chosen; then the item goes back to the line with the choices", async () => {
  const t = await conflicted({ contact_phone: "41988887777", property_type: "2" }, { contact_phone: "4130000000", property_type: "3" });
  const { onDone } = await mount(t.db, t.seq);
  const send = () => screen.getByRole("button", { name: "Enviar" });
  await screen.findByRole("header", { name: "Resolver conflito" });
  expect(send().props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(field("contact_phone").getByRole("radio", { name: "No tablet: 41988887777" }));
  expect(send().props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(field("property_type").getByRole("radio", { name: "No posto: Terreno baldio" }));
  expect(send().props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(send());
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const item = (await outboxRepo.bySeq(t.db, t.seq))!;
  expect([item.state, item.conflicts, item.edit_base_version]).toEqual(["pending", null, 4]);
  expect(item.body).toMatchObject({ household_id: HH, contact_phone: "41988887777", property_type: "3" });
});

test("an item that is not in conflict (any more) says so", async () => {
  const db = await loadedTablet();
  await saveHousehold(db, { key: HH, fields: { micro_area_id: AREA, property_type: "1" } }, { newUuid, now: () => NOW });
  const [item] = await outboxRepo.all(db);
  await mount(db, item.seq);
  expect(await screen.findByText(NOT_IN_CONFLICT)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull();
});
