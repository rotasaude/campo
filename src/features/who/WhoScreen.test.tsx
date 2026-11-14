import { fireEvent, screen, within } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { createTestDb } from "../../db/testing/sqljsDb";
import { applyPage } from "../../sync/download";
import { WhoScreen } from "./WhoScreen";
import { personLine, reasonText } from "./whoText";

async function mount(file: string) {
  const db = await createTestDb();
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await applyPage(db, example<ChangesResponse>(file));
  const onStartVisit = jest.fn();
  await renderWithServices(<WhoScreen onStartVisit={onStartVisit} />, fakeServices({ db }));
  return { db, onStartVisit };
}

test("reason texts: care line with its practice and date, registration due, never visited", () => {
  expect(reasonText({ code: "care_line", care_line: "Pessoa com hipertensão", practice: "2 visitas do ACS nos últimos 12 meses", status: "overdue", due_on: "2026-11-01" }))
    .toBe("Pessoa com hipertensão: 2 visitas do ACS nos últimos 12 meses — atrasada desde 01/11/2026");
  expect(reasonText({ code: "care_line", care_line: "Pessoa com hipertensão", practice: "2 visitas do ACS nos últimos 12 meses", status: "overdue", due_on: null }))
    .toBe("Pessoa com hipertensão: 2 visitas do ACS nos últimos 12 meses — nunca feita");
  expect(reasonText({ code: "care_line", care_line: "Gestante", practice: "Visita no puerpério", status: "due_soon", due_on: "2026-12-05" }))
    .toBe("Gestante: Visita no puerpério — até 05/12/2026");
  expect(reasonText({ code: "registration_due", status: "due_soon", due_on: "2026-12-20" })).toBe("Cadastro a vencer em 20/12/2026");
  expect(reasonText({ code: "registration_due", status: "expired", due_on: "2026-10-20" })).toBe("Cadastro vencido desde 20/10/2026");
  expect(reasonText({ code: "never_visited" })).toBe("Nunca visitado");
});

test("person line: age when known, nothing in its place when not", () => {
  expect(personLine({ display_name: "Joana Conceição", age: 65 })).toBe("Joana Conceição, 65 anos");
  expect(personLine({ display_name: "Recém-nascido de Maria", age: 0 })).toBe("Recém-nascido de Maria, menos de 1 ano");
  expect(personLine({ display_name: "Davi Souza", age: 1 })).toBe("Davi Souza, 1 ano");
  expect(personLine({ display_name: "Benedita Rocha", age: null })).toBe("Benedita Rocha");
});

test("who-to-visit lists each micro-area's people with address, last visit and reasons", async () => {
  await mount("changes-last-page.json");
  expect(await screen.findByText("03 · Vila Nova — rua das Flores")).toBeTruthy();
  const joana = within(screen.getByTestId("who-0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b"));
  expect(joana.getByText("Joana Conceição, 65 anos")).toBeTruthy();
  expect(joana.getByText("Rua das Flores, 120")).toBeTruthy();
  expect(joana.getByText("Última visita: 20/08/2026")).toBeTruthy();
  expect(joana.getByText("Pessoa com hipertensão: 2 visitas do ACS nos últimos 12 meses — atrasada desde 01/11/2026")).toBeTruthy();
  const benedita = within(screen.getByTestId("who-1f2a3b4c-5d6e-4f7a-9b8c-9d0e1f2a3b4c"));
  expect(benedita.getByText("Cadastro a vencer em 20/12/2026")).toBeTruthy();
  expect(benedita.getByText("Nunca visitado")).toBeTruthy();
  expect(benedita.queryByText(/Última visita/)).toBeNull();
});

test("who-to-visit shows 'nunca feita' for null due_on and no age when null", async () => {
  await mount("changes-last-page-care-line-never-done.json");
  expect(await screen.findByText("Pessoa com hipertensão: 2 visitas do ACS nos últimos 12 meses — nunca feita")).toBeTruthy();
});

test("a person without age is listed by name only", async () => {
  await mount("changes-last-page-age-null.json");
  expect(await screen.findByText("Benedita Rocha")).toBeTruthy();
  expect(screen.queryByText(/Benedita Rocha,/)).toBeNull();
});

test("Registrar visita hands the person, the household and the micro-area to the visit form", async () => {
  const t = await mount("changes-last-page.json");
  await fireEvent.press(within(await screen.findByTestId("who-0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b")).getByRole("button", { name: "Registrar visita" }));
  expect(t.onStartVisit).toHaveBeenCalledWith({
    patient_id: "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b", household_id: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f",
    family_id: "9d0e1f2a-3b4c-4d5e-9f6a-7b8c9d0e1f2a", micro_area_id: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d",
  });
});

test("nobody to visit: says so", async () => {
  const db = await createTestDb();
  await renderWithServices(<WhoScreen onStartVisit={jest.fn()} />, fakeServices({ db }));
  expect(await screen.findByText("Ninguém a visitar por enquanto. A lista chega na próxima sincronização completa.")).toBeTruthy();
});
