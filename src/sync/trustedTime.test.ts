import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { HIGH_WATER_KEY, anchorServerTime, readTrustedNow, trustedTime } from "./trustedTime";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const meta = async (db: Db, key: string) => (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? null;
const setMeta = (db: Db, key: string, value: string) =>
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);

test("trustedTime: the tablet's clock corrected by the server's difference, never before the latest time seen", () => {
  expect(trustedTime(T0, 0, null)).toBe(T0);
  expect(trustedTime(T0, 7 * MIN, null)).toBe(T0 + 7 * MIN);
  expect(trustedTime(T0, -10 * DAY, null)).toBe(T0 - 10 * DAY);
  // A clock set back reads as the latest time seen; one that moved on reads as itself.
  expect(trustedTime(T0, 0, T0 + 3 * DAY)).toBe(T0 + 3 * DAY);
  expect(trustedTime(T0 + 4 * DAY, 0, T0 + 3 * DAY)).toBe(T0 + 4 * DAY);
});

test("readTrustedNow uses the measured difference and keeps the latest time it gave", async () => {
  const db = await createTestDb();
  // Before any session: no difference known, the tablet's clock as it is.
  expect(await readTrustedNow(db, T0)).toBe(T0);
  await setMeta(db, "clock_skew_ms", String(-10 * DAY)); // the tablet runs ten days ahead of the server
  expect(await readTrustedNow(db, T0 + 12 * DAY)).toBe(T0 + 2 * DAY);
  expect(await meta(db, HIGH_WATER_KEY)).toBe(String(T0 + 2 * DAY));
});

test("a clock set back between two openings never moves the time back", async () => {
  const db = await createTestDb();
  expect(await readTrustedNow(db, T0 + 20 * DAY)).toBe(T0 + 20 * DAY);
  // Next opening: somebody set the tablet back fifteen days.
  expect(await readTrustedNow(db, T0 + 5 * DAY)).toBe(T0 + 20 * DAY);
  // It goes on from there once the clock passes the latest time seen.
  expect(await readTrustedNow(db, T0 + 21 * DAY)).toBe(T0 + 21 * DAY);
});

test("the server's time replaces the latest time seen, even when that one ran ahead", async () => {
  const db = await createTestDb();
  // The tablet ran ahead before its first session and was believed.
  expect(await readTrustedNow(db, T0 + 9 * DAY)).toBe(T0 + 9 * DAY);
  await anchorServerTime(db, T0);
  expect(await meta(db, HIGH_WATER_KEY)).toBe(String(T0));
  await setMeta(db, "clock_skew_ms", String(-9 * DAY));
  expect(await readTrustedNow(db, T0 + 9 * DAY + MIN)).toBe(T0 + MIN);
});
