import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";
import { SafeAreaInsetsContext, type EdgeInsets } from "react-native-safe-area-context";
import { fakeServices, renderWithServices } from "../../app/testing";
import type { ChangesResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { createTestDb } from "../../db/testing/sqljsDb";
import type { LocationPort } from "../../location/capture";
import type { MapCanvasProps } from "../../map/canvas";
import { applyPage } from "../../sync/download";
import { ATTRIBUTION, MapScreen, NO_FIX, NO_MAP } from "./MapScreen";

const HH1 = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";
// The first 127 bytes of a real PMTiles v3 file (an extract of Curitiba).
const HEAD = "504d54696c6573037f000000000000005209000000000000d1090000000000009b040000000000006c0e00000000000000000000000000006c0e0000000000001fd6df0000000000be03000000000000be03000000000000be0300000000000001020201000f80288ee2e01eb6f040baafe2406ce5f00060f19ee291c5cdf0";
const head = () => Uint8Array.from(HEAD.match(/../g) ?? [], (pair) => parseInt(pair, 16));

// A drawing that writes down what it was told and lets the test touch the map and a household.
function Canvas(props: MapCanvasProps) {
  const told = {
    source: Object.values(props.mapStyle.sources)[0]?.url, style: JSON.stringify(props.mapStyle),
    keys: props.points.features.map((f) => f.properties.key), bounds: props.bounds, focus: props.focus, me: props.me, picked: props.picked,
    canOpen: props.onPressHousehold !== undefined, canMark: props.onPressMap !== undefined,
  };
  return (
    <>
      <Text testID="canvas">{JSON.stringify(told)}</Text>
      <Text onPress={() => props.onPressMap?.({ latitude: -25.43, longitude: -49.27, zoom: 17.5 })}>tocar no mapa</Text>
      <Text onPress={() => props.onPressHousehold?.(HH1)}>tocar no domicílio</Text>
    </>
  );
}
const told = () => JSON.parse(screen.getByTestId("canvas").props.children as string) as {
  source: string; style: string; keys: string[]; bounds: unknown; focus: unknown; me: unknown; picked: unknown; canOpen: boolean; canMark: boolean;
};

function gps(o: { accuracy?: number } = {}): LocationPort & { asked: number } {
  const port = {
    asked: 0,
    permission: async () => ({ granted: true, precise: true }),
    current: async () => { port.asked += 1; return { latitude: -25.428471234, longitude: -49.273254112, accuracy: o.accuracy ?? 6 }; },
  };
  return port;
}

async function mount(o: { map?: boolean; location?: LocationPort; readHead?: (uri: string, bytes: number) => Promise<Uint8Array>; pick?: boolean; insets?: EdgeInsets } = {}) {
  const db = await createTestDb();
  await applyTerritory(db);
  if (o.map !== false) {
    await db.run("INSERT INTO map_file (id, version, sha256, size_bytes, path) VALUES (1, '2026-11-01', ?, 41234567, 'map/2026-11-01-abababababab.pmtiles')", ["ab".repeat(32)]);
  }
  const reads: [string, number][] = [];
  const readHead = o.readHead ?? (async (uri: string, bytes: number) => { reads.push([uri, bytes]); return head(); });
  const onPicked = jest.fn();
  const onOpenHousehold = jest.fn();
  const location = o.location ?? gps();
  const ui = <MapScreen Canvas={Canvas} readHead={readHead} onOpenHousehold={onOpenHousehold} pick={o.pick ? { onPicked } : undefined} />;
  await renderWithServices(
    o.insets ? <SafeAreaInsetsContext.Provider value={o.insets}>{ui}</SafeAreaInsetsContext.Provider> : ui,
    fakeServices({ db, location }));
  return { db, reads, onPicked, onOpenHousehold, location };
}
async function applyTerritory(db: Awaited<ReturnType<typeof createTestDb>>) {
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await applyPage(db, example<ChangesResponse>("changes-last-page.json"));
}

test("without a map file the screen says so and draws nothing", async () => {
  await mount({ map: false });
  expect(await screen.findByText(NO_MAP)).toBeTruthy();
  expect(NO_MAP).toBe("Mapa ainda não baixado");
  expect(screen.queryByTestId("canvas")).toBeNull();
  expect(screen.queryByText("Minha posição")).toBeNull();
});

test("with the map: the style points to the local file, calls nobody, and the OSM attribution is on screen", async () => {
  const t = await mount();
  await screen.findByTestId("canvas");
  expect(told().source).toBe("pmtiles://file:///data/user/0/br.rotasaude.campo/files/map/2026-11-01-abababababab.pmtiles");
  expect(told().style).not.toMatch(/https?:\/\//);
  expect(told().style).not.toMatch(/__[A-Z]+__/);
  expect(ATTRIBUTION).toBe("© OpenStreetMap");
  expect(screen.getByText(ATTRIBUTION)).toBeTruthy();
  expect(told().keys).toContain(HH1);
  // The box comes from the head of the file itself: 127 bytes, read from its plain file URI.
  expect(t.reads).toEqual([["file:///data/user/0/br.rotasaude.campo/files/map/2026-11-01-abababababab.pmtiles", 127]]);
  expect(told().bounds).toEqual({ west: -49.4, south: -25.65, east: -49.18, north: -25.34 });
});

// The map does not scroll: under a bar, "Usar este ponto" could never be touched (on a tablet, the taskbar).
test("with the map: the title and the last button stay clear of the system bars", async () => {
  await mount({ pick: true, insets: { top: 48, bottom: 120, left: 0, right: 16 } });
  await screen.findByTestId("canvas");
  expect(screen.getByRole("button", { name: "Usar este ponto" })).toBeTruthy();
  // The outermost view of the screen holds the title, the map and the buttons.
  expect(StyleSheet.flatten(screen.root?.props.style)).toMatchObject({ flex: 1, paddingTop: 48, paddingBottom: 120, paddingLeft: 0, paddingRight: 16 });
});

test("a head that cannot be read still shows the map, with no box", async () => {
  await mount({ readHead: async () => { throw new Error("EIO"); } });
  await screen.findByTestId("canvas");
  expect(told().bounds).toBeNull();
});

test("the position is asked only when the person touches 'Minha posição'", async () => {
  const t = await mount();
  await screen.findByTestId("canvas");
  expect((t.location as ReturnType<typeof gps>).asked).toBe(0);
  expect(told().me).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Minha posição" }));
  await waitFor(() => expect(told().me).toEqual({ latitude: -25.42847123, longitude: -49.27325411 }));
  expect(told().focus).toEqual({ latitude: -25.42847123, longitude: -49.27325411, zoom: 17 });
  expect((t.location as ReturnType<typeof gps>).asked).toBe(1);
});

test("no precise position: the screen says so and the map stays where it was", async () => {
  await mount({ location: gps({ accuracy: 120 }) });
  await screen.findByTestId("canvas");
  await fireEvent.press(screen.getByRole("button", { name: "Minha posição" }));
  expect(await screen.findByText(NO_FIX)).toBeTruthy();
  expect(told().me).toBeNull();
  expect(told().focus).toBeNull();
});

test("touching a household opens it; the map itself takes no touch outside the marking mode", async () => {
  const t = await mount();
  await screen.findByTestId("canvas");
  expect(told().canMark).toBe(false);
  await fireEvent.press(screen.getByText("tocar no domicílio"));
  expect(t.onOpenHousehold).toHaveBeenCalledWith(HH1);
  expect(screen.queryByText("Usar este ponto")).toBeNull();
});

test("marking mode: touch the map, then confirm — the caller gets latitude, longitude and zoom", async () => {
  const t = await mount({ pick: true });
  await screen.findByTestId("canvas");
  expect(screen.getByRole("header", { name: "Marcar o ponto do imóvel" })).toBeTruthy();
  expect(told().canOpen).toBe(false);
  expect(screen.getByRole("button", { name: "Usar este ponto" }).props.accessibilityState.disabled).toBe(true);

  await fireEvent.press(screen.getByText("tocar no mapa"));
  expect(told().picked).toEqual({ latitude: -25.43, longitude: -49.27 });
  expect(t.onPicked).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole("button", { name: "Usar este ponto" }));
  expect(t.onPicked).toHaveBeenCalledWith({ latitude: -25.43, longitude: -49.27, zoom: 17.5 });
});
