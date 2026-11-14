// One household: where it is, who lives there and what can be done from the
// gate — edit it, add a family or a resident, register a visit. What is
// still in the line is shown as it was typed, and marked.
import { useCallback } from "react";
import { View } from "react-native";
import type { RegistrationBody } from "../../contract";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { dictLabel } from "../../rules/dictionaries";
import { createRegistryRules } from "../../rules/registry";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Body, Button, Muted, Notice, Screen, Title } from "../../ui/components";
import { canEditRegistry, loadSession } from "../session";
import type { VisitStart } from "../who/WhoScreen";
import { READ_ONLY } from "./HouseholdForm";
import { WAITING } from "./HouseholdList";
import { HOUSEHOLD_TABLES, addressLine, pointText, readHousehold, type HouseholdView } from "./view";

// Q47: leaving the registry and the identity of a person are not done in the app.
export const AT_THE_DASHBOARD = "Mudança, óbito e correção de nome, nascimento ou documento: faça pelo dashboard.";
export const NOT_FOUND = "Domicílio não encontrado neste tablet.";
export const HAS_CONFLICT = "Há um conflito a resolver neste domicílio";

interface Resident { patientId: string; registrationKey: string; name: string; familyId: string | null; responsible: boolean }
interface Loaded {
  view: HouseholdView; line: string; type: string; residents: Resident[];
  canEdit: boolean; visitsOn: boolean; takesFamilies: boolean;
}

const TABLES = [...HOUSEHOLD_TABLES, "registrations", "reference", "session"];
const people = (n: number) => (n === 1 ? "1 pessoa" : `${n} pessoas`);

async function read(db: Db, key: string): Promise<Loaded | "missing"> {
  const view = await readHousehold(db, key);
  if (!view) return "missing";
  const reference = await loadReference(db).catch(() => null);
  const dict = reference?.dictionaries ?? null;
  const session = await loadSession(db);
  const rows = await db.all<{ key: string; body: string }>("SELECT key, body FROM registrations WHERE household_key = ? ORDER BY name_norm", [key]);
  const residents = rows.map((row) => {
    const body = JSON.parse(row.body) as RegistrationBody;
    return { patientId: body.patient.id, registrationKey: row.key, name: body.patient.display_name, familyId: body.family_id, responsible: body.is_responsible };
  });
  return {
    view, line: addressLine(view.body, dict), type: dict ? dictLabel(dict, "tipo_de_imovel", view.body.property_type) : view.body.property_type, residents,
    canEdit: canEditRegistry(session), visitsOn: session?.features.home_visits === true,
    takesFamilies: dict !== null && createRegistryRules(dict).allowsFamilies(view.body.property_type) && !view.body.refused,
  };
}

export function HouseholdScreen({ householdKey, onEdit, onNewFamily, onEditFamily, onNewResident, onStartVisit, onOpenResident }: {
  householdKey: string; onEdit(): void; onNewFamily(): void; onEditFamily(familyId: string): void;
  // `familyId`: the family the new resident enters; null for somebody outside any family (or the head of one yet to be registered).
  onNewResident(familyId: string | null): void; onStartVisit(start: VisitStart): void; onOpenResident(registrationKey: string): void;
}) {
  const { colors } = useTheme();
  const load = useCallback((db: Db) => read(db, householdKey), [householdKey]);
  const data = useLive(TABLES, load);

  if (!data) return <Screen title="Domicílio"><Muted>Carregando…</Muted></Screen>;
  if (data === "missing") return <Screen title="Domicílio"><Notice tone="warn">{NOT_FOUND}</Notice></Screen>;
  const { view } = data;
  const body = view.body;
  const card = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;
  const families = body.families;

  return (
    <Screen title={data.line}>
      <Muted>{`Microárea ${body.micro_area.code} · ${data.type}`}</Muted>
      {view.conflict && <Notice tone="down">{HAS_CONFLICT}</Notice>}
      {view.pending && !view.conflict && <Notice tone="warn">{WAITING}</Notice>}
      {body.refused && <Notice>Cadastro recusado</Notice>}
      {!data.canEdit && <Notice>{READ_ONLY}</Notice>}
      <Body>{pointText(body.location ?? null)}</Body>
      {body.contact_phone !== null && body.contact_phone !== "" && <Body>{`Telefone: ${body.contact_phone}`}</Body>}
      {data.canEdit && !view.conflict && <Button label="Editar domicílio" variant="secondary" onPress={onEdit} />}

      <Title>Famílias</Title>
      {families.length === 0 && <Muted>Nenhuma família</Muted>}
      {families.map((family) => (
        <View key={family.id} testID={`family-${family.id}`} style={card}>
          <Body>{`Responsável: ${family.responsible.display_name}`}</Body>
          {family.members_count !== null && <Muted>{people(family.members_count)}</Muted>}
          {family.moved_out && <Muted>Mudou-se</Muted>}
          {data.canEdit && !view.conflict && !family.moved_out && (
            <>
              <Button label="Editar família" variant="secondary" onPress={() => onEditFamily(family.id)} />
              <Button label="Novo morador nesta família" variant="secondary" onPress={() => onNewResident(family.id)} />
            </>
          )}
        </View>
      ))}
      {data.canEdit && data.takesFamilies && <Button label="Nova família" variant="secondary" onPress={onNewFamily} />}

      <Title>Moradores</Title>
      {data.residents.length === 0 && <Muted>Nenhum morador cadastrado</Muted>}
      {data.residents.map((resident) => (
        <View key={resident.registrationKey} testID={`resident-${resident.patientId}`} style={card}>
          <Body>{resident.name}</Body>
          {resident.responsible && <Muted>Responsável pela família</Muted>}
          <Button label="Abrir cadastro" variant="secondary" onPress={() => onOpenResident(resident.registrationKey)} />
          {data.visitsOn && (
            <Button label="Registrar visita" variant="secondary" onPress={() => onStartVisit({
              patient_id: resident.patientId, household_id: view.id ?? view.key, family_id: resident.familyId, micro_area_id: body.micro_area.id,
            })} />
          )}
        </View>
      ))}
      {data.canEdit && <Button label="Novo morador" variant="secondary" onPress={() => onNewResident(null)} />}
      <Muted>{AT_THE_DASHBOARD}</Muted>
    </Screen>
  );
}
