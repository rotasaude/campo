// The PIN is created right after the device is registered, typed twice. This
// screen only collects it; who stores it (salt and hash, never the PIN) is the
// caller, with setPin.
import { useState } from "react";
import { PIN_LENGTH } from "../../security/pin";
import { Button, Field, Notice, Screen } from "../../ui/components";

export const PIN_MISMATCH = "Os PINs não são iguais";
const digits = (text: string) => text.replace(/\D/g, "").slice(0, PIN_LENGTH);

export function PinCreateScreen({ onCreated }: { onCreated(pin: string): void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const complete = pin.length === PIN_LENGTH;

  function next() {
    if (!complete) return;
    if (first === null) { setFirst(pin); setPin(""); setMismatch(false); return; }
    if (pin === first) { onCreated(pin); return; }
    setFirst(null); setPin(""); setMismatch(true);
  }

  return (
    <Screen title={first === null ? "Crie um PIN de 6 números" : "Repita o PIN"}>
      {mismatch && <Notice tone="warn">{PIN_MISMATCH}</Notice>}
      <Field label="PIN" value={pin} onChangeText={(text) => setPin(digits(text))} keyboardType="number-pad" secureTextEntry
        maxLength={PIN_LENGTH} autoFocus onSubmitEditing={next} />
      <Button label={first === null ? "Continuar" : "Criar PIN"} disabled={!complete} onPress={next} />
    </Screen>
  );
}
