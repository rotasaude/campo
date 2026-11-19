// Two erasures. wipeTerritory drops the copy of the server (30 days without a
// full download, or a scope reset) and never touches what the tablet still
// owes the server — the queue, and what the queue points to on the tablet. wipeAll is the end of this installation: manual revocation
// (device_revoked) or a confirmed "Sair".
import { DB_NAME } from "../db/open";
import { QUEUED_OVITRAP } from "../db/repos/queued";
import type { Db } from "../db/types";
import { SECURE_KEYS, type SecureStorePort } from "./secureStore";

export interface FsPort {
  documentDirectory: string;
  deleteAsync(uri: string, options: { idempotent: true }): Promise<void>;
}

// What the line still points to. A record born on this tablet whose item has not been accepted exists nowhere else: the
// queue is kept, so the row the queue edits is kept too (its form, its place in the lists). The same for a visit or an
// activity still to be sent.
const QUEUED_ROW = "client_uuid IS NOT NULL AND key IN (SELECT target_id FROM outbox WHERE target_id IS NOT NULL)";

// Keeps outbox, client_ids, reference, map_file and session — and the rows the outbox still needs (see QUEUED_ROW and
// QUEUED_OVITRAP). In meta only the download's cursor and date go: the trusted clock (clock_skew_ms and the high water,
// campo#2) is not territory.
//
// restart: the first page of a download that began without a cursor (Q42). Only the territory and the cursor go: the
// visits and activities the server already accepted stay (the "Visitado hoje" mark, Q42 (b)), and so does
// last_download_ok_at — a restart that stops after page 1 is not a first load (Q13(4), review I1). A server reset and
// the 30 days take both (24c).
export async function wipeTerritory(db: Db, options: { restart?: boolean } = {}): Promise<void> {
  await db.tx(async (tx) => {
    await tx.exec("DELETE FROM micro_areas");
    await tx.exec("DELETE FROM who_to_visit");
    await tx.exec(`DELETE FROM households WHERE NOT (${QUEUED_ROW})`);
    await tx.exec("DELETE FROM families WHERE household_key NOT IN (SELECT key FROM households)");
    await tx.exec(`DELETE FROM registrations WHERE NOT (${QUEUED_ROW})`);
    await tx.exec("DELETE FROM city_blocks");
    await tx.exec("DELETE FROM liraa_items");
    await tx.exec("DELETE FROM transmission_blocks");
    await tx.exec(`DELETE FROM ovitraps WHERE NOT (${QUEUED_OVITRAP})`);
    await tx.run("DELETE FROM meta WHERE key = ?", ["cursor"]);
    if (options.restart === true) return;
    await tx.run("DELETE FROM meta WHERE key = ?", ["last_download_ok_at"]);
    await tx.exec("DELETE FROM local_visits WHERE client_uuid NOT IN (SELECT client_uuid FROM outbox)");
    await tx.exec("DELETE FROM local_activities WHERE client_uuid NOT IN (SELECT client_uuid FROM outbox)");
  });
}

// expo-sqlite keeps its files under <documents>/SQLite; SQLCipher may leave the -wal and -shm beside the main file.
export const dbFiles = (documentDirectory: string): string[] =>
  ["", "-wal", "-shm", "-journal"].map((suffix) => `${documentDirectory}SQLite/${DB_NAME}${suffix}`);
export const mapDir = (documentDirectory: string): string => `${documentDirectory}map/`;

// The debt of an erasure that did not go to the end. It lives in the store (the database is what is being erased) and
// is not one of SECURE_KEYS: it is the one key the erasure must not take until everything else is gone.
const WIPE_OWED = "campo.wipe_owed";
export const wipeOwed = async (secure: SecureStorePort): Promise<boolean> => (await secure.get(WIPE_OWED)) !== null;

// Every step runs even if an earlier one fails: half an erasure is worse than a reported error at the end.
// An erasure that fails stays owed: the app shows nothing but the failure, and the next start-up tries again first.
export async function wipeAll(deps: { secure: SecureStorePort; fs: FsPort; closeDb: () => Promise<void> }): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => { try { await step(); } catch (err) { failures.push(err); } };

  // Owed from before the first step. A store that cannot even write this does not, by itself, make the erasure fail.
  await deps.secure.set(WIPE_OWED, "1").catch(() => undefined);
  await attempt(() => deps.closeDb());
  for (const file of dbFiles(deps.fs.documentDirectory)) await attempt(() => deps.fs.deleteAsync(file, { idempotent: true }));
  await attempt(() => deps.fs.deleteAsync(mapDir(deps.fs.documentDirectory), { idempotent: true }));
  // The database key goes with the rest: a leftover file could not be read again.
  for (const key of Object.values(SECURE_KEYS)) await attempt(() => deps.secure.delete(key));

  if (failures.length > 0) throw new Error(`apagar o aparelho: ${failures.length} passo(s) falharam`);
  await deps.secure.delete(WIPE_OWED);
}
