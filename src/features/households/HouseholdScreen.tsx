// One household: where it is, who lives there and what can be done from the
// gate — edit it, add a family or a resident, register a visit. What is
// still in the line is shown as it was typed, and marked. The endemic agent
// (35a, Q13(1)) edits a non-residential property, never a family or a resident;
// with the bulletin, he visits a property nobody lives in from here (Q59(b)).
import { useCallback } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import type { RegistrationBody } from "../../contract";
import { useLive } from "../../db/events";
import type { Db } from "../../db/types";
import { dictLabel } from "../../rules/dictionaries";
import { createRegistryRules } from "../../rules/registry";
import { loadReference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { Body, Button, Muted, Notice, Screen, Title } from "../../ui/components";
import { canEditHousehold, canEditRegistry, canRecordInspection, canUseOvitraps, loadSession } from "../session";
import { DUE_TABLES, loadDue } from "../vector/dueData";
import { propertyVisitParams, type DueVisitParams } from "../vector/DueScreen";
import { readProfile } from "../vector/profile";
import { todayVisits } from "../visits/save";
import type { VisitStart } from "../who/WhoScreen";
import { READ_ONLY } from "./HouseholdForm";
import { WAITING } from "./HouseholdList";
import { AGENT_HAS_RESIDENT } from "./save";
import { HOUSEHOLD_TABLES, addressLine, hasActiveResident, pointText, readHousehold, type HouseholdView } from "./view";

// Q47: leaving the registry and the identity of a person are not done in the app.
export const AT_THE_DASHBOARD = "Mudança, óbito e correção de nome, nascimento ou documento: faça pelo dashboard.";
export const NOT_FOUND = "Domicílio não encontrado neste tablet.";
export const HAS_CONFLICT = "Há um conflito a resolver neste domicílio";

interface Resident { patientId: string; registrationKey: string; name: string; familyId: string | null; responsible: boolean }
interface Loaded {
  view: HouseholdView; line: string; type: string; residents: Resident[];
  // `canEdit`: families and residents (the registry, only the ACS); `editsHousehold`: the household itself (canEditHousehold).
  // `occupied`: the endemic agent's non-residential property with an active resident — the api refuses his edit (M2).
  canEdit: boolean; editsHousehold: boolean; occupied: boolean; visitsOn: boolean; takesFamilies: boolean;
  // 35a: the endemic agent installs an ovitrap here (canUseOvitraps), only in an active household (the api refuses
  // not_found on household_id otherwise); `hasBlock`: the profile as the tablet knows it.
  ovitraps: { hasBlock: boolean } | null;
  // Q59(b): the property's own visit, for who records the bulletin with the visit on, at an active property where nobody
  // lives as the tablet knows it (a visit with no person; with a resident, the visit goes through the resident, as in
  // the 24c).
  propertyVisit: DueVisitParams | null;
  // The hours of the visits made there today on this tablet (withdrawn ones left out).
  visitsToday: string[];
}

const TABLES = [...new Set([...HOUSEHOLD_TABLES, "registrations", "reference", "session", "local_visits", "meta", ...DUE_TABLES])];

// Nobody there, as the api would see it: an inactive household is refused (household_inactive, like the due sheet leaves
// it out), and an active family (not moved out) takes the reasons 34–37 from a visit with no person (Q44) — the
// bulletin's derived ones among them.
async function propertyVisitOf(db: Db, view: HouseholdView, now: number, visits: boolean): Promise<DueVisitParams | null> {
  if (!visits || view.body.status !== "active" || view.body.families.some((family) => !family.moved_out)) return null;
  if (await hasActiveResident(db, view.key)) return null;
  const entry = (await loadDue(db, now)).items.find((item) => item.householdKey === view.key) ?? null;
  return propertyVisitParams(view.key, view.body.property_type, entry);
}

const people = (n: number) => (n === 1 ? "1 pessoa" : `${n} pessoas`);

async function read(db: Db, key: string, now: number): Promise<Loaded | "missing"> {
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
    canEdit: canEditRegistry(session), editsHousehold: canEditHousehold(session, view.body.property_type),
    occupied: !canEditRegistry(session) && canEditHousehold(session, view.body.property_type) && await hasActiveResident(db, key), visitsOn: session?.features.home_visits === true,
    ovitraps: canUseOvitraps(session) && view.body.status === "active" ? { hasBlock: !!(await readProfile(db, key))?.city_block_id } : null,
    propertyVisit: await propertyVisitOf(db, view, now, session?.features.home_visits === true && canRecordInspection(session, reference)),
    takesFamilies: dict !== null && createRegistryRules(dict).allowsFamilies(view.body.property_type) && !view.body.refused,
    visitsToday: (await todayVisits(db, now)).filter((visit) => visit.householdKey === key && visit.state !== "withdrawn").map((visit) => visit.time),
  };
}

export function HouseholdScreen({ householdKey, onEdit, onNewFamily, onEditFamily, onNewResident, onStartVisit, onOpenResident, onInstallOvitrap, onStartPropertyVisit }: {
  householdKey: string; onEdit(): void; onNewFamily(): void; onEditFamily(familyId: string): void; onInstallOvitrap(): void;
  onStartPropertyVisit(params: DueVisitParams): void;
  // `familyId`: the family the new resident enters; null for somebody outside any family (or the head of one yet to be registered).
  onNewResident(familyId: string | null): void; onStartVisit(start: VisitStart): void; onOpenResident(registrationKey: string): void;
}) {
  const { colors } = useTheme();
  const { now } = useServices();
  const load = useCallback((db: Db) => read(db, householdKey, now()), [householdKey, now]);
  const data = useLive(TABLES, load);

  if (!data) return <Screen title="Domicílio"><Muted>Carregando…</Muted></Screen>;
  if (data === "missing") return <Screen title="Domicílio"><Notice tone="warn">{NOT_FOUND}</Notice></Screen>;
  const { view } = data;
  const body = view.body;
  const card = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;
  const families = body.families;
  const { propertyVisit } = data;

  return (
    <Screen title={data.line}>
      <Muted>{`Microárea ${body.micro_area.code} · ${data.type}`}</Muted>
      {view.conflict && <Notice tone="down">{HAS_CONFLICT}</Notice>}
      {view.pending && !view.conflict && <Notice tone="warn">{WAITING}</Notice>}
      {body.refused && <Notice>Cadastro recusado</Notice>}
      {!data.editsHousehold && <Notice>{READ_ONLY}</Notice>}
      <Body>{pointText(body.location ?? null)}</Body>
      {body.contact_phone !== null && body.contact_phone !== "" && <Body>{`Telefone: ${body.contact_phone}`}</Body>}
      {data.visitsToday.length > 0 && <Body>{`Visitas de hoje: ${data.visitsToday.join(", ")}`}</Body>}
      {data.occupied && <Notice>{AGENT_HAS_RESIDENT}</Notice>}
      {data.editsHousehold && !data.occupied && !view.conflict && <Button label="Editar domicílio" variant="secondary" onPress={onEdit} />}
      {data.ovitraps && !data.ovitraps.hasBlock && <Notice tone="warn">{VECTOR_ERRORS.household_without_block}</Notice>}
      {data.ovitraps && <Button label="Instalar ovitrampa" variant="secondary" disabled={!data.ovitraps.hasBlock} onPress={onInstallOvitrap} />}
      {propertyVisit && <Button label="Registrar visita" variant="secondary" onPress={() => onStartPropertyVisit(propertyVisit)} />}

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
              patient_id: resident.patientId, household_id: view.key, family_id: resident.familyId, micro_area_id: body.micro_area.id,
            })} />
          )}
        </View>
      ))}
      {data.canEdit && <Button label="Novo morador" variant="secondary" onPress={() => onNewResident(null)} />}
      <Muted>{AT_THE_DASHBOARD}</Muted>
    </Screen>
  );
}
