// Test support: a whole fake platform for the app shell — a keystore in memory, a raw database that answers
// cipher_version as told, a network that answers from the contract's examples, and an AppState the test drives.
import { Text } from "react-native";
import type { ChangesResponse, ReferenceResponse, SessionResponse, UploadItem } from "../contract";
import { example } from "../contract/fixtures";
import { createEmptyTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import { fixedRandom, memorySecure, sha256 } from "../security/testing";
import type { HttpFailure } from "../sync/http";
import type { Platform } from "./platform";

export const SESSION = example<SessionResponse>("session-acs.json");
export const TEST_HOST = "curitiba.rotasaude.example";
export const TEST_TOKEN = "rsf_" + "A".repeat(43);

// A raw connection over sql.js that pretends to be SQLCipher: PRAGMA key is swallowed and cipher_version answers `cipher`.
export function cipheredRaw(inner: Db, cipher: string | null): Db {
  const wrap = (db: Db): Db => ({
    exec: async (sql) => { if (!/^PRAGMA key/.test(sql)) await db.exec(sql); },
    run: (sql, params) => db.run(sql, params),
    all: (sql, params) => db.all(sql, params),
    get: async <T,>(sql: string, params?: (string | number | null)[]) =>
      (/cipher_version/i.test(sql) ? ((cipher === null ? null : { cipher_version: cipher }) as T | null) : db.get<T>(sql, params)),
    tx: (fn) => db.tx((tx) => fn(wrap(tx))),
    close: async () => undefined,
  });
  return wrap(inner);
}

export interface FakePlatform extends Platform {
  secure: ReturnType<typeof memorySecure>;
  clock: { now: number };
  // What the server answers next; null = works.
  server: { fail: HttpFailure | null; session: SessionResponse; requests: string[] };
  appState: Platform["appState"] & { emit(status: string): void };
  scan(text: string): void;
  deleted: string[];
  raw: () => Db | null;
}

export function fakePlatform(o: { cipher?: string | null } = {}): FakePlatform {
  const secure = memorySecure();
  const clock = { now: Date.parse("2026-11-14T15:00:00Z") };
  const server: FakePlatform["server"] = { fail: null, session: SESSION, requests: [] };
  const listeners = new Set<(status: string) => void>();
  let scanned: (text: string) => void = () => undefined;
  let raw: Db | null = null;
  const deleted: string[] = [];

  const http = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    server.requests.push(path);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    // The failure as the server (or the lack of one) would give it.
    if (server.fail?.kind === "network") throw new TypeError("Network request failed");
    if (server.fail?.kind === "revoked") return json({ error: "device_revoked" }, 401);
    if (server.fail?.kind === "suspended") return json({ error: "device_suspended" }, 401);
    if (server.fail) return json({ error: "city_schema_behind" }, 503);
    if (path.endsWith("/session")) return json(server.session);
    if (path.endsWith("/reference")) return json(example<ReferenceResponse>("reference.json"));
    if (path.endsWith("/changes")) return json(example<ChangesResponse>("changes-last-page.json"));
    if (path.endsWith("/uploads")) {
      const items = (JSON.parse(String(init?.body)) as { items: UploadItem[] }).items;
      return json({ results: items.map((i) => ({ client_uuid: i.client_uuid, status: "accepted", type: i.type, id: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f" })) });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  return {
    secure, clock, server, deleted,
    crypto: { digestHex: sha256.digestHex, randomUUID: () => "00000000-0000-4000-9000-000000000001" },
    random: fixedRandom,
    now: () => clock.now,
    fs: {
      documentDirectory: "file:///data/user/0/br.rotasaude.campo/files/",
      deleteAsync: async (uri) => { deleted.push(uri); },
      makeDirectoryAsync: async () => undefined, moveAsync: async () => undefined, getInfoAsync: async () => ({ exists: false }),
    },
    net: { isOnline: async () => true, isWifi: async () => true },
    openRaw: async () => { raw ??= await createEmptyTestDb(); return cipheredRaw(raw, o.cipher === undefined ? "4.17.0 community" : o.cipher); },
    forgetDb: () => { raw = null; },
    raw: () => raw,
    appState: {
      addEventListener: (_event, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener); } }; },
      emit: (status) => { for (const listener of [...listeners]) listener(status); },
    },
    downloader: { run: async () => ({ status: 404 }) },
    sha256File: async () => "00".repeat(32),
    readFileHead: async () => new Uint8Array(0),
    location: { permission: async () => ({ granted: false, precise: false }), current: async () => { throw new Error("no position"); } },
    MapCanvas: () => <Text>mapa</Text>,
    http,
    Camera: ({ onScanned }) => <Text onPress={() => { scanned = onScanned; }}>câmera</Text>,
    scan: (text) => scanned(text),
    build: { appVersion: "0.1.0", allowedHostSuffixes: [".rotasaude.example"] },
  };
}
