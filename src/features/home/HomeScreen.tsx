// The first screen after the PIN: what there is to do today and what the
// tablet still owes the server. With the visit turned off by the city, only
// the queue and the sync button remain.
import { useCallback } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { outcomeText, useSyncState } from "../../app/sync";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { APP_UPDATE_NOTICE } from "../../sync/reference";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";
import { loadHome } from "./homeData";

export const VISITS_OFF = "Visita desligada pela secretaria";
const TABLES = ["outbox", "who_to_visit", "micro_areas", "households"];

export function HomeScreen({ onOpenWho, onOpenToday, onNewActivity, onOpenHouseholds, onOpenMap, onOpenOutbox, onOpenAbout }: {
  onOpenWho(): void; onOpenToday(): void; onNewActivity(): void; onOpenHouseholds(): void; onOpenMap(): void; onOpenOutbox(): void; onOpenAbout(): void;
}) {
  const { now } = useServices();
  const sync = useSyncState();
  const read = useCallback((db: Db) => loadHome(db, now()), [now]);
  const home = useLive(TABLES, read);
  const problem = outcomeText(sync.lastOutcome);

  if (!home) return <Screen title="Início"><Muted>Carregando…</Muted></Screen>;
  return (
    <Screen title="Início">
      {home.appUpdate && <Notice tone="warn">{APP_UPDATE_NOTICE}</Notice>}
      {home.clockWarning && <Notice tone="warn">{home.clockWarning}</Notice>}
      {home.territoryWarning && <Notice tone="warn">{home.territoryWarning}</Notice>}
      {home.visitsOff && <Notice tone="info">{VISITS_OFF}</Notice>}
      {problem && <Notice tone="info">{problem}</Notice>}

      {!home.visitsOff && (
        <View style={{ gap: 8 }}>
          {home.microAreas.map((area) => <Body key={area.id}>{`${area.code} · ${area.name}`}</Body>)}
          <Body>{`A visitar: ${home.toVisit}`}</Body>
        </View>
      )}
      <View style={{ gap: 8 }}>
        <Body>{`Pendentes de envio: ${home.pending}`}</Body>
        <Body>{`Precisam de atenção: ${home.attention}`}</Body>
        <Body>{`Conflitos: ${home.conflicts}`}</Body>
        <Muted>{`Última sincronização: ${home.lastSync ?? "nunca"}`}</Muted>
      </View>

      <Button label={sync.running ? "Sincronizando…" : "Sincronizar"} disabled={sync.running} onPress={sync.run} />
      {!home.visitsOff && <Button label="Quem visitar" variant="secondary" onPress={onOpenWho} />}
      {!home.visitsOff && <Button label="Minhas visitas de hoje" variant="secondary" onPress={onOpenToday} />}
      {home.activitiesOn && <Button label="Nova atividade coletiva" variant="secondary" onPress={onNewActivity} />}
      <Button label="Domicílios" variant="secondary" onPress={onOpenHouseholds} />
      <Button label="Mapa" variant="secondary" onPress={onOpenMap} />
      <Button label="Ver envios" variant="secondary" onPress={onOpenOutbox} />
      <Button label="Sobre" variant="secondary" onPress={onOpenAbout} />
    </Screen>
  );
}
