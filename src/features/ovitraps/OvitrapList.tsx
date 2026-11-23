// "Ovitrampas" of the endemic agent (35a; contract §6, §17; Q7, Q11): the active ovitraps of the scope, by micro-area,
// with the paddles the line opened or closed on top (view.ts). The card is the dashboard's OvitrapCard
// (apps/dashboard src/modules/FieldOvitraps.tsx, main 2e3a2a9) without the egg count (the app never counts): the number,
// the household by its short address and the paddle's window (min, max and the 5-day target of §6). No person.
import { useCallback } from "react";
import { View } from "react-native";
import type { HouseholdBody } from "../../contract";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { paddleWindowText } from "../../rules/ovitrap";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Screen, Title } from "../../ui/components";
import { WAITING } from "../households/HouseholdList";
import { addressShort } from "../households/view";
import { OVITRAP_TABLES, readOvitraps } from "./view";

export const OVITRAPS_TITLE = "Ovitrampas";
// The dashboard's OVITRAPS_EMPTY.
export const OVITRAPS_EMPTY = "nenhuma ovitrampa ativa nesta microárea";

interface Card { key: string; number: string; address: string; paddle: string | null; waiting: boolean }
interface Group { id: string; title: string; cards: Card[] }

const TABLES = [...OVITRAP_TABLES, "households", "micro_areas", "reference"];

async function read(db: Db): Promise<Group[]> {
  const reference = await loadReference(db).catch(() => null);
  const params = reference?.vectorDomains?.parameters ?? null;
  const dict = reference?.dictionaries ?? null;
  const areas = (await db.all<{ id: string; body: string }>("SELECT id, body FROM micro_areas")).map((row) => {
    const body = JSON.parse(row.body) as { code: string; name: string };
    return { id: row.id, title: `${body.code} · ${body.name}`, cards: [] as Card[] };
  }).sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
  const byArea = new Map(areas.map((area) => [area.id, area]));
  for (const o of await readOvitraps(db)) {
    const row = await db.get<{ micro_area_id: string; body: string }>("SELECT micro_area_id, body FROM households WHERE key = ?", [o.householdKey]);
    const area = row ? byArea.get(row.micro_area_id) : undefined;
    if (!row || !area) continue;
    area.cards.push({
      key: o.key, number: o.number, address: addressShort(JSON.parse(row.body) as HouseholdBody, dict),
      paddle: o.installedOn === null ? null : paddleWindowText(o.installedOn, params), waiting: o.waiting,
    });
  }
  return areas;
}

export function OvitrapList({ onCollect }: { onCollect(ovitrapKey: string): void }) {
  const { colors } = useTheme();
  const groups = useLive(TABLES, useCallback((db: Db) => read(db), []));

  if (!groups) return <Screen title={OVITRAPS_TITLE}><Muted>Carregando…</Muted></Screen>;
  return (
    <Screen title={OVITRAPS_TITLE}>
      {groups.map((group) => (
        <View key={group.id} style={{ gap: 8 }}>
          <Title>{group.title}</Title>
          {group.cards.length === 0 && <Muted>{OVITRAPS_EMPTY}</Muted>}
          {group.cards.map((card) => (
            <View key={card.key} testID={`ovitrap-${card.key}`}
              style={{ gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
              <Body>{`Ovitrampa ${card.number}`}</Body>
              <Body>{card.address}</Body>
              <Muted>{card.paddle ?? "sem palheta instalada"}</Muted>
              {card.waiting && <Muted>{WAITING}</Muted>}
              {card.paddle !== null && <Button label="Coletar palheta" variant="secondary" onPress={() => onCollect(card.key)} />}
            </View>
          ))}
        </View>
      ))}
    </Screen>
  );
}
