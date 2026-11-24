import type { ChangesResponse, SessionResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { createTestDb } from "../../db/testing/sqljsDb";
import type { Db } from "../../db/types";
import { applyPage } from "../../sync/download";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { loadHome } from "./homeData";

const SESSION = example<SessionResponse>("session-acs.json");
const NOW = Date.parse("2026-11-14T15:00:00Z");
const DAY = 86_400_000;

async function setup(o: { session?: SessionResponse; offsetMin?: number; skewMs?: number; lastOk?: string | null } = {}) {
  const db = await createTestDb();
  await db.run("INSERT INTO session (id, body, fetched_at) VALUES (1, ?, 't')", [JSON.stringify(o.session ?? SESSION)]);
  const meta = (key: string, value: string) => db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  await meta("city_offset_min", String(o.offsetMin ?? -180));
  await meta("clock_skew_ms", String(o.skewMs ?? 0));
  if (o.lastOk !== null) await meta("last_download_ok_at", o.lastOk ?? "2026-11-14T12:30:00.000Z");
  return db;
}
const queue = async (db: Db, states: string[]) => {
  for (const state of states) {
    const item = await enqueue(db, { type: "home_visit", body: {} }, newUuid);
    await outboxRepo.update(db, item.seq, { state: state as never });
  }
};

test("home shows counters, last sync and the micro-areas of the session", async () => {
  const db = await setup();
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await applyPage(db, example<ChangesResponse>("changes-last-page.json"));
  await db.run("UPDATE meta SET value = '2026-11-14T12:30:00.000Z' WHERE key = 'last_download_ok_at'");
  await queue(db, ["pending", "pending", "sending", "blocked", "needs_attention", "conflict", "conflict"]);
  const home = await loadHome(db, NOW);
  expect(home.microAreas).toEqual(SESSION.teams.flatMap((team) => team.micro_areas.map((m) => ({ id: m.id, code: m.code, name: m.name }))));
  expect(home.toVisit).toBe(example<ChangesResponse>("changes-last-page.json").who_to_visit ? 2 : 0);
  expect([home.pending, home.attention, home.conflicts]).toEqual([4, 1, 2]);
  expect(home.lastSync).toBe("14/11/2026 09:30"); // the city's clock, not the tablet's zone
  expect([home.territoryWarning, home.clockWarning, home.appUpdate, home.visitsOff]).toEqual([null, null, false, false]);
});

test("the day-25 warning names the last day to sync; before it there is none", async () => {
  const last = "2026-10-01T15:00:00.000Z";
  const at = (days: number) => Date.parse(last) + days * DAY;
  const db = await setup({ lastOk: last });
  expect((await loadHome(db, at(24))).territoryWarning).toBeNull();
  expect((await loadHome(db, at(25))).territoryWarning).toBe("Sincronize até 31/10/2026: depois disso o território some do tablet");
  expect((await loadHome(db, at(29))).territoryWarning).toBe("Sincronize até 31/10/2026: depois disso o território some do tablet");
});

// campo#2: the warning is the server's day 25, and a clock set back does not take it away.
test("the day-25 warning counts on the server's clock and stays when the tablet is set back", async () => {
  const last = "2026-10-01T15:00:00.000Z";
  const at = (days: number) => Date.parse(last) + days * DAY;
  const ahead = await setup({ lastOk: last, skewMs: -10 * DAY });
  expect((await loadHome(ahead, at(34))).territoryWarning).toBeNull(); // the tablet reads 34, the server 24
  expect((await loadHome(ahead, at(35))).territoryWarning).not.toBeNull();

  const setBack = await setup({ lastOk: last });
  await setBack.run("INSERT INTO meta (key, value) VALUES ('clock_high_water_ms', ?)", [String(at(26))]);
  expect((await loadHome(setBack, at(3))).territoryWarning).toBe("Sincronize até 31/10/2026: depois disso o território some do tablet");
});

test("never synced: no last sync and no warning", async () => {
  const db = await setup({ lastOk: null });
  const home = await loadHome(db, NOW);
  expect([home.lastSync, home.territoryWarning]).toEqual([null, null]);
});

test("the clock warning says by how many minutes, only above 5", async () => {
  expect((await loadHome(await setup({ skewMs: 5 * 60_000 }), NOW)).clockWarning).toBeNull();
  expect((await loadHome(await setup({ skewMs: 7 * 60_000 }), NOW)).clockWarning).toBe("O relógio do tablet está 7 min diferente do servidor");
  expect((await loadHome(await setup({ skewMs: -125 * 60_000 - 20_000 }), NOW)).clockWarning).toBe("O relógio do tablet está 125 min diferente do servidor");
});

test("home_visits off in the session and a refused reference are reported", async () => {
  const db = await setup({ session: { ...SESSION, features: { ...SESSION.features, home_visits: false } } });
  await db.run("INSERT INTO meta (key, value) VALUES ('reference_refused_version', 'x')");
  const home = await loadHome(db, NOW);
  expect([home.visitsOff, home.appUpdate]).toEqual([true, true]);
});

test("without a session (the first load has not happened) everything is empty, nothing throws", async () => {
  const db = await createTestDb();
  expect(await loadHome(db, NOW)).toEqual({
    microAreas: [], toVisit: 0, pending: 0, attention: 0, conflicts: 0, lastSync: null, territoryWarning: null, clockWarning: null,
    appUpdate: false, visitsOff: false, activitiesOn: false, registryOn: false, vectorDue: null, ovitrapsOn: false, collarsDue: null,
  });
});
