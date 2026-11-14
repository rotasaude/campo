import { PMTILES_HEADER_BYTES, pmtilesBounds } from "./pmtilesHeader";

// The first 127 bytes of a real PMTiles v3 file (an extract of Curitiba made in the technical proof).
const CURITIBA = "504d54696c6573037f000000000000005209000000000000d1090000000000009b040000000000006c0e00000000000000000000000000006c0e0000000000001fd6df0000000000be03000000000000be03000000000000be0300000000000001020201000f80288ee2e01eb6f040baafe2406ce5f00060f19ee291c5cdf0";
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

test("the header is 127 bytes", () => expect(PMTILES_HEADER_BYTES).toBe(127));

test("reads the box the file covers from a real header", () => {
  expect(pmtilesBounds(bytes(CURITIBA))).toEqual({ west: -49.4, south: -25.65, east: -49.18, north: -25.34 });
});

test("anything that is not a PMTiles v3 header gives no box", () => {
  expect(pmtilesBounds(bytes(CURITIBA).slice(0, 100))).toBeNull();
  expect(pmtilesBounds(bytes(CURITIBA.replace(/^504d/, "0000")))).toBeNull();
  expect(pmtilesBounds(bytes(CURITIBA.replace(/^(.{14})03/, "$102")))).toBeNull();
  expect(pmtilesBounds(new Uint8Array(127))).toBeNull();
});

test("a box that is empty or outside the world gives no box", () => {
  const zeroed = bytes(CURITIBA);
  zeroed.fill(0, 102, 118);
  expect(pmtilesBounds(zeroed)).toBeNull();
});
