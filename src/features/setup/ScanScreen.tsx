// Pairing: the person reads the QR the dashboard shows ("Aparelhos de campo").
// The text is checked before anything else (qr.ts): a QR that is not ours, is
// broken or points somewhere the build does not accept never reaches the
// network. The token is never shown, logged or kept in this screen's state.
import { useRef, useState, type ComponentType, type ReactElement } from "react";
import { View } from "react-native";
import { parseQrPayload } from "../../setup/qr";
import type { RegisterOutcome } from "../../setup/register";
import type { HttpFailure } from "../../sync/http";
import { Body, Notice, Screen } from "../../ui/components";

const QR_REFUSALS = {
  not_rotasaude: "Este QR não é do Rota Saúde",
  malformed: "QR ilegível — gere outro no dashboard",
  host_not_allowed: "Este QR aponta para um endereço que o app não reconhece",
} as const;
export const REFUSED_CONTRACT = "Atualize o app antes de cadastrar este tablet.";
export const REFUSED_PENDING = "Há registros deste tablet ainda não enviados. Sincronize com o usuário atual antes de cadastrar outro.";

function failureText(failure: HttpFailure): string {
  if (failure.kind === "network") return "Sem conexão: leia o QR de novo quando houver rede.";
  if (failure.kind === "suspended" || failure.kind === "revoked") return "Este QR não vale mais. Gere outro no dashboard.";
  return "O Rota Saúde não respondeu como esperado. Tente de novo em alguns minutos.";
}

export function ScanScreen({ allowedHostSuffixes, Camera, register, onRegistered }: {
  allowedHostSuffixes: string[];
  // The camera view of the platform; it calls onScanned with the text of each code it reads.
  Camera: ComponentType<{ onScanned(text: string): void }>;
  register(qr: { host: string; token: string }): Promise<RegisterOutcome>;
  onRegistered(outcome: Extract<RegisterOutcome, { kind: "registered" | "token_replaced" }>): void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // The camera keeps reading the same code many times a second: only one is handled at a time.
  const busy = useRef(false);

  async function scanned(text: string) {
    if (busy.current) return;
    const qr = parseQrPayload(text, allowedHostSuffixes);
    if (!qr.ok) { setMessage(QR_REFUSALS[qr.reason]); return; }
    busy.current = true;
    setWorking(true);
    setMessage(null);
    try {
      const outcome = await register({ host: qr.host, token: qr.token });
      if (outcome.kind === "registered" || outcome.kind === "token_replaced") onRegistered(outcome);
      else if (outcome.kind === "refused_contract") setMessage(REFUSED_CONTRACT);
      else setMessage(outcome.kind === "refused_pending" ? REFUSED_PENDING : failureText(outcome.failure));
    } catch {
      setMessage("Não foi possível cadastrar o aparelho. Leia o QR de novo.");
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }
  const onScanned = (text: string) => { void scanned(text); };

  // Maestro cannot show a QR to the emulator's camera: the e2e build has a field to paste the code (Q48).
  // The literal check lets the bundler drop the branch — and the module — from every other build.
  let paste: ReactElement | null = null;
  if (process.env.EXPO_PUBLIC_E2E === "1") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PasteCode } = require("./PasteCode") as typeof import("./PasteCode");
    paste = <PasteCode onScanned={onScanned} />;
  }

  return (
    <Screen title="Leia o QR do dashboard">
      <Body>No dashboard, abra Aparelhos de campo, cadastre este aparelho e aponte a câmera para o QR.</Body>
      {message && <Notice tone="warn">{message}</Notice>}
      {working ? <Body>Cadastrando o aparelho…</Body> : <View><Camera onScanned={onScanned} /></View>}
      {paste}
    </Screen>
  );
}
