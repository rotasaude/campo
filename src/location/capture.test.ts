import { GPS_TIMEOUT_MS, MAX_ACCURACY_M, captureGps, mapTapLocation, roundAccuracy, roundCoord, type LocationPort } from "./capture";

const port = (o: Partial<{ granted: boolean; precise: boolean; accuracy: number | null; fails: boolean; never: boolean }> = {}): LocationPort & { asked: number } => {
  const p = {
    asked: 0,
    permission: async () => ({ granted: o.granted ?? true, precise: o.precise ?? true }),
    current: () => {
      p.asked += 1;
      if (o.never) return new Promise<never>(() => undefined);
      if (o.fails) return Promise.reject(new Error("no provider"));
      return Promise.resolve({ latitude: -25.428471234567, longitude: -49.273254112233, accuracy: o.accuracy === undefined ? 8.46 : o.accuracy });
    },
  };
  return p;
};

test("the limits are the contract's: 15 s and 50 m", () => {
  expect(GPS_TIMEOUT_MS).toBe(15_000);
  expect(MAX_ACCURACY_M).toBe(50);
});

test("roundCoord keeps at most 8 decimals", () => {
  expect(roundCoord(-25.428471234567)).toBe(-25.42847123);
  expect(roundCoord(-49.273254118)).toBe(-49.27325412);
  let seed = 7;
  const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 10_000; i += 1) {
    const x = roundCoord(-74 + next() * 40);
    expect(JSON.stringify(x)).toMatch(/^-?\d+(\.\d{1,8})?$/);
  }
});

test("roundAccuracy keeps one decimal inside 0..10000", () => {
  expect(roundAccuracy(8.46)).toBe(8.5);
  expect(roundAccuracy(-3)).toBe(0);
  expect(roundAccuracy(123456)).toBe(10000);
});

test("a precise reading becomes a gps location, rounded, always with accuracy_m", async () => {
  expect(await captureGps(port())).toEqual({ latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" });
});

test("permission denied or only approximate → null, and the position is not even asked", async () => {
  const denied = port({ granted: false });
  expect(await captureGps(denied)).toBeNull();
  expect(denied.asked).toBe(0);
  const coarse = port({ precise: false });
  expect(await captureGps(coarse)).toBeNull();
  expect(coarse.asked).toBe(0);
});

test("accuracy 51 m → null, 50 m → location, unknown accuracy → null", async () => {
  expect(await captureGps(port({ accuracy: 51 }))).toBeNull();
  expect((await captureGps(port({ accuracy: 50 })))?.accuracy_m).toBe(50);
  expect(await captureGps(port({ accuracy: null }))).toBeNull();
});

test("a device that gives no position → null", async () => {
  expect(await captureGps(port({ fails: true }))).toBeNull();
});

test("timeout after 15 s → null", async () => {
  jest.useFakeTimers();
  try {
    const result = captureGps(port({ never: true }));
    await jest.advanceTimersByTimeAsync(GPS_TIMEOUT_MS - 1);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await result).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("a point marked on the map has source map and the resolution of the touch as accuracy_m", () => {
  const near = mapTapLocation(-25.428471234567, -49.273254112233, 18);
  expect(near).toEqual({ latitude: -25.42847123, longitude: -49.27325411, accuracy_m: roundAccuracy((156543.03392 * Math.cos((-25.428471234567 * Math.PI) / 180) / 2 ** 18) * 24), source: "map" });
  expect(near.accuracy_m).toBeGreaterThan(0);
  // Far away the touch is worth kilometres: the value stays inside the contract's range.
  expect(mapTapLocation(0, 0, 0).accuracy_m).toBe(10000);
  expect(mapTapLocation(-25, -49, 12).accuracy_m!).toBeGreaterThan(near.accuracy_m!);
});
