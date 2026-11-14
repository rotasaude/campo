import { LOCK_AFTER_MS, shouldLock } from "./lock";

test("shouldLock: 4:59 no, 5:00 yes, cold start (null) yes", () => {
  const left = 1_000_000;
  expect(LOCK_AFTER_MS).toBe(300_000);
  expect(shouldLock(left, left + 4 * 60_000 + 59_000)).toBe(false);
  expect(shouldLock(left, left + 5 * 60_000)).toBe(true);
  expect(shouldLock(left, left + 60 * 60_000)).toBe(true);
  expect(shouldLock(null, left)).toBe(true);
});

test("a clock set back while the app was away locks", () => {
  expect(shouldLock(1_000_000, 999_000)).toBe(true);
  expect(shouldLock(1_000_000, 1_000_000)).toBe(false);
});
