// The city's offline map: one PMTiles file, served by the Rota Saúde itself
// (GET /field/v1/map) and read by byte ranges. The session says which file is
// published ({ version, size_bytes, sha256 }); the tablet downloads it to a
// .part, checks the size and the SHA-256 of the whole file, and only then
// swaps. A map that does not match is never used; the one the tablet already
// has stays until the new one is proved good.
//
// A download that stopped half-way continues from where it was, with
// If-Range set to the session's SHA-256 (Q34): if the file changed on the
// server, the answer is the whole new file (200) or 416, and the partial is
// thrown away — bytes of two different files are never glued together.
import type { SessionResponse } from "../contract";
import { dbEvents } from "../db/events";
import type { Db } from "../db/types";
import { log } from "../log";
import type { FieldClient } from "../sync/http";

export type MapManifest = NonNullable<SessionResponse["map"]>;
export type MapSyncResult = "none" | "current" | "downloaded" | "resumed" | "needs_wifi" | "failed";

export interface MapFsPort {
  documentDirectory: string;
  makeDirectoryAsync(uri: string, options: { intermediates: true }): Promise<void>;
  deleteAsync(uri: string, options: { idempotent: true }): Promise<void>;
  moveAsync(move: { from: string; to: string }): Promise<void>;
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }>;
}

// The resumable download of the file system module. Resolves with the HTTP status when the transfer ended;
// rejects when it was interrupted. `resumeFrom`: how many bytes the file already has — the transfer asks
// for the rest (Range) and appends it to the file; null writes the file from the start.
export interface MapDownloader {
  run(request: { url: string; fileUri: string; headers: Record<string, string>; resumeFrom: number | null }): Promise<{ status: number }>;
}

export interface MapDeps {
  db: Db;
  client: Pick<FieldClient, "mapRequest">;
  fs: MapFsPort;
  downloader: MapDownloader;
  // SHA-256 of the whole file, computed natively (the method chosen in the technical proof).
  sha256File(uri: string): Promise<string>;
  net: { isWifi(): Promise<boolean> };
}

export const MAP_DIR = "map/";
// Version and the start of the hash: a new file of the same base date never lands on the name of the one in use.
export const mapFileName = (manifest: Pick<MapManifest, "version" | "sha256">) => `${manifest.version}-${manifest.sha256.slice(0, 12)}.pmtiles`;

export interface MapFile { version: string; sha256: string; size_bytes: number; path: string }
interface Row { version: string | null; sha256: string | null; size_bytes: number | null; path: string | null; partial_path: string | null; partial_sha256: string | null }

const readRow = (db: Db) => db.get<Row>("SELECT version, sha256, size_bytes, path, partial_path, partial_sha256 FROM map_file WHERE id = 1");

// The map the tablet can show, or null. `path` is relative to the document directory.
export async function readMapFile(db: Db): Promise<MapFile | null> {
  const row = await readRow(db);
  if (!row || row.path === null || row.version === null || row.sha256 === null || row.size_bytes === null) return null;
  return { version: row.version, sha256: row.sha256, size_bytes: row.size_bytes, path: row.path };
}

// "pmtiles://file:///…/map/<file>": what the map style's source points to.
export function mapUri(file: Pick<MapFile, "path">, documentDirectory: string): string {
  return `pmtiles://${documentDirectory}${file.path}`;
}

// The record only says a partial of which file is on disk; where it stopped is the file's own size.
async function setPartial(db: Db, partial: { path: string; sha256: string } | null): Promise<void> {
  await db.run(
    `INSERT INTO map_file (id, partial_path, partial_sha256) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET partial_path = excluded.partial_path, partial_sha256 = excluded.partial_sha256`,
    [partial?.path ?? null, partial?.sha256 ?? null]);
}

// One download at a time per database. A round may end while the download the previous round started is still running
// (it runs behind the screen): a second transfer would read the size of the live partial and append to the same file.
// The caller that arrives meanwhile waits for the one in flight and gets its answer.
const inFlight = new WeakMap<Db, Promise<MapSyncResult>>();

export function syncMapFile(deps: MapDeps, manifest: MapManifest | null): Promise<MapSyncResult> {
  const running = inFlight.get(deps.db);
  if (running) return running;
  const mine = download(deps, manifest).finally(() => { if (inFlight.get(deps.db) === mine) inFlight.delete(deps.db); });
  inFlight.set(deps.db, mine);
  return mine;
}

async function download(deps: MapDeps, manifest: MapManifest | null): Promise<MapSyncResult> {
  const { db, fs } = deps;
  // The city has no map published: the one the tablet has, if any, stays.
  if (manifest === null) return "none";
  const at = (path: string) => fs.documentDirectory + path;
  const remove = (path: string) => fs.deleteAsync(at(path), { idempotent: true });

  const row = await readRow(db);
  if (row?.sha256 === manifest.sha256 && row.path !== null && (await fs.getInfoAsync(at(row.path))).exists) return "current";
  if (!(await deps.net.isWifi()) && (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'mobile_data'"))?.value !== "1") return "needs_wifi";

  const finalPath = MAP_DIR + mapFileName(manifest);
  const partPath = `${finalPath}.part`;
  // A partial of another file is of no use.
  if (row?.partial_path && row.partial_sha256 !== manifest.sha256) {
    await remove(row.partial_path);
    await setPartial(db, null);
  }
  const discard = async (): Promise<void> => { await remove(partPath); await setPartial(db, null); };
  await fs.makeDirectoryAsync(at(MAP_DIR), { intermediates: true });

  // Where to resume from is what the file has now — never a number kept from before: the resume appends
  // to the file, and the last bytes of an interrupted transfer reach the disk after anything the app saw.
  let resumeFrom: number | null = null;
  if (row?.partial_sha256 === manifest.sha256) {
    const part = await fs.getInfoAsync(at(partPath));
    if (part.exists && (part.size ?? 0) > 0) resumeFrom = part.size ?? null;
  }
  const resumed = resumeFrom !== null;
  // A partial already whole (or longer) needs no transfer: a Range past the end would only answer 416.
  const whole = resumeFrom !== null && resumeFrom >= manifest.size_bytes;

  // At most two transfers: the resume and, if the server says the file changed, one fresh start.
  for (let attempt = 0; attempt < 2 && !whole; attempt += 1) {
    const request = await deps.client.mapRequest(resumeFrom !== null ? { ifRange: manifest.sha256 } : undefined);
    await setPartial(db, { path: partPath, sha256: manifest.sha256 });
    let status: number;
    try {
      status = (await deps.downloader.run({ url: request.url, fileUri: at(partPath), headers: request.headers, resumeFrom })).status;
    } catch {
      // Interrupted (no network, no space, app closed): the partial stays for the next round.
      return "failed";
    }

    const fresh = resumeFrom === null;
    if (status === 206 || (status === 200 && fresh)) break;
    await discard();
    log("map.download.failed", { status });
    if (status === 404) return "none"; // map_not_found: the published map is gone
    // On a resume, 200 (the whole new file) or 416 mean the file changed on the server: start over, once.
    if (!fresh && (status === 200 || status === 416) && attempt === 0) { resumeFrom = null; continue; }
    return "failed";
  }

  // Size first (cheap), then the hash of the whole file.
  const info = await fs.getInfoAsync(at(partPath));
  if (!info.exists || info.size !== manifest.size_bytes || (await deps.sha256File(at(partPath))) !== manifest.sha256) {
    await discard();
    log("map.download.failed", { code: "mismatch" });
    return "failed";
  }

  const previous = row?.path ?? null;
  await fs.moveAsync({ from: at(partPath), to: at(finalPath) });
  await db.run(
    `INSERT INTO map_file (id, version, sha256, size_bytes, path) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, sha256 = excluded.sha256, size_bytes = excluded.size_bytes, path = excluded.path,
       partial_path = NULL, partial_sha256 = NULL`,
    [manifest.version, manifest.sha256, manifest.size_bytes, finalPath]);
  dbEvents.emit("map_file");
  // Only now, with the new one recorded, the old file goes.
  if (previous !== null && previous !== finalPath) await remove(previous);
  return resumed && resumeFrom !== null ? "resumed" : "downloaded";
}
