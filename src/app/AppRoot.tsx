// The app's shell. It decides what the person sees before any screen with
// people's data exists: the fatal screen (a build without the cipher), pairing
// (the QR), the PIN (always at open, and after 5 minutes away), "access
// suspended" and the first load. Only then the main screens are mounted.
//
// Nothing talks to the server before the PIN: the scheduler and the rounds
// start after it and stop when the app locks.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MissingKeyError, UNENCRYPTED_MESSAGE, UnencryptedDatabaseError, openEncryptedDb } from "../db/open";
import { territoryRepo } from "../db/repos/territoryRepo";
import type { Db } from "../db/types";
import { LockScreen } from "../features/lock/LockScreen";
import { InitialLoadScreen } from "../features/setup/InitialLoadScreen";
import { PinCreateScreen } from "../features/setup/PinCreateScreen";
import { ScanScreen } from "../features/setup/ScanScreen";
import { SuspendedScreen } from "../features/suspended/SuspendedScreen";
import { syncMapFile } from "../map/download";
import { shouldLock } from "../security/lock";
import { hasPin, setPin } from "../security/pin";
import { SECURE_KEYS } from "../security/secureStore";
import { wipeAll } from "../security/wipe";
import { registerDevice, type RegisterOutcome } from "../setup/register";
import { createFieldClient } from "../sync/http";
import { recoverSending } from "../sync/outbox";
import { runRound, type RoundOutcome, type RoundTrigger } from "../sync/round";
import { startScheduler } from "../sync/scheduler";
import { Body, Muted, Notice, Screen } from "../ui/components";
import type { Platform } from "./platform";
import { ServicesProvider, type AppServices } from "./services";
import { SyncContext, type SyncState } from "./sync";

export const OPEN_FAILED = "Não foi possível abrir os dados do app. Feche o app e abra de novo.";

type Phase = "starting" | "fatal" | "pairing" | "pin_create" | "locked" | "suspended" | "initial_load" | "ready";

export interface AppActions {
  appVersion: string; signOut(): void; scanNew(): void;
  // What the map route needs from the device.
  map: { Canvas: Platform["MapCanvas"]; readHead: Platform["readFileHead"] };
}
const AppContext = createContext<AppActions | null>(null);
export function useApp(): AppActions {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp fora do AppRoot");
  return app;
}

// Where an unlocked app goes: suspended, the first load, or the main screens.
async function gateOf(db: Db): Promise<Phase> {
  if ((await territoryRepo.getMeta(db, "suspended")) === "1") return "suspended";
  return (await territoryRepo.getMeta(db, "last_download_ok_at")) === null ? "initial_load" : "ready";
}

export function AppRoot({ platform, children }: { platform: Platform; children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [db, setDb] = useState<Db | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<RoundOutcome | null>(null);

  const dbRef = useRef<Db | null>(null);
  const unlocked = useRef(false);
  const busy = useRef(false);
  const stopScheduler = useRef<(() => void) | null>(null);
  const leftAt = useRef<number | null>(null);

  const changeDb = useCallback((next: Db | null) => { dbRef.current = next; setDb(next); }, []);
  const lock = useCallback(() => {
    unlocked.current = false;
    stopScheduler.current?.();
    stopScheduler.current = null;
  }, []);

  // Erases this installation and goes back to pairing: manual revocation, or a confirmed "Sair".
  const wipe = useCallback(async () => {
    lock();
    const current = dbRef.current;
    await wipeAll({ db: current as Db, secure: platform.secure, fs: platform.fs, closeDb: async () => { await current?.close(); } }).catch(() => undefined);
    platform.forgetDb();
    changeDb(null);
    setLastOutcome(null);
  }, [lock, platform, changeDb]);

  const run = useCallback(async (trigger: RoundTrigger) => {
    const current = dbRef.current;
    const host = await platform.secure.get(SECURE_KEYS.host);
    if (current === null || host === null || busy.current) return;
    busy.current = true;
    setRunning(true);
    try {
      const client = createFieldClient({
        host, getToken: () => platform.secure.get(SECURE_KEYS.token), fetch: platform.http, devOrigin: platform.build.devOrigin,
      });
      const outcome = await runRound({
        db: current, client, now: platform.now, net: platform.net, isLocked: () => !unlocked.current, wipeAll: wipe,
        syncMap: (manifest) => syncMapFile({ db: current, client, fs: platform.fs, downloader: platform.downloader, sha256File: platform.sha256File, net: platform.net }, manifest),
      }, trigger);
      setLastOutcome(outcome);
      if (outcome.kind === "revoked") setPhase("pairing");
      else if (outcome.kind === "suspended") setPhase("suspended");
      // The access came back (a new QR of the same person): leave the suspended screen.
      else if (outcome.kind === "ok" || outcome.kind === "feature_disabled") {
        const next = await gateOf(current);
        setPhase((now) => (now === "suspended" ? next : now));
      }
    } catch {
      // A round never breaks the shell: what failed stays in the queue for the next one.
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, [platform, wipe]);

  const enter = useCallback(async (trigger: RoundTrigger) => {
    const current = dbRef.current;
    if (current === null) return;
    unlocked.current = true;
    leftAt.current = null;
    setPhase(await gateOf(current));
    stopScheduler.current ??= startScheduler({ run, appState: platform.appState, net: platform.net, isLocked: () => !unlocked.current });
    void run(trigger);
  }, [platform, run]);

  // Start-up.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if ((await platform.secure.get(SECURE_KEYS.token)) === null) { if (alive) setPhase("pairing"); return; }
      try {
        const opened = await openEncryptedDb({ secure: platform.secure, random: platform.random, openRaw: platform.openRaw });
        await recoverSending(opened);
        if (!alive) return;
        changeDb(opened);
        // Always the PIN at open; a tablet paired but left without one creates it now.
        setPhase((await hasPin(platform.secure)) ? "locked" : "pin_create");
      } catch (err) {
        if (!alive) return;
        // The key is gone: so is the data. The tablet pairs again.
        if (err instanceof MissingKeyError) { setPhase("pairing"); return; }
        setFatal(err instanceof UnencryptedDatabaseError ? UNENCRYPTED_MESSAGE : OPEN_FAILED);
        setPhase("fatal");
      }
    })();
    return () => { alive = false; stopScheduler.current?.(); stopScheduler.current = null; };
  }, [platform, changeDb]);

  // Five minutes away and the PIN is asked again.
  useEffect(() => {
    const subscription = platform.appState.addEventListener("change", (status) => {
      if (status === "background") { leftAt.current = platform.now(); return; }
      if (status !== "active" || !unlocked.current || leftAt.current === null) return;
      if (shouldLock(leftAt.current, platform.now())) { lock(); setPhase("locked"); }
      leftAt.current = null;
    });
    return () => subscription.remove();
  }, [lock, platform]);

  const register = useCallback((qr: { host: string; token: string }) => registerDevice({
    secure: platform.secure,
    clientFor: (host, token) => createFieldClient({ host, getToken: async () => token, fetch: platform.http, devOrigin: platform.build.devOrigin }),
    currentDb: async () => dbRef.current,
    wipe,
    createDb: async () => {
      const fresh = await openEncryptedDb({ secure: platform.secure, random: platform.random, openRaw: platform.openRaw }, { create: true });
      changeDb(fresh);
      return fresh;
    },
    now: platform.now,
  }, qr), [platform, changeDb, wipe]);

  const onRegistered = useCallback((outcome: Extract<RegisterOutcome, { kind: "registered" | "token_replaced" }>) => {
    if (outcome.kind === "registered" || outcome.needsNewPin) { setPhase("pin_create"); return; }
    // The same person's new QR: whoever was already in goes on; whoever was not still owes the PIN.
    if (unlocked.current) void enter("after_pairing");
    else setPhase("locked");
  }, [enter]);

  const createPin = useCallback(async (pin: string) => {
    await setPin(platform.secure, pin, platform.random, platform.crypto);
    await enter("after_pairing");
  }, [enter, platform]);

  const services = useMemo<AppServices | null>(() => (db === null ? null : {
    db, secure: platform.secure, http: platform.http, fs: platform.fs, net: platform.net, location: platform.location, camera: undefined,
    crypto: platform.crypto, now: platform.now, random: platform.random,
  }), [db, platform]);
  const sync = useMemo<SyncState>(() => ({ running, lastOutcome, run: () => { void run("button"); } }), [lastOutcome, run, running]);
  const actions = useMemo<AppActions>(() => ({
    appVersion: platform.build.appVersion,
    signOut: () => { void wipe().then(() => setPhase("pairing")); },
    scanNew: () => setPhase("pairing"),
    map: { Canvas: platform.MapCanvas, readHead: platform.readFileHead },
  }), [platform, wipe]);

  if (phase === "starting") return <Screen><Muted>Abrindo…</Muted></Screen>;
  if (phase === "fatal") return <Screen title="O app não pode abrir"><Notice tone="down">{fatal ?? OPEN_FAILED}</Notice></Screen>;

  const pairing = (
    <ScanScreen allowedHostSuffixes={platform.build.allowedHostSuffixes} Camera={platform.Camera} register={register} onRegistered={onRegistered} />
  );
  if (services === null) return phase === "pairing" ? pairing : <Screen><Body>Abrindo…</Body></Screen>;

  let screen: ReactNode;
  if (phase === "pairing") screen = pairing;
  else if (phase === "pin_create") screen = <PinCreateScreen onCreated={(pin) => { void createPin(pin); }} />;
  else if (phase === "locked") screen = <LockScreen onUnlocked={() => { void enter("open"); }} onScanNew={() => setPhase("pairing")} />;
  else if (phase === "suspended") screen = <SuspendedScreen onScanNew={() => setPhase("pairing")} />;
  else if (phase === "initial_load") screen = <InitialLoadScreen onDone={() => setPhase("ready")} />;
  else screen = children;

  return (
    <ServicesProvider value={services}>
      <SyncContext.Provider value={sync}>
        <AppContext.Provider value={actions}>{screen}</AppContext.Provider>
      </SyncContext.Provider>
    </ServicesProvider>
  );
}
