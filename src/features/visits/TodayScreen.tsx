// "Minhas visitas de hoje": the visits made on this tablet in the city's day,
// in order, each with where it stands on its way to the server, and the way
// to take one back. When and where only — nothing of what was said there.
import { useCallback, useState } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, Muted, Notice, Screen } from "../../ui/components";
import { addressLine, readHousehold } from "../households/view";
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

const TABLES = [...TODAY_TABLES, "households", "reference"];

export function TodayScreen({ onNewVisit }: { onNewVisit(): void }) {
  const { colors } = useTheme();
  const { db, crypto, now } = useServices();
  const read = useCallback(async (from: Db): Promise<Line[]> => {
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
    return lines;
  }, [now]);
  const lines = useLive(TABLES, read);
  // The visit being taken back, the reason typed for it and what went wrong with it.
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!lines) return <Screen title="Minhas visitas de hoje"><Muted>Carregando…</Muted></Screen>;
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
        <View key={visit.clientUuid} testID={`visit-${visit.clientUuid}`}
          style={{ gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
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
    </Screen>
  );
}
