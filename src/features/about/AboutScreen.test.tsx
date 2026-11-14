import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { territoryRepo } from "../../db/repos/territoryRepo";
import { createTestDb } from "../../db/testing/sqljsDb";
import { SECURE_KEYS } from "../../security/secureStore";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { AboutScreen } from "./AboutScreen";

const SESSION = example<SessionResponse>("session-acs.json");

async function mount(pending = 0) {
  const db = await createTestDb();
  await db.run("INSERT INTO session (id, body, fetched_at) VALUES (1, ?, 't')", [JSON.stringify(SESSION)]);
  for (let i = 0; i < pending; i++) await enqueue(db, { type: "home_visit", body: {} }, newUuid);
  const services = fakeServices({ db });
  await services.secure.set(SECURE_KEYS.host, "curitiba.rotasaude.example");
  await services.secure.set(SECURE_KEYS.token, "rsf_" + "A".repeat(43));
  const onSignOut = jest.fn();
  await renderWithServices(<AboutScreen appVersion="0.1.0" onSignOut={onSignOut} />, services);
  return { db, onSignOut };
}

test("about shows version, city, user and the map attribution — never the token", async () => {
  await mount();
  expect(await screen.findByText("Versão 0.1.0")).toBeTruthy();
  expect(screen.getByText("Cidade: curitiba.rotasaude.example")).toBeTruthy();
  expect(screen.getByText(`Usuário: ${SESSION.user.name}`)).toBeTruthy();
  expect(screen.getByText("© OpenStreetMap")).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/rsf_/);
});

test("the mobile data preference is off by default and is kept when changed", async () => {
  const t = await mount();
  const toggle = await screen.findByRole("switch", { name: "Usar dados móveis para a carga e o mapa" });
  expect(toggle.props.accessibilityState).toEqual({ checked: false });
  await fireEvent(toggle, "valueChange", true);
  await waitFor(async () => expect(await territoryRepo.getMeta(t.db, "mobile_data")).toBe("1"));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Usar dados móveis para a carga e o mapa" }).props.accessibilityState).toEqual({ checked: true }));
  await fireEvent(screen.getByRole("switch", { name: "Usar dados móveis para a carga e o mapa" }), "valueChange", false);
  await waitFor(async () => expect(await territoryRepo.getMeta(t.db, "mobile_data")).toBe("0"));
});

test("sign out with pending items warns with the count", async () => {
  const t = await mount(3);
  await fireEvent.press(await screen.findByRole("button", { name: "Sair" }));
  expect(await screen.findByText("Há 3 registros não enviados. Sair apaga tudo deste tablet, inclusive eles.")).toBeTruthy();
  expect(t.onSignOut).not.toHaveBeenCalled();
  // Double confirmation: the first one only arms the second.
  await fireEvent.press(screen.getByRole("button", { name: "Sair e apagar tudo" }));
  expect(t.onSignOut).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Confirmar: apagar tudo deste tablet" }));
  expect(t.onSignOut).toHaveBeenCalledTimes(1);
});

test("sign out can be given up at any step", async () => {
  const t = await mount(1);
  await fireEvent.press(await screen.findByRole("button", { name: "Sair" }));
  expect(await screen.findByText("Há 1 registro não enviado. Sair apaga tudo deste tablet, inclusive ele.")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Sair e apagar tudo" }));
  await fireEvent.press(screen.getByRole("button", { name: "Cancelar" }));
  expect(screen.getByRole("button", { name: "Sair" })).toBeTruthy();
  expect(t.onSignOut).not.toHaveBeenCalled();
});

test("sign out without pending items asks once", async () => {
  const t = await mount(0);
  await fireEvent.press(await screen.findByRole("button", { name: "Sair" }));
  expect(await screen.findByText("Sair apaga os dados deste tablet. Para voltar, leia um QR novo no dashboard.")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Sair e apagar tudo" }));
  expect(t.onSignOut).toHaveBeenCalledTimes(1);
});
