// One sync round, one at a time: recover → session → send → download → purge.
// Sending comes before downloading: the tablet's own records leave first, and
// what the station changed meanwhile is met at send time (stale → merge).
//
// How a round ends says what the app must do next:
//   revoked           manual revocation: everything is erased and the app goes back to pairing
//   suspended         access suspended (automatic revocation, replaced device or an unknown token): the territory
//                     is erased, the queue stays until a new QR of the same host and user
//   feature_disabled  the city turned the visit off: nothing is sent, nothing is lost
//   stopped           rate limit, server or network: try again later, nothing is lost; app_outdated: the server speaks
//                     another contract, and nothing is exchanged with it until the app is updated
import type { SessionResponse } from "../contract";
import { dbEvents } from "../db/events";
import { territoryRepo } from "../db/repos/territoryRepo";
import type { Db } from "../db/types";
import { log } from "../log";
import { wipeTerritory } from "../security/wipe";
import { cityOffsetMinutes, cityToday, measureSkew } from "./clock";
import { sendQueue } from "./dispatch";
import { downloadAll } from "./download";
import { FieldHttpError, speaksOurContract, type FieldClient, type HttpFailure } from "./http";
import { recoverSending } from "./outbox";
import { refreshReference } from "./reference";
import { enforceTerritoryAge, purgeAccepted } from "./retention";
import { handleStale } from "./stale";
import { anchorServerTime } from "./trustedTime";

export type RoundTrigger = "open" | "foreground" | "timer" | "button" | "after_pairing";
export type RoundOutcome =
  | { kind: "ok"; downloaded: boolean }
  | { kind: "skipped"; reason: "running" | "offline" | "locked" | "needs_wifi" }
  | { kind: "stopped"; reason: "rate_limited" | "server" | "network" | "app_outdated" }
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

// Said while the server speaks another contract (Q83): not the notice of the reference — here nothing syncs.
export const CONTRACT_UPDATE_NOTICE = "Atualize o app: esta versão não conversa mais com o servidor da secretaria. O que você registrar fica guardado no tablet até a atualização.";

const running = new WeakSet<Db>();

// The reference is what the forms read, not what the tablet owes: when the server answers and cannot deliver it, the
// previous one stays (as with a reference the app cannot read, Q71) and the round goes on to send. Without a network,
// with the rate limit or without access there is no round to go on with.
async function refreshReferenceOrKeep(deps: RoundDeps, version: string): Promise<void> {
  try {
    await refreshReference(deps.db, deps.client, version);
  } catch (err) {
    if (!(err instanceof FieldHttpError)) throw err;
    const kind = err.failure.kind;
    if (kind !== "server" && kind !== "invalid" && kind !== "not_found" && kind !== "range") throw err;
  }
}

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
  // Even offline: 30 days without a complete download and the copy of the territory goes. Online, the age is judged
  // after the session, with the clock it measures (campo#2); without a session, with the last difference known.
  if (!(await deps.net.isOnline())) {
    await enforceTerritoryAge(db, deps.now());
    return { kind: "skipped", reason: "offline" };
  }
  await recoverSending(db);

  try {
    let session: SessionResponse;
    try {
      session = await client.session();
    } catch (err) {
      await enforceTerritoryAge(db, deps.now());
      throw err;
    }
    // Another contract: its answers are not this app's to read. Nothing is kept from it, sent to it or downloaded.
    if (!speaksOurContract(session)) {
      await enforceTerritoryAge(db, deps.now());
      return { kind: "stopped", reason: "app_outdated" };
    }
    const skew = measureSkew(session.server_time, deps.now());
    const offset = cityOffsetMinutes(session.server_time);
    await db.tx(async (tx) => {
      await tx.run(
        "INSERT INTO session (id, body, fetched_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
        [JSON.stringify(session), new Date(deps.now()).toISOString()]);
      await territoryRepo.setMeta(tx, "clock_skew_ms", String(skew));
      await territoryRepo.setMeta(tx, "city_offset_min", String(offset));
      await anchorServerTime(tx, Date.parse(session.server_time));
      // The token works: whatever suspended this tablet before is over.
      await tx.run("DELETE FROM meta WHERE key = ?", ["suspended"]);
    });
    await enforceTerritoryAge(db, deps.now());
    // What the session says (the city's switches, the teams) and the clock are on the screens.
    dbEvents.emit("session");
    dbEvents.emit("meta");
    await refreshReferenceOrKeep(deps, session.reference_version);

    const visitsOn = session.features.home_visits;
    if (visitsOn) {
      const sent = await sendQueue({ db, client, onStale: (item, result) => handleStale(db, item, result) });
      if (sent.stop === "rate_limited") return { kind: "stopped", reason: "rate_limited" };
      if (sent.stop === "http") return failed(deps, sent.failure ?? { kind: "network" });
    }

    // The first load is the big one: it waits for Wi-Fi unless the person allowed mobile data. First = no download ever
    // reached the end (Q13(4)): a tablet migrated to v2 lost only its cursor (Q6) and downloads on any network; a fresh
    // one, and one whose territory the 30 days took (wipeTerritory forgets both), still wait.
    const initial = (await territoryRepo.getMeta(db, "cursor")) === null
      && (await territoryRepo.getMeta(db, "last_download_ok_at")) === null;
    if (initial && !(await deps.net.isWifi()) && (await territoryRepo.getMeta(db, "mobile_data")) !== "1") {
      return { kind: "skipped", reason: "needs_wifi" };
    }
    await downloadAll({ db, client, now: deps.now });
    // Known window (review M3, Q61): the purge takes the city's day of now, after the download, not of its horizon. A
    // bulletin accepted just before midnight in a round whose download ends after it is "yesterday" and goes, though
    // the horizon (first request − 2 s) may fall before the acceptance and the download not bring it yet: for that
    // round its LIRAa item shows as pending again, until the next download brings it inspected. Seconds, only with
    // work at midnight; accepted as is.
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
