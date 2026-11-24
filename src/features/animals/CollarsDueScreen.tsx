// "Coleiras a trocar" (35b; contract Q23): its own list in the animals area, beside "Imóveis a visitar" and not inside it.
// Each row: the household's short address, the animal's name and "vence em dd/mm/aaaa" (the dashboard's labels, Q24).
// "Abrir domicílio" opens the household, whose detail has the "Animais" section. Never the tutor nor the microchip.
import { useCallback } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { fmtDay } from "../../rules/homeVisit";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Screen } from "../../ui/components";
import { COLLARS_TABLES, loadCollarsDue } from "./collars";

export const COLLARS_TITLE = "Coleiras a trocar";
export const COLLARS_EMPTY = "Nenhuma coleira a trocar nas suas microáreas.";

export function CollarsDueScreen({ onOpen }: { onOpen(householdKey: string): void }) {
  const { colors } = useTheme();
  const { now } = useServices();
  const read = useCallback((db: Db) => loadCollarsDue(db, now()), [now]);
  const rows = useLive(COLLARS_TABLES, read);

  if (!rows) return <Screen title={COLLARS_TITLE}><Muted>Carregando…</Muted></Screen>;
  return (
    <Screen title={COLLARS_TITLE}>
      {rows.length === 0 && <Body>{COLLARS_EMPTY}</Body>}
      {rows.map((row) => (
        <View key={row.animalKey} testID={`collar-${row.animalKey}`}
          style={{ gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel }}>
          <Body>{row.address}</Body>
          {row.animalName !== null && <Body>{row.animalName}</Body>}
          <Muted>{`vence em ${fmtDay(row.dueOn)}`}</Muted>
          <Button label="Abrir domicílio" variant="secondary" onPress={() => onOpen(row.householdKey)} />
        </View>
      ))}
    </Screen>
  );
}
