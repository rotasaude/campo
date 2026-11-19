import { fireEvent, screen, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import type { Db } from "../../db/types";
import { applyPage } from "../../sync/download";
import { HH, LIRAA_ITEM, TRANSMISSION_BLOCK, endemicTablet } from "../testing";
import { DUE_EMPTY, DueScreen } from "./DueScreen";

const NOW = Date.parse("2026-11-14T15:00:00Z");

async function mount(db: Db) {
  const onStartVisit = jest.fn();
  await renderWithServices(<DueScreen onStartVisit={onStartVisit} />, fakeServices({ db, now: () => NOW }));
  return { onStartVisit };
}
// The vector page's entity of this type, ended (a closed blockade, an inspected LIRAa item).
async function ended(db: Db, type: "transmission_block" | "liraa_item", status: string): Promise<void> {
  const page = example<ChangesResponse>("changes-vector-page.json");
  const item = page.items.find((candidate) => candidate.type === type)!;
  await applyPage(db, { ...page, items: [{ ...item, version: 9, body: { ...(item.body as Record<string, unknown>), status, version: 9 } }] } as unknown as ChangesResponse);
}

test("each household with its reason, block, risk and dates; never who lives there", async () => {
  const db = await endemicTablet();
  await mount(db);
  const card = within(await screen.findByTestId(`due-${HH}`));
  expect(card.getByText("bloqueio")).toBeTruthy();
  expect(card.getByText(/das Flores, 120/)).toBeTruthy();
  expect(card.getByText(/Quarteirão 12A/)).toBeTruthy();
  expect(card.getByText("Amarelo (médio)")).toBeTruthy();
  // Not due yet: the blockade is the reason (the dashboard's "vence em").
  expect(card.getByText("trabalhado em 03/11/2026 · vence em 02/01/2027")).toBeTruthy();
  // The tablet has the resident of HH; the sheet never shows her.
  expect(screen.queryByText(/Joana/)).toBeNull();
});

test("never worked and without a block", async () => {
  const db = await endemicTablet({ household: { vector: null } });
  await ended(db, "liraa_item", "inspected");
  await mount(db);
  const card = within(await screen.findByTestId(`due-${HH}`));
  expect(card.getByText("vencido")).toBeTruthy();
  expect(card.getByText(/sem quarteirão/)).toBeTruthy();
  expect(card.getByText("nunca trabalhado")).toBeTruthy();
});

test("\"Registrar visita\" of the LIRAa item opens the visit with the activity and the link", async () => {
  const db = await endemicTablet();
  await ended(db, "transmission_block", "closed");
  const { onStartVisit } = await mount(db);
  const card = within(await screen.findByTestId(`due-${HH}`));
  expect(card.getByText("LIRAa")).toBeTruthy();
  await fireEvent.press(card.getByRole("button", { name: "Registrar visita" }));
  expect(onStartVisit).toHaveBeenCalledWith({ household_id: HH, vector_activity: "liraa", liraa_draw_item_id: LIRAA_ITEM });
});

test("\"Registrar visita\" of the blockade carries its id", async () => {
  const { onStartVisit } = await mount(await endemicTablet());
  await fireEvent.press(within(await screen.findByTestId(`due-${HH}`)).getByRole("button", { name: "Registrar visita" }));
  expect(onStartVisit).toHaveBeenCalledWith({ household_id: HH, vector_activity: "transmission_block", transmission_block_id: TRANSMISSION_BLOCK });
});

test("nothing to visit", async () => {
  await mount(await endemicTablet({ household: { status: "inactive" } }));
  expect(await screen.findByText(DUE_EMPTY)).toBeTruthy();
});
