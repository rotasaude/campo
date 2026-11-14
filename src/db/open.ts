// Opens the local database only when SQLCipher answers. The key is 32 random
// bytes kept in the Android Keystore; a build without the cipher (the stock
// SQLite) accepts PRAGMA key silently and would write people's data in clear,
// so `PRAGMA cipher_version` with no row is fatal and nothing else runs.
import { SECURE_KEYS, type SecureStorePort } from "../security/secureStore";
import { migrate } from "./migrations";
import type { Db } from "./types";

export const DB_NAME = "campo.db";
// Shown by the shell (Task 16) when the open fails with UnencryptedDatabaseError.
export const UNENCRYPTED_MESSAGE = "Banco sem cifra: o app não abre. Reinstale pela loja da secretaria.";

export class UnencryptedDatabaseError extends Error {
  constructor() { super(UNENCRYPTED_MESSAGE); }
}
export class MissingKeyError extends Error {
  constructor() { super("chave do banco ausente"); }
}

const KEY = /^[0-9a-f]{64}$/;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export interface OpenDeps {
  secure: SecureStorePort;
  random: (n: number) => Uint8Array;
  openRaw: (name: string) => Promise<Db>;
}

// `create: true` only at device registration: anywhere else a missing key means the data is gone, not a new install.
export async function openEncryptedDb(deps: OpenDeps, opts: { create: boolean } = { create: false }): Promise<Db> {
  let key = await deps.secure.get(SECURE_KEYS.dbKey);
  if (key === null || !KEY.test(key)) {
    if (!opts.create) throw new MissingKeyError();
    key = hex(deps.random(32));
    await deps.secure.set(SECURE_KEYS.dbKey, key);
  }
  const db = await deps.openRaw(DB_NAME);
  try {
    await db.exec(`PRAGMA key = "x'${key}'"`);
    const cipher = await db.get<{ cipher_version: string | null }>("PRAGMA cipher_version");
    if (!cipher?.cipher_version) throw new UnencryptedDatabaseError();
    await migrate(db);
    return db;
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
}
