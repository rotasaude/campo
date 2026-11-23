// The first screen after the PIN: what there is to do today and what the
// tablet still owes the server. Each way in follows its own switch of the city:
// the visit (who to visit, today's visits), the collective activity, and the
// territory registry (households and the map). The queue and the sync button
// are always there.
import { useCallback } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { outcomeText, useSyncState } from "../../app/sync";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { APP_UPDATE_NOTICE } from "../../sync/reference";
import { CONTRACT_UPDATE_NOTICE } from "../../sync/round";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";
import { DUE_TABLES } from "../vector/dueData";
import { loadHome } from "./homeData";

export const VISITS_OFF = "Visita desligada pela secretaria";
// meta: the last sync and the clock; session: the switches of the city and the micro-areas.
// reference and the vector tables (DUE_TABLES): the endemic agent's properties due.
const TABLES = [...new Set(["outbox", "who_to_visit", "micro_areas", "households", "meta", "session", ...DUE_TABLES])];

export function HomeScreen({ onOpenWho, onOpenToday, onOpenDue, onOpenOvitraps, onNewActivity, onOpenHouseholds, onOpenMap, onOpenOutbox, onOpenAbout }: {
  onOpenWho(): void; onOpenToday(): void; onOpenDue(): void; onOpenOvitraps(): void; onNewActivity(): void; onOpenHouseholds(): void; onOpenMap(): void; onOpenOutbox(): void; onOpenAbout(): void;
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
      {problem && <Notice tone={problem === CONTRACT_UPDATE_NOTICE ? "warn" : "info"}>{problem}</Notice>}

      {!home.visitsOff && (
        <View style={{ gap: 8 }}>
          {home.microAreas.map((area) => <Body key={area.id}>{`${area.code} · ${area.name}`}</Body>)}
          <Body>{`A visitar: ${home.toVisit}`}</Body>
          {home.vectorDue !== null && <Body>{`Imóveis a visitar: ${home.vectorDue}`}</Body>}
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
      {home.vectorDue !== null && <Button label="Imóveis a visitar" variant="secondary" onPress={onOpenDue} />}
      {home.ovitrapsOn && <Button label="Ovitrampas" variant="secondary" onPress={onOpenOvitraps} />}
      {!home.visitsOff && <Button label="Minhas visitas de hoje" variant="secondary" onPress={onOpenToday} />}
      {home.activitiesOn && <Button label="Nova atividade coletiva" variant="secondary" onPress={onNewActivity} />}
      {home.registryOn && <Button label="Domicílios" variant="secondary" onPress={onOpenHouseholds} />}
      {home.registryOn && <Button label="Mapa" variant="secondary" onPress={onOpenMap} />}
      <Button label="Ver envios" variant="secondary" onPress={onOpenOutbox} />
      <Button label="Sobre" variant="secondary" onPress={onOpenAbout} />
    </Screen>
  );
}
