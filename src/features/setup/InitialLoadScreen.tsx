// The first load after pairing: the whole scope of the device comes down, page
// by page. It is the big download, so it waits for Wi-Fi unless the person
// says mobile data may be used.
import { useServices } from "../../app/services";
import { outcomeText, useSyncState } from "../../app/sync";
import { dbEvents, useLive } from "../../db/events";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { readMapFile } from "../../map/download";
import { Body, Button, Muted, Notice, Screen } from "../../ui/components";

export const MAP_NOT_DOWNLOADED = "Mapa ainda não baixado";
const TABLES = ["households", "registrations", "map_file", "meta"];

async function readLoad(db: Db) {
  const count = async (table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0;
  return {
    households: await count("households"), registrations: await count("registrations"),
    complete: (await territoryRepo.getMeta(db, "last_download_ok_at")) !== null,
    hasMap: (await readMapFile(db)) !== null,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function InitialLoadScreen({ onDone }: { onDone(): void }) {
  const { db } = useServices();
  const sync = useSyncState();
  const load = useLive(TABLES, readLoad);

  if (!load) return <Screen title="Primeira carga"><Muted>Carregando…</Muted></Screen>;
  const arrived = `${plural(load.households, "domicílio", "domicílios")} e ${plural(load.registrations, "cadastro", "cadastros")}`;
  const needsWifi = sync.lastOutcome?.kind === "skipped" && sync.lastOutcome.reason === "needs_wifi";
  const problem = needsWifi ? null : outcomeText(sync.lastOutcome);
  const allowMobileData = async () => { await territoryRepo.setMeta(db, "mobile_data", "1"); dbEvents.emit("meta"); sync.run(); };

  if (load.complete) {
    return (
      <Screen title="Primeira carga">
        <Notice tone="ok">{`Carga concluída: ${arrived} neste tablet.`}</Notice>
        <Muted>{load.hasMap ? "Mapa baixado" : MAP_NOT_DOWNLOADED}</Muted>
        <Button label="Continuar" onPress={onDone} />
      </Screen>
    );
  }
  return (
    <Screen title="Primeira carga">
      {sync.running && <Body>{`Baixando o território: ${arrived} até agora.`}</Body>}
      {needsWifi && (
        <>
          <Notice tone="info">A primeira carga é grande e espera o Wi-Fi.</Notice>
          <Button label="Usar dados móveis agora" variant="secondary" onPress={() => void allowMobileData()} />
        </>
      )}
      {problem && <Notice tone="info">{problem}</Notice>}
      {!sync.running && <Button label="Tentar de novo" onPress={sync.run} />}
    </Screen>
  );
}
