// Registers this tablet from a QR already parsed (qr.ts). Nothing is written
// before the server answers GET session with the new token: a QR that does not
// work never costs the tablet what it has.
//
// "Same user" is same host AND same user id (Q46): the id is only unique in
// its city. For the same user the token is swapped and the database and the
// queue stay — this is what "Substituir" and "Cadastrar novo" of the dashboard
// rely on (Q16, Q17). For another user, a tablet that still owes records to
// the server refuses; an idle one is wiped and starts over.
import type { SessionResponse } from "../contract";
import type { Db } from "../db/types";
import { isLocked } from "../security/pin";
import { SECURE_KEYS, type SecureStorePort } from "../security/secureStore";
import { FieldHttpError, type FieldClient, type HttpFailure } from "../sync/http";

export type RegisterOutcome =
  | { kind: "registered" }
  | { kind: "token_replaced"; needsNewPin: boolean }
  | { kind: "refused_pending" }
  | { kind: "failed"; failure: HttpFailure };

export interface RegisterDeps {
  secure: SecureStorePort;
  // A client for this host that authenticates with this token and nothing else (the stored token is not touched yet).
  clientFor(host: string, token: string): Pick<FieldClient, "session">;
  // The current database, or null when there is none (first registration, or the key is gone).
  currentDb(): Promise<Db | null>;
  // Closes and deletes everything of the previous user: database file, map and every secure key.
  wipe(): Promise<void>;
  // Creates the key and the database of a new installation.
  createDb(): Promise<Db>;
  now(): number;
}

async function saveSession(db: Db, session: SessionResponse, host: string, now: number): Promise<void> {
  const fetchedAt = new Date(now).toISOString();
  await db.tx(async (tx) => {
    await tx.run(
      "INSERT INTO session (id, body, fetched_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
      [JSON.stringify(session), fetchedAt]);
    for (const [key, value] of [["session_host", host], ["session_user_id", session.user.id]]) {
      await tx.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
    }
  });
}

export async function registerDevice(deps: RegisterDeps, qr: { host: string; token: string }): Promise<RegisterOutcome> {
  let session: SessionResponse;
  try {
    session = await deps.clientFor(qr.host, qr.token).session();
  } catch (err) {
    if (err instanceof FieldHttpError) return { kind: "failed", failure: err.failure };
    throw err;
  }

  const storedHost = await deps.secure.get(SECURE_KEYS.host);
  const storedUser = await deps.secure.get(SECURE_KEYS.userId);
  const db = await deps.currentDb();

  if (db !== null && storedHost === qr.host && storedUser === session.user.id) {
    await deps.secure.set(SECURE_KEYS.token, qr.token);
    await saveSession(db, session, qr.host, deps.now());
    // A PIN locked by five wrong attempts is only left behind by a new one.
    return { kind: "token_replaced", needsNewPin: await isLocked(deps.secure) };
  }

  if (db !== null) {
    const pending = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    if ((pending?.n ?? 0) > 0) return { kind: "refused_pending" };
  }

  await deps.wipe();
  const fresh = await deps.createDb();
  await deps.secure.set(SECURE_KEYS.token, qr.token);
  await deps.secure.set(SECURE_KEYS.host, qr.host);
  await deps.secure.set(SECURE_KEYS.userId, session.user.id);
  await saveSession(fresh, session, qr.host, deps.now());
  return { kind: "registered" };
}
