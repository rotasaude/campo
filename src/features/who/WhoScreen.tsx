// "Quem visitar": per micro-area, the people the server listed for a visit,
// each with the reasons and a shortcut to register the visit. The list is the
// one of the last complete download; it is not recomputed on the tablet.
import { View } from "react-native";
import type { MicroAreaBody, WhoItem } from "../../contract";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Screen, Title } from "../../ui/components";
import { lastVisitText, personLine, reasonText } from "./whoText";

export const NOBODY = "Ninguém a visitar por enquanto. A lista chega na próxima sincronização completa.";

export interface VisitStart { patient_id: string; household_id: string | null; family_id: string | null; micro_area_id: string }
interface Area { id: string; title: string; people: WhoItem[] }

const TABLES = ["who_to_visit", "micro_areas"];

async function readWho(db: Db): Promise<Area[]> {
  const areas = new Map((await db.all<{ id: string; body: string }>("SELECT id, body FROM micro_areas")).map((row) => [row.id, JSON.parse(row.body) as MicroAreaBody]));
  const rows = await db.all<{ micro_area_id: string; people: string }>("SELECT micro_area_id, people FROM who_to_visit");
  return rows
    .map((row) => {
      const area = areas.get(row.micro_area_id);
      return { id: row.micro_area_id, title: area ? `${area.code} · ${area.name}` : "Microárea", people: JSON.parse(row.people) as WhoItem[] };
    })
    .filter((area) => area.people.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
}

export function WhoScreen({ onStartVisit }: { onStartVisit(start: VisitStart): void }) {
  const { colors } = useTheme();
  const areas = useLive(TABLES, readWho);

  if (!areas) return <Screen title="Quem visitar"><Muted>Carregando…</Muted></Screen>;
  return (
    <Screen title="Quem visitar">
      {areas.length === 0 && <Body>{NOBODY}</Body>}
      {areas.map((area) => (
        <View key={area.id} style={{ gap: SIZES.gap }}>
          <Title>{area.title}</Title>
          {area.people.map((person) => {
            const lastVisit = lastVisitText(person.last_visit_on);
            return (
              <View key={person.patient_id} testID={`who-${person.patient_id}`}
                style={{ gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
                <Body>{personLine(person)}</Body>
                {person.household && <Muted>{person.household.address_short}</Muted>}
                {lastVisit && <Muted>{lastVisit}</Muted>}
                {person.reasons.map((reason, index) => <Body key={index}>{reasonText(reason)}</Body>)}
                <Button label="Registrar visita" variant="secondary" onPress={() => onStartVisit({
                  patient_id: person.patient_id, household_id: person.household?.id ?? null, family_id: person.family_id, micro_area_id: person.micro_area.id,
                })} />
              </View>
            );
          })}
        </View>
      ))}
    </Screen>
  );
}
