// "Sobre": which app, which city, which user; the mobile data preference; and
// "Sair", which erases this installation. With records still not sent, the
// person is told how many will be lost and has to confirm twice.
import { useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { useServices } from "../../app/services";
import type { SessionResponse } from "../../contract";
import { dbEvents, useLive } from "../../db/events";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { SECURE_KEYS } from "../../security/secureStore";
import { SIZES } from "../../theme/theme";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";

export const MOBILE_DATA_LABEL = "Usar dados móveis para a carga e o mapa";
const TABLES = ["outbox", "meta", "session"];

async function readAbout(db: Db) {
  const row = await db.get<{ body: string }>("SELECT body FROM session WHERE id = 1");
  return {
    user: row ? (JSON.parse(row.body) as SessionResponse).user.name : null,
    mobileData: (await territoryRepo.getMeta(db, "mobile_data")) === "1",
    pending: await outboxRepo.count(db),
  };
}

function signOutWarning(pending: number): string {
  if (pending === 0) return "Sair apaga os dados deste tablet. Para voltar, leia um QR novo no dashboard.";
  return pending === 1
    ? "Há 1 registro não enviado. Sair apaga tudo deste tablet, inclusive ele."
    : `Há ${pending} registros não enviados. Sair apaga tudo deste tablet, inclusive eles.`;
}

// `onOpenDiagnostics`: given only in the e2e build.
export function AboutScreen({ appVersion, onSignOut, onOpenDiagnostics }: { appVersion: string; onSignOut(): void; onOpenDiagnostics?(): void }) {
  const { db, secure } = useServices();
  const about = useLive(TABLES, readAbout);
  const [host, setHost] = useState<string | null>(null);
  // 0: not asked; 1: warned; 2: armed (only with records that would be lost).
  const [step, setStep] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    let alive = true;
    void secure.get(SECURE_KEYS.host).then((value) => { if (alive) setHost(value); });
    return () => { alive = false; };
  }, [secure]);

  if (!about) return <Screen title="Sobre"><Muted>Carregando…</Muted></Screen>;
  const setMobileData = async (on: boolean) => { await territoryRepo.setMeta(db, "mobile_data", on ? "1" : "0"); dbEvents.emit("meta"); };

  return (
    <Screen title="Sobre">
      <View style={{ gap: 6 }}>
        <Body>{`Versão ${appVersion}`}</Body>
        <Body>{`Cidade: ${host ?? "—"}`}</Body>
        <Body>{`Usuário: ${about.user ?? "—"}`}</Body>
        <Muted>© OpenStreetMap</Muted>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: SIZES.gap, minHeight: SIZES.touch }}>
        <Switch accessible accessibilityRole="switch" accessibilityLabel={MOBILE_DATA_LABEL} accessibilityState={{ checked: about.mobileData }}
          value={about.mobileData} onValueChange={(on) => void setMobileData(on)} />
        <View style={{ flex: 1 }}><Body>{MOBILE_DATA_LABEL}</Body></View>
      </View>

      {onOpenDiagnostics && <Button label="Diagnóstico" variant="secondary" onPress={onOpenDiagnostics} />}
      {step === 0 && <Button label="Sair" variant="danger" onPress={() => setStep(1)} />}
      {step > 0 && (
        <View style={{ gap: 8 }}>
          <Notice tone="down">{signOutWarning(about.pending)}</Notice>
          {step === 1 && <Button label="Sair e apagar tudo" variant="danger" onPress={() => (about.pending > 0 ? setStep(2) : onSignOut())} />}
          {step === 2 && <Button label="Confirmar: apagar tudo deste tablet" variant="danger" onPress={onSignOut} />}
          <Button label="Cancelar" variant="secondary" onPress={() => setStep(0)} />
        </View>
      )}
    </Screen>
  );
}
