import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { UNENCRYPTED_MESSAGE, openEncryptedDb } from "../db/open";
import { LOCKED_MESSAGE } from "../features/lock/LockScreen";
import { phraseFor } from "../features/messages/errorPhrases";
import { setPin } from "../security/pin";
import { SECURE_KEYS } from "../security/secureStore";
import { sha256 } from "../security/testing";
import { QR_PREFIX } from "../setup/qr";
import { enqueue } from "../sync/outbox";
import { newUuid } from "../sync/testing";
import { AppRoot, WIPE_FAILED, useApp } from "./AppRoot";
import { SESSION, TEST_HOST, TEST_TOKEN, fakePlatform, type FakePlatform } from "./platformTesting";
import { useSyncState } from "./sync";

const GOOD_QR = QR_PREFIX + Buffer.from(JSON.stringify({ host: TEST_HOST, token: TEST_TOKEN }), "utf8").toString("base64url");

let startRound: () => void = () => undefined;
function Main() {
  const app = useApp();
  const sync = useSyncState();
  // What the timer would do: start a round with no touch at all (a covered screen takes none).
  useEffect(() => { startRound = sync.run; }, [sync.run]);
  return (
    <>
      <Text>telas principais</Text>
      <Draft />
      <Text onPress={app.signOut}>sair</Text>
    </>
  );
}
// A form in the middle of being filled: its text lives only in the screen's memory.
function Draft() {
  const [note, setNote] = useState("");
  return <TextInput accessibilityLabel="Observação" value={note} onChangeText={setNote} />;
}
const mount = (platform: FakePlatform) => render(<AppRoot platform={platform}><Main /></AppRoot>);

// A tablet already paired, with its PIN and (optionally) a complete first load.
async function paired(o: { loaded?: boolean; cipher?: string | null } = {}) {
  const platform = fakePlatform({ cipher: o.cipher });
  // The database of this platform, created the way registration does (none when the build has no cipher).
  const real = o.cipher === null ? null : await openEncryptedDb({ secure: platform.secure, random: platform.random, openRaw: platform.openRaw }, { create: true });
  await platform.secure.set(SECURE_KEYS.token, TEST_TOKEN);
  await platform.secure.set(SECURE_KEYS.host, TEST_HOST);
  await platform.secure.set(SECURE_KEYS.userId, SESSION.user.id);
  await setPin(platform.secure, "123456", platform.random, sha256);
  if (real && o.loaded !== false) await real.run("INSERT INTO meta (key, value) VALUES ('last_download_ok_at', '2026-11-14T12:00:00.000Z'), ('cursor', 'c')");
  return { platform, db: real };
}
async function unlock() {
  await fireEvent.changeText(await screen.findByLabelText("PIN"), "123456");
  await fireEvent.press(screen.getByRole("button", { name: "Entrar" }));
}

test("encryption failure shows the fatal screen and never opens the main stack", async () => {
  const { platform } = await paired({ cipher: null });
  await platform.secure.set(SECURE_KEYS.dbKey, "ab".repeat(32));
  await mount(platform);
  expect(await screen.findByText(UNENCRYPTED_MESSAGE)).toBeTruthy();
  expect(screen.queryByText("telas principais")).toBeNull();
  expect(screen.queryByLabelText("PIN")).toBeNull();
  expect(platform.server.requests).toEqual([]);
});

test("cold start asks for the PIN; the main screens only exist after it, and a round runs", async () => {
  const { platform } = await paired();
  await mount(platform);
  expect(await screen.findByRole("header", { name: "Digite o PIN" })).toBeTruthy();
  expect(screen.queryByText("telas principais")).toBeNull();
  expect(platform.server.requests).toEqual([]); // nothing talks to the server before the PIN
  await unlock();
  expect(await screen.findByText("telas principais")).toBeTruthy();
  await waitFor(() => expect(platform.server.requests).toContain("/field/v1/session"));
});

test("after 5 min in background the app locks; a shorter absence does not", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await screen.findByText("telas principais");

  await act(async () => { platform.appState.emit("background"); platform.clock.now += 4 * 60_000 + 59_000; platform.appState.emit("active"); });
  expect(screen.getByText("telas principais")).toBeTruthy();

  await act(async () => { platform.appState.emit("background"); platform.clock.now += 5 * 60_000; platform.appState.emit("active"); });
  expect(await screen.findByRole("header", { name: "Digite o PIN" })).toBeTruthy();
  expect(screen.queryByText("telas principais")).toBeNull();
});

// campo#2: five minutes away lock even when the tablet's clock was set back to show one.
test("five minutes away lock even with the tablet's clock set back during them", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await screen.findByText("telas principais");

  await act(async () => { platform.appState.emit("background"); platform.clock.now += 60_000; platform.clock.mono += 5 * 60_000; platform.appState.emit("active"); });
  expect(await screen.findByRole("header", { name: "Digite o PIN" })).toBeTruthy();
});

// Q75(8): a lock in the middle of a form keeps the form — hidden, out of reach, with nothing going to the server.
test("locked after 5 min: the screens below stay mounted but hidden, the scheduler stops, and what was typed is back after the PIN", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await fireEvent.changeText(await screen.findByLabelText("Observação"), "Sr. José pediu retorno na sexta");
  await waitFor(() => expect(platform.server.requests.length).toBeGreaterThan(0));

  await act(async () => { platform.appState.emit("background"); platform.clock.now += 5 * 60_000; platform.appState.emit("active"); });
  expect(await screen.findByRole("header", { name: "Digite o PIN" })).toBeTruthy();
  // Not for the eyes: the PIN screen is opaque and covers everything.
  const veil = StyleSheet.flatten(screen.getByTestId("lock-veil").props.style);
  expect(veil).toMatchObject({ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 });
  expect(veil.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
  // Not for the screen reader, not for a touch: the tree below is out of accessibility.
  expect(screen.queryByDisplayValue("Sr. José pediu retorno na sexta")).toBeNull();
  expect(screen.queryByText("telas principais")).toBeNull();
  const below = screen.getByTestId("main-screens", { includeHiddenElements: true });
  expect(below.props).toMatchObject({ importantForAccessibility: "no-hide-descendants", accessibilityElementsHidden: true, pointerEvents: "none" });
  // But still there, with what was typed.
  expect(screen.getByDisplayValue("Sr. José pediu retorno na sexta", { includeHiddenElements: true })).toBeTruthy();

  // Nothing goes to the server while locked: coming back to the app, which starts a round when unlocked, starts none.
  const before = platform.server.requests.length;
  await act(async () => { platform.appState.emit("background"); platform.clock.now += 60_000; platform.appState.emit("active"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(platform.server.requests.length).toBe(before);

  await unlock();
  expect(await screen.findByDisplayValue("Sr. José pediu retorno na sexta")).toBeTruthy();
  expect(screen.queryByTestId("lock-veil")).toBeNull();
  expect(screen.getByTestId("main-screens").props).toMatchObject({ importantForAccessibility: "auto", accessibilityElementsHidden: false, pointerEvents: "auto" });
  await waitFor(() => expect(platform.server.requests.length).toBeGreaterThan(before));
});

// Coming back, Android redraws the screen that was there before the app can put the PIN over it: the cover goes up on the way out.
test("on the way to the background the main screens are covered at once; a short absence only takes the cover off", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await fireEvent.changeText(await screen.findByLabelText("Observação"), "rascunho");
  expect(screen.queryByTestId("lock-cover")).toBeNull();

  await act(async () => { platform.appState.emit("background"); });
  const cover = StyleSheet.flatten(screen.getByTestId("lock-cover").props.style);
  expect(cover).toMatchObject({ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 });
  expect(cover.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(screen.queryByDisplayValue("rascunho")).toBeNull();
  expect(screen.queryByRole("header", { name: "Digite o PIN" })).toBeNull();

  await act(async () => { platform.clock.now += 60_000; platform.appState.emit("active"); });
  expect(screen.queryByTestId("lock-cover")).toBeNull();
  expect(screen.getByDisplayValue("rascunho")).toBeTruthy();
  expect(screen.queryByRole("header", { name: "Digite o PIN" })).toBeNull();

  // Five minutes: the cover becomes the PIN, with no frame of the screens in between.
  await act(async () => { platform.appState.emit("background"); });
  expect(screen.getByTestId("lock-cover")).toBeTruthy();
  await act(async () => { platform.clock.now += 5 * 60_000; platform.appState.emit("active"); });
  expect(await screen.findByRole("header", { name: "Digite o PIN" })).toBeTruthy();
  expect(screen.queryByTestId("lock-cover")).toBeNull();
  expect(screen.getByTestId("lock-veil")).toBeTruthy();
});

// Review I4: the lock flag only flips when the app comes back; a round started meanwhile (the timer) must still find it locked.
test("past five minutes in the background nothing is synced, even before the app comes back and asks for the PIN", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await screen.findByText("telas principais");
  await waitFor(() => expect(platform.server.requests.length).toBeGreaterThan(0));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

  await act(async () => { platform.appState.emit("background"); platform.clock.now += 4 * 60_000; });
  const before = platform.server.requests.length;
  await act(async () => { startRound(); });
  await waitFor(() => expect(platform.server.requests.length).toBeGreaterThan(before)); // still within the five minutes

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); platform.clock.now += 2 * 60_000; });
  const late = platform.server.requests.length;
  await act(async () => { startRound(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(platform.server.requests.length).toBe(late);
});

// Review (could not verify → fixed): Android's Back button is not a touch; under the PIN it would pop the hidden form.
test("the Back button does nothing while the screens are covered or under the PIN, and is the screens' own again afterwards", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await screen.findByText("telas principais");
  expect(platform.pressBack()).toBe(false); // not ours: the navigator's

  await act(async () => { platform.appState.emit("background"); });
  expect(platform.pressBack()).toBe(true);
  await act(async () => { platform.clock.now += 5 * 60_000; platform.appState.emit("active"); });
  await screen.findByRole("header", { name: "Digite o PIN" });
  expect(platform.pressBack()).toBe(true);

  await unlock();
  await waitFor(() => expect(screen.queryByTestId("lock-veil")).toBeNull());
  expect(platform.pressBack()).toBe(false);
});

test("a cold start has nothing below the PIN", async () => {
  const { platform } = await paired();
  await mount(platform);
  expect(await screen.findByRole("header", { name: "Digite o PIN" })).toBeTruthy();
  expect(screen.queryByTestId("main-screens", { includeHiddenElements: true })).toBeNull();
  expect(screen.queryByLabelText("Observação", { includeHiddenElements: true })).toBeNull();
});

test("a tablet that was never paired opens on the QR; a good QR leads to the PIN and then to the first load", async () => {
  const platform = fakePlatform();
  await mount(platform);
  expect(await screen.findByRole("header", { name: "Leia o QR do dashboard" })).toBeTruthy();
  await fireEvent.press(screen.getByText("câmera"));
  await act(async () => { platform.scan(GOOD_QR); });
  expect(await screen.findByRole("header", { name: "Crie um PIN de 6 números" })).toBeTruthy();
  expect(await platform.secure.get(SECURE_KEYS.token)).toBe(TEST_TOKEN);

  for (const label of ["Continuar", "Criar PIN"]) {
    await fireEvent.changeText(screen.getByLabelText("PIN"), "246810");
    await fireEvent.press(screen.getByRole("button", { name: label }));
  }
  // The first load runs by itself; when it is complete the person goes on.
  expect(await screen.findByRole("header", { name: "Primeira carga" })).toBeTruthy();
  await fireEvent.press(await screen.findByRole("button", { name: "Continuar" }));
  expect(await screen.findByText("telas principais")).toBeTruthy();
  expect(await platform.secure.get(SECURE_KEYS.pinHash)).toBeTruthy();
});

test("locked by 5 errors shows the QR replacement message; the same person's new QR asks for a new PIN and keeps the queue", async () => {
  const { platform, db } = await paired();
  await enqueue(db!, { type: "home_visit", body: {} }, newUuid);
  await mount(platform);
  for (let i = 0; i < 5; i++) {
    await fireEvent.changeText(await screen.findByLabelText("PIN"), "000000");
    await fireEvent.press(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText(i < 4 ? /PIN incorreto/ : LOCKED_MESSAGE);
  }
  platform.server.fail = { kind: "network" }; // nothing must leave while the app is locked
  await fireEvent.press(screen.getByRole("button", { name: "Ler QR novo" }));
  platform.server.fail = null;
  await fireEvent.press(await screen.findByText("câmera"));
  await act(async () => { platform.scan(GOOD_QR); });
  expect(await screen.findByRole("header", { name: "Crie um PIN de 6 números" })).toBeTruthy();
  expect((await db!.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"))!.n).toBe(1);
});

test("a round that comes back suspended shows the suspended screen; revoked erases everything and goes back to pairing", async () => {
  const suspended = await paired();
  suspended.platform.server.fail = { kind: "suspended" };
  const first = await mount(suspended.platform);
  await unlock();
  expect(await screen.findByText(phraseFor("device_suspended"))).toBeTruthy();
  expect(screen.queryByText("telas principais")).toBeNull();
  first.unmount();

  const revoked = await paired();
  revoked.platform.server.fail = { kind: "revoked" };
  await mount(revoked.platform);
  await unlock();
  expect(await screen.findByRole("header", { name: "Leia o QR do dashboard" })).toBeTruthy();
  expect(revoked.platform.secure.data.size).toBe(0);
  expect(revoked.platform.deleted.some((uri) => uri.endsWith("SQLite/campo.db"))).toBe(true);
});

test("sign out erases the installation and goes back to pairing", async () => {
  const { platform } = await paired();
  await mount(platform);
  await unlock();
  await fireEvent.press(await screen.findByText("sair"));
  expect(await screen.findByRole("header", { name: "Leia o QR do dashboard" })).toBeTruthy();
  expect(platform.secure.data.size).toBe(0);
  expect(screen.queryByText("telas principais")).toBeNull();
});

// Q82(3b): an erasure that does not go to the end is never taken for done.
const brokenDisk = (platform: FakePlatform) => {
  const working = platform.fs.deleteAsync;
  platform.fs.deleteAsync = async () => { throw new Error("EBUSY"); };
  return () => { platform.fs.deleteAsync = working; };
};

test("a sign out that cannot erase everything stops at the fatal screen; the next start-up erases before anything else", async () => {
  const { platform } = await paired();
  const repair = brokenDisk(platform);
  const first = await mount(platform);
  await unlock();
  await fireEvent.press(await screen.findByText("sair"));
  expect(await screen.findByText(WIPE_FAILED)).toBeTruthy();
  expect(WIPE_FAILED).toBe("Não foi possível apagar os dados deste tablet. Feche o app e abra de novo.");
  // Not the QR (a pairing over a half-erased tablet), and nothing of the data.
  expect(screen.queryByRole("header", { name: "Leia o QR do dashboard" })).toBeNull();
  expect(screen.queryByText("telas principais")).toBeNull();
  expect(screen.queryByLabelText("PIN")).toBeNull();
  await first.unmount();

  // Opened again with the disk still refusing: fatal again, and still nothing asked of anybody.
  platform.server.requests.length = 0;
  const second = await mount(platform);
  expect(await screen.findByText(WIPE_FAILED)).toBeTruthy();
  expect(screen.queryByRole("header", { name: "Leia o QR do dashboard" })).toBeNull();
  expect(platform.server.requests).toEqual([]);
  await second.unmount();

  // Opened again with the disk working: the erasure goes to the end and the tablet pairs from nothing.
  repair();
  platform.deleted.length = 0;
  await mount(platform);
  expect(await screen.findByRole("header", { name: "Leia o QR do dashboard" })).toBeTruthy();
  expect(platform.deleted.some((uri) => uri.endsWith("SQLite/campo.db"))).toBe(true);
  expect(platform.secure.data.size).toBe(0);
});

test("a revocation that cannot erase everything stops at the fatal screen instead of pairing", async () => {
  const { platform } = await paired();
  platform.server.fail = { kind: "revoked" };
  brokenDisk(platform);
  await mount(platform);
  await unlock();
  expect(await screen.findByText(WIPE_FAILED)).toBeTruthy();
  expect(screen.queryByRole("header", { name: "Leia o QR do dashboard" })).toBeNull();
  expect(screen.queryByText("telas principais")).toBeNull();
});
