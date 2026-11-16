import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import type { RegisterOutcome } from "../../setup/register";
import { QR_PREFIX } from "../../setup/qr";
import { ScanScreen } from "./ScanScreen";

const TOKEN = "rsf_" + "A".repeat(43);
const HOST = "curitiba.rotasaude.example";
const qr = (value: unknown) => QR_PREFIX + Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const GOOD = qr({ host: HOST, token: TOKEN });

async function mount(outcome: RegisterOutcome | Promise<RegisterOutcome> = { kind: "registered" }) {
  let scan: (text: string) => void = () => undefined;
  const register = jest.fn(async () => outcome);
  const onRegistered = jest.fn();
  // A camera that reads nothing by itself: the test says what it "sees".
  const Camera = ({ onScanned }: { onScanned(text: string): void }) => <Text onPress={() => { scan = onScanned; }}>câmera</Text>;
  await render(<ScanScreen allowedHostSuffixes={[".rotasaude.example"]} register={register} onRegistered={onRegistered} Camera={Camera} />);
  // What the camera does when it reads a code.
  return {
    scan: async (text: string) => { await fireEvent.press(screen.getByText("câmera")); await act(async () => { scan(text); }); },
    // The camera fires again with the callback it already has (the view may be gone by then).
    again: (text: string) => act(async () => { scan(text); }),
    register, onRegistered,
  };
}

test("a valid QR registers the device and tells the caller how it went", async () => {
  const t = await mount({ kind: "registered" });
  expect(screen.getByRole("header", { name: "Leia o QR do dashboard" })).toBeTruthy();
  await t.scan(GOOD);
  await waitFor(() => expect(t.onRegistered).toHaveBeenCalledWith({ kind: "registered" }));
  expect(t.register).toHaveBeenCalledWith({ host: HOST, token: TOKEN });
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/rsf_/);
});

test.each([
  ["https://exemplo.test/qualquer", "Este QR não é do Rota Saúde"],
  [QR_PREFIX + "%%%", "QR ilegível — gere outro no dashboard"],
  [qr({ host: "curitiba.evil.test", token: TOKEN }), "Este QR aponta para um endereço que o app não reconhece"],
])("a QR that is not good says why and never calls the network: %s", async (text, phrase) => {
  const t = await mount();
  await t.scan(text);
  expect(await screen.findByText(phrase)).toBeTruthy();
  expect(t.register).not.toHaveBeenCalled();
  expect(t.onRegistered).not.toHaveBeenCalled();
});

test("the camera stops at the first code: a second read while the first is being handled is ignored", async () => {
  let finish: (outcome: RegisterOutcome) => void = () => undefined;
  const t = await mount(new Promise<RegisterOutcome>((resolve) => { finish = resolve; }));
  await t.scan(GOOD);
  await t.again(GOOD);
  expect(await screen.findByText("Cadastrando o aparelho…")).toBeTruthy();
  expect(t.register).toHaveBeenCalledTimes(1);
  finish({ kind: "token_replaced", needsNewPin: false });
  await waitFor(() => expect(t.onRegistered).toHaveBeenCalledWith({ kind: "token_replaced", needsNewPin: false }));
});

test("another user's QR on a tablet that still owes records is refused with the reason", async () => {
  const t = await mount({ kind: "refused_pending" });
  await t.scan(GOOD);
  expect(await screen.findByText("Há registros deste tablet ainda não enviados. Sincronize com o usuário atual antes de cadastrar outro.")).toBeTruthy();
  expect(t.onRegistered).not.toHaveBeenCalled();
  // The person can read another QR afterwards.
  await t.scan(GOOD);
  expect(t.register).toHaveBeenCalledTimes(2);
});

test.each<[RegisterOutcome, string]>([
  [{ kind: "failed", failure: { kind: "network" } }, "Sem conexão: leia o QR de novo quando houver rede."],
  [{ kind: "failed", failure: { kind: "suspended" } }, "Este QR não vale mais. Gere outro no dashboard."],
  [{ kind: "failed", failure: { kind: "revoked" } }, "Este QR não vale mais. Gere outro no dashboard."],
  [{ kind: "failed", failure: { kind: "server", status: 503, code: "city_schema_behind" } }, "O Rota Saúde não respondeu como esperado. Tente de novo em alguns minutos."],
])("a failed registration says what to do: %j", async (outcome, phrase) => {
  const t = await mount(outcome);
  await t.scan(GOOD);
  expect(await screen.findByText(phrase)).toBeTruthy();
  expect(t.onRegistered).not.toHaveBeenCalled();
});

test("the paste field exists only in the e2e build", async () => {
  await mount();
  expect(screen.queryByLabelText("Colar código")).toBeNull();
});

// Q83(2): a server of another contract is not paired with.
test("a server of another contract: the screen says to update the app, and the tablet is not registered", async () => {
  const t = await mount({ kind: "refused_contract" });
  await t.scan(GOOD);
  expect(await screen.findByText("Atualize o app antes de cadastrar este tablet.")).toBeTruthy();
  expect(t.onRegistered).not.toHaveBeenCalled();
});
