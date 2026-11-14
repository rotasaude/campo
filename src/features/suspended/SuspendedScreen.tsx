// "Acesso suspenso": the server stopped accepting this device's token —
// automatic revocation (the person left the team, or the user was disabled),
// the device was replaced, or the token is unknown. The territory was erased;
// the queue is kept, and goes out when a new QR of the same person is read.
import { useSyncState } from "../../app/sync";
import { useLive } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { Body, Button, Notice, Screen } from "../../ui/components";
import { phraseFor } from "../messages/errorPhrases";

const TABLES = ["outbox"];
const readCount = (db: Db) => outboxRepo.count(db);

export function SuspendedScreen({ onScanNew }: { onScanNew(): void }) {
  const sync = useSyncState();
  const kept = useLive(TABLES, readCount);
  return (
    <Screen title="Acesso suspenso">
      <Notice tone="down">{phraseFor("device_suspended")}</Notice>
      {kept !== undefined && kept > 0 && (
        <Body>{kept === 1
          ? "Há 1 registro guardado neste tablet. Ele será enviado quando o acesso voltar."
          : `Há ${kept} registros guardados neste tablet. Eles serão enviados quando o acesso voltar.`}</Body>
      )}
      <Button label="Ler QR novo" onPress={onScanNew} />
      <Button label="Tentar de novo" variant="secondary" disabled={sync.running} onPress={sync.run} />
    </Screen>
  );
}
