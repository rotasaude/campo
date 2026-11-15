// e2e builds only (EXPO_PUBLIC_E2E=1): what the encryption flow of the
// end-to-end tests reads on screen. Two lines, with fixed wording: the cipher
// the open database answers with, and what happened when a copy of the
// database file was opened WITHOUT the key — it must be refused. This module
// is loaded by `require` behind the literal flag, so nothing of it is in any
// other build. It shows nothing of what the database holds.
import { useEffect, useState } from "react";
import { useServices } from "../../app/services";
import { Body, Screen } from "../../ui/components";

export type ProbeResult = "refused" | "opened";
type Probe = ProbeResult | "checking" | "failed";

const PROBE_TEXT: Record<Probe, string> = {
  checking: "sem chave: verificando", refused: "sem chave: recusado", opened: "sem chave: ABRIU", failed: "sem chave: não foi possível verificar",
};

export function DiagnosticsScreen({ probe }: { probe(): Promise<ProbeResult> }) {
  const { db } = useServices();
  const [cipher, setCipher] = useState<string | null | undefined>(undefined);
  const [result, setResult] = useState<Probe>("checking");

  useEffect(() => {
    let alive = true;
    db.get<{ cipher_version: string | null }>("PRAGMA cipher_version")
      .then((row) => { if (alive) setCipher(row?.cipher_version ?? null); })
      .catch(() => { if (alive) setCipher(null); });
    probe().then((answer) => { if (alive) setResult(answer); }).catch(() => { if (alive) setResult("failed"); });
    return () => { alive = false; };
  }, [db, probe]);

  return (
    <Screen title="Diagnóstico">
      <Body>{cipher === undefined ? "cifra: verificando" : `cifra: ${cipher ?? "ausente"}`}</Body>
      <Body>{PROBE_TEXT[result]}</Body>
    </Screen>
  );
}
