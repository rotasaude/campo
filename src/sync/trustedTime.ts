// The time the 30-day retention counts on (campo#2). The tablet's clock alone is not to be trusted: it may run ahead or
// behind, and somebody may change it. So the clock is corrected by the difference to the server measured at the last
// session (clock.ts), and the result never goes back: the latest time given is kept in meta and read as the time
// whenever the clock says less. Each session puts it back on the server's time.
//
// What this does not cover: a clock set back while the app is closed is read as the latest time seen, so the age stands
// still until the clock catches up with it — at most by as much as the clock was set back.
import type { Db } from "../db/types";

export const HIGH_WATER_KEY = "clock_high_water_ms";

export function trustedTime(deviceNow: number, skewMs: number, highWater: number | null): number {
  const corrected = deviceNow + skewMs;
  return highWater !== null && highWater > corrected ? highWater : corrected;
}

const numberOr = (value: string | undefined, fallback: number | null) => {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export async function readClock(db: Db): Promise<{ skewMs: number; highWater: number | null }> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('clock_skew_ms', ?)", [HIGH_WATER_KEY]);
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return { skewMs: numberOr(meta.get("clock_skew_ms"), 0) ?? 0, highWater: numberOr(meta.get(HIGH_WATER_KEY), null) };
}

// Written without telling the screens: it moves at every reading.
const writeHighWater = (db: Db, value: number) =>
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [HIGH_WATER_KEY, String(value)]);

// The time for a decision that must not run backwards (the territory's age); it moves the latest time seen forward.
export async function readTrustedNow(db: Db, deviceNow: number): Promise<number> {
  const { skewMs, highWater } = await readClock(db);
  const now = trustedTime(deviceNow, skewMs, highWater);
  if (highWater === null || now > highWater) await writeHighWater(db, now);
  return now;
}

// The server's time at a session: it replaces the latest time seen, also when that one ran ahead.
export async function anchorServerTime(db: Db, serverNow: number): Promise<void> {
  await writeHighWater(db, serverNow);
}
