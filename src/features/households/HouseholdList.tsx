// The households of the agent's micro-areas, by street and number, as they
// are walked. What still waits to be sent is marked. Addresses only: who
// lives there is one touch further, in the household itself. The endemic
// agent (35a, Q13(1)) registers non-residential properties from here.
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { dictLabel } from "../../rules/dictionaries";
import { loadReference } from "../../sync/reference";
import { normalizeText } from "../../sync/text";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Field, Muted, Screen, Title } from "../../ui/components";
import { agentRegistersNonResidential, canEditRegistry, loadSession } from "../session";
import { HOUSEHOLD_TABLES, addressLine, listHouseholds } from "./view";

export const NO_HOUSEHOLDS = "Nenhum domicílio encontrado.";
export const WAITING = "Aguardando envio";
export const IN_CONFLICT = "Em conflito";
export const NEW_NON_RESIDENTIAL = "Novo imóvel não residencial";
// The dashboard's note for the agent's micro-areas (TerritoryTeam.tsx, NON_RESIDENTIAL_ONLY), word for word.
export const NON_RESIDENTIAL_ONLY =
  "Nesta microárea você cadastra só imóvel não residencial (ponto estratégico, comércio, terreno baldio, escola, creche, estabelecimento religioso e outros).";

interface Row { key: string; line: string; type: string; pending: boolean; conflict: boolean; search: string; number: string }
interface Group { id: string; title: string; rows: Row[] }

const TABLES = [...HOUSEHOLD_TABLES, "micro_areas", "reference", "session"];

// `creates`: what the button makes — a household of any type (the ACS), a non-residential property (the endemic agent), nothing.
async function read(db: Db): Promise<{ groups: Group[]; creates: "household" | "non_residential" | null }> {
  const reference = await loadReference(db).catch(() => null);
  const dict = reference?.dictionaries ?? null;
  const areas = new Map((await db.all<{ id: string; body: string }>("SELECT id, body FROM micro_areas")).map((row) => [row.id, JSON.parse(row.body) as { code: string; name: string }]));
  const groups = new Map<string, Group>();
  for (const view of await listHouseholds(db)) {
    const area = view.body.micro_area;
    const known = areas.get(area.id);
    const group = groups.get(area.id) ?? { id: area.id, title: known ? `${known.code} · ${known.name}` : `Microárea ${area.code}`, rows: [] };
    groups.set(area.id, group);
    const line = addressLine(view.body, dict);
    group.rows.push({
      key: view.key, line, type: dict ? dictLabel(dict, "tipo_de_imovel", view.body.property_type) : "", pending: view.pending, conflict: view.conflict,
      search: normalizeText(line), number: view.body.address?.number ?? "",
    });
  }
  const session = await loadSession(db);
  const creates = canEditRegistry(session) ? "household" : agentRegistersNonResidential(session) ? "non_residential" : null;
  return { groups: [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, "pt-BR")), creates };
}

export function HouseholdList({ onOpen, onNew }: { onOpen(key: string): void; onNew(): void }) {
  const { colors } = useTheme();
  const data = useLive(TABLES, read);
  const [query, setQuery] = useState("");

  if (!data) return <Screen title="Domicílios"><Muted>Carregando…</Muted></Screen>;
  const wanted = normalizeText(query);
  const groups = data.groups
    .map((group) => ({ ...group, rows: group.rows.filter((row) => wanted === "" || row.search.includes(wanted) || row.number === query.trim()) }))
    .filter((group) => group.rows.length > 0);

  return (
    <Screen title="Domicílios">
      {data.creates === "household" && <Button label="Novo domicílio" onPress={onNew} />}
      {data.creates === "non_residential" && (
        <>
          <Muted>{NON_RESIDENTIAL_ONLY}</Muted>
          <Button label={NEW_NON_RESIDENTIAL} onPress={onNew} />
        </>
      )}
      <Field label="Buscar por rua ou número" value={query} onChangeText={setQuery} autoCorrect={false} />
      {groups.length === 0 && <Body>{NO_HOUSEHOLDS}</Body>}
      {groups.map((group) => (
        <View key={group.id} style={{ gap: 8 }}>
          <Title>{group.title}</Title>
          {group.rows.map((row) => (
            <View key={row.key} testID={`household-${row.key}`}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Abrir ${row.line}`} onPress={() => onOpen(row.key)}
                style={{ minHeight: SIZES.touch, padding: SIZES.gap, gap: 4, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
                <Text style={{ fontSize: SIZES.text, color: colors.ink }}>{row.line}</Text>
                {row.type !== "" && <Text style={{ fontSize: SIZES.small, color: colors.ink3 }}>{row.type}</Text>}
                {row.conflict && <Text style={{ fontSize: SIZES.small, fontWeight: "700", color: colors.down }}>{IN_CONFLICT}</Text>}
                {row.pending && !row.conflict && <Text style={{ fontSize: SIZES.small, fontWeight: "700", color: colors.warn }}>{WAITING}</Text>}
              </Pressable>
            </View>
          ))}
        </View>
      ))}
    </Screen>
  );
}
