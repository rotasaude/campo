// The home visit form: when, where, who was visited, the outcome, the
// reasons and the measurements — what each visit may carry is decided by the
// rules ported from the dashboard, read from the reference's domains. The
// moment offered is now, in the city's clock. On saving, the tablet tries for
// a precise GPS position for up to 15 seconds and saves with it or without
// it, without asking. Labels and sentences are the dashboard's
// (modules/homeVisits).
// 35a: for the endemic agent (canRecordInspection), "Registrar boletim" (on) and, with a registered household, the
// bulletin after "Quem foi visitado" (InspectionSection). With it the outcome comes from the property's situation, the
// reasons 34–37 are not offered (the api derives them: the screen previews them and counts them in the 24b's rules),
// and saving also runs checkInspection. The visit's client_uuid is drawn when the form opens and is the one saved: the
// sample labels shown are made from it (§9).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import type { RegistrationBody, SessionResponse } from "../../contract";
import { territoryRepo } from "../../db/repos/territoryRepo";
import type { Db } from "../../db/types";
import { captureGps } from "../../location/capture";
import {
  allowedMeasurements, createVisitRules, emptyVisitDraft, familyVisitNotice, isNonResidential, offeredReasons, pruneVisitDraft, prunedText, reasonLabel, shiftPreview,
  type DraftHousehold, type HomeVisitTeam, type MeasureDraft, type VisitDraft, type VisitOutcome, type VisitProblem, type VisitSubject,
} from "../../rules/homeVisit";
import type { MeasurementKey } from "../../rules/domains";
import { createRegistryRules, type PatientSex } from "../../rules/registry";
import {
  DERIVED_REASONS, ENDEMIC_AGENT_CBO, createInspectionRules, derivedReasons, emptyInspectionDraft, issueText, outcomeForSituation, pruneInspection,
  type InspectionCtx, type InspectionDraft, type VectorStart,
} from "../../rules/vectorInspection";
import { cityNowIso } from "../../sync/clock";
import { loadReference, type Reference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Check, Choice, MultiChoice, YesNo } from "../../ui/choices";
import { Body, Button, Field, FieldRefusal, InSightAfter, Muted, Notice, Screen, Title } from "../../ui/components";
import { dateFromScreen, dateToScreen } from "../forms/SectionFields";
import { VISITS_OFF } from "../home/HomeScreen";
import { NOT_READY } from "../households/HouseholdForm";
import { addressLine, listHouseholds, readHousehold, type HouseholdView } from "../households/view";
import { canRecordInspection, loadSession, myMicroAreas, vectorControlOn } from "../session";
import { readInspectionFacts, type InspectionFacts } from "../vector/profile";
import { BULLETIN_NEEDS_HOUSEHOLD, BULLETIN_UNAVAILABLE, InspectionSection, inspectionPaths, type InspectionChange } from "./InspectionSection";
import { saveVisit, toUploadBody } from "./save";

export const NOTE_HINT = "Observação interna: não vai ao e-SUS nem ao cidadão.";
export const LOCATING = "Pegando a posição…";
const OUT_OF_AREA = "out";
const SUBJECT_LABEL: Record<VisitSubject, string> = { resident: "Morador", family_responsible: "Família — documento do responsável", none: "Imóvel sem pessoa" };
const MEASURE_LABEL: Record<MeasurementKey, string> = {
  weight_kg: "peso (kg)", height_cm: "altura (cm)", systolic: "pressão sistólica", diastolic: "pressão diastólica", temperature_c: "temperatura (°C)",
  glucose_mg_dl: "glicemia (mg/dL)",
};
const MEASURE_KEYS = Object.keys(MEASURE_LABEL) as MeasurementKey[];

// `vector`: the bulletin's start (activity, work type and the LIRAa or transmission block link), from the lists of what to visit.
export interface VisitStartKeys { householdKey?: string; patientRef?: string; familyId?: string; vector?: VectorStart }
interface Resident { patientRef: string; name: string; sex: PatientSex | null; familyId: string | null }
interface Clock { offsetMin: number; skewMs: number }
interface Loaded {
  session: SessionResponse; reference: Reference; clock: Clock;
  households: { key: string; label: string }[];
  // The visit's client_uuid, drawn once when the form opens.
  clientUuid: string;
}
// A refusal on screen: the object of this save (FieldRefusal brings it into sight once per save).
type Shown = VisitProblem & { message: string };

// The household as the rules read it: its families with the responsible's sex, and who lives there; for the bulletin,
// its server id and neighbourhood and the vector facts of the tablet.
interface ChosenHousehold { detail: DraftHousehold; residents: Resident[]; label: string; serverId: string | null; vector: InspectionFacts }
async function householdForRules(db: Db, view: HouseholdView, reference: Reference): Promise<ChosenHousehold> {
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
    label, residents, serverId: view.id, vector: await readInspectionFacts(db, view.key),
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
  const [household, setHousehold] = useState<ChosenHousehold | null>(null);
  const [problems, setProblemsState] = useState<Shown[]>([]);
  const setProblems = (found: VisitProblem[]) => setProblemsState(found.map((problem) => ({ ...problem, message: problem.text })));
  // The bulletin (35a): only in memory, as the rest of the form.
  const [bulletin, setBulletin] = useState(true);
  const [inspection, setInspection] = useState<InspectionDraft>(() => emptyInspectionDraft(start?.vector));
  const [inspCleared, setInspCleared] = useState<string | null>(null);
  const [touched, setTouched] = useState<{ entry: boolean; exit: boolean }>({ entry: false, exit: false });
  const { colors } = useTheme();
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
      let detail: ChosenHousehold | null = null;
      if (start?.householdKey !== undefined) {
        // The household may come named by its server id (the list of who to visit) or by its local key.
        const view = await readHousehold(db, (await territoryRepo.householdKey(db, start.householdKey)) ?? start.householdKey);
        if (view !== null) {
          detail = await householdForRules(db, view, reference);
          first.place = { kind: "household", householdId: view.key, propertyType: view.body.property_type, microAreaId: view.body.micro_area.id };
          const resident = detail.residents.find((r) => r.patientRef === start.patientRef);
          if (resident) { first.subject = "resident"; first.person = { kind: "patient", patientId: resident.patientRef, sex: resident.sex }; }
          else if (start.familyId !== undefined && detail.detail.families.some((f) => f.id === start.familyId)) { first.subject = "family_responsible"; first.familyId = start.familyId; }
        }
      }
      if (!alive) return;
      setLoaded({ session, reference, clock, households, clientUuid: crypto.randomUUID().toLowerCase() });
      // The entry offered is the minute of the visit's moment (Q11).
      setInspection((current) => ({ ...current, enteredAt: first.time }));
      setHousehold(detail);
      setPlaceKind(first.place ? "household" : null);
      setDraft(first);
    })();
    return () => { alive = false; };
  }, [crypto, db, now, start?.familyId, start?.householdKey, start?.patientRef]);

  const data = loaded !== null && typeof loaded === "object" ? loaded : null;
  const rules = useMemo(() => (data === null ? null : createVisitRules({
    offsetMin: data.clock.offsetMin, newPatientProblem: createRegistryRules(data.reference.dictionaries).newPatientProblem,
  })), [data]);
  const inspectionRules = useMemo(() => (data === null ? null : createInspectionRules({ offsetMin: data.clock.offsetMin })), [data]);

  if (loaded === null) return <Screen title="Nova visita"><Muted>Carregando…</Muted></Screen>;
  if (loaded === "off") return <Screen title="Nova visita"><Notice>{VISITS_OFF}</Notice></Screen>;
  if (data === null || draft === null || rules === null || inspectionRules === null) return <Screen title="Nova visita"><Notice tone="warn">{NOT_READY}</Notice></Screen>;

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

  // The bulletin (35a): the endemic agent with the switch and the domains; on, with a registered household (Q10).
  const vectorDomains = canRecordInspection(data.session, data.reference) ? data.reference.vectorDomains : null;
  const unavailable = vectorDomains === null && vectorControlOn(data.session) && data.session.professional.cbo === ENDEMIC_AGENT_CBO;
  const atHousehold = draft.place?.kind === "household" && household !== null;
  const vectorOn = vectorDomains !== null && bulletin && atHousehold;
  const facts = household?.vector ?? null;
  const derived = vectorOn ? derivedReasons(inspectionRules.inspectionInput(inspection, draft.day)) : [];
  // What the api reads in the 24b's rules: the reasons chosen and the bulletin's, once each (inspection_rules.rb#derived_reasons).
  const extra = derived.filter((code) => !draft.reasons.includes(code));
  const reasonRules: VisitDraft = extra.length > 0 ? { ...draft, reasons: [...draft.reasons, ...extra] } : draft;

  // Every change is followed by taking out what stopped being valid for this visit — and the screen says what went.
  const change = (patch: Partial<VisitDraft>, forHousehold: DraftHousehold | null = detail) => {
    const pruned = pruneVisitDraft(domains, { ...draft, ...patch }, forHousehold);
    setDraft(pruned.draft);
    setCleared(pruned.cleared.length > 0 ? prunedText(pruned.cleared) : null);
    setProblems([]);
  };
  const pickHousehold = async (key: string | null) => {
    const view = key === null ? null : await readHousehold(db, key);
    // The block chosen was of the household before.
    if (inspection.cityBlockId !== null) { setInspection((i) => ({ ...i, cityBlockId: null })); setInspCleared(prunedText(["quarteirão"])); }
    if (view === null) { setHousehold(null); change({ place: null, subject: null, person: null, familyId: null }, null); return; }
    const next = await householdForRules(db, view, data.reference);
    setHousehold(next);
    change({ place: { kind: "household", householdId: view.key, propertyType: view.body.property_type, microAreaId: view.body.micro_area.id }, subject: null, person: null, familyId: null }, next.detail);
  };
  // The visit's time: the entry offered follows it while it was not typed (Q11).
  const changeTime = (time: string) => {
    if (!touched.entry) setInspection((i) => ({ ...i, enteredAt: time }));
    change({ time });
  };

  // Review Focus 1: with the property worked (or no situation yet), no sample goes by itself — the labels already shown
  // would renumber. A sample left over by fewer larvae is refused at saving (samples_exceed_larvae) and the agent
  // deletes the last one. Closed, refused or vacant takes everything out, and says what.
  const prune = (next: InspectionDraft) => {
    if (next.situation !== null && next.situation !== "worked") return pruneInspection(next);
    const out = pruneInspection({ ...next, samples: [] });
    return { draft: { ...out.draft, samples: next.samples }, cleared: out.cleared };
  };
  // A change of the situation passes by the prune and fixes the outcome (pruning the visit for it); the rest is set as it came.
  const onInspection = (next: InspectionDraft, o: InspectionChange = {}) => {
    setProblems([]);
    if (o.touched) setTouched((t) => ({ ...t, [o.touched as "entry" | "exit"]: true }));
    const lost = [...(o.cleared ?? [])];
    let out = next;
    if (o.prune) {
      const pruned = prune(next);
      out = pruned.draft;
      lost.unshift(...pruned.cleared);
      if (next.situation !== null && next.situation !== inspection.situation) {
        const visit = pruneVisitDraft(domains, { ...draft, outcome: outcomeForSituation(next.situation) }, detail);
        setDraft(visit.draft);
        setCleared(null);
        lost.push(...visit.cleared);
      }
    }
    setInspection(out);
    setInspCleared(lost.length > 0 ? prunedText(lost) : null);
  };
  const toggleBulletin = (on: boolean) => {
    setBulletin(on);
    setInspCleared(null);
    if (on && inspection.situation !== null) change({ outcome: outcomeForSituation(inspection.situation) });
    else setProblems([]);
  };

  const property = detail?.property_type ?? draft.place?.propertyType ?? "";
  const residential = property !== "" && !isNonResidential(domains, property);
  // With the bulletin, the 24b's offer reads the derived reasons too (the limit and the family's turn count with them),
  // and 34–37 are not offered — unless already marked, so they can be unmarked (the rule refuses them: reason_derived).
  const offered = offeredReasons(domains, reasonRules, detail)
    .filter((reason) => !vectorOn || !(DERIVED_REASONS as readonly number[]).includes(reason.code) || draft.reasons.includes(reason.code));
  const groups = [...new Map(offered.map((reason) => [reason.group, reason.group_label])).entries()];
  const allowed = allowedMeasurements(domains, reasonRules, detail);
  const anyMeasure = MEASURE_KEYS.some((key) => allowed[key]);
  const notice = familyVisitNotice(domains, reasonRules, detail);
  const activeFamilies = (household?.detail.families ?? []).filter((family) => !family.moved_out);
  const subjects: VisitSubject[] = draft.place?.kind === "household" && activeFamilies.length > 0 ? ["resident", "family_responsible", "none"] : ["resident", "none"];
  const noHousehold = draft.place?.kind === "no_household" ? draft.place : null;
  const microAreaValue = noHousehold === null ? null : noHousehold.outOfArea ? OUT_OF_AREA : noHousehold.microAreaId;
  const outcomeLabel = (code: VisitOutcome) => domains.desfecho.find((row) => row.code === code)?.label ?? String(code);

  // The facts the api reads for the bulletin, as the tablet has them.
  const inspectionCtx = (): InspectionCtx => ({
    visit: { outcome: (draft.outcome ?? 0) as VisitOutcome, occurred_at: rules.occurredAt(draft.day, draft.time) ?? "", reasons: draft.reasons },
    household: household === null ? null : { id: household.serverId ?? household.detail.id, property_type: property, neighborhood_id: facts?.neighborhoodId ?? null },
    profile: facts?.profile ? { city_block_id: facts.profile.city_block_id } : null,
    agent: true, gateUsable: true, products: vectorDomains?.products ?? [], limits: vectorDomains!.limits,
    ...(facts?.blocks ? { blocks: facts.blocks.map((b) => ({ id: b.id, neighborhood_id: b.neighborhood_id, active: b.active })) } : {}),
    liraaItems: (facts?.liraaItems ?? []).map((item) => ({ id: item.id, household_id: item.household_id, status: item.status })),
    transmissionBlocks: (facts?.transmissionBlocks ?? []).map((block) => ({ id: block.id, status: block.status, block_ids: block.block_ids })),
  });

  const save = async () => {
    const corrected = new Date(now() + data.clock.skewMs);
    const nowIso = cityNowIso(now(), data.clock.skewMs, data.clock.offsetMin);
    const today = nowIso.slice(0, 10);
    const ctx = { domains, today, minDate: data.session.min_date, team, household: detail, now: corrected };
    let found: VisitProblem[];
    let vectorInspection = null;
    if (!vectorOn) found = rules.visitProblems(draft, ctx);
    else {
      // The exit not typed is now, in the city's clock corrected (campo#2); always on the visit's day — a visit opened
      // before midnight and saved after it is refused here, before saving (Review Focus 2).
      const bulletinNow = !touched.exit && inspection.enteredAt.trim() !== "" ? { ...inspection, leftAt: nowIso.slice(11, 16) } : inspection;
      if (bulletinNow !== inspection) setInspection(bulletinNow);
      // The 24b's rules with the derived reasons (the limit counts them, path reasons); a refusal at a derived reason
      // points at `subject`, as the api's (Q10).
      const n = draft.reasons.length;
      found = rules.visitProblems(reasonRules, ctx).map((problem) => {
        const index = /^reasons\[(\d+)\]$/.exec(problem.path);
        return index && Number(index[1]) >= n ? { ...problem, path: "subject" } : problem;
      });
      const input = inspectionRules.inspectionInput(bulletinNow, draft.day);
      const issues = inspectionRules.checkInspection(input, inspectionCtx());
      found.push(...issues.map(issueText));
      if (issues.length === 0) vectorInspection = toUploadBody(input, issues);
    }
    if (found.length > 0) { setProblems(found); return; }
    setFailed(false);
    setBusy("locating");
    const fix = await captureGps(gps);
    setBusy("saving");
    try {
      await saveVisit(db, draft, {
        clientUuid: data.clientUuid, teamId: team.id, location: fix, visitBody: rules.visitBody, newUuid: crypto.randomUUID, now, vectorInspection,
      });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  // What is on screen now: the refusals of these paths go under their field; any other, before the button.
  const choosingPlace = !(draft.place?.kind === "household" && household !== null);
  const showPatient = residential && draft.subject === "resident" && household !== null;
  const showFamily = residential && draft.subject === "family_responsible";
  const shownMeasures = anyMeasure ? MEASURE_KEYS.filter((key) => allowed[key]) : [];
  const placed = new Set<string>([
    "occurred_at", ...(choosingPlace ? ["household_id"] : []), ...(noHousehold !== null ? ["micro_area_id", "property_type"] : []),
    ...(residential ? ["subject"] : []), ...(showPatient ? ["patient_id"] : []), ...(showFamily ? ["family_id"] : []),
    "outcome", ...(offered.length > 0 ? ["reasons"] : []), ...shownMeasures.map((key) => `measurements.${key}`),
    ...(anyMeasure && allowed.glucose_mg_dl ? ["measurements.glucose_type"] : []), "shared", "note",
    ...(vectorOn ? inspectionPaths(inspection) : []),
  ]);
  // The refusals of a field, under it: the first of this save brings itself into sight (FieldRefusal), once.
  const refusals = (path: string): ReactNode => problems.map((problem, index) => (problem.path !== path ? null : index === 0
    ? <FieldRefusal key={index} problem={problem} />
    : <Text key={index} accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.text}</Text>));
  const at = (key: string, children: ReactNode, path = key) => <View testID={`field-${key}`} style={{ gap: 6 }}>{children}{refusals(path)}</View>;
  const setMeasure = (key: keyof MeasureDraft, value: string) => change({ measurements: { ...draft.measurements, [key]: value } });

  const body = (
    <>
      <Title>Quando</Title>
      {at("occurred_at", (
        <>
          <Field label="Data (dd/mm/aaaa)" value={dateToScreen(draft.day)} keyboardType="number-pad" onChangeText={(text) => change({ day: dateFromScreen(text) })} />
          <Field label="Hora (hh:mm)" value={draft.time} keyboardType="number-pad" onChangeText={changeTime} />
        </>
      ))}
      {shiftPreview(draft.time) !== null && <Muted>{shiftPreview(draft.time)}</Muted>}

      <Title>Onde</Title>
      {!choosingPlace && household !== null ? (
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
              }} />, "household_id")}
          {placeKind === "household" && at("household",
            <Choice label="Domicílio" options={data.households.map((h) => ({ code: h.key, label: h.label }))} value={null} onChange={(key) => { void pickHousehold(key); }} />)}
          {noHousehold !== null && (
            <>
              {at("micro_area",
                <Choice label="Microárea" value={microAreaValue}
                  options={[...areas.map((area) => ({ code: area.id, label: `${area.code} · ${area.name}` })), ...(team.out_of_area_allowed ? [{ code: OUT_OF_AREA, label: "Fora de área" }] : [])]}
                  onChange={(next) => change({ place: { ...noHousehold, outOfArea: next === OUT_OF_AREA, microAreaId: next === OUT_OF_AREA ? null : next } })} />, "micro_area_id")}
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
          {showPatient && household !== null && at("patient",
            <Choice label="Morador" options={household.residents.map((r) => ({ code: r.patientRef, label: r.name }))}
              value={draft.person?.kind === "patient" ? draft.person.patientId : null}
              onChange={(next) => {
                const resident = household.residents.find((r) => r.patientRef === next);
                change({ person: resident ? { kind: "patient", patientId: resident.patientRef, sex: resident.sex } : null });
              }} />, "patient_id")}
          {showFamily && at("family",
            <Choice label="Família" options={activeFamilies.map((family) => ({ code: family.id, label: `Família de ${family.responsible.display_name ?? ""}` }))}
              value={draft.familyId} onChange={(next) => change({ familyId: next })} />, "family_id")}
        </>
      )}

      {unavailable && <Notice>{BULLETIN_UNAVAILABLE}</Notice>}
      {vectorDomains !== null && noHousehold !== null && <Muted>{BULLETIN_NEEDS_HOUSEHOLD}</Muted>}
      {vectorDomains !== null && atHousehold && <Check label="Registrar boletim" value={bulletin} onChange={toggleBulletin} />}
      {vectorOn && household !== null && (
        <InspectionSection draft={inspection} onChange={onInspection} domains={vectorDomains} propertyType={property}
          profile={facts?.profile ?? null} neighborhoodId={facts?.neighborhoodId ?? null} blocks={facts?.blocks ?? null}
          clientUuid={data.clientUuid} cleared={inspCleared} refusals={refusals} />
      )}

      <Title>Desfecho</Title>
      {vectorOn ? at("outcome",
        <Body>{inspection.situation !== null
          ? `Desfecho: ${outcomeLabel(outcomeForSituation(inspection.situation))} (da situação do imóvel)`
          : "Desfecho: escolha a situação do imóvel"}</Body>)
        : at("outcome",
          <Choice label="Desfecho da visita" options={domains.desfecho} value={draft.outcome} onChange={(next) => change({ outcome: next as VisitOutcome | null })} />)}

      {offered.length > 0 && at("reasons", (
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
      ))}
      {vectorOn && derived.length > 0 && <Muted>{`O boletim acrescenta: ${derived.map((code) => `${code} ${reasonLabel(domains, code)}`).join(", ")}`}</Muted>}

      {anyMeasure && (
        <>
          <Title>Medidas (opcionais)</Title>
          {shownMeasures.map((key) => (
            <View key={key}>{at(`measurements.${key}`,
              <Field label={MEASURE_LABEL[key]} value={draft.measurements[key]} keyboardType="decimal-pad" onChangeText={(value) => setMeasure(key, value)} />)}</View>
          ))}
          {allowed.glucose_mg_dl && at("glucose_type",
            <Choice label="Tipo da glicemia" options={domains.tipo_glicemia.map((g) => ({ code: String(g.code), label: g.label }))}
              value={draft.measurements.glucose_type === "" ? null : draft.measurements.glucose_type} onChange={(next) => setMeasure("glucose_type", next ?? "")} />,
            "measurements.glucose_type")}
        </>
      )}

      {at("shared", <YesNo label="Visita compartilhada" value={draft.shared} onChange={(next) => change({ shared: next === true })} />)}
      {at("note", <Field label="Observação" value={draft.note} multiline onChangeText={(note) => change({ note })} />)}
      <Muted>{NOTE_HINT}</Muted>
    </>
  );
  // What no field above shows goes here, before the button (the first of this save brought into sight).
  const rest = problems.filter((problem) => !placed.has(problem.path));

  return (
    <Screen title="Nova visita">
      {body}
      {notice !== null && <Notice>{notice}</Notice>}
      {cleared !== null && <Notice tone="warn">{cleared}</Notice>}
      <InSightAfter after={rest[0] === problems[0] ? rest[0] : null}>
        <View style={{ gap: SIZES.gap }}>
          {rest.map((problem) => <Notice key={problem.path + problem.text} tone="down">{problem.text}</Notice>)}
        </View>
      </InSightAfter>
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={busy === "locating" ? LOCATING : busy === "saving" ? "Salvando…" : "Registrar visita"} disabled={busy !== null} onPress={() => { void save(); }} />
    </Screen>
  );
}
