import { fireEvent, render, screen } from "@testing-library/react-native";
import { PinCreateScreen } from "./PinCreateScreen";

const type = (label: string, pin: string) => fireEvent.changeText(screen.getByLabelText(label), pin);
const press = (name: string) => fireEvent.press(screen.getByRole("button", { name }));

test("asks for the PIN twice and hands it over only when both are equal", async () => {
  const onCreated = jest.fn();
  await render(<PinCreateScreen onCreated={onCreated} />);
  expect(screen.getByRole("header", { name: "Crie um PIN de 6 números" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
  await type("PIN", "123456");
  await press("Continuar");
  expect(await screen.findByRole("header", { name: "Repita o PIN" })).toBeTruthy();
  expect(screen.getByLabelText("PIN").props.value).toBe("");
  await type("PIN", "123456");
  await press("Criar PIN");
  expect(onCreated).toHaveBeenCalledWith("123456");
});

test("different PINs: says so and starts over", async () => {
  const onCreated = jest.fn();
  await render(<PinCreateScreen onCreated={onCreated} />);
  await type("PIN", "123456");
  await press("Continuar");
  await type("PIN", "654321");
  await press("Criar PIN");
  expect(await screen.findByText("Os PINs não são iguais")).toBeTruthy();
  expect(screen.getByRole("header", { name: "Crie um PIN de 6 números" })).toBeTruthy();
  expect(onCreated).not.toHaveBeenCalled();
});

test("only six digits are accepted and they are never shown", async () => {
  await render(<PinCreateScreen onCreated={jest.fn()} />);
  await type("PIN", "12ab345678");
  const field = screen.getByLabelText("PIN");
  expect(field.props.value).toBe("123456");
  expect(field.props.secureTextEntry).toBe(true);
});
