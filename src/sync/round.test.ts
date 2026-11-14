import type { ChangesResponse, ReferenceResponse, SessionResponse, UploadItem } from "../contract";
import { example } from "../contract/fixtures";
import { outboxRepo } from "../db/repos/outboxRepo";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { SECURE_KEYS } from "../security/secureStore";
import { memorySecure } from "../security/testing";
import { FieldHttpError, type FieldClient, type HttpFailure } from "./http";
import { enqueue } from "./outbox";
import { runRound, type RoundDeps } from "./round";
import { accepted, exampleItems, newUuid } from "./testing";

const SESSION = example<SessionResponse>("session-acs.json");
const REFERENCE = example<ReferenceResponse>("reference.json");
const FIRST = example<ChangesResponse>("changes-first-page.json");
const LAST = example<ChangesResponse>("changes-last-page.json");
const VISIT = exampleItems("upload-home-visit-resident.json")[0];
const NOW = Date.parse("2026-11-12T12:00:00Z");

type Fail = Partial<Record<"session" | "uploads" | "changes" | "reference", HttpFailure>>;
async function setup(o: { session?: SessionResponse; fail?: Fail; wifi?: boolean; online?: boolean; locked?: boolean } = {}) {
  const db = await createTestDb();
  const secure = memorySecure(Object.fromEntries(Object.values(SECURE_KEYS).map((key) => [key, "x"])));
  const calls: string[] = [];
  const fail = o.fail ?? {};
  const step = <T>(name: keyof Fail, value: () => T) => async (): Promise<T> => {
    calls.push(name);
    if (fail[name]) throw new FieldHttpError(fail[name]!);
    return value();
  };
  const pages = [FIRST, LAST];
  const client: FieldClient = {
    session: step("session", () => o.session ?? SESSION),
    uploads: async (items: UploadItem[]) => { calls.push("uploads"); if (fail.uploads) throw new FieldHttpError(fail.uploads); return { results: items.map((i) => accepted(i)) } as never; },
    changes: step("changes", () => pages.shift() ?? LAST),
    reference: step("reference", () => REFERENCE),
    mapRequest: async () => ({ url: "", headers: {} }),
  };
  const wipeAll = jest.fn(async () => { for (const key of Object.values(SECURE_KEYS)) await secure.delete(key); });
  const syncMap = jest.fn(async () => "none");
  const deps: RoundDeps = {
    db, client, now: () => NOW, wipeAll, syncMap,
    net: { isOnline: async () => o.online ?? true, isWifi: async () => o.wifi ?? true },
    isLocked: () => o.locked ?? false,
  };
  return { db, deps, calls, wipeAll, syncMap, secure };
}
const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const meta = async (db: Db, key: string) => (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? null;
const pendingVisit = (db: Db) => enqueue(db, { type: "home_visit", body: VISIT.body }, newUuid);

test("upload before download", async () => {
  const t = await setup();
  await pendingVisit(t.db);
  expect(await runRound(t.deps, "button")).toEqual({ kind: "ok", downloaded: true });
  expect(t.calls).toEqual(["session", "reference", "uploads", "changes", "changes"]);
  expect(await outboxRepo.count(t.db)).toBe(0);
  expect(await count(t.db, "households")).toBe(1);
  // The session is kept, with the clock difference and the city's offset.
  expect(JSON.parse((await t.db.get<{ body: string }>("SELECT body FROM session WHERE id = 1"))!.body)).toEqual(SESSION);
  expect([await meta(t.db, "clock_skew_ms"), await meta(t.db, "city_offset_min")]).toEqual(["0", "0"]);
  expect(t.syncMap).toHaveBeenCalledWith(SESSION.map);
});

test("second round while one runs is skipped", async () => {
  const t = await setup();
  const [first, second] = await Promise.all([runRound(t.deps, "open"), runRound(t.deps, "timer")]);
  expect(first).toEqual({ kind: "ok", downloaded: true });
  expect(second).toEqual({ kind: "skipped", reason: "running" });
  expect(t.calls.filter((c) => c === "session")).toHaveLength(1);
  // The lock is released: the next one runs.
  expect((await runRound(t.deps, "button")).kind).toBe("ok");
});

test("offline or locked: nothing is asked of the server", async () => {
  const offline = await setup({ online: false });
  expect(await runRound(offline.deps, "timer")).toEqual({ kind: "skipped", reason: "offline" });
  const locked = await setup({ locked: true });
  expect(await runRound(locked.deps, "timer")).toEqual({ kind: "skipped", reason: "locked" });
  expect([...offline.calls, ...locked.calls]).toEqual([]);
});

test("device_revoked wipes everything including the outbox", async () => {
  const t = await setup({ fail: { session: { kind: "revoked" } } });
  await pendingVisit(t.db);
  expect(await runRound(t.deps, "open")).toEqual({ kind: "revoked" });
  expect(t.wipeAll).toHaveBeenCalledTimes(1);
  expect(t.secure.data.size).toBe(0);
  expect(t.calls).toEqual(["session"]);
});

test.each<["session" | "uploads" | "changes"]>([["session"], ["uploads"], ["changes"]])(
  "device_suspended and invalid_token wipe territory but keep the outbox (failing at %s)", async (where) => {
    const t = await setup({ fail: { [where]: { kind: "suspended" } } });
    await t.db.run("INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('old', 'm', '{}', 'x', '1')");
    const kept = await pendingVisit(t.db);
    // Failing at the download, the visit was already sent and accepted; an item waiting for the person is what is left.
    const waiting = await enqueue(t.db, { type: "patient", body: {} }, newUuid);
    await outboxRepo.update(t.db, waiting.seq, { state: "needs_attention", error: "invalid_cpf" });
    const outcome = await runRound(t.deps, "open");
    expect(outcome).toEqual({ kind: "suspended" });
    expect(await count(t.db, "households")).toBe(0);
    expect(await meta(t.db, "suspended")).toBe("1");
    expect(t.wipeAll).not.toHaveBeenCalled();
    const left = (await outboxRepo.all(t.db)).map((i) => i.client_uuid);
    expect(left).toEqual(where === "changes" ? [waiting.client_uuid] : [kept.client_uuid, waiting.client_uuid]);
  });

test("a round that works again clears the suspended mark", async () => {
  const t = await setup();
  await t.db.run("INSERT INTO meta (key, value) VALUES ('suspended', '1')");
  expect((await runRound(t.deps, "after_pairing")).kind).toBe("ok");
  expect(await meta(t.db, "suspended")).toBeNull();
});

test("403 feature_disabled keeps the queue", async () => {
  const t = await setup({ fail: { uploads: { kind: "feature_disabled" } } });
  const kept = await pendingVisit(t.db);
  expect(await runRound(t.deps, "button")).toEqual({ kind: "feature_disabled" });
  expect(await outboxRepo.bySeq(t.db, kept.seq)).toMatchObject({ state: "pending" });
  expect(t.calls).not.toContain("changes");
});

test("home_visits off in the session: nothing is sent, the download goes on", async () => {
  const t = await setup({ session: { ...SESSION, features: { ...SESSION.features, home_visits: false } } });
  const kept = await pendingVisit(t.db);
  expect(await runRound(t.deps, "button")).toEqual({ kind: "feature_disabled" });
  expect(t.calls).toEqual(["session", "reference", "changes", "changes"]);
  expect(await outboxRepo.bySeq(t.db, kept.seq)).toMatchObject({ state: "pending", attempts: 0 });
  expect(await count(t.db, "households")).toBe(1);
});

test.each<[HttpFailure, string]>([
  [{ kind: "server", status: 503, code: "city_schema_behind" }, "server"],
  [{ kind: "network" }, "network"],
  [{ kind: "rate_limited" }, "rate_limited"],
  [{ kind: "invalid", status: 422, code: "invalid_request" }, "server"],
])("5xx and network keep everything and stop: %j", async (failure, reason) => {
  for (const where of ["session", "uploads", "changes"] as const) {
    const t = await setup({ fail: { [where]: failure } });
    await t.db.run("INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('old', 'm', '{}', 'x', '1')");
    const kept = await pendingVisit(t.db);
    expect([where, await runRound(t.deps, "timer")]).toEqual([where, { kind: "stopped", reason }]);
    expect(await count(t.db, "households")).toBeGreaterThanOrEqual(1);
    if (where !== "changes") expect(await outboxRepo.bySeq(t.db, kept.seq)).toMatchObject({ state: "pending" });
    expect(t.wipeAll).not.toHaveBeenCalled();
    expect(await meta(t.db, "suspended")).toBeNull();
  }
});

test("initial load without wifi waits unless mobile data is allowed", async () => {
  const t = await setup({ wifi: false });
  await pendingVisit(t.db);
  expect(await runRound(t.deps, "after_pairing")).toEqual({ kind: "skipped", reason: "needs_wifi" });
  expect(t.calls).toEqual(["session", "reference", "uploads"]); // the queue was sent before waiting
  expect(await outboxRepo.count(t.db)).toBe(0);

  await t.db.run("UPDATE meta SET value = '1' WHERE key = 'mobile_data'");
  expect(await runRound(t.deps, "button")).toEqual({ kind: "ok", downloaded: true });

  // With a cursor (not the initial load) the incremental download does not wait for wifi.
  const later = await setup({ wifi: false });
  await later.db.run("INSERT INTO meta (key, value) VALUES ('cursor', 'c')");
  expect(await runRound(later.deps, "timer")).toEqual({ kind: "ok", downloaded: true });
});

test("reference refreshed only when the version changes", async () => {
  const t = await setup();
  await runRound(t.deps, "open");
  await runRound(t.deps, "timer");
  expect(t.calls.filter((c) => c === "reference")).toHaveLength(1);
});

test("the round measures the clock against server_time and keeps the city's offset", async () => {
  const t = await setup({ session: { ...SESSION, server_time: "2026-11-12T09:07:00-03:00" } }); // the tablet says 12:00Z = 09:00 in the city
  await runRound(t.deps, "open");
  expect([await meta(t.db, "clock_skew_ms"), await meta(t.db, "city_offset_min")]).toEqual([String(7 * 60_000), "-180"]);
});

test("accepted visits of earlier days are purged at the end of a round, by the city's day", async () => {
  const t = await setup();
  for (const [uuid, day] of [["old", "2026-11-11"], ["today", "2026-11-12"]]) {
    await t.db.run("INSERT INTO local_visits (client_uuid, city_day, occurred_at, summary, state) VALUES (?, ?, 't', '{}', 'accepted')", [uuid, day]);
  }
  await runRound(t.deps, "open");
  expect(await t.db.all("SELECT client_uuid FROM local_visits")).toEqual([{ client_uuid: "today" }]);
});

test("a territory older than 30 days is wiped at the start of the round, even offline", async () => {
  const t = await setup({ online: false });
  await t.db.run("INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('old', 'm', '{}', 'x', '1')");
  await t.db.run("INSERT INTO meta (key, value) VALUES ('last_download_ok_at', '2026-10-01T12:00:00.000Z')");
  const kept = await pendingVisit(t.db);
  await runRound(t.deps, "timer");
  expect(await count(t.db, "households")).toBe(0);
  expect((await outboxRepo.all(t.db)).map((i) => i.client_uuid)).toEqual([kept.client_uuid]);
});

test("a failing map sync never changes the outcome of the round", async () => {
  const t = await setup();
  t.syncMap.mockRejectedValueOnce(new Error("disk full"));
  expect(await runRound(t.deps, "open")).toEqual({ kind: "ok", downloaded: true });
});
