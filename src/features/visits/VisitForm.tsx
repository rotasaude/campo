// The home visit form: when, where, who was visited, the outcome, the
// reasons and the measurements — what each visit may carry is decided by the
// rules ported from the dashboard, read from the reference's domains. The
// moment offered is now, in the city's clock. On saving, the tablet tries for
// a precise GPS position for up to 15 seconds and saves with it or without
// it, without asking. Labels and sentences are the dashboard's
// (modules/homeVisits).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import type { RegistrationBody, SessionResponse } from "../../contract";
import type { Db } from "../../db/types";
import { captureGps } from "../../location/capture";
import {
  allowedMeasurements, createVisitRules, emptyVisitDraft, familyVisitNotice, isNonResidential, offeredReasons, pruneVisitDraft, prunedText, shiftPreview,
  type DraftHousehold, type HomeVisitTeam, type MeasureDraft, type VisitDraft, type VisitOutcome, type VisitProblem, type VisitSubject,
} from "../../rules/homeVisit";
import type { MeasurementKey } from "../../rules/domains";
import { createRegistryRules, type PatientSex } from "../../rules/registry";
import { cityNowIso } from "../../sync/clock";
import { loadReference, type Reference } from "../../sync/reference";
import { SIZES } from "../../theme/theme";
import { Choice, MultiChoice, YesNo } from "../../ui/choices";
import { Body, Button, Field, Muted, Notice, Screen, Title } from "../../ui/components";
import { dateFromScreen, dateToScreen } from "../forms/SectionFields";
import { VISITS_OFF } from "../home/HomeScreen";
import { NOT_READY } from "../households/HouseholdForm";
import { addressLine, listHouseholds, readHousehold, type HouseholdView } from "../households/view";
import { loadSession, myMicroAreas } from "../session";
import { saveVisit } from "./save";

export const NOTE_HINT = "Observação interna: não vai ao e-SUS nem ao cidadão.";
export const LOCATING = "Pegando a posição…";
const OUT_OF_AREA = "out";
const SUBJECT_LABEL: Record<VisitSubject, string> = { resident: "Morador", family_responsible: "Família — documento do responsável", none: "Imóvel sem pessoa" };
const MEASURE_LABEL: Record<MeasurementKey, string> = {
  weight_kg: "peso (kg)", height_cm: "altura (cm)", systolic: "pressão sistólica", diastolic: "pressão diastólica", temperature_c: "temperatura (°C)",
  glucose_mg_dl: "glicemia (mg/dL)",
};
const MEASURE_KEYS = Object.keys(MEASURE_LABEL) as MeasurementKey[];

export interface VisitStartKeys { householdKey?: string; patientRef?: string; familyId?: string }
interface Resident { patientRef: string; name: string; sex: PatientSex | null; familyId: string | null }
interface Clock { offsetMin: number; skewMs: number }
interface Loaded {
  session: SessionResponse; reference: Reference; clock: Clock;
  households: { key: string; label: string }[];
}

// The household as the rules read it: its families with the responsible's sex, and who lives there.
async function householdForRules(db: Db, view: HouseholdView, reference: Reference): Promise<{ detail: DraftHousehold; residents: Resident[]; label: string }> {
  const rows = await db.all<{ body: string }>("SELECT body FROM registrations WHERE household_key = ? ORDER BY name_norm", [view.key]);
  const residents = rows.map((row) => {
    const body = JSON.parse(row.body) as RegistrationBody;
    return { patientRef: body.patient.id, name: body.patient.display_name, sex: body.patient.sex, familyId: body.family_id };
  });
  const sexOf = (patientId: string) => residents.find((resident) => resident.patientRef === patientId)?.sex ?? null;
  const families = view.body.families.map((family) => ({
    id: family.id, responsible: { patient_id: family.responsible.patient_id, display_name: family.responsible.display_name, sex: sexOf(family.responsible.patient_id) },
    moved_out: family.moved_out, responsible_exited: family.responsible_exited,
  }));
  const label = addressLine(view.body, reference.dictionaries);
  return {
    label, residents,
    detail: {
      id: view.key, address_short: label, property_type: view.body.property_type, status: view.body.status, micro_area: view.body.micro_area,
      families, has_active_family: families.some((family) => !family.moved_out),
      residents: residents.map((resident) => ({ patient_id: resident.patientRef, display_name: resident.name, sex: resident.sex, family_id: resident.familyId, unidentified: false })),
    },
  };
}

export function VisitForm({ start, onSaved }: { start?: VisitStartKeys; onSaved(): void }) {
  const { db, crypto, now, location: gps } = useServices();
  const [loaded, setLoaded] = useState<Loaded | "off" | "not_ready" | null>(null);
  const [draft, setDraft] = useState<VisitDraft | null>(null);
  const [placeKind, setPlaceKind] = useState<"household" | "no_household" | null>(null);
  const [household, setHousehold] = useState<{ detail: DraftHousehold; residents: Resident[]; label: string } | null>(null);
  const [problems, setProblems] = useState<VisitProblem[]>([]);
  const [cleared, setCleared] = useState<string | null>(null);
  const [busy, setBusy] = useState<"locating" | "saving" | null>(null);
  const [failed, setFailed] = useState(false);

  // Read once: a sync in the middle of the typing must not rewrite what the person sees.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const session = await loadSession(db);
      if (session === null || session.features.home_visits !== true) { if (alive) setLoaded("off"); return; }
      const reference = await loadReference(db).catch(() => null);
      if (reference === null) { if (alive) setLoaded("not_ready"); return; }
      const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('city_offset_min', 'clock_skew_ms')")).map((row) => [row.key, row.value]));
      const clock = { offsetMin: Number(meta.get("city_offset_min") ?? 0) || 0, skewMs: Number(meta.get("clock_skew_ms") ?? 0) || 0 };
      const households = (await listHouseholds(db)).map((view) => ({ key: view.key, label: addressLine(view.body, reference.dictionaries) }));
      const nowIso = cityNowIso(now(), clock.skewMs, clock.offsetMin);
      const first: VisitDraft = { ...emptyVisitDraft(), day: nowIso.slice(0, 10), time: nowIso.slice(11, 16) };
      let detail: Awaited<ReturnType<typeof householdForRules>> | null = null;
      if (start?.householdKey !== undefined) {
        const view = await readHousehold(db, start.householdKey);
        if (view !== null) {
          detail = await householdForRules(db, view, reference);
          first.place = { kind: "household", householdId: view.key, propertyType: view.body.property_type, microAreaId: view.body.micro_area.id };
          const resident = detail.residents.find((r) => r.patientRef === start.patientRef);
          if (resident) { first.subject = "resident"; first.person = { kind: "patient", patientId: resident.patientRef, sex: resident.sex }; }
          else if (start.familyId !== undefined && detail.detail.families.some((f) => f.id === start.familyId)) { first.subject = "family_responsible"; first.familyId = start.familyId; }
        }
      }
      if (!alive) return;
      setLoaded({ session, reference, clock, households });
      setHousehold(detail);
      setPlaceKind(first.place ? "household" : null);
      setDraft(first);
    })();
    return () => { alive = false; };
  }, [db, now, start?.familyId, start?.householdKey, start?.patientRef]);

  const data = loaded !== null && typeof loaded === "object" ? loaded : null;
  const rules = useMemo(() => (data === null ? null : createVisitRules({
    offsetMin: data.clock.offsetMin, newPatientProblem: createRegistryRules(data.reference.dictionaries).newPatientProblem,
  })), [data]);

  if (loaded === null) return <Screen title="Nova visita"><Muted>Carregando…</Muted></Screen>;
  if (loaded === "off") return <Screen title="Nova visita"><Notice>{VISITS_OFF}</Notice></Screen>;
  if (data === null || draft === null || rules === null) return <Screen title="Nova visita"><Notice tone="warn">{NOT_READY}</Notice></Screen>;

  const domains = data.reference.homeVisitDomains;
  const areas = myMicroAreas(data.session);
  const detail = draft.place?.kind === "household" ? household?.detail ?? null : null;
  const sessionTeam = (() => {
    const areaId = draft.place?.microAreaId ?? null;
    const teamId = areas.find((area) => area.id === areaId)?.teamId;
    return data.session.teams.find((team) => team.id === teamId) ?? data.session.teams[0];
  })();
  const team: HomeVisitTeam = {
    id: sessionTeam.id, ine: sessionTeam.ine, name: sessionTeam.name, cbo: data.session.professional.cbo, can_register: true, reads_whole_team: false,
    out_of_area_allowed: sessionTeam.out_of_area_allowed, can_assign: false, can_register_device: false, micro_areas: sessionTeam.micro_areas, professionals: [],
  };

  // Every change is followed by taking out what stopped being valid for this visit — and the screen says what went.
  const change = (patch: Partial<VisitDraft>, forHousehold: DraftHousehold | null = detail) => {
    const pruned = pruneVisitDraft(domains, { ...draft, ...patch }, forHousehold);
    setDraft(pruned.draft);
    setCleared(pruned.cleared.length > 0 ? prunedText(pruned.cleared) : null);
    setProblems([]);
  };
  const pickHousehold = async (key: string | null) => {
    const view = key === null ? null : await readHousehold(db, key);
    if (view === null) { setHousehold(null); change({ place: null, subject: null, person: null, familyId: null }, null); return; }
    const next = await householdForRules(db, view, data.reference);
    setHousehold(next);
    change({ place: { kind: "household", householdId: view.key, propertyType: view.body.property_type, microAreaId: view.body.micro_area.id }, subject: null, person: null, familyId: null }, next.detail);
  };

  const property = detail?.property_type ?? draft.place?.propertyType ?? "";
  const residential = property !== "" && !isNonResidential(domains, property);
  const offered = offeredReasons(domains, draft, detail);
  const groups = [...new Map(offered.map((reason) => [reason.group, reason.group_label])).entries()];
  const allowed = allowedMeasurements(domains, draft, detail);
  const anyMeasure = MEASURE_KEYS.some((key) => allowed[key]);
  const notice = familyVisitNotice(domains, draft, detail);
  const activeFamilies = (household?.detail.families ?? []).filter((family) => !family.moved_out);
  const subjects: VisitSubject[] = draft.place?.kind === "household" && activeFamilies.length > 0 ? ["resident", "family_responsible", "none"] : ["resident", "none"];
  const noHousehold = draft.place?.kind === "no_household" ? draft.place : null;
  const microAreaValue = noHousehold === null ? null : noHousehold.outOfArea ? OUT_OF_AREA : noHousehold.microAreaId;

  const save = async () => {
    const corrected = new Date(now() + data.clock.skewMs);
    const today = cityNowIso(now(), data.clock.skewMs, data.clock.offsetMin).slice(0, 10);
    const found = rules.visitProblems(draft, { domains, today, minDate: data.session.min_date, team, household: detail, now: corrected });
    if (found.length > 0) { setProblems(found); return; }
    setFailed(false);
    setBusy("locating");
    const fix = await captureGps(gps);
    setBusy("saving");
    try {
      await saveVisit(db, draft, { teamId: team.id, location: fix, visitBody: rules.visitBody, newUuid: crypto.randomUUID, now });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const at = (key: string, children: ReactNode) => <View testID={`field-${key}`} style={{ gap: 6 }}>{children}</View>;
  const setMeasure = (key: keyof MeasureDraft, value: string) => change({ measurements: { ...draft.measurements, [key]: value } });

  return (
    <Screen title="Nova visita">
      <Title>Quando</Title>
      <Field label="Data (dd/mm/aaaa)" value={dateToScreen(draft.day)} keyboardType="number-pad" onChangeText={(text) => change({ day: dateFromScreen(text) })} />
      <Field label="Hora (hh:mm)" value={draft.time} keyboardType="number-pad" onChangeText={(time) => change({ time })} />
      {shiftPreview(draft.time) !== null && <Muted>{shiftPreview(draft.time)}</Muted>}

      <Title>Onde</Title>
      {draft.place?.kind === "household" && household !== null ? (
        <>
          <Body>{household.label}</Body>
          {start?.householdKey === undefined && <Button label="Trocar domicílio" variant="secondary" onPress={() => { void pickHousehold(null); }} />}
        </>
      ) : (
        <>
          {at("place_kind",
            <Choice label="Tipo de lugar" value={placeKind}
              options={[{ code: "household" as const, label: "Domicílio cadastrado" }, { code: "no_household" as const, label: "Imóvel sem cadastro" }]}
              onChange={(next) => {
                setPlaceKind(next);
                change({ place: next === "no_household" ? { kind: "no_household", propertyType: "", microAreaId: areas.length === 1 ? areas[0].id : null, outOfArea: false } : null, subject: null, person: null, familyId: null }, null);
              }} />)}
          {placeKind === "household" && at("household",
            <Choice label="Domicílio" options={data.households.map((h) => ({ code: h.key, label: h.label }))} value={null} onChange={(key) => { void pickHousehold(key); }} />)}
          {noHousehold !== null && (
            <>
              {at("micro_area",
                <Choice label="Microárea" value={microAreaValue}
                  options={[...areas.map((area) => ({ code: area.id, label: `${area.code} · ${area.name}` })), ...(team.out_of_area_allowed ? [{ code: OUT_OF_AREA, label: "Fora de área" }] : [])]}
                  onChange={(next) => change({ place: { ...noHousehold, outOfArea: next === OUT_OF_AREA, microAreaId: next === OUT_OF_AREA ? null : next } })} />)}
              {at("property_type",
                <Choice label="Tipo de imóvel" options={domains.tipo_de_imovel} value={noHousehold.propertyType === "" ? null : noHousehold.propertyType}
                  onChange={(next) => change({ place: { ...noHousehold, propertyType: next ?? "" }, ...(next !== null && isNonResidential(domains, next) ? { subject: "none" as const } : {}) })} />)}
            </>
          )}
        </>
      )}

      {residential && (
        <>
          <Title>Quem foi visitado</Title>
          {at("subject",
            <Choice label="Visita a" options={subjects.map((code) => ({ code, label: SUBJECT_LABEL[code] }))} value={draft.subject}
              onChange={(next) => change({ subject: next, person: null, familyId: null })} />)}
          {draft.subject === "resident" && household !== null && at("patient",
            <Choice label="Morador" options={household.residents.map((r) => ({ code: r.patientRef, label: r.name }))}
              value={draft.person?.kind === "patient" ? draft.person.patientId : null}
              onChange={(next) => {
                const resident = household.residents.find((r) => r.patientRef === next);
                change({ person: resident ? { kind: "patient", patientId: resident.patientRef, sex: resident.sex } : null });
              }} />)}
          {draft.subject === "family_responsible" && at("family",
            <Choice label="Família" options={activeFamilies.map((family) => ({ code: family.id, label: `Família de ${family.responsible.display_name ?? ""}` }))}
              value={draft.familyId} onChange={(next) => change({ familyId: next })} />)}
        </>
      )}

      <Title>Desfecho</Title>
      {at("outcome",
        <Choice label="Desfecho da visita" options={domains.desfecho} value={draft.outcome} onChange={(next) => change({ outcome: next as VisitOutcome | null })} />)}

      {offered.length > 0 && (
        <>
          <Title>Motivos da visita</Title>
          {groups.map(([group, label]) => (
            <View key={group} style={{ gap: 6 }}>
              <MultiChoice label={label} showAll options={offered.filter((reason) => reason.group === group && reason.disabled === null)}
                value={draft.reasons.filter((code) => offered.some((reason) => reason.code === code && reason.group === group))}
                onChange={(next) => change({ reasons: [...draft.reasons.filter((code) => !offered.some((reason) => reason.code === code && reason.group === group)), ...next] })} />
              {offered.filter((reason) => reason.group === group && reason.disabled !== null).map((reason) => <Muted key={reason.code}>{`${reason.label}: ${reason.disabled}`}</Muted>)}
            </View>
          ))}
        </>
      )}

      {anyMeasure && (
        <>
          <Title>Medidas (opcionais)</Title>
          {MEASURE_KEYS.filter((key) => allowed[key]).map((key) => (
            <Field key={key} label={MEASURE_LABEL[key]} value={draft.measurements[key]} keyboardType="decimal-pad" onChangeText={(value) => setMeasure(key, value)} />
          ))}
          {allowed.glucose_mg_dl && at("glucose_type",
            <Choice label="Tipo da glicemia" options={domains.tipo_glicemia.map((g) => ({ code: String(g.code), label: g.label }))}
              value={draft.measurements.glucose_type === "" ? null : draft.measurements.glucose_type} onChange={(next) => setMeasure("glucose_type", next ?? "")} />)}
        </>
      )}

      {at("shared", <YesNo label="Visita compartilhada" value={draft.shared} onChange={(next) => change({ shared: next === true })} />)}
      <Field label="Observação" value={draft.note} multiline onChangeText={(note) => change({ note })} />
      <Muted>{NOTE_HINT}</Muted>

      {notice !== null && <Notice>{notice}</Notice>}
      {cleared !== null && <Notice tone="warn">{cleared}</Notice>}
      <View style={{ gap: SIZES.gap }}>
        {problems.map((problem) => <Notice key={problem.path} tone="down">{problem.text}</Notice>)}
      </View>
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy === "locating" ? LOCATING : busy === "saving" ? "Salvando…" : "Registrar visita"} disabled={busy !== null} onPress={() => { void save(); }} />
    </Screen>
  );
}
