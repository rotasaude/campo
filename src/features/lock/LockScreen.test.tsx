import { fireEvent, screen } from "@testing-library/react-native";
import { fakeServices, renderWithServices } from "../../app/testing";
import { createTestDb } from "../../db/testing/sqljsDb";
import { setPin } from "../../security/pin";
import { fixedRandom, sha256 } from "../../security/testing";
import { LOCKED_MESSAGE, LockScreen } from "./LockScreen";

async function setup() {
  const services = fakeServices({ db: await createTestDb() });
  await setPin(services.secure, "123456", fixedRandom, sha256);
  const onUnlocked = jest.fn();
  const onScanNew = jest.fn();
  await renderWithServices(<LockScreen onUnlocked={onUnlocked} onScanNew={onScanNew} />, services);
  return { services, onUnlocked, onScanNew };
}
const type = (pin: string) => fireEvent.changeText(screen.getByLabelText("PIN"), pin);
const enter = () => fireEvent.press(screen.getByRole("button", { name: "Entrar" }));

test("cold start asks for the PIN, and the right one lets the person in", async () => {
  const t = await setup();
  expect(screen.getByRole("header", { name: "Digite o PIN" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled();
  await type("12345");
  expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled();
  await type("123456");
  await enter();
  expect(await screen.findByLabelText("PIN")).toBeTruthy();
  expect(t.onUnlocked).toHaveBeenCalledTimes(1);
});

test("a wrong PIN says how many attempts are left and never lets in", async () => {
  const t = await setup();
  await type("000000");
  await enter();
  expect(await screen.findByText("PIN incorreto. Restam 4 tentativas.")).toBeTruthy();
  expect(screen.getByLabelText("PIN").props.value).toBe(""); // the field is cleared for the next try
  await type("000000");
  await enter();
  expect(await screen.findByText("PIN incorreto. Restam 3 tentativas.")).toBeTruthy();
  expect(t.onUnlocked).not.toHaveBeenCalled();
});

test("locked by 5 errors shows the QR replacement message", async () => {
  const t = await setup();
  for (let i = 0; i < 5; i++) { await type("000000"); await enter(); await screen.findByText(i < 4 ? /PIN incorreto/ : LOCKED_MESSAGE); }
  expect(LOCKED_MESSAGE).toBe("Este aparelho foi bloqueado depois de 5 tentativas erradas. Leia um QR novo no dashboard: Aparelhos de campo → Substituir.");
  expect(screen.queryByLabelText("PIN")).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Ler QR novo" }));
  expect(t.onScanNew).toHaveBeenCalledTimes(1);
  expect(t.onUnlocked).not.toHaveBeenCalled();
});

test("an app that opens already locked goes straight to the QR message", async () => {
  const services = fakeServices({ db: await createTestDb() });
  await setPin(services.secure, "123456", fixedRandom, sha256);
  await services.secure.set("campo.locked", "1");
  await renderWithServices(<LockScreen onUnlocked={jest.fn()} onScanNew={jest.fn()} />, services);
  expect(await screen.findByText(LOCKED_MESSAGE)).toBeTruthy();
  expect(screen.queryByLabelText("PIN")).toBeNull();
});

test("the PIN is never shown: the field hides what is typed and accepts only six digits", async () => {
  await setup();
  const field = screen.getByLabelText("PIN");
  expect(field.props.secureTextEntry).toBe(true);
  expect(field.props.maxLength).toBe(6);
  expect(field.props.keyboardType).toBe("number-pad");
  await type("12a4b6");
  expect(screen.getByLabelText("PIN").props.value).toBe("1246");
});
