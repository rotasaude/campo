// The station changed a record while the tablet was editing it, and both
// changed the same field to different things. Nothing is decided for the
// person: each field in conflict shows what the station has and what the
// tablet has, and a side must be chosen for every one before the record can
// go again.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { useLive } from "../../db/events";
import { outboxRepo, type OutboxItem } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import type { RegistrationDictionaries } from "../../rules/dictionaries";
import { loadReference } from "../../sync/reference";
import { resolveConflict } from "../../sync/stale";
import { Button, Muted, Notice, Screen, Title } from "../../ui/components";
import { Choice } from "../../ui/choices";
import { ITEM_TYPE_LABEL } from "../outbox/OutboxScreen";
import { fieldLabel, valueText } from "./fieldText";

export const NOT_IN_CONFLICT = "Este registro não está em conflito.";
export const CONFLICT_HINT = "O posto mudou este registro enquanto você o editava. Escolha, em cada campo, qual valor fica.";

type Side = "station" | "tablet";
interface Loaded { item: OutboxItem | null; dict: RegistrationDictionaries | null; areas: Map<string, string> }

const TABLES = ["outbox", "reference", "micro_areas"];

export function ConflictScreen({ seq, onDone }: { seq: number; onDone(): void }) {
  const { db } = useServices();
  const read = useCallback(async (from: Db): Promise<Loaded> => {
    const reference = await loadReference(from).catch(() => null);
    const areas = new Map((await from.all<{ id: string; body: string }>("SELECT id, body FROM micro_areas")).map((row) => {
      const area = JSON.parse(row.body) as { code: string; name: string };
      return [row.id, `${area.code} · ${area.name}`] as const;
    }));
    return { item: await outboxRepo.bySeq(from, seq), dict: reference?.dictionaries ?? null, areas };
  }, [seq]);
  const data = useLive(TABLES, read);
  const [choices, setChoices] = useState<Record<string, Side>>({});
  const [failed, setFailed] = useState(false);

  if (!data) return <Screen title="Resolver conflito"><Muted>Carregando…</Muted></Screen>;
  const { item } = data;
  if (item === null || item.state !== "conflict" || item.conflicts === null) return <Screen title="Resolver conflito"><Notice>{NOT_IN_CONFLICT}</Notice></Screen>;

  const conflicts = item.conflicts;
  const complete = conflicts.every((conflict) => choices[conflict.path] !== undefined);
  const send = async () => {
    try {
      await resolveConflict(db, seq, choices);
      onDone();
    } catch {
      setFailed(true);
    }
  };

  return (
    <Screen title="Resolver conflito">
      <Muted>{ITEM_TYPE_LABEL[item.type] ?? item.type}</Muted>
      <Notice>{CONFLICT_HINT}</Notice>
      {conflicts.map((conflict) => (
        <View key={conflict.path} testID={`conflict-${conflict.path}`} style={{ gap: 6 }}>
          <Title>{fieldLabel(item.type, conflict.path)}</Title>
          <Choice<Side> label="Qual valor fica" showAll value={choices[conflict.path] ?? null}
            options={[
              { code: "station", label: `No posto: ${valueText(item.type, conflict.path, conflict.station, data.dict, data.areas)}` },
              { code: "tablet", label: `No tablet: ${valueText(item.type, conflict.path, conflict.tablet, data.dict, data.areas)}` },
            ]}
            onChange={(next) => {
              const { [conflict.path]: _old, ...rest } = choices;
              setChoices(next === null ? rest : { ...rest, [conflict.path]: next });
              setFailed(false);
            }} />
        </View>
      ))}
      {failed && <Notice tone="down">Não foi possível enviar. Tente de novo.</Notice>}
      <Button label="Enviar" disabled={!complete} onPress={() => { void send(); }} />
    </Screen>
  );
}
