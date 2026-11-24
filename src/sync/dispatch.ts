// Sends the outbox: ordered batches of up to 50, each item with the version
// its edit was based on, and each result applied to the queue and to the rows.
//
// The version an edit is sent with is the one the person saw when the edit
// began (Q41) — never the one a later download wrote on the row. If the
// station changed the record in between, the api answers stale_version and
// the merge (stale.ts) decides field by field. Sending the row's newest
// version would overwrite the station's change without anyone seeing it.
import type { UploadItem, UploadResult } from "../contract";
import { dbEvents } from "../db/events";
import { outboxRepo, type OutboxItem } from "../db/repos/outboxRepo";
import { territoryRepo } from "../db/repos/territoryRepo";
import { vectorRepo } from "../db/repos/vectorRepo";
import { zoonosesRepo } from "../db/repos/zoonosesRepo";
import type { Db } from "../db/types";
import { log } from "../log";
import { collarDueOn } from "../rules/animal";
import { FieldHttpError, type FieldClient, type HttpFailure } from "./http";
import { targetTable } from "./outbox";
import { loadReference } from "./reference";

export const MAX_BATCH = 50;
export const MAX_BATCHES_PER_ROUND = 100;
// household_changed and internal_error are transient (Q45): two more rounds, then the person is told.
export const TRANSIENT_ATTEMPTS = 3;
const TRANSIENT = new Set(["household_changed", "internal_error"]);

// `items` is the whole queue in seq order. A dependency that is not in it has already left the queue (it was accepted).
// `skip`: items this round already tried and put back (rate limit, transient refusal): they wait for the next round.
export function selectBatch(items: OutboxItem[], max = MAX_BATCH, skip: ReadonlySet<string> = new Set()): OutboxItem[] {
  const queued = new Set(items.map((item) => item.client_uuid));
  const batch: OutboxItem[] = [];
  const inBatch = new Set<string>();
  const targets = new Set<string>();
  for (const item of items) {
    if (batch.length >= max) break;
    if (item.state !== "pending" || skip.has(item.client_uuid)) continue;
    // Two edits of the same row never travel together: the second needs the version the first will get.
    if (item.target_id !== null && targets.has(item.target_id)) continue;
    const ready = item.depends_on.every((dep) => {
      if (!queued.has(dep.client_uuid)) return true;
      // "cite" may follow its target in the same batch; "version" needs the accepted answer first.
      return dep.kind === "cite" && inBatch.has(dep.client_uuid);
    });
    if (!ready) continue;
    batch.push(item);
    inBatch.add(item.client_uuid);
    if (item.target_id !== null) targets.add(item.target_id);
  }
  return batch;
}

// Q41: an edit carries its own base version, always. Without one (the target was born on the tablet, or the item
// only cites it) the row's base version — the one the last accepted answer wrote — is used.
export function resolveVersion(item: OutboxItem, rowBaseVersion: number | null): number | null {
  if (item.target_id !== null && item.edit_base_version !== null) return item.edit_base_version;
  return rowBaseVersion;
}

// An item is held while something it depends on is waiting for a person (needs attention, conflict) or is itself held.
// Computed from scratch every time: when the cause is fixed or discarded, the item goes back to the line.
export async function refreshBlocked(db: Db): Promise<void> {
  const items = await outboxRepo.all(db);
  const byUuid = new Map(items.map((item) => [item.client_uuid, item]));
  const held = new Set(items.filter((item) => item.state === "needs_attention" || item.state === "conflict").map((item) => item.client_uuid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (held.has(item.client_uuid)) continue;
      if (item.depends_on.some((dep) => byUuid.has(dep.client_uuid) && held.has(dep.client_uuid))) { held.add(item.client_uuid); grew = true; }
    }
  }
  for (const item of items) {
    if (item.state === "pending" && held.has(item.client_uuid)) await outboxRepo.update(db, item.seq, { state: "blocked" });
    if (item.state === "blocked" && !held.has(item.client_uuid)) await outboxRepo.update(db, item.seq, { state: "pending" });
  }
}

// `deferred`: the items that went back to the line and must wait for the next round.
export type ApplySignal = { stop: "rate_limited" | null; progressed: boolean; deferred: string[] };
export interface ApplyHooks { onStale(item: OutboxItem, result: UploadResult): Promise<void> }

// The collection's label as the api gives it (upload-response-v1.json, Q21).
const LEISH_LABEL = /^LV-[0-9]{4}-([0-9A-F]{6}|AVUL)-[0-9]{4,6}$/;

const VERSIONED = new Set(["household", "family", "individual_registration", "animal"]);

async function accept(db: Db, item: OutboxItem, result: UploadResult): Promise<void> {
  await outboxRepo.remove(db, item.seq);
  if (typeof result.id === "string") await outboxRepo.mapClientId(db, item.client_uuid, item.type, result.id);
  const now = new Date().toISOString();

  if (item.type === "home_visit") {
    await db.run("UPDATE local_visits SET state = 'accepted', server_id = ?, accepted_at = ? WHERE client_uuid = ?", [result.id ?? null, now, item.client_uuid]);
    dbEvents.emit("local_visits");
  } else if (item.type === "home_visit_withdrawal") {
    const visit = item.body.visit_client_uuid;
    if (typeof visit === "string") await db.run("UPDATE local_visits SET state = 'withdrawn' WHERE client_uuid = ?", [visit]);
    dbEvents.emit("local_visits");
  } else if (item.type === "collective_activity") {
    await db.run("UPDATE local_activities SET state = 'accepted', server_id = ?, accepted_at = ? WHERE client_uuid = ?", [result.id ?? null, now, item.client_uuid]);
    dbEvents.emit("local_activities");
  } else if (item.type === "ovitrap_installation") {
    // The result's id is the ovitrap's (Q7(2)); the row born here is under the installation's client_uuid.
    if (typeof result.id === "string") await vectorRepo.acceptInstallation(db, item.client_uuid, result.id);
    dbEvents.emit("ovitraps");
  } else if (item.type === "ovitrap_collection") {
    await vectorRepo.acceptCollection(db, item.body);
    dbEvents.emit("ovitraps");
  } else if (item.type === "rabies_vaccination") {
    // The animal's row shows the vaccine until the download brings the animal (Q20); its version does not move.
    await zoonosesRepo.acceptVaccination(db, item.body);
    dbEvents.emit("animals");
  } else if (item.type === "leish_collection") {
    // The label is the api's, on accepted and on duplicate alike (Q21): the tablet never makes one up.
    if (typeof result.label === "string") await zoonosesRepo.acceptLeishCollection(db, item.client_uuid, result.label);
    dbEvents.emit("local_leish_collections");
  } else if (item.type === "collar") {
    // The answer has no due date: the reference's collar_months gives it. Without them the download brings it.
    const months = (await loadReference(db).catch(() => null))?.zoonosesDomains?.parameters.collar_months;
    if (months !== undefined && typeof item.body.placed_on === "string") {
      await zoonosesRepo.acceptCollar(db, item.body, collarDueOn(item.body.placed_on, months));
    }
    dbEvents.emit("animals");
  }

  const table = targetTable(item.type);
  if (table === null || item.target_id === null) return;

  if (typeof result.version !== "number") {
    // A receipt older than v1.2.0 (Q5): the record is on the server, but the tablet does not know its version.
    // No merge is possible: the next download that brings the row replaces it and clears the mark.
    await db.run(`UPDATE ${table} SET needs_reload = 1 WHERE key = ?`, [item.target_id]);
    dbEvents.emit(table);
    return;
  }
  if (item.type === "family") {
    // The family lives in its household: the version is the household's, and the row shows the family as accepted.
    await territoryRepo.acceptFamily(db, item.target_id, item, { id: result.id ?? null, version: result.version });
    dbEvents.emit("registrations");
  } else if (item.type === "household") {
    // The row shows what was accepted until the next download brings the record itself.
    await territoryRepo.acceptHousehold(db, item.target_id, item.body, { id: result.id ?? null, version: result.version });
  } else if (item.type === "animal") {
    // The same for the animal (Q20): the accepted answer carries its version.
    await zoonosesRepo.acceptAnimal(db, item.target_id, item.body, { id: result.id ?? null, version: result.version });
  } else {
    await territoryRepo.acceptRegistration(db, item.target_id, item.body, { id: result.id ?? null, version: result.version });
  }
  // Edits made on top of this one (their base was the version just sent) now stand on the accepted version.
  // An edit whose base came from somewhere else keeps it, and will go through the merge.
  for (const later of await outboxRepo.all(db)) {
    if (later.target_id === item.target_id && later.state === "pending" && later.edit_base_version !== null && later.edit_base_version === item.sent_version) {
      await outboxRepo.update(db, later.seq, { edit_base_version: result.version });
    }
  }
  dbEvents.emit(table);
}

export async function applyResults(db: Db, sent: OutboxItem[], results: UploadResult[], hooks: ApplyHooks): Promise<ApplySignal> {
  const signal: ApplySignal = { stop: null, progressed: false, deferred: [] };
  const refused = new Set<string>();
  const answered = new Set<string>();
  const bySent = new Map(sent.map((item) => [item.client_uuid, item]));
  const back = (item: OutboxItem, attempts = item.attempts) => {
    signal.deferred.push(item.client_uuid);
    return outboxRepo.update(db, item.seq, { state: "pending", attempts });
  };
  const attention = (item: OutboxItem, result: Pick<UploadResult, "error" | "path" | "candidates" | "confirmable" | "id">) => {
    refused.add(item.client_uuid);
    signal.progressed = true;
    return outboxRepo.update(db, item.seq, {
      state: "needs_attention", error: result.error ?? "invalid_request", path: result.path ?? null,
      // already_registered may name the registration the person already has: kept where the screen can find it.
      candidates: result.candidates ?? (result.error === "already_registered" && typeof result.id === "string" ? [{ registration_id: result.id }] : null),
      confirmable: result.confirmable ?? null,
    });
  };

  for (const [index, result] of results.entries()) {
    // Matched by client_uuid; a result without one is judged by its position.
    const item = typeof result.client_uuid === "string" ? bySent.get(result.client_uuid) : sent[index];
    if (!item || answered.has(item.client_uuid)) continue;
    answered.add(item.client_uuid);
    if (typeof result.client_uuid !== "string") { await attention(item, { error: "invalid_request" }); continue; }
    // The verdict of each item: its uuid, type and code. Never the path, the candidates or anything of the body.
    log("sync.item.result", { client_uuid: item.client_uuid, type: item.type, code: result.status === "rejected" ? (result.error ?? "rejected") : result.status });

    if ((result.status === "accepted" || result.status === "duplicate") && item.type === "leish_collection" && !LEISH_LABEL.test(result.label ?? "")) {
      // Accepted without its label (the contract requires it): kept in the line, the resend answers duplicate with it.
      await back(item);
    } else if (result.status === "accepted" || result.status === "duplicate") {
      await db.tx((tx) => accept(tx, item, result));
      signal.progressed = true;
    } else if (result.status === "stale_version") {
      await hooks.onStale(item, result);
      signal.progressed = true;
    } else if (result.error === "too_many_requests") {
      await back(item, item.attempts + 1);
      signal.stop = "rate_limited";
    } else if (result.error === "feature_disabled") {
      await back(item); // decision 22: the record waits in the tablet until the city turns the feature on again
    } else if (result.error !== undefined && TRANSIENT.has(result.error)) {
      if (item.attempts + 1 >= TRANSIENT_ATTEMPTS) await attention(item, result);
      else await back(item, item.attempts + 1);
    } else if (result.error === "not_found" && (result.path ?? "").endsWith("_client_uuid")
      && item.depends_on.some((dep) => signal.deferred.includes(dep.client_uuid))) {
      // The record it cites only went back to the line (rate limit, a transient refusal): this one goes back with it.
      await back(item);
    } else if (result.error === "not_found" && (result.path ?? "").endsWith("_client_uuid")
      && item.depends_on.some((dep) => refused.has(dep.client_uuid))) {
      // The record it cites was refused in this same batch: nothing wrong with this one.
      await outboxRepo.update(db, item.seq, { state: "blocked" });
      refused.add(item.client_uuid); // what cites this one in the same batch is held for the same reason
      signal.progressed = true;
    } else {
      await attention(item, result);
    }
  }
  // An item the answer forgot goes back to the line: its client_uuid makes the resend safe.
  for (const item of sent) if (!answered.has(item.client_uuid)) await back(item);
  await refreshBlocked(db);
  return signal;
}

export interface SendDeps { db: Db; client: Pick<FieldClient, "uploads">; onStale: ApplyHooks["onStale"] }

async function targetRow(db: Db, item: OutboxItem): Promise<{ id: string | null; base_version: number | null } | null> {
  const table = targetTable(item.type);
  if (table === null || item.target_id === null) return null;
  return db.get<{ id: string | null; base_version: number | null }>(`SELECT id, base_version FROM ${table} WHERE key = ?`, [item.target_id]);
}

// The key that names an existing record in the body. The schema ties it to `version`: one never travels without the other.
const ID_KEY: Record<string, string> = { household: "household_id", individual_registration: "registration_id", animal: "animal_id" };

// An item that names an existing record and carries no base of its own reads the version from the row at send time: a
// family (its version is the household's) or an edit written without an edit base.
function needsRowVersion(item: OutboxItem): boolean {
  if (!VERSIONED.has(item.type) || item.target_id === null || item.edit_base_version !== null) return false;
  if (item.type === "family") return true;
  return typeof item.body[ID_KEY[item.type]] === "string";
}

// The body as it travels: the version is filled here and nowhere else.
function wireBody(item: OutboxItem, version: number | null, rowId: string | null): Record<string, unknown> {
  if (version === null) return item.body;
  const idKey = ID_KEY[item.type];
  if (idKey === undefined || typeof item.body[idKey] === "string") return { ...item.body, version };
  // An edit written before the server gave the record an id (the creation was still in the line).
  return rowId === null ? item.body : { ...item.body, [idKey]: rowId, version };
}

export async function sendQueue(deps: SendDeps): Promise<{ stop: "rate_limited" | "http" | null; failure?: HttpFailure }> {
  const { db } = deps;
  const deferred = new Set<string>();
  // A merged item goes straight back to the line; the cap only exists so a server that never agrees cannot spin the round forever.
  for (let batches = 0; batches < MAX_BATCHES_PER_ROUND; batches += 1) {
    await refreshBlocked(db);
    const batch = selectBatch(await outboxRepo.all(db), MAX_BATCH, deferred);
    if (batch.length === 0) return { stop: null };

    // The version goes into the body only here; `sending` is written before the request leaves.
    const wire: UploadItem[] = [];
    const sent: OutboxItem[] = [];
    await db.tx(async (tx) => {
      for (const item of batch) {
        const row = VERSIONED.has(item.type) ? await targetRow(tx, item) : null;
        // The copy of the territory may have been erased with this item still in the line. One that takes its version
        // from the row waits for the download to bring the row back: without it the item would go out malformed.
        if (needsRowVersion(item) && row === null) { deferred.add(item.client_uuid); continue; }
        const body = wireBody(item, VERSIONED.has(item.type) ? resolveVersion(item, row?.base_version ?? null) : null, row?.id ?? null);
        const version = typeof body.version === "number" ? body.version : null;
        await outboxRepo.update(tx, item.seq, { state: "sending", sent_version: version });
        sent.push({ ...item, state: "sending", sent_version: version });
        wire.push({ client_uuid: item.client_uuid, type: item.type, body });
      }
    });

    if (sent.length === 0) continue; // every item of this batch waits for the download
    let results: UploadResult[];
    try {
      results = (await deps.client.uploads(wire)).results;
    } catch (err) {
      for (const item of sent) await outboxRepo.update(db, item.seq, { state: "pending" });
      if (err instanceof FieldHttpError) return { stop: "http", failure: err.failure };
      throw err;
    }
    const signal = await applyResults(db, sent, results, { onStale: deps.onStale });
    for (const uuid of signal.deferred) deferred.add(uuid);
    if (signal.stop) return { stop: signal.stop };
  }
  return { stop: null };
}
