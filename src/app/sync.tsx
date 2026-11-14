// The state of the synchronisation as the screens see it: whether a round is
// running, how the last one ended and a way to start one. The provider lives
// in the app shell (AppProvider); screens only read.
import { createContext, useContext } from "react";
import type { RoundOutcome } from "../sync/round";

export interface SyncState { running: boolean; lastOutcome: RoundOutcome | null; run(): void }

export const SyncContext = createContext<SyncState>({ running: false, lastOutcome: null, run: () => undefined });
export const useSyncState = (): SyncState => useContext(SyncContext);

// What to tell the person when a round did not finish. Null: nothing to say (it worked, or the screen for it is another one).
export function outcomeText(outcome: RoundOutcome | null): string | null {
  if (outcome === null) return null;
  if (outcome.kind === "stopped") {
    if (outcome.reason === "network") return "Sem conexão: nada foi perdido. O tablet tenta de novo sozinho.";
    if (outcome.reason === "rate_limited") return "Muitos envios em pouco tempo. O tablet tenta de novo em alguns minutos.";
    return "O Rota Saúde não respondeu como esperado: nada foi perdido. O tablet tenta de novo sozinho.";
  }
  if (outcome.kind === "skipped") {
    if (outcome.reason === "offline") return "Sem conexão: nada foi perdido. O tablet tenta de novo sozinho.";
    if (outcome.reason === "needs_wifi") return "A primeira carga espera o Wi-Fi. Para usar dados móveis, ative em Sobre.";
  }
  return null;
}
