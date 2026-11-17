import { syncLocked, LOCK_AFTER_MS, shouldLock, type Instant } from "./lock";

// `wall` is the tablet's clock, `mono` a clock of the process that only goes forward (campo#2).
const at = (wall: number, mono = wall): Instant => ({ wall, mono });

test("shouldLock: 4:59 no, 5:00 yes, cold start (null) yes", () => {
  const left = at(1_000_000);
  expect(LOCK_AFTER_MS).toBe(300_000);
  expect(shouldLock(left, at(1_000_000 + 4 * 60_000 + 59_000))).toBe(false);
  expect(shouldLock(left, at(1_000_000 + 5 * 60_000))).toBe(true);
  expect(shouldLock(left, at(1_000_000 + 60 * 60_000))).toBe(true);
  expect(shouldLock(null, at(1_000_000))).toBe(true);
});

test("a clock set back while the app was away locks", () => {
  expect(shouldLock(at(1_000_000), at(999_000, 1_000_000))).toBe(true);
  expect(shouldLock(at(1_000_000), at(1_000_000))).toBe(false);
});

// campo#2: setting the tablet's clock back by a little less than the time away does not dodge the PIN.
test("five minutes on the process's clock lock, whatever the tablet's clock says", () => {
  const left = at(1_000_000, 50_000);
  // Five minutes passed; somebody set the tablet back four of them.
  expect(shouldLock(left, { wall: 1_000_000 + 60_000, mono: 50_000 + 5 * 60_000 })).toBe(true);
  expect(shouldLock(left, { wall: 1_000_000 + 60_000, mono: 50_000 + 60_000 })).toBe(false);
  // The tablet asleep: the process's clock may stand still, and the tablet's clock still counts.
  expect(shouldLock(left, { wall: 1_000_000 + 5 * 60_000, mono: 50_000 })).toBe(true);
  // A process's clock that went back is not one to trust either.
  expect(shouldLock(left, { wall: 1_000_000 + 60_000, mono: 49_000 })).toBe(true);
});

// Review I4: the PIN is asked when the app COMES BACK, but a tablet left in the background past five minutes already
// owes it — nothing may be read from or sent to the server from then on.
test("syncing is locked without the PIN, and from five minutes in the background even before the app comes back", () => {
  const t0 = 1_000_000;
  expect(syncLocked(false, null, at(t0))).toBe(true);
  expect(syncLocked(true, null, at(t0))).toBe(false); // in the foreground
  expect(syncLocked(true, at(t0), at(t0 + LOCK_AFTER_MS - 1))).toBe(false);
  expect(syncLocked(true, at(t0), at(t0 + LOCK_AFTER_MS))).toBe(true);
  expect(syncLocked(true, at(t0), at(t0 - 1, t0))).toBe(true); // a clock that went backwards
  expect(syncLocked(true, at(t0), { wall: t0 + 60_000, mono: t0 + LOCK_AFTER_MS })).toBe(true);
});
