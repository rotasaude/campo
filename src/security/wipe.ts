// Two erasures. wipeTerritory drops the copy of the server (30 days without a
// full download, or a scope reset) and never touches what the tablet still
// owes the server — the queue, and what the queue points to on the tablet. wipeAll is the end of this installation: manual revocation
// (device_revoked) or a confirmed "Sair".
import { DB_NAME } from "../db/open";
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

// Keeps outbox, client_ids, reference, map_file and session — and the rows the outbox still needs (see QUEUED_ROW).
export async function wipeTerritory(db: Db): Promise<void> {
  await db.tx(async (tx) => {
    await tx.exec("DELETE FROM micro_areas");
    await tx.exec("DELETE FROM who_to_visit");
    await tx.exec(`DELETE FROM households WHERE NOT (${QUEUED_ROW})`);
    await tx.exec("DELETE FROM families WHERE household_key NOT IN (SELECT key FROM households)");
    await tx.exec(`DELETE FROM registrations WHERE NOT (${QUEUED_ROW})`);
    await tx.exec("DELETE FROM local_visits WHERE client_uuid NOT IN (SELECT client_uuid FROM outbox)");
    await tx.exec("DELETE FROM local_activities WHERE client_uuid NOT IN (SELECT client_uuid FROM outbox)");
    await tx.run("DELETE FROM meta WHERE key IN (?, ?)", ["cursor", "last_download_ok_at"]);
  });
}

// expo-sqlite keeps its files under <documents>/SQLite; SQLCipher may leave the -wal and -shm beside the main file.
export const dbFiles = (documentDirectory: string): string[] =>
  ["", "-wal", "-shm", "-journal"].map((suffix) => `${documentDirectory}SQLite/${DB_NAME}${suffix}`);
export const mapDir = (documentDirectory: string): string => `${documentDirectory}map/`;

// Every step runs even if an earlier one fails: half an erasure is worse than a reported error at the end.
export async function wipeAll(deps: { db: Db; secure: SecureStorePort; fs: FsPort; closeDb: () => Promise<void> }): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => { try { await step(); } catch (err) { failures.push(err); } };

  await attempt(() => deps.closeDb());
  for (const file of dbFiles(deps.fs.documentDirectory)) await attempt(() => deps.fs.deleteAsync(file, { idempotent: true }));
  await attempt(() => deps.fs.deleteAsync(mapDir(deps.fs.documentDirectory), { idempotent: true }));
  // The database key goes with the rest: a leftover file could not be read again.
  for (const key of Object.values(SECURE_KEYS)) await attempt(() => deps.secure.delete(key));

  if (failures.length > 0) throw new Error(`apagar o aparelho: ${failures.length} passo(s) falharam`);
}
