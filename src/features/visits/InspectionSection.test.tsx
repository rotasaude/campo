import { fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import type { VectorStart } from "../../rules/vectorInspection";
import { HH, LIRAA_ITEM, NEIGHBORHOOD, endemicTablet, loadedTablet } from "../testing";
import { BLOCK_FROM_PROFILE, BULLETIN_NEEDS_HOUSEHOLD, BULLETIN_UNAVAILABLE, EXIT_AT_SAVE } from "./InspectionSection";
import { VisitForm } from "./VisitForm";

const NOW = Date.parse("2026-11-14T15:00:30Z"); // 12:00:30 in the city (UTC−3)
const UUID = "c0ffee60-0000-4000-8000-000000000060";
const NO_PROFILE = { city_block_id: null, risk_class: null, risk_assessed_on: null, last_worked_on: null, last_situation: null };
const ADDRESS = { zip: "80010000", street_type: "081", street: "das Flores", number: "120", no_number: false, complement: null, district: "Centro", reference: null };

let view: Awaited<ReturnType<typeof renderWithServices>> | null = null;
const unmount = async () => { await view?.unmount(); view = null; };

async function mount(o: { db?: Db; vector?: VectorStart; householdKey?: string | null; clock?: { now: number } } = {}) {
  const db = o.db ?? (await endemicTablet());
  const onSaved = jest.fn();
  const clock = o.clock ?? { now: NOW };
  const services = fakeServices({ db, now: () => clock.now });
  services.crypto = { ...services.crypto, randomUUID: () => UUID };
  const start = o.householdKey === null ? undefined : { householdKey: o.householdKey ?? HH, vector: o.vector };
  view = await renderWithServices(<VisitForm start={start} onSaved={onSaved} />, services);
  await screen.findByRole("header", { name: "Nova visita" });
  return { db, onSaved };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));
const radio = async (key: string, name: string) => { await fireEvent.press(field(key).getByRole("radio", { name })); };
const press = async (name: string) => { await fireEvent.press(screen.getByRole("button", { name })); };
const plus = async (label: string, times = 1, inside: Pick<typeof screen, "getByRole"> = screen) => { for (let i = 0; i < times; i += 1) await fireEvent.press(inside.getByRole("button", { name: `Aumentar ${label}` })); };
const SECTION = "Boletim do agente de endemias";

// Worked, a deposit of the group with `larvae` larvae (all of them with water), ready for samples.
async function worked(group = "A1 — Depósito de água elevado", larvae = 2) {
  await radio("vector_inspection.activity", "LI — Levantamento de índice");
  await radio("vector_inspection.situation", "Trabalhado");
  await radio("vector_inspection.deposit_group", group);
  await press("Adicionar grupo");
  const box = within(screen.getByTestId(`deposit-${group.split(" ")[0]}`));
  await plus("Existentes", larvae, box); await plus("Com água", larvae, box); await plus("Com larva", larvae, box);
}
const addSample = async (group = "A1") => { await radio("vector_inspection.sample_group", group); await press("Adicionar amostra"); };

test("hidden for the ACS; hidden with a notice when the domains are missing; off when 'Registrar boletim' is unchecked", async () => {
  await mount({ db: await loadedTablet() });
  expect(screen.queryByRole("checkbox", { name: "Registrar boletim" })).toBeNull();
  expect(screen.queryByText(SECTION)).toBeNull();
  expect(screen.queryByText(BULLETIN_UNAVAILABLE)).toBeNull();
  // The 24b 'Quem foi visitado' and the outcome are the ACS's as before.
  expect(screen.getByText("Quem foi visitado")).toBeTruthy();
  expect(field("outcome").getByRole("radio", { name: "Visita realizada" })).toBeTruthy();
  await unmount();

  await mount({ db: await endemicTablet({ domains: null }) });
  expect(screen.getByText(BULLETIN_UNAVAILABLE)).toBeTruthy();
  expect(BULLETIN_UNAVAILABLE).toBe("o boletim está indisponível neste aparelho — sincronize ou atualize o app");
  expect(screen.queryByRole("checkbox", { name: "Registrar boletim" })).toBeNull();
  expect(screen.queryByText(SECTION)).toBeNull();
  await unmount();

  const t = await mount();
  const toggle = screen.getByRole("checkbox", { name: "Registrar boletim" });
  expect(toggle.props.accessibilityState.checked).toBe(true);
  expect(screen.getByText(SECTION)).toBeTruthy();
  expect(screen.queryByTestId("field-outcome")).toBeTruthy();
  expect(screen.getByText("Desfecho: escolha a situação do imóvel")).toBeTruthy();
  await fireEvent.press(toggle);
  expect(screen.queryByText(SECTION)).toBeNull();
  // Without the bulletin the visit is the 24b's: the outcome is chosen, and it saves with no vector_inspection.
  await radio("subject", "Imóvel sem pessoa");
  await radio("outcome", "Ausente");
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.client_uuid).toBe(UUID);
  expect("vector_inspection" in item.body).toBe(false);
});

test("no household registered: the bulletin needs one, and no section (Q10)", async () => {
  await mount({ householdKey: null });
  await radio("place_kind", "Imóvel sem cadastro");
  expect(screen.getByText(BULLETIN_NEEDS_HOUSEHOLD)).toBeTruthy();
  expect(BULLETIN_NEEDS_HOUSEHOLD).toBe("O boletim precisa de um imóvel cadastrado.");
  expect(screen.queryByText(SECTION)).toBeNull();
});

test("the label of a new sample shows at once and stays the same after other edits", async () => {
  const t = await mount();
  // With an active family, the derived reasons go to the family (Q43): the visit is to it.
  await radio("subject", "Família — documento do responsável");
  await radio("family", "Família de Joana Conceição");
  await worked();
  await addSample();
  expect(within(screen.getByTestId("sample-1")).getByText("C0FFEE60-01")).toBeTruthy();
  await addSample();
  expect(within(screen.getByTestId("sample-2")).getByText("C0FFEE60-02")).toBeTruthy();
  // Other edits: larvae collected, the visit's time, the educational action, another group.
  await plus("Larvas coletadas", 3, within(screen.getByTestId("sample-1")));
  await plus("Larvas coletadas", 2, within(screen.getByTestId("sample-2")));
  await fireEvent.changeText(screen.getByLabelText("Hora (hh:mm)"), "11:50");
  await fireEvent.press(screen.getByRole("checkbox", { name: "Ação educativa" }));
  await radio("vector_inspection.deposit_group", "B — Depósito móvel");
  await press("Adicionar grupo");
  expect(within(screen.getByTestId("sample-1")).getByText("C0FFEE60-01")).toBeTruthy();
  expect(within(screen.getByTestId("sample-2")).getByText("C0FFEE60-02")).toBeTruthy();
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  // What is sent names the samples by the same number under the same client_uuid: the label shown is the label the api makes.
  const [item] = await outboxRepo.all(t.db);
  expect(item.client_uuid).toBe(UUID);
  expect((item.body.vector_inspection as { samples: unknown[] }).samples).toEqual([
    { number: 1, deposit_group: "A1", larvae_collected: 3 }, { number: 2, deposit_group: "A1", larvae_collected: 2 },
  ]);
});

test("only the last sample can be removed", async () => {
  await mount();
  await worked();
  await addSample();
  await addSample();
  expect(within(screen.getByTestId("sample-1")).queryByRole("button", { name: "Retirar amostra" })).toBeNull();
  await fireEvent.press(within(screen.getByTestId("sample-2")).getByRole("button", { name: "Retirar amostra" }));
  expect(screen.queryByTestId("sample-2")).toBeNull();
  expect(within(screen.getByTestId("sample-1")).getByText("C0FFEE60-01")).toBeTruthy();
  expect(within(screen.getByTestId("sample-1")).getByRole("button", { name: "Retirar amostra" })).toBeTruthy();
  // A group with samples is not taken out (its samples would renumber the others).
  expect(within(screen.getByTestId("deposit-A1")).queryByRole("button", { name: "Retirar grupo" })).toBeNull();
});

test("'Com larva' does not step below the samples of its group", async () => {
  await mount();
  await worked();
  await addSample();
  await addSample();
  const a1 = within(screen.getByTestId("deposit-A1"));
  expect(a1.getByLabelText("Com larva").props.value).toBe("2");
  expect(a1.getByRole("button", { name: "Diminuir Com larva" }).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(a1.getByRole("button", { name: "Diminuir Com larva" }));
  expect(a1.getByLabelText("Com larva").props.value).toBe("2");
  // With the last sample gone, it steps down to the one left.
  await fireEvent.press(within(screen.getByTestId("sample-2")).getByRole("button", { name: "Retirar amostra" }));
  await fireEvent.press(a1.getByRole("button", { name: "Diminuir Com larva" }));
  expect(a1.getByLabelText("Com larva").props.value).toBe("1");
  expect(a1.getByRole("button", { name: "Diminuir Com larva" }).props.accessibilityState.disabled).toBe(true);
});

test("closed after worked: prune says what went and the outcome line becomes absent", async () => {
  await mount();
  await worked();
  await fireEvent.press(screen.getByRole("checkbox", { name: "Ação educativa" }));
  expect(screen.getByText("Desfecho: Visita realizada (da situação do imóvel)")).toBeTruthy();
  await radio("vector_inspection.situation", "Fechado");
  expect(screen.getByText("Retirado por não valer para esta visita: depósitos, ação educativa.")).toBeTruthy();
  expect(screen.getByText("Desfecho: Ausente (da situação do imóvel)")).toBeTruthy();
  expect(screen.queryByText("Depósitos")).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Ação educativa" })).toBeNull();
});

test("block choice only when the profile has none, from the household neighbourhood", async () => {
  // The profile has a block: nothing to choose.
  await mount();
  expect(screen.getByText(BLOCK_FROM_PROFILE)).toBeTruthy();
  expect(screen.queryByTestId("field-vector_inspection.city_block_id")).toBeNull();
  await unmount();

  // No block, a neighbourhood: its active blocks only.
  const t = await mount({ db: await endemicTablet({ household: { vector: NO_PROFILE, address: { ...ADDRESS, neighborhood_id: NEIGHBORHOOD } } }) });
  expect(field("vector_inspection.city_block_id").getByRole("radio", { name: "12A" })).toBeTruthy();
  expect(field("vector_inspection.city_block_id").queryByRole("radio", { name: "7" })).toBeNull();
  await radio("subject", "Imóvel sem pessoa");
  await radio("vector_inspection.activity", "LI — Levantamento de índice");
  await radio("vector_inspection.situation", "Fechado");
  await radio("vector_inspection.city_block_id", "12A");
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  await unmount();

  // The block now waits in the line: the next visit to the household does not offer it again.
  view = await renderWithServices(<VisitForm start={{ householdKey: HH }} onSaved={jest.fn()} />, fakeServices({ db: t.db, now: () => NOW }));
  await screen.findByRole("header", { name: "Nova visita" });
  expect(screen.getByText(BLOCK_FROM_PROFILE)).toBeTruthy();
  await unmount();

  // No neighbourhood: the phrase, and no choice.
  await mount({ db: await endemicTablet({ household: { vector: NO_PROFILE } }) });
  expect(screen.getByText(VECTOR_ERRORS.household_without_neighborhood)).toBeTruthy();
  expect(screen.queryByTestId("field-vector_inspection.city_block_id")).toBeNull();
});

test("liraa and transmission_block offered only with the link of the start (Q8); pe only for property type 4", async () => {
  const names = () => field("vector_inspection.activity").getAllByRole("radio").map((r) => r.props.accessibilityLabel);
  await mount();
  expect(names()).toEqual(["LI — Levantamento de índice", "LI+T — Levantamento de índice e tratamento"]);
  await unmount();

  const t = await mount({ vector: { activity: "liraa", liraaDrawItemId: LIRAA_ITEM } });
  expect(names()).toEqual(["LI — Levantamento de índice", "LI+T — Levantamento de índice e tratamento", "LIRAa"]);
  expect(field("vector_inspection.activity").getByRole("radio", { name: "LIRAa" }).props.accessibilityState.checked).toBe(true);
  await radio("subject", "Imóvel sem pessoa");
  await radio("vector_inspection.situation", "Recusado");
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  expect((await outboxRepo.all(t.db))[0].body).toMatchObject({ outcome: 2, vector_inspection: { activity: "liraa", liraa_draw_item_id: LIRAA_ITEM, situation: "refused" } });
  await unmount();

  await mount({ db: await endemicTablet({ household: { property_type: "4" } }) });
  expect(names()).toContain("PE — Ponto estratégico");
  expect(names()).not.toContain("IE — Imóvel especial");
});

test("entry defaults to the minute of occurred_at, so entered_at ≤ occurred_at", async () => {
  const t = await mount();
  expect(screen.getByLabelText("Hora (hh:mm)").props.value).toBe("12:00");
  expect(screen.getByLabelText("Entrada (hh:mm)").props.value).toBe("12:00");
  await radio("subject", "Imóvel sem pessoa");
  await radio("vector_inspection.activity", "LI — Levantamento de índice");
  await radio("vector_inspection.situation", "Trabalhado");
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body.occurred_at).toBe("2026-11-14T12:00:00-03:00");
  // The exit left blank is the moment of saving, in the city's clock.
  expect(item.body.vector_inspection).toMatchObject({ entered_at: "2026-11-14T12:00:00-03:00", left_at: "2026-11-14T12:00:00-03:00" });
});

test("the exit hint holds in every state; an exit typed and cleared is the moment of saving again", async () => {
  const clock = { now: NOW };
  const t = await mount({ clock });
  expect(screen.getByText(EXIT_AT_SAVE)).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText("Saída (hh:mm)"), "12:30");
  expect(screen.queryByText(EXIT_AT_SAVE)).toBeNull();
  await fireEvent.changeText(screen.getByLabelText("Saída (hh:mm)"), "");
  expect(screen.getByText(EXIT_AT_SAVE)).toBeTruthy();
  // Without an entry nothing of the times goes: the hint is not said.
  await fireEvent.changeText(screen.getByLabelText("Entrada (hh:mm)"), "");
  expect(screen.queryByText(EXIT_AT_SAVE)).toBeNull();
  // Cleared, the entry follows the visit's time again.
  await fireEvent.changeText(screen.getByLabelText("Hora (hh:mm)"), "11:45");
  expect(screen.getByLabelText("Entrada (hh:mm)").props.value).toBe("11:45");
  expect(screen.getByText(EXIT_AT_SAVE)).toBeTruthy();
  await radio("subject", "Imóvel sem pessoa");
  await radio("vector_inspection.activity", "LI — Levantamento de índice");
  await radio("vector_inspection.situation", "Trabalhado");
  clock.now = Date.parse("2026-11-14T15:05:00Z"); // 12:05 in the city
  await press("Registrar visita");
  await waitFor(() => expect(t.onSaved).toHaveBeenCalled());
  const [item] = await outboxRepo.all(t.db);
  expect(item.body.vector_inspection).toMatchObject({ entered_at: "2026-11-14T11:45:00-03:00", left_at: "2026-11-14T12:05:00-03:00" });
});

test("saving after midnight with entry the day before is refused on screen at vector_inspection.entered_at", async () => {
  const clock = { now: Date.parse("2026-11-15T02:55:00Z") }; // 23:55 of the 14th in the city
  const t = await mount({ clock });
  expect(screen.getByLabelText("Entrada (hh:mm)").props.value).toBe("23:55");
  await radio("subject", "Imóvel sem pessoa");
  await radio("vector_inspection.activity", "LI — Levantamento de índice");
  await radio("vector_inspection.situation", "Trabalhado");
  clock.now = Date.parse("2026-11-15T03:10:00Z"); // 00:10 of the 15th
  await press("Registrar visita");
  expect(await field("vector_inspection.entered_at").findByText(VECTOR_ERRORS.inspection_times_invalid)).toBeTruthy();
  expect(await outboxRepo.all(t.db)).toEqual([]);
  expect(t.onSaved).not.toHaveBeenCalled();
});

test("no more than 7 deposit groups and limits.measures_max measures", async () => {
  await mount({ db: await endemicTablet({ limits: { measures_max: 2 } }) });
  await radio("vector_inspection.situation", "Trabalhado");
  for (let i = 0; i < 7; i += 1) {
    const option = field("vector_inspection.deposit_group").getAllByRole("radio")[0];
    await fireEvent.press(option);
    await press("Adicionar grupo");
  }
  expect(["A1", "A2", "B", "C", "D1", "D2", "E"].every((g) => screen.queryByTestId(`deposit-${g}`) !== null)).toBe(true);
  expect(screen.queryByRole("button", { name: "Adicionar grupo" })).toBeNull();

  for (let i = 0; i < 2; i += 1) { await radio("vector_inspection.measure_method", "Mecânico (eliminação)"); await press("Adicionar medida"); }
  expect(screen.getByTestId("measure-2")).toBeTruthy();
  await radio("vector_inspection.measure_method", "Focal (larvicida)");
  expect(screen.getByRole("button", { name: "Adicionar medida" }).props.accessibilityState.disabled).toBe(true);
  await press("Adicionar medida");
  expect(screen.queryByTestId("measure-3")).toBeNull();
});
