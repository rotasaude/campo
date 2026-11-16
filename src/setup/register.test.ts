import type { SessionResponse } from "../contract";
import { example } from "../contract/fixtures";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import * as logModule from "../log";
import { checkPin, setPin } from "../security/pin";
import { SECURE_KEYS } from "../security/secureStore";
import { fixedRandom, memorySecure, sha256 } from "../security/testing";
import { FieldHttpError } from "../sync/http";
import { registerDevice, type RegisterDeps } from "./register";

const HOST = "curitiba.rotasaude.example";
const OLD_TOKEN = "rsf_" + "O".repeat(43);
const NEW_TOKEN = "rsf_" + "N".repeat(43);
const SESSION = example<SessionResponse>("session-acs.json");
const NOW = Date.parse("2026-11-14T15:00:00Z");

const sessionOf = (userId: string): SessionResponse => ({ ...SESSION, user: { ...SESSION.user, id: userId } });
const OTHER_USER = "9c1d2e3f-0000-4000-8000-00000000abcd";

async function setup(o: { registered?: boolean; pending?: boolean; session?: SessionResponse | FieldHttpError } = {}) {
  const secure = memorySecure();
  let db: Db | null = null;
  if (o.registered) {
    db = await createTestDb();
    await secure.set(SECURE_KEYS.token, OLD_TOKEN);
    await secure.set(SECURE_KEYS.host, HOST);
    await secure.set(SECURE_KEYS.userId, SESSION.user.id);
    await secure.set(SECURE_KEYS.dbKey, "k".repeat(64));
    await db.run("INSERT INTO households (key, micro_area_id, body, street_norm, number) VALUES ('hh1', 'ma1', '{}', 'flores', '120')");
    if (o.pending) {
      await db.run("INSERT INTO outbox (client_uuid, type, body, state, created_at, updated_at) VALUES ('o1', 'home_visit', '{}', 'pending', 't', 't')");
    }
  }
  const calls: { host: string; token: string }[] = [];
  const order: string[] = [];
  let current = db;
  let fresh: Db | null = null;
  const answer = o.session ?? SESSION;
  const deps: RegisterDeps = {
    secure,
    clientFor: (host, token) => ({
      session: async () => {
        calls.push({ host, token });
        order.push("session");
        if (answer instanceof FieldHttpError) throw answer;
        return answer;
      },
    }),
    currentDb: async () => current,
    wipe: async () => {
      order.push("wipe");
      current = null;
      for (const key of Object.values(SECURE_KEYS)) await secure.delete(key);
    },
    createDb: async () => {
      order.push("createDb");
      fresh = await createTestDb();
      await secure.set(SECURE_KEYS.dbKey, "f".repeat(64));
      current = fresh;
      return fresh;
    },
    now: () => NOW,
  };
  return { deps, secure, db, calls, order, fresh: () => fresh };
}

const count = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
const meta = async (db: Db, key: string) => (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? null;

test("first registration: asks the session with the new token before writing anything, then stores token, host, user and the session", async () => {
  const t = await setup();
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "registered" });
  expect(t.calls).toEqual([{ host: HOST, token: NEW_TOKEN }]);
  expect(t.order).toEqual(["session", "wipe", "createDb"]);
  expect(await t.secure.get(SECURE_KEYS.token)).toBe(NEW_TOKEN);
  expect(await t.secure.get(SECURE_KEYS.host)).toBe(HOST);
  expect(await t.secure.get(SECURE_KEYS.userId)).toBe(SESSION.user.id);
  const fresh = t.fresh()!;
  const row = await fresh.get<{ body: string; fetched_at: string }>("SELECT body, fetched_at FROM session WHERE id = 1");
  expect(JSON.parse(row!.body)).toEqual(SESSION);
  expect(row!.fetched_at).toBe("2026-11-14T15:00:00.000Z");
  expect(await meta(fresh, "session_host")).toBe(HOST);
  expect(await meta(fresh, "session_user_id")).toBe(SESSION.user.id);
});

test("same host and user: swaps token, keeps outbox and db", async () => {
  const t = await setup({ registered: true, pending: true });
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "token_replaced", needsNewPin: false });
  expect(t.order).toEqual(["session"]);
  expect(await t.secure.get(SECURE_KEYS.token)).toBe(NEW_TOKEN);
  expect(await t.secure.get(SECURE_KEYS.dbKey)).toBe("k".repeat(64));
  expect(await count(t.db!, "outbox")).toBe(1);
  expect(await count(t.db!, "households")).toBe(1);
  expect(await count(t.db!, "session")).toBe(1);
});

test("same host and user from 'Cadastrar novo' (other device id) also swaps the token and keeps the outbox (Q16)", async () => {
  // The session does not name the device: what identifies "the same tablet owner" is host and user, whatever device row the token belongs to.
  const t = await setup({ registered: true, pending: true });
  const again = await registerDevice(t.deps, { host: HOST, token: "rsf_" + "C".repeat(43) });
  expect(again).toEqual({ kind: "token_replaced", needsNewPin: false });
  expect(await count(t.db!, "outbox")).toBe(1);
  expect(t.order).not.toContain("wipe");
});

test("a PIN locked by wrong attempts asks for a new PIN after the token swap", async () => {
  const t = await setup({ registered: true });
  await setPin(t.secure, "123456", fixedRandom, sha256);
  for (let i = 0; i < 5; i++) await checkPin(t.secure, "000000", sha256);
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "token_replaced", needsNewPin: true });
});

test("same user id on another host is another user (Q46)", async () => {
  const t = await setup({ registered: true, pending: true });
  expect(await registerDevice(t.deps, { host: "maringa.rotasaude.example", token: NEW_TOKEN })).toEqual({ kind: "refused_pending" });
  expect(await t.secure.get(SECURE_KEYS.token)).toBe(OLD_TOKEN);
});

test("other user with pending items: refused and nothing changes", async () => {
  const t = await setup({ registered: true, pending: true, session: sessionOf(OTHER_USER) });
  const before = Object.fromEntries(t.secure.data);
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "refused_pending" });
  expect(Object.fromEntries(t.secure.data)).toEqual(before);
  expect(t.order).toEqual(["session"]);
  expect(await count(t.db!, "outbox")).toBe(1);
  expect(await count(t.db!, "session")).toBe(0);
});

test("other user without pending: wipes everything then registers", async () => {
  const t = await setup({ registered: true, session: sessionOf(OTHER_USER) });
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "registered" });
  expect(t.order).toEqual(["session", "wipe", "createDb"]);
  expect(await t.secure.get(SECURE_KEYS.userId)).toBe(OTHER_USER);
  expect(await t.secure.get(SECURE_KEYS.token)).toBe(NEW_TOKEN);
  expect(await t.secure.get(SECURE_KEYS.dbKey)).toBe("f".repeat(64));
  expect(await count(t.fresh()!, "households")).toBe(0);
});

// Q83(2): a server that speaks another contract is not paired with — on a new tablet or on one already in use.
test("a session of another contract: refused, and nothing is written, swapped or erased", async () => {
  const other = { ...SESSION, contract: "field-sync-v2" } as unknown as SessionResponse;

  const first = await setup({ session: other });
  expect(await registerDevice(first.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "refused_contract" });
  expect(first.secure.data.size).toBe(0);
  expect(first.order).toEqual(["session"]);

  // The same person's new QR: the token that works with what the tablet has is not swapped.
  const same = await setup({ registered: true, pending: true, session: other });
  const before = Object.fromEntries(same.secure.data);
  expect(await registerDevice(same.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "refused_contract" });
  expect(Object.fromEntries(same.secure.data)).toEqual(before);
  expect(same.order).toEqual(["session"]);
  expect(await count(same.db!, "outbox")).toBe(1);
  expect(await count(same.db!, "session")).toBe(0);

  // Another person's QR on an idle tablet: it is not wiped for a server the app cannot talk to.
  const idle = await setup({ registered: true, session: { ...other, user: { ...other.user, id: OTHER_USER } } });
  expect(await registerDevice(idle.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "refused_contract" });
  expect(idle.order).toEqual(["session"]);
  expect(await idle.secure.get(SECURE_KEYS.token)).toBe(OLD_TOKEN);
});

test("session failure leaves the previous token in place", async () => {
  const t = await setup({ registered: true, pending: true, session: new FieldHttpError({ kind: "suspended" }) });
  const before = Object.fromEntries(t.secure.data);
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "failed", failure: { kind: "suspended" } });
  expect(Object.fromEntries(t.secure.data)).toEqual(before);
  expect(t.order).toEqual(["session"]);

  const offline = await setup({ session: new FieldHttpError({ kind: "network" }) });
  expect(await registerDevice(offline.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "failed", failure: { kind: "network" } });
  expect(offline.secure.data.size).toBe(0);
});

test("a stored key without a database (the file is gone) registers as new", async () => {
  const t = await setup();
  await t.secure.set(SECURE_KEYS.host, HOST);
  await t.secure.set(SECURE_KEYS.userId, SESSION.user.id);
  expect(await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN })).toEqual({ kind: "registered" });
  expect(t.order).toEqual(["session", "wipe", "createDb"]);
});

test("token never reaches log", async () => {
  const spy = jest.spyOn(logModule, "log");
  const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const o of [{}, { registered: true, pending: true }, { registered: true, session: new FieldHttpError({ kind: "revoked" }) }]) {
      const t = await setup(o);
      await registerDevice(t.deps, { host: HOST, token: NEW_TOKEN });
    }
    expect(JSON.stringify([spy.mock.calls, consoleSpy.mock.calls])).not.toMatch(/rsf_/);
  } finally {
    spy.mockRestore();
    consoleSpy.mockRestore();
  }
});
