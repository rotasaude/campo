// "Imóveis a visitar" of the endemic agent (35a; contrato §5; Q8, Q11): the households of the scope that have a reason
// for a visit, in the api's order, computed on the tablet (dueData.ts). The card is the dashboard's DueCard
// (apps/dashboard src/modules/vectorControl/DueList.tsx, main 2e3a2a9) with its labels (dueReasonLabel). No person:
// the household by its address and type only. "Registrar visita" opens the visit with the household's local key and
// the bulletin's start (startFor) — ids and codes only in the route.
import { useCallback } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { dictLabel } from "../../rules/dictionaries";
import { fmtDay } from "../../rules/homeVisit";
import { startFor, startForProperty, type DueReason } from "../../rules/vectorDue";
import type { VectorStart } from "../../rules/vectorInspection";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Screen } from "../../ui/components";
import { cityTodayOf } from "../session";
import { DUE_TABLES, loadDue, type DueEntry } from "./dueData";

export const DUE_TITLE = "Imóveis a visitar";
export const DUE_EMPTY = "Nenhum imóvel vencido nas suas microáreas.";
// The dashboard's dueReasonLabel (apps/dashboard src/lib/vectorControl.ts).
const DUE_REASON: Record<DueReason, string> = { transmission_block: "bloqueio", liraa: "LIRAa", pending: "pendência", due: "vencido" };

// What the visit route reads (app/(main)/visits/new.tsx): the household's local key and the start of the bulletin.
export interface DueVisitParams {
  household_id: string; vector_activity?: string; work_type?: string; liraa_draw_item_id?: string; transmission_block_id?: string;
}
export function dueVisitParams(entry: DueEntry): DueVisitParams {
  return visitParams(entry.householdKey, startFor(entry, entry.propertyType));
}

// Q59(b): the visit of a property from its detail — its card's start when the property is on the sheet (the LIRAa or
// blockade link, a pending one), the routine one otherwise.
export function propertyVisitParams(householdKey: string, propertyType: string, entry: DueEntry | null): DueVisitParams {
  return entry ? dueVisitParams(entry) : visitParams(householdKey, startForProperty(propertyType));
}

function visitParams(householdKey: string, start: VectorStart): DueVisitParams {
  return {
    household_id: householdKey,
    ...(start.activity ? { vector_activity: start.activity } : {}),
    ...(start.workType ? { work_type: start.workType } : {}),
    ...(start.liraaDrawItemId ? { liraa_draw_item_id: start.liraaDrawItemId } : {}),
    ...(start.transmissionBlockId ? { transmission_block_id: start.transmissionBlockId } : {}),
  };
}

interface Card { entry: DueEntry; property: string; risk: string | null; dates: string }

async function read(db: Db, now: number): Promise<Card[]> {
  const [{ items }, reference, today] = await Promise.all([loadDue(db, now), loadReference(db).catch(() => null), cityTodayOf(db, now)]);
  const dict = reference?.dictionaries ?? null;
  const risks = reference?.vectorDomains?.risk_classes ?? [];
  return items.map((entry) => {
    // due_since null = never worked; on the reasons that are not "vencido" the date may not have come yet.
    const due = entry.dueSince === null ? null : entry.dueSince <= today ? `vencido desde ${fmtDay(entry.dueSince)}` : `vence em ${fmtDay(entry.dueSince)}`;
    return {
      entry,
      property: dict ? dictLabel(dict, "tipo_de_imovel", entry.propertyType) : entry.propertyType,
      risk: entry.riskClass === null ? null : risks.find((r) => r.code === entry.riskClass)?.label ?? entry.riskClass,
      dates: [entry.lastWorkedOn ? `trabalhado em ${fmtDay(entry.lastWorkedOn)}` : "nunca trabalhado", due].filter(Boolean).join(" · "),
    };
  });
}

export function DueScreen({ onStartVisit }: { onStartVisit(params: DueVisitParams): void }) {
  const { colors } = useTheme();
  const { now } = useServices();
  const reader = useCallback((db: Db) => read(db, now()), [now]);
  const cards = useLive(DUE_TABLES, reader);

  if (!cards) return <Screen title={DUE_TITLE}><Muted>Carregando…</Muted></Screen>;
  return (
    <Screen title={DUE_TITLE}>
      {cards.length === 0 && <Body>{DUE_EMPTY}</Body>}
      {cards.map(({ entry, property, risk, dates }) => (
        <View key={entry.householdKey} testID={`due-${entry.householdKey}`}
          style={{ gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Body>{DUE_REASON[entry.reason]}</Body>
            {risk && <Body>{risk}</Body>}
          </View>
          <Body>{entry.address}</Body>
          <Muted>{[property, entry.block ? `Quarteirão ${entry.block.number}` : "sem quarteirão"].join(" · ")}</Muted>
          <Muted>{dates}</Muted>
          <Button label="Registrar visita" variant="secondary" onPress={() => onStartVisit(dueVisitParams(entry))} />
        </View>
      ))}
    </Screen>
  );
}
