import { syncLocked, LOCK_AFTER_MS, shouldLock } from "./lock";

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

// Review I4: the PIN is asked when the app COMES BACK, but a tablet left in the background past five minutes already
// owes it — nothing may be read from or sent to the server from then on.
test("syncing is locked without the PIN, and from five minutes in the background even before the app comes back", () => {
  const t0 = 1_000_000;
  expect(syncLocked(false, null, t0)).toBe(true);
  expect(syncLocked(true, null, t0)).toBe(false); // in the foreground
  expect(syncLocked(true, t0, t0 + LOCK_AFTER_MS - 1)).toBe(false);
  expect(syncLocked(true, t0, t0 + LOCK_AFTER_MS)).toBe(true);
  expect(syncLocked(true, t0, t0 - 1)).toBe(true); // a clock that went backwards
});
