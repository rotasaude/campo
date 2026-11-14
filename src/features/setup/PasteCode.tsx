// e2e build only (loaded by ScanScreen behind EXPO_PUBLIC_E2E): the Maestro flows paste the QR's text here,
// because an emulator has no camera to point at a QR. It does exactly what the camera does.
import { useState } from "react";
import { Button, Field } from "../../ui/components";

export function PasteCode({ onScanned }: { onScanned(text: string): void }) {
  const [text, setText] = useState("");
  return (
    <>
      <Field label="Colar código" value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} />
      <Button label="Usar código" variant="secondary" disabled={text.trim() === ""} onPress={() => onScanned(text.trim())} />
    </>
  );
}
