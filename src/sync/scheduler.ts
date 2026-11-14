// When a round starts by itself: on coming back to the foreground and every
// 15 minutes with a network. Never while the app is locked — a round reads
// and writes people's data, and the PIN comes first. The round at open (after
// the PIN) and the one after pairing belong to the app shell.
import type { RoundTrigger } from "./round";

export const SYNC_INTERVAL_MS = 15 * 60_000;

export interface SchedulerDeps {
  run: (trigger: RoundTrigger) => Promise<unknown>;
  // React Native's AppState: "active" | "background" | "inactive".
  appState: { addEventListener(event: "change", listener: (status: string) => void): { remove(): void } };
  net: { isOnline(): Promise<boolean> };
  isLocked: () => boolean;
  intervalMs?: number;
}

// Returns the function that stops it.
export function startScheduler(deps: SchedulerDeps): () => void {
  let wasAway = false;
  // A round that fails is the round's business (it returns an outcome); a throw must not break the schedule.
  const fire = (trigger: RoundTrigger) => { if (!deps.isLocked()) void deps.run(trigger).catch(() => undefined); };

  const subscription = deps.appState.addEventListener("change", (status) => {
    if (status === "background") { wasAway = true; return; }
    if (status === "active" && wasAway) { wasAway = false; fire("foreground"); }
  });
  const timer = setInterval(() => {
    if (deps.isLocked()) return;
    void deps.net.isOnline().then((online) => { if (online) fire("timer"); }).catch(() => undefined);
  }, deps.intervalMs ?? SYNC_INTERVAL_MS);

  return () => { subscription.remove(); clearInterval(timer); };
}
