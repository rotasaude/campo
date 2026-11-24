// "Animais" on the household (35b; contract §11, Q24): the animals the tablet has there, each with what the agent needs
// at the gate — species, name, the tutor or "comunitário", whether it has a microchip (never the number, §16), whether
// something of it still waits in the line — and the dashboard's "Cadastrar animal". The household screen shows it only
// with canUseZoonoses and an active household.
import { useCallback } from "react";
import { View } from "react-native";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Notice, Title } from "../../ui/components";
import { WAITING } from "../households/HouseholdList";
import { ITEM_STATE_LABEL } from "../outbox/OutboxScreen";
import { ANIMAL_TABLES, readAnimals, type AnimalView } from "./view";

export const ANIMALS_TITLE = "Animais";
export const NEW_ANIMAL = "Cadastrar animal";
export const HAS_MICROCHIP = "Tem microchip";
export const COMMUNITY = "Comunitário";

interface Card extends AnimalView { speciesLabel: string; statusLabel: string | null }

const TABLES = [...ANIMAL_TABLES, "reference", "registrations"];

async function read(db: Db, householdKey: string): Promise<Card[]> {
  const domains = (await loadReference(db).catch(() => null))?.zoonosesDomains ?? null;
  const label = (list: { code: string; label: string }[] | undefined, code: string) => list?.find((entry) => entry.code === code)?.label ?? code;
  return (await readAnimals(db, householdKey)).map((view) => ({
    ...view, speciesLabel: label(domains?.species, view.species), statusLabel: view.status === "active" ? null : label(domains?.animal_statuses, view.status),
  }));
}

export function AnimalSection({ householdKey, onNew, onEdit }: { householdKey: string; onNew(): void; onEdit(animalKey: string): void }) {
  const { colors } = useTheme();
  const load = useCallback((db: Db) => read(db, householdKey), [householdKey]);
  const cards = useLive(TABLES, load) ?? [];
  const box = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;

  return (
    <>
      <Title>{ANIMALS_TITLE}</Title>
      {cards.map((card) => (
        <View key={card.key} testID={`animal-${card.key}`} style={box}>
          <Body>{[card.speciesLabel, card.name].filter((part) => part !== null && part !== "").join(" · ")}</Body>
          {card.community ? <Muted>{COMMUNITY}</Muted> : card.tutorName !== null && <Muted>{`Tutor: ${card.tutorName}`}</Muted>}
          {card.hasMicrochip && <Muted>{HAS_MICROCHIP}</Muted>}
          {card.statusLabel !== null && <Muted>{card.statusLabel}</Muted>}
          {card.held !== null ? <Notice tone="warn">{ITEM_STATE_LABEL[card.held]}</Notice> : card.waiting && <Muted>{WAITING}</Muted>}
          <Button label="Editar" variant="secondary" onPress={() => onEdit(card.key)} />
        </View>
      ))}
      <Button label={NEW_ANIMAL} variant="secondary" onPress={onNew} />
    </>
  );
}
