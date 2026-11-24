import { fireEvent, screen, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { Db } from "../../db/types";
import { ANIMAL, HH, zoonosesTablet } from "../testing";
import { COLLARS_EMPTY, COLLARS_TITLE, CollarsDueScreen } from "./CollarsDueScreen";

const NOW = Date.parse("2026-11-24T15:00:00Z");

async function mount(db: Db) {
  const onOpen = jest.fn();
  await renderWithServices(<CollarsDueScreen onOpen={onOpen} />, fakeServices({ db, now: () => NOW }));
  return { onOpen };
}

test("each row has the short address, the animal's name and the due date; opening goes to the household", async () => {
  const { onOpen } = await mount(await zoonosesTablet());
  const row = within(await screen.findByTestId(`collar-${ANIMAL}`));
  expect(row.getByText(/Flores, 120/)).toBeTruthy();
  expect(row.getByText("Pipoca")).toBeTruthy();
  expect(row.getByText("vence em 01/12/2026")).toBeTruthy();
  expect(screen.queryByText(/Joana/)).toBeNull();
  fireEvent.press(row.getByText("Abrir domicílio"));
  expect(onOpen).toHaveBeenCalledWith(HH);
});

test("title is Coleiras a trocar; an empty list says so", async () => {
  const db = await zoonosesTablet();
  await db.run("UPDATE animals SET body = json_set(body, '$.collar_due_on', '2027-06-01')");
  await mount(db);
  expect(await screen.findByText(COLLARS_EMPTY)).toBeTruthy();
  expect(screen.getAllByText(COLLARS_TITLE).length).toBeGreaterThan(0);
});
