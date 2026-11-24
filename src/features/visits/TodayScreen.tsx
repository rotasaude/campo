// "Minhas visitas de hoje": the visits made on this tablet in the city's day,
// in order, each with where it stands on its way to the server, and the way
// to take one back. When and where only — nothing of what was said there.
// 35b (Q21): below them, the blood collections of the day, each with its animal and "Etiqueta depois de enviar" until
// the acceptance brings the api's label. Read from local_leish_collections, so it is the same after the screen closed.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, Muted, Notice, Screen } from "../../ui/components";
import { labelText } from "../animals/AnimalSection";
import { todayCollections, type TodayCollection } from "../animals/view";
import { addressLine, readHousehold } from "../households/view";
import { ITEM_TYPE_LABEL } from "../outbox/OutboxScreen";
import { cityTodayOf } from "../session";
import { NOT_SENT_WILL_BE_ERASED, TODAY_TABLES, todayVisits, withdrawVisit, type TodayVisit } from "./save";

export const NO_VISITS_TODAY = "Nenhuma visita registrada hoje.";
const OUTCOME: Record<number, string> = { 1: "Visita realizada", 2: "Visita recusada", 3: "Ausente" };

interface Line extends TodayVisit { where: string; outcomeLabel: string; status: string; canWithdraw: boolean }

function statusOf(visit: TodayVisit): string {
  if (visit.state === "withdrawn") return "Retirada";
  if (visit.withdrawalQueued) return "Retirada aguardando envio";
  if (visit.sending === "needs_attention" || visit.sending === "conflict") return "Precisa de atenção";
  if (visit.sending === "blocked") return "Aguardando outro registro";
  // "Sent" is what the server accepted — never the mere absence of the item in the line.
  return visit.state === "accepted" ? "Enviada" : "Aguardando envio";
}

const TABLES = [...TODAY_TABLES, "households", "reference", "local_leish_collections", "animals"];

export function TodayScreen({ onNewVisit }: { onNewVisit(): void }) {
  const { colors } = useTheme();
  const { db, crypto, now } = useServices();
  const read = useCallback(async (from: Db): Promise<{ visits: Line[]; collections: TodayCollection[] }> => {
    const reference = await loadReference(from).catch(() => null);
    const outcomes = new Map((reference?.homeVisitDomains.desfecho ?? []).map((row) => [row.code, row.label]));
    const lines: Line[] = [];
    for (const visit of await todayVisits(from, now())) {
      const household = visit.householdKey === null ? null : await readHousehold(from, visit.householdKey);
      lines.push({
        ...visit, where: household ? addressLine(household.body, reference?.dictionaries ?? null) : "Imóvel sem cadastro",
        outcomeLabel: outcomes.get(visit.outcome) ?? OUTCOME[visit.outcome] ?? String(visit.outcome), status: statusOf(visit),
        canWithdraw: visit.state !== "withdrawn" && !visit.withdrawalQueued && visit.sending !== "sending",
      });
    }
    return { visits: lines, collections: await todayCollections(from, await cityTodayOf(from, now())) };
  }, [now]);
  const data = useLive(TABLES, read);
  // The visit being taken back, the reason typed for it and what went wrong with it.
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!data) return <Screen title="Minhas visitas de hoje"><Muted>Carregando…</Muted></Screen>;
  const lines = data.visits;
  const card = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;
  const withdraw = async (visit: Line) => {
    try {
      await withdrawVisit(db, visit.clientUuid, reason, { newUuid: crypto.randomUUID });
      setOpen(null); setReason(""); setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível retirar a visita.");
    }
  };

  return (
    <Screen title="Minhas visitas de hoje">
      <Button label="Nova visita" onPress={onNewVisit} />
      {lines.length === 0 && <Body>{NO_VISITS_TODAY}</Body>}
      {lines.map((visit) => (
        <View key={visit.clientUuid} testID={`visit-${visit.clientUuid}`} style={card}>
          <Body>{`${visit.time} · ${visit.where}`}</Body>
          <Muted>{visit.outcomeLabel}</Muted>
          <Muted>{visit.status}</Muted>
          {/* Q58: the dashboard's words after the 201, until the server accepts the visit. */}
          {visit.labels.length > 0 && <Body>{`Etiquete os tubitos: ${visit.labels.join(", ")}`}</Body>}
          {visit.canWithdraw && open !== visit.clientUuid && (
            <Button label="Retirar" variant="secondary" onPress={() => { setOpen(visit.clientUuid); setReason(""); setError(null); }} />
          )}
          {open === visit.clientUuid && (visit.state !== "accepted" ? (
            <>
              <Notice tone="warn">{NOT_SENT_WILL_BE_ERASED}</Notice>
              <Button label="Apagar visita" variant="danger" onPress={() => { void withdraw(visit); }} />
            </>
          ) : (
            <>
              <Field label="Motivo da retirada" value={reason} multiline onChangeText={setReason} />
              <Button label="Retirar visita" variant="danger" onPress={() => { void withdraw(visit); }} />
            </>
          ))}
          {open === visit.clientUuid && error !== null && <Notice tone="down">{error}</Notice>}
          {open === visit.clientUuid && <Button label="Cancelar" variant="secondary" onPress={() => { setOpen(null); setError(null); }} />}
        </View>
      ))}
      {data.collections.map((collection) => (
        <View key={collection.clientUuid} testID={`collection-${collection.clientUuid}`} style={card}>
          <Body>{[ITEM_TYPE_LABEL.leish_collection, collection.animalName].filter((part) => part !== null && part !== "").join(" · ")}</Body>
          <Body>{labelText(collection.label)}</Body>
        </View>
      ))}
    </Screen>
  );
}
