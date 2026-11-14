import { SKEW_WARN_MS, cityNowIso, cityOffsetMinutes, cityToday, measureSkew, needsClockWarning } from "./clock";

test("cityNowIso uses the city offset, not the device zone", () => {
  expect(cityNowIso(Date.parse("2026-11-13T12:00:00Z"), 0, -180)).toBe("2026-11-13T09:00:00-03:00");
  expect(cityNowIso(Date.parse("2026-11-13T12:00:00.987Z"), 0, 0)).toBe("2026-11-13T12:00:00+00:00"); // whole seconds
  expect(cityNowIso(Date.parse("2026-11-13T12:00:00Z"), 0, 330)).toBe("2026-11-13T17:30:00+05:30");
  expect(cityNowIso(Date.parse("2026-11-13T12:00:00Z"), 0, -240)).toBe("2026-11-13T08:00:00-04:00");
});

test("the city's day is not the device's: 01:30 UTC is still yesterday in the city", () => {
  const now = Date.parse("2026-11-14T01:30:00Z");
  expect(cityToday(now, 0, -180)).toBe("2026-11-13");
  expect(cityToday(now, 0, 0)).toBe("2026-11-14");
  expect(cityNowIso(now, 0, -180)).toBe("2026-11-13T22:30:00-03:00");
});

test("cityOffsetMinutes reads the suffix of server_time", () => {
  expect(cityOffsetMinutes("2026-11-12T12:00:00Z")).toBe(0);
  expect(cityOffsetMinutes("2026-11-12T09:00:00-03:00")).toBe(-180);
  expect(cityOffsetMinutes("2026-11-12T09:00:00.123-04:00")).toBe(-240);
  expect(cityOffsetMinutes("2026-11-12T17:30:00+05:30")).toBe(330);
  expect(() => cityOffsetMinutes("2026-11-12T12:00:00")).toThrow();
  expect(() => cityOffsetMinutes("ontem")).toThrow();
});

test("skew of 7 min corrects occurred_at and asks for a warning", () => {
  const device = Date.parse("2026-11-13T12:00:00Z"); // the tablet's clock, 7 minutes behind
  const skew = measureSkew("2026-11-13T09:07:00-03:00", device);
  expect(skew).toBe(7 * 60_000);
  expect(needsClockWarning(skew)).toBe(true);
  expect(cityNowIso(device, skew, -180)).toBe("2026-11-13T09:07:00-03:00");
  // A tablet ahead of the server is corrected the other way.
  const ahead = measureSkew("2026-11-13T11:53:00Z", device);
  expect(ahead).toBe(-7 * 60_000);
  expect(needsClockWarning(ahead)).toBe(true);
  expect(cityNowIso(device, ahead, 0)).toBe("2026-11-13T11:53:00+00:00");
});

test("up to 5 minutes of difference is not worth a warning", () => {
  expect(SKEW_WARN_MS).toBe(300_000);
  expect(needsClockWarning(300_000)).toBe(false);
  expect(needsClockWarning(-300_000)).toBe(false);
  expect(needsClockWarning(300_001)).toBe(true);
  expect(needsClockWarning(0)).toBe(false);
});
