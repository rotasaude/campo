import { screen } from "@testing-library/react-native";
import { cipheredRaw } from "../../app/platformTesting";
import { fakeServices, renderWithServices } from "../../app/testing";
import { createTestDb } from "../../db/testing/sqljsDb";
import { DiagnosticsScreen } from "./DiagnosticsScreen";

const mount = async (cipher: string | null, probe: () => Promise<"refused" | "opened">) =>
  renderWithServices(<DiagnosticsScreen probe={probe} />, fakeServices({ db: cipheredRaw(await createTestDb(), cipher) }));

test("a ciphered database whose copy does not open without the key: the two lines the e2e flow reads", async () => {
  await mount("4.17.0 community", async () => "refused");
  expect(await screen.findByText("cifra: 4.17.0 community")).toBeTruthy();
  expect(await screen.findByText("sem chave: recusado")).toBeTruthy();
});

test("a copy that opens without the key is said in capitals: the build has no cipher", async () => {
  await mount("4.17.0 community", async () => "opened");
  expect(await screen.findByText("sem chave: ABRIU")).toBeTruthy();
});

test("no cipher answer, and a probe that could not run, are told apart from a good result", async () => {
  await mount(null, async () => { throw new Error("EIO"); });
  expect(await screen.findByText("cifra: ausente")).toBeTruthy();
  expect(await screen.findByText("sem chave: não foi possível verificar")).toBeTruthy();
  expect(screen.queryByText("sem chave: recusado")).toBeNull();
});
