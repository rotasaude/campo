// One sync round, one at a time: recover → session → send → download → purge.
// Sending comes before downloading: the tablet's own records leave first, and
// what the station changed meanwhile is met at send time (stale → merge).
//
// How a round ends says what the app must do next:
//   revoked           manual revocation: everything is erased and the app goes back to pairing
//   suspended         access suspended (automatic revocation, replaced device or an unknown token): the territory
//                     is erased, the queue stays until a new QR of the same host and user
//   feature_disabled  the city turned the visit off: nothing is sent, nothing is lost
//   stopped           rate limit, server or network: try again later, nothing is lost
import type { SessionResponse } from "../contract";
import { territoryRepo } from "../db/repos/territoryRepo";
import type { Db } from "../db/types";
import { log } from "../log";
import { wipeTerritory } from "../security/wipe";
import { cityOffsetMinutes, cityToday, measureSkew } from "./clock";
import { sendQueue } from "./dispatch";
import { downloadAll } from "./download";
import { FieldHttpError, type FieldClient, type HttpFailure } from "./http";
import { recoverSending } from "./outbox";
import { refreshReference } from "./reference";
import { enforceTerritoryAge, purgeAccepted } from "./retention";
import { handleStale } from "./stale";

export type RoundTrigger = "open" | "foreground" | "timer" | "button" | "after_pairing";
export type RoundOutcome =
  | { kind: "ok"; downloaded: boolean }
  | { kind: "skipped"; reason: "running" | "offline" | "locked" | "needs_wifi" }
  | { kind: "stopped"; reason: "rate_limited" | "server" | "network" }
  | { kind: "revoked" } | { kind: "suspended" } | { kind: "feature_disabled" };

export interface RoundDeps {
  db: Db;
  client: FieldClient;
  now: () => number;
  net: { isOnline(): Promise<boolean>; isWifi(): Promise<boolean> };
  isLocked: () => boolean;
  // Erases this installation (database, map, secure keys): manual revocation.
  wipeAll: () => Promise<void>;
  // Task 14: the map download. It runs behind the screen and never changes the outcome of the round.
  syncMap?: (manifest: SessionResponse["map"]) => Promise<unknown>;
}

const running = new WeakSet<Db>();

async function failed(deps: RoundDeps, failure: HttpFailure): Promise<RoundOutcome> {
  switch (failure.kind) {
    case "revoked":
      await deps.wipeAll();
      return { kind: "revoked" };
    case "suspended":
      await wipeTerritory(deps.db);
      await territoryRepo.setMeta(deps.db, "suspended", "1");
      territoryRepo.emitTerritory();
      return { kind: "suspended" };
    case "feature_disabled":
      return { kind: "feature_disabled" };
    case "rate_limited":
      return { kind: "stopped", reason: "rate_limited" };
    case "network":
      return { kind: "stopped", reason: "network" };
    default:
      // server, not_found, range, invalid: the server answered something the round cannot act on.
      return { kind: "stopped", reason: "server" };
  }
}

async function round(deps: RoundDeps): Promise<RoundOutcome> {
  const { db, client } = deps;
  // Even offline: 30 days without a complete download and the copy of the territory goes.
  await enforceTerritoryAge(db, deps.now());
  if (!(await deps.net.isOnline())) return { kind: "skipped", reason: "offline" };
  await recoverSending(db);

  try {
    const session = await client.session();
    const skew = measureSkew(session.server_time, deps.now());
    const offset = cityOffsetMinutes(session.server_time);
    await db.tx(async (tx) => {
      await tx.run(
        "INSERT INTO session (id, body, fetched_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
        [JSON.stringify(session), new Date(deps.now()).toISOString()]);
      await territoryRepo.setMeta(tx, "clock_skew_ms", String(skew));
      await territoryRepo.setMeta(tx, "city_offset_min", String(offset));
      // The token works: whatever suspended this tablet before is over.
      await tx.run("DELETE FROM meta WHERE key = ?", ["suspended"]);
    });
    await refreshReference(db, client, session.reference_version);

    const visitsOn = session.features.home_visits;
    if (visitsOn) {
      const sent = await sendQueue({ db, client, onStale: (item, result) => handleStale(db, item, result) });
      if (sent.stop === "rate_limited") return { kind: "stopped", reason: "rate_limited" };
      if (sent.stop === "http") return failed(deps, sent.failure ?? { kind: "network" });
    }

    // The first load is the big one: it waits for Wi-Fi unless the person allowed mobile data.
    const initial = (await territoryRepo.getMeta(db, "cursor")) === null;
    if (initial && !(await deps.net.isWifi()) && (await territoryRepo.getMeta(db, "mobile_data")) !== "1") {
      return { kind: "skipped", reason: "needs_wifi" };
    }
    await downloadAll({ db, client, now: deps.now });
    await purgeAccepted(db, cityToday(deps.now(), skew, offset));

    // The reason of a failure may carry a path or a message of the platform: only the fact is logged.
    if (deps.syncMap) void deps.syncMap(session.map).catch(() => log("map.download.failed"));
    return visitsOn ? { kind: "ok", downloaded: true } : { kind: "feature_disabled" };
  } catch (err) {
    if (err instanceof FieldHttpError) return failed(deps, err.failure);
    throw err;
  }
}

export async function runRound(deps: RoundDeps, trigger: RoundTrigger): Promise<RoundOutcome> {
  if (deps.isLocked()) return { kind: "skipped", reason: "locked" };
  if (running.has(deps.db)) return { kind: "skipped", reason: "running" };
  running.add(deps.db);
  log("sync.round.start", { code: trigger });
  try {
    const outcome = await round(deps);
    log("sync.round.end", { code: "reason" in outcome ? `${outcome.kind}:${outcome.reason}` : outcome.kind });
    return outcome;
  } catch (err) {
    log("sync.round.end", { code: "error" });
    throw err;
  } finally {
    running.delete(deps.db);
  }
}
