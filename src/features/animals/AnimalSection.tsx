// "Animais" on the household (35b; contract §11, Q24): the animals the tablet has there, each with what the agent needs
// at the gate — species, name, the tutor or "comunitário", whether it has a microchip (never the number, §16), whether
// something of it still waits in the line — and the dashboard's "Cadastrar animal". The household screen shows it only
// with canUseZoonoses and an active household.
// Task 7: "Vacinar" on an active dog or cat while the reference has an open campaign (no check of a dose already given in
// it: the api's, Q19), "Colocar coleira" on an active dog — the animal as the line leaves it.
// Task 8: "Coletar sangue (LV)" on an active dog, for the endemic agent only (canCollectLeish), and each collection made
// here with "Etiqueta depois de enviar" until the api's label comes with the acceptance (Q21) — never one of the app's.
import { useCallback } from "react";
import { View } from "react-native";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Notice, Title } from "../../ui/components";
import { WAITING } from "../households/HouseholdList";
import { ITEM_STATE_LABEL } from "../outbox/OutboxScreen";
import { canCollectLeish, loadSession } from "../session";
import { ANIMAL_TABLES, readAnimals, type AnimalView } from "./view";

export const ANIMALS_TITLE = "Animais";
export const NEW_ANIMAL = "Cadastrar animal";
export const HAS_MICROCHIP = "Tem microchip";
export const COMMUNITY = "Comunitário";
export const VACCINATE = "Vacinar";
export const PLACE_COLLAR = "Colocar coleira";
export const COLLECT_LEISH = "Coletar sangue (LV)";
export const LABEL_AFTER_SENDING = "Etiqueta depois de enviar";
// The collection's label as the screens show it: the api's, or the contract's words while it has none.
export const labelText = (label: string | null): string => (label === null ? LABEL_AFTER_SENDING : `Etiqueta: ${label}`);

interface Card extends AnimalView { speciesLabel: string; statusLabel: string | null; vaccinates: boolean; collars: boolean; collects: boolean }

const TABLES = [...ANIMAL_TABLES, "reference", "registrations", "session"];

async function read(db: Db, householdKey: string): Promise<Card[]> {
  const reference = await loadReference(db).catch(() => null);
  const domains = reference?.zoonosesDomains ?? null;
  const collector = canCollectLeish(await loadSession(db), reference);
  const label = (list: { code: string; label: string }[] | undefined, code: string) => list?.find((entry) => entry.code === code)?.label ?? code;
  return (await readAnimals(db, householdKey)).map((view) => ({
    ...view, speciesLabel: label(domains?.species, view.species), statusLabel: view.status === "active" ? null : label(domains?.animal_statuses, view.status),
    vaccinates: view.status === "active" && (view.species === "dog" || view.species === "cat") && (domains?.open_campaign ?? null) !== null,
    collars: view.status === "active" && view.species === "dog",
    collects: collector && view.status === "active" && view.species === "dog",
  }));
}

export function AnimalSection({ householdKey, onNew, onEdit, onVaccinate, onCollar, onCollect }: {
  householdKey: string; onNew(): void; onEdit(animalKey: string): void; onVaccinate(animalKey: string): void; onCollar(animalKey: string): void;
  onCollect(animalKey: string): void;
}) {
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
          {card.collections.map((collection) => <Body key={collection.clientUuid}>{labelText(collection.label)}</Body>)}
          {card.vaccinates && <Button label={VACCINATE} variant="secondary" onPress={() => onVaccinate(card.key)} />}
          {card.collars && <Button label={PLACE_COLLAR} variant="secondary" onPress={() => onCollar(card.key)} />}
          {card.collects && <Button label={COLLECT_LEISH} variant="secondary" onPress={() => onCollect(card.key)} />}
          <Button label="Editar" variant="secondary" onPress={() => onEdit(card.key)} />
        </View>
      ))}
      <Button label={NEW_ANIMAL} variant="secondary" onPress={onNew} />
    </>
  );
}
