import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { newUuid } from "../../sync/testing";
import { READ_ONLY } from "../households/HouseholdForm";
import { saveHousehold } from "../households/save";
import { AREA, HH, loadedTablet } from "../testing";
import { scrollIntoView } from "../../ui/reveal";
import { FamilyForm, MOVED_OUT_WARNING, NO_RESIDENTS } from "./FamilyForm";

// The measuring and the scrolling are the device's: here, that each refusal asks to be brought into sight.
jest.mock("../../ui/reveal", () => ({ ...jest.requireActual<typeof import("../../ui/reveal")>("../../ui/reveal"), scrollIntoView: jest.fn() }));
const revealed = scrollIntoView as jest.MockedFunction<typeof scrollIntoView>;

const NOW = Date.parse("2026-11-14T15:00:00Z");
const FAMILY = "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a";
const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";

async function mount(o: { db?: Db; householdKey?: string; familyId?: string } = {}) {
  const db = o.db ?? (await loadedTablet());
  const onSaved = jest.fn();
  await renderWithServices(<FamilyForm householdKey={o.householdKey ?? HH} familyId={o.familyId} onSaved={onSaved} />, fakeServices({ db, now: () => NOW }));
  return { db, onSaved };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));

test("a new family: the responsible among the residents, income, members and since when", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova família" });
  await fireEvent.press(field("responsible").getByRole("radio", { name: "Joana Conceição" }));
  await fireEvent.press(field("income_band").getByRole("radio", { name: "Meio salário mínimo" }));
  await fireEvent.changeText(screen.getByLabelText("Número de membros"), "2");
  await fireEvent.changeText(screen.getByLabelText("Reside desde (mm/aaaa)"), "11/2026");
  await press("Salvar família");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.type).toBe("family");
  expect(item.body).toEqual({ household_id: HH, responsible: { patient_id: JOANA }, income_band: "2", members_count: 2, living_since: "2026-11" });
});

test("what the api would refuse is written under the field: no responsible, members out of range, a month in the future", async () => {
  const t = await mount();
  await screen.findByRole("header", { name: "Nova família" });
  await press("Salvar família");
  expect(await field("responsible").findByText("escolha o responsável")).toBeTruthy();
  await fireEvent.press(field("responsible").getByRole("radio", { name: "Joana Conceição" }));
  await fireEvent.changeText(screen.getByLabelText("Número de membros"), "0");
  await press("Salvar família");
  expect(await field("members_count").findByText("número de membros de 1 a 999")).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("Número de membros"), "2");
  await fireEvent.changeText(screen.getByLabelText("Reside desde (mm/aaaa)"), "12/2026");
  await press("Salvar família");
  expect(await field("living_since").findByText("reside desde depois deste mês")).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});

test("each refusal is brought into sight, and again when saved without fixing", async () => {
  await mount();
  await screen.findByRole("header", { name: "Nova família" });
  revealed.mockClear();
  await press("Salvar família");
  expect(await field("responsible").findByText("escolha o responsável")).toBeTruthy();
  expect(revealed).toHaveBeenCalledTimes(1);
  await press("Salvar família");
  expect(revealed).toHaveBeenCalledTimes(2);
});

test("editing: the responsible is shown and cannot change; what the family has is in the form; moving out is final and says so", async () => {
  const t = await mount({ familyId: FAMILY });
  await screen.findByRole("header", { name: "Editar família" });
  expect(screen.getByText("Responsável: Joana Conceição")).toBeTruthy();
  expect(screen.queryByTestId("field-responsible")).toBeNull();
  expect(screen.getByLabelText("Número de membros").props.value).toBe("3");
  expect(screen.getByLabelText("Reside desde (mm/aaaa)").props.value).toBe("03/2019");
  expect(field("income_band").getByRole("radio", { name: "Um salário mínimo" }).props.accessibilityState.checked).toBe(true);

  await fireEvent.changeText(screen.getByLabelText("Número de membros"), "4");
  await fireEvent.press(field("moved_out").getByRole("radio", { name: "Sim" }));
  expect(screen.getByText(MOVED_OUT_WARNING)).toBeTruthy();
  expect(MOVED_OUT_WARNING).toBe("a mudança é definitiva: a família sai do domicílio e não volta nem muda mais");
  await press("Salvar família");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body).toEqual({ household_id: HH, family_id: FAMILY, income_band: "3", members_count: 4, living_since: "2019-03", moved_out: true });
});

test("a household with no resident yet cannot have a family: the screen says to register the person first", async () => {
  const db = await loadedTablet();
  const empty = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "1" } }, { newUuid, now: () => NOW });
  await mount({ db, householdKey: empty.key });
  expect(await screen.findByText(NO_RESIDENTS)).toBeTruthy();
  expect(NO_RESIDENTS).toBe("nenhum morador com cadastro disponível — cadastre o responsável antes");
  expect(screen.queryByRole("button", { name: "Salvar família" })).toBeNull();
});

test("only a home takes families, and only the community health agent registers them", async () => {
  const db = await loadedTablet();
  const shop = await saveHousehold(db, { fields: { micro_area_id: AREA, property_type: "2" } }, { newUuid, now: () => NOW });
  const first = await renderWithServices(<FamilyForm householdKey={shop.key} onSaved={jest.fn()} />, fakeServices({ db, now: () => NOW }));
  expect(await screen.findByText("só domicílio (tipo 01) tem famílias")).toBeTruthy();
  await first.unmount();

  const session = example<SessionResponse>("session-acs.json");
  const other = await loadedTablet({ session: { professional: { ...session.professional, cbo: "322255" } } });
  await renderWithServices(<FamilyForm householdKey={HH} onSaved={jest.fn()} />, fakeServices({ db: other, now: () => NOW }));
  expect(await screen.findByText(READ_ONLY)).toBeTruthy();
});
