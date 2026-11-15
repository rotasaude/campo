import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { MAP_DIR, mapFileName, mapUri, readMapFile, syncMapFile, type MapDeps, type MapManifest } from "./download";

const SHA = "ab".repeat(32);
const OTHER_SHA = "cd".repeat(32);
const TOKEN = "rsf_" + "A".repeat(43);
const DOC = "file:///data/user/0/br.rotasaude.campo/files/";
const MANIFEST: MapManifest = { version: "2026-11-01", size_bytes: 1000, sha256: SHA };
const FINAL = `${MAP_DIR}2026-11-01-${SHA.slice(0, 12)}.pmtiles`;
const PART = `${FINAL}.part`;

// interrupt: the transfer stops with `left` bytes in the file (400 when not told).
type Step = { status: number } | { interrupt: string; left?: number } | { write: number; status: number };
async function setup(o: { steps?: Step[]; wifi?: boolean; sha?: (uri: string) => string; db?: Db } = {}) {
  const db = o.db ?? (await createTestDb());
  const files = new Map<string, number>(); // uri → size
  const requests: { url: string; fileUri: string; headers: Record<string, string>; resumeFrom: number | null }[] = [];
  const steps = [...(o.steps ?? [{ write: 1000, status: 200 }])];
  const deps: MapDeps = {
    db,
    client: { mapRequest: async (resume) => ({ url: "https://curitiba.rotasaude.example/field/v1/map", headers: { Authorization: `Bearer ${TOKEN}`, ...(resume ? { "If-Range": `"${resume.ifRange}"` } : {}) } }) },
    fs: {
      documentDirectory: DOC,
      makeDirectoryAsync: async () => undefined,
      deleteAsync: async (uri) => { files.delete(uri); },
      moveAsync: async ({ from, to }) => { files.set(to, files.get(from)!); files.delete(from); },
      getInfoAsync: async (uri) => (files.has(uri) ? { exists: true, size: files.get(uri)! } : { exists: false }),
    },
    downloader: {
      run: async (request) => {
        requests.push({ url: request.url, fileUri: request.fileUri, headers: request.headers, resumeFrom: request.resumeFrom });
        const step = steps.shift() ?? { write: 1000, status: 200 };
        if ("interrupt" in step) {
          if (step.left !== 0) files.set(request.fileUri, step.left ?? 400);
          throw new Error(step.interrupt);
        }
        if ("write" in step) files.set(request.fileUri, step.write);
        return { status: step.status };
      },
    },
    sha256File: async (uri) => (o.sha ? o.sha(uri) : SHA),
    net: { isWifi: async () => o.wifi ?? true },
  };
  return { db, deps, files, requests };
}
const uri = (path: string) => DOC + path;

test("first download: fetched to a .part, checked, renamed and recorded", async () => {
  const t = await setup();
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("downloaded");
  expect(t.requests).toEqual([{ url: "https://curitiba.rotasaude.example/field/v1/map", fileUri: uri(PART), headers: { Authorization: `Bearer ${TOKEN}` }, resumeFrom: null }]);
  expect([...t.files.keys()]).toEqual([uri(FINAL)]);
  expect(await readMapFile(t.db)).toEqual({ version: "2026-11-01", sha256: SHA, size_bytes: 1000, path: FINAL });
  expect(mapFileName(MANIFEST)).toBe(`2026-11-01-${SHA.slice(0, 12)}.pmtiles`);
});

test("current file is not downloaded again", async () => {
  const t = await setup();
  await syncMapFile(t.deps, MANIFEST);
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("current");
  expect(t.requests).toHaveLength(1);
  // The record says current but the file is gone (storage cleared): it is fetched again.
  t.files.clear();
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("downloaded");
});

test("no manifest: none, and the map the tablet already has stays", async () => {
  const t = await setup();
  await syncMapFile(t.deps, MANIFEST);
  expect(await syncMapFile(t.deps, null)).toBe("none");
  expect([...t.files.keys()]).toEqual([uri(FINAL)]);
  expect((await readMapFile(t.db))!.sha256).toBe(SHA);
});

test("interrupted download resumes from the size of the .part on disk, with If-Range set to the session sha256 (Q34)", async () => {
  const t = await setup({ steps: [{ interrupt: "connection reset" }, { write: 1000, status: 206 }] });
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("failed");
  expect(await readMapFile(t.db)).toBeNull(); // nothing usable yet
  expect(t.files.has(uri(PART))).toBe(true);

  expect(await syncMapFile(t.deps, MANIFEST)).toBe("resumed");
  expect(t.requests[1]).toEqual({
    url: "https://curitiba.rotasaude.example/field/v1/map", fileUri: uri(PART),
    headers: { Authorization: `Bearer ${TOKEN}`, "If-Range": `"${SHA}"` }, resumeFrom: 400,
  });
  expect((await readMapFile(t.db))!.path).toBe(FINAL);
  expect([...t.files.keys()]).toEqual([uri(FINAL)]);
});

// The Android resume sends Range from the number it is given and APPENDS the body to the file: the only
// number that is right is the size the file has now.
test("the resume point is what is on disk, not a number remembered from before", async () => {
  const t = await setup({ steps: [{ interrupt: "reset", left: 400 }, { write: 1000, status: 206 }] });
  await syncMapFile(t.deps, MANIFEST);
  t.files.set(uri(PART), 731); // more bytes reached the disk after the last thing the app saw
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("resumed");
  expect(t.requests[1].resumeFrom).toBe(731);
});

test.each([["gone", undefined], ["empty", 0]])("a .part that is %s starts a fresh download, without If-Range", async (_name, size) => {
  const t = await setup({ steps: [{ interrupt: "reset" }, { write: 1000, status: 200 }] });
  await syncMapFile(t.deps, MANIFEST);
  if (size === undefined) t.files.delete(uri(PART)); else t.files.set(uri(PART), size);
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("downloaded");
  expect(t.requests[1].resumeFrom).toBeNull();
  expect(t.requests[1].headers["If-Range"]).toBeUndefined();
});

test("a .part already whole is not asked for again: it goes straight to the check", async () => {
  const t = await setup({ steps: [{ interrupt: "reset at the last byte", left: 1000 }] });
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("failed");
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("resumed");
  expect(t.requests).toHaveLength(1); // a Range past the end would answer 416
  expect((await readMapFile(t.db))!.path).toBe(FINAL);
});

test("a .part larger than the file is thrown away without a transfer; the next round starts fresh", async () => {
  const t = await setup({ steps: [{ interrupt: "reset", left: 1400 }, { write: 1000, status: 200 }] });
  await syncMapFile(t.deps, MANIFEST);
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("failed");
  expect(t.requests).toHaveLength(1);
  expect(t.files.size).toBe(0);
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("downloaded");
  expect(t.requests[1].resumeFrom).toBeNull();
});

test.each([[200], [416]])("%s on a resume discards the partial and starts over once", async (status) => {
  const t = await setup({ steps: [{ interrupt: "reset" }, { status }, { write: 1000, status: 200 }] });
  await syncMapFile(t.deps, MANIFEST);
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("downloaded");
  expect(t.requests.map((r) => [r.resumeFrom, r.headers["If-Range"] ?? null])).toEqual([[null, null], [400, `"${SHA}"`], [null, null]]);
  expect([...t.files.keys()]).toEqual([uri(FINAL)]);
});

test("a resume that keeps failing does not loop: one fresh start per call", async () => {
  const t = await setup({ steps: [{ interrupt: "reset" }, { status: 416 }, { status: 416 }] });
  await syncMapFile(t.deps, MANIFEST);
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("failed");
  expect(t.requests).toHaveLength(3);
  expect(t.files.size).toBe(0);
});

test("partial of another sha is discarded before starting", async () => {
  const t = await setup({ steps: [{ interrupt: "reset" }, { write: 2000, status: 200 }] });
  await syncMapFile(t.deps, MANIFEST);
  const newer: MapManifest = { version: "2026-11-01", size_bytes: 2000, sha256: OTHER_SHA };
  const result = await syncMapFile({ ...t.deps, sha256File: async () => OTHER_SHA }, newer);
  expect(result).toBe("downloaded");
  expect(t.requests[1].resumeFrom).toBeNull();
  expect(t.requests[1].headers["If-Range"]).toBeUndefined();
  expect([...t.files.keys()]).toEqual([uri(`${MAP_DIR}2026-11-01-${OTHER_SHA.slice(0, 12)}.pmtiles`)]);
});

test("sha mismatch keeps the previous map and deletes the partial", async () => {
  const t = await setup();
  await syncMapFile(t.deps, MANIFEST);
  const newer: MapManifest = { version: "2026-12-01", size_bytes: 1000, sha256: OTHER_SHA };
  expect(await syncMapFile({ ...t.deps, sha256File: async () => "ef".repeat(32) }, newer)).toBe("failed");
  expect([...t.files.keys()]).toEqual([uri(FINAL)]);
  expect(await readMapFile(t.db)).toEqual({ version: "2026-11-01", sha256: SHA, size_bytes: 1000, path: FINAL });
});

test("size mismatch is refused before the hash is even computed", async () => {
  const sha = jest.fn(async () => SHA);
  const t = await setup({ steps: [{ write: 999, status: 200 }] });
  expect(await syncMapFile({ ...t.deps, sha256File: sha }, MANIFEST)).toBe("failed");
  expect(sha).not.toHaveBeenCalled();
  expect(t.files.size).toBe(0);
});

test("disk full error keeps the previous map", async () => {
  const t = await setup({ steps: [{ write: 1000, status: 200 }, { interrupt: "ENOSPC: no space left on device" }] });
  await syncMapFile(t.deps, MANIFEST);
  const newer: MapManifest = { version: "2026-12-01", size_bytes: 5000, sha256: OTHER_SHA };
  expect(await syncMapFile(t.deps, newer)).toBe("failed");
  expect(t.files.has(uri(FINAL))).toBe(true);
  expect((await readMapFile(t.db))!.sha256).toBe(SHA);
});

test("swap is atomic: map_file changes only after the check, and the old file goes last", async () => {
  const t = await setup();
  await syncMapFile(t.deps, MANIFEST);
  const newer: MapManifest = { version: "2026-12-01", size_bytes: 3000, sha256: OTHER_SHA };
  const order: string[] = [];
  const deps: MapDeps = {
    ...t.deps,
    sha256File: async () => { order.push(`check:${(await readMapFile(t.db))!.sha256 === SHA ? "old-row" : "new-row"}`); return OTHER_SHA; },
    downloader: { run: async (request) => { t.files.set(request.fileUri, 3000); return { status: 200 }; } },
    fs: {
      ...t.deps.fs,
      moveAsync: async (move) => { order.push("move"); await t.deps.fs.moveAsync(move); },
      deleteAsync: async (target, options) => { order.push(`delete:${target === uri(FINAL) ? "old-file" : "other"}:${(await readMapFile(t.db))!.sha256 === OTHER_SHA ? "new-row" : "old-row"}`); await t.deps.fs.deleteAsync(target, options); },
    },
  };
  expect(await syncMapFile(deps, newer)).toBe("downloaded");
  expect(order.filter((step) => !step.startsWith("delete:other"))).toEqual(["check:old-row", "move", "delete:old-file:new-row"]);
  expect([...t.files.keys()]).toEqual([uri(`${MAP_DIR}2026-12-01-${OTHER_SHA.slice(0, 12)}.pmtiles`)]);
});

test("no wifi and no mobile-data preference → needs_wifi", async () => {
  const t = await setup({ wifi: false });
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("needs_wifi");
  expect(t.requests).toHaveLength(0);
  await t.db.run("UPDATE meta SET value = '1' WHERE key = 'mobile_data'");
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("downloaded");
});

test("map_not_found → none", async () => {
  const t = await setup({ steps: [{ status: 404 }] });
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("none");
  expect(t.files.size).toBe(0);
});

test("401 or 5xx: failed, nothing kept of the attempt", async () => {
  for (const status of [401, 503]) {
    const t = await setup({ steps: [{ status }] });
    expect([status, await syncMapFile(t.deps, MANIFEST)]).toEqual([status, "failed"]);
    expect(t.files.size).toBe(0);
  }
});

test("pmtiles uri is absolute file:// under the document directory", async () => {
  const t = await setup();
  await syncMapFile(t.deps, MANIFEST);
  const row = (await readMapFile(t.db))!;
  expect(mapUri(row, DOC)).toMatch(/^pmtiles:\/\/file:\/\/\/.+\/map\/2026-11-01-[0-9a-f]{12}\.pmtiles$/);
});

test("the token goes only in the request headers: never stored with the partial", async () => {
  const t = await setup({ steps: [{ interrupt: "reset" }] });
  await syncMapFile(t.deps, MANIFEST);
  expect(JSON.stringify(await t.db.all("SELECT * FROM map_file"))).not.toMatch(/rsf_/);
});

// Review I3: a round that ends while the previous round's download is still running must not start a second transfer
// onto the same .part — the two would append to each other's bytes and the file would never check.
test("two calls at the same time are one download: the second waits for the first and gets its answer", async () => {
  const t = await setup();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = t.deps.downloader.run;
  let transfers = 0;
  t.deps.downloader.run = async (request) => { transfers += 1; await gate; return run(request); };
  const first = syncMapFile(t.deps, MANIFEST);
  const second = syncMapFile(t.deps, MANIFEST);
  release();
  expect(await Promise.all([first, second])).toEqual(["downloaded", "downloaded"]);
  expect(transfers).toBe(1);
  // Once it is over, a later call is a call of its own again.
  expect(await syncMapFile(t.deps, MANIFEST)).toBe("current");
});
