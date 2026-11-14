// The app's own lock. Asked when the app opens and after 5 minutes in the
// background. Five wrong PINs in a row lock the app for good: the way out is a
// new QR from the dashboard, read on this same tablet (the queue is kept).
import { useEffect, useState } from "react";
import { useServices } from "../../app/services";
import { MAX_PIN_FAILURES, PIN_LENGTH, checkPin, isLocked } from "../../security/pin";
import { SECURE_KEYS } from "../../security/secureStore";
import { Button, Field, Notice, Screen } from "../../ui/components";

export const LOCKED_MESSAGE =
  "Este aparelho foi bloqueado depois de 5 tentativas erradas. Leia um QR novo no dashboard: Aparelhos de campo → Substituir.";

export function LockScreen({ onUnlocked, onScanNew }: { onUnlocked(): void; onScanNew(): void }) {
  const { secure, crypto } = useServices();
  const [pin, setPin] = useState("");
  const [locked, setLocked] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    void isLocked(secure).then((value) => { if (alive) setLocked(value); });
    return () => { alive = false; };
  }, [secure]);

  async function enter() {
    if (checking || pin.length !== PIN_LENGTH) return;
    setChecking(true);
    try {
      const result = await checkPin(secure, pin, crypto);
      setPin("");
      if (result === "ok") { setLeft(null); onUnlocked(); return; }
      if (result === "locked") { setLocked(true); return; }
      setLeft(MAX_PIN_FAILURES - (Number(await secure.get(SECURE_KEYS.pinFailures)) || 0));
    } finally {
      setChecking(false);
    }
  }

  if (locked) {
    return (
      <Screen title="Aparelho bloqueado">
        <Notice tone="down">{LOCKED_MESSAGE}</Notice>
        <Button label="Ler QR novo" onPress={onScanNew} />
      </Screen>
    );
  }
  return (
    <Screen title="Digite o PIN">
      {left !== null && <Notice tone="warn">{`PIN incorreto. ${left === 1 ? "Resta 1 tentativa" : `Restam ${left} tentativas`}.`}</Notice>}
      <Field label="PIN" value={pin} onChangeText={(text) => setPin(text.replace(/\D/g, "").slice(0, PIN_LENGTH))}
        keyboardType="number-pad" secureTextEntry maxLength={PIN_LENGTH} autoFocus onSubmitEditing={() => void enter()} />
      <Button label="Entrar" disabled={pin.length !== PIN_LENGTH || checking} onPress={() => void enter()} />
    </Screen>
  );
}
