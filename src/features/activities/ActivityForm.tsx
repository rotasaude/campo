// The collective activity form. What each activity type asks for, forbids or
// accepts comes from the reference (the rules ported from the dashboard read
// it): a list the type forbids is not on screen. Participants are found by
// name among the people on the tablet, or typed right there when they have no
// registration. A participant without a document is a warning, not a block.
// Labels and sentences are the dashboard's (modules/collectiveActivities).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useServices } from "../../app/services";
import type { RegistrationBody, SessionResponse } from "../../contract";
import {
  activityWarnings, alteredCount, createActivityRules, emptyActivityDraft, fieldRule, healthTopicsAllowed, needsProcedure, offeredHealthTopics, offeredPractices,
  pruneActivityDraft, smokingAllowed, type ActivityDraft, type CollectiveOptions, type ParticipantDraft, type VisitShift,
} from "../../rules/collectiveActivity";
import type { FieldRule } from "../../rules/domains";
import { createVisitRules, type QuickPatient, type VisitProblem } from "../../rules/homeVisit";
import { createRegistryRules, type PatientSex } from "../../rules/registry";
import { cityNowIso } from "../../sync/clock";
import { healthUnitOptions, loadReference, professionalOptions, type Reference } from "../../sync/reference";
import { normalizeText } from "../../sync/text";
import { SIZES, useTheme } from "../../theme/theme";
import { Choice, MultiChoice, YesNo } from "../../ui/choices";
import { Body, Button, Field, Muted, Notice, Screen, Title } from "../../ui/components";
import { dateFromScreen, dateToScreen } from "../forms/SectionFields";
import { NOT_READY } from "../households/HouseholdForm";
import { loadSession } from "../session";
import { saveActivity } from "./save";

export const COLLECTIVE_DISABLED = "a atividade coletiva está desligada nesta cidade";
const SHIFTS: { code: VisitShift; label: string }[] = [{ code: 1, label: "Manhã" }, { code: 2, label: "Tarde" }, { code: 3, label: "Noite" }];
const SEXES: { code: PatientSex; label: string }[] = [{ code: "female", label: "Feminino" }, { code: "male", label: "Masculino" }];
const SEARCH_MIN = 3;
const SEARCH_SHOWN = 8;

interface Person { patientId: string; name: string; search: string; hasCpf: boolean; hasCns: boolean }
interface Loaded { session: SessionResponse; reference: Reference; today: string; people: Person[]; offsetMin: number }
interface QuickDraft { full_name: string; birth: string; sex: PatientSex | null; mother_name: string; cpf: string; no_cpf_reason: string | null; cns: string }
const EMPTY_QUICK: QuickDraft = { full_name: "", birth: "", sex: null, mother_name: "", cpf: "", no_cpf_reason: null, cns: "" };

const digits = (text: string) => text.replace(/\D/g, "");
const squish = (text: string) => text.replace(/\s+/g, " ").trim();
const withRule = (label: string, rule: FieldRule) => (rule === "required" ? `${label} (obrigatório)` : label);
const nameOf = (p: ParticipantDraft) => (p.kind === "patient" ? p.displayName ?? "" : p.patient.full_name);

export function ActivityForm({ onSaved }: { onSaved(): void }) {
  const { colors } = useTheme();
  const { db, crypto, now } = useServices();
  const [loaded, setLoaded] = useState<Loaded | "off" | "not_ready" | null>(null);
  const [draft, setDraft] = useState<ActivityDraft | null>(null);
  const [problems, setProblems] = useState<VisitProblem[]>([]);
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState<QuickDraft | null>(null);
  const [quickProblems, setQuickProblems] = useState<VisitProblem[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  // Read once: a sync in the middle of the typing must not rewrite what the person sees.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const session = await loadSession(db);
      if (session === null || session.features.collective_activities !== true) { if (alive) setLoaded("off"); return; }
      const reference = await loadReference(db).catch(() => null);
      if (reference === null) { if (alive) setLoaded("not_ready"); return; }
      const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('city_offset_min', 'clock_skew_ms')")).map((row) => [row.key, row.value]));
      const offsetMin = Number(meta.get("city_offset_min") ?? 0) || 0;
      const nowIso = cityNowIso(now(), Number(meta.get("clock_skew_ms") ?? 0) || 0, offsetMin);
      const people = (await db.all<{ body: string; name_norm: string }>("SELECT body, name_norm FROM registrations ORDER BY name_norm")).map((row) => {
        const patient = (JSON.parse(row.body) as RegistrationBody).patient;
        return { patientId: patient.id, name: patient.display_name, search: row.name_norm, hasCpf: patient.has_cpf, hasCns: patient.cns_masked !== null };
      });
      if (!alive) return;
      const hour = Number(nowIso.slice(11, 13));
      setLoaded({ session, reference, today: nowIso.slice(0, 10), people, offsetMin });
      setDraft({ ...emptyActivityDraft(nowIso.slice(0, 10)), teamId: session.teams.length === 1 ? session.teams[0].id : null, shift: hour < 12 ? 1 : hour < 18 ? 2 : 3 });
    })();
    return () => { alive = false; };
  }, [db, now]);

  const data = loaded !== null && typeof loaded === "object" ? loaded : null;
  const rules = useMemo(() => {
    if (data === null) return null;
    const visit = createVisitRules({ offsetMin: data.offsetMin, newPatientProblem: createRegistryRules(data.reference.dictionaries).newPatientProblem });
    return { quickPatientProblems: visit.quickPatientProblems, ...createActivityRules({ quickPatientProblems: visit.quickPatientProblems }) };
  }, [data]);

  if (loaded === null) return <Screen title="Nova atividade coletiva"><Muted>Carregando…</Muted></Screen>;
  if (loaded === "off") return <Screen title="Nova atividade coletiva"><Notice>{COLLECTIVE_DISABLED}</Notice></Screen>;
  if (data === null || draft === null || rules === null) return <Screen title="Nova atividade coletiva"><Notice tone="warn">{NOT_READY}</Notice></Screen>;

  const domains = data.reference.collectiveDomains;
  const type = draft.activityType;
  // The type decides what the activity may carry: what it forbids leaves the draft with the change.
  const change = (patch: Partial<ActivityDraft>) => { setDraft(pruneActivityDraft(domains, { ...draft, ...patch })); setProblems([]); };
  const patchParticipant = (index: number, patch: Partial<ParticipantDraft>) =>
    change({ participants: draft.participants.map((p, i) => (i === index ? ({ ...p, ...patch } as ParticipantDraft) : p)) });
  const options: CollectiveOptions = {
    today: data.today, min_date: data.session.min_date, domains,
    teams: data.session.teams.map((team) => ({
      id: team.id, ine: team.ine, name: team.name, cbo: data.session.professional.cbo, can_register: true,
      // Whoever registers is the activity's header, never one of the professionals who took part (the api refuses it;
      // the dashboard takes them out on the server). The reference carries the whole team, this person included.
      professionals: professionalOptions(data.reference, team.id)
        .filter((p) => p.id !== data.session.professional.id)
        .map((p) => ({ ...p, in_team: true })),
    })),
    units: healthUnitOptions(data.reference).map((unit) => ({ id: unit.id, name: unit.name, has_cnes: unit.has_cnes })),
  };
  const team = options.teams.find((t) => t.id === draft.teamId) ?? null;
  const participantsRule = fieldRule(domains, type, "participants");
  const smoking = smokingAllowed(domains, draft.healthPractices);
  const warnings = activityWarnings(draft);
  const wanted = normalizeText(query);
  const found = wanted.length < SEARCH_MIN ? [] : data.people
    .filter((person) => person.search.includes(wanted) && !draft.participants.some((p) => p.kind === "patient" && p.patientId === person.patientId))
    .slice(0, SEARCH_SHOWN);

  const addQuick = () => {
    if (quick === null) return;
    const patient: QuickPatient = {
      full_name: squish(quick.full_name), birth_date: dateFromScreen(quick.birth), sex: quick.sex as PatientSex,
      ...(quick.mother_name.trim() ? { mother_name: squish(quick.mother_name) } : {}), ...(digits(quick.cpf) ? { cpf: digits(quick.cpf) } : {}),
      ...(quick.no_cpf_reason ? { no_cpf_reason: quick.no_cpf_reason } : {}), ...(digits(quick.cns) ? { cns: digits(quick.cns) } : {}),
    };
    const refused = rules.quickPatientProblems(patient, data.today);
    if (refused.length > 0) { setQuickProblems(refused); return; }
    change({ participants: [...draft.participants, { kind: "new", patient, duplicatesReviewed: false, altered: false, weight: "", height: "", smoking: null }] });
    setQuick(null);
    setQuickProblems([]);
  };

  const save = async () => {
    const refused = rules.activityProblems(draft, { options, today: data.today });
    if (refused.length > 0) { setProblems(refused); return; }
    setSaving(true);
    setFailed(false);
    try {
      await saveActivity(db, draft, { domains, newUuid: crypto.randomUUID, now });
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const at = (key: string, children: ReactNode) => <View testID={`field-${key}`} style={{ gap: 6 }}>{children}</View>;
  const list = (label: string, rule: FieldRule, codes: { code: number; label: string }[], value: number[], set: (next: number[]) => void) =>
    (rule === "forbidden" ? null : <MultiChoice label={withRule(label, rule)} showAll options={codes} value={value} onChange={set} />);
  const noCpfReasons = (data.reference.dictionaries.domains.justificativa_nao_possui_cpf ?? []).map((entry) => ({ code: String(entry.code), label: entry.label }));
  const card = { gap: 6, padding: SIZES.gap, borderRadius: SIZES.radius, borderWidth: 1, borderColor: colors.rule, backgroundColor: colors.panel } as const;

  return (
    <Screen title="Nova atividade coletiva">
      {options.teams.length > 1 && at("team",
        <Choice label="Equipe" options={options.teams.map((t) => ({ code: t.id, label: t.name ?? t.ine }))} value={draft.teamId} onChange={(next) => change({ teamId: next, professionals: [] })} />)}
      <Field label="Data da atividade (dd/mm/aaaa)" value={dateToScreen(draft.heldOn)} keyboardType="number-pad" onChangeText={(text) => change({ heldOn: dateFromScreen(text) })} />
      {at("shift", <Choice label="Turno" options={SHIFTS} value={draft.shift} onChange={(next) => change({ shift: next })} />)}
      {at("activity_type", <Choice label="Tipo de atividade" options={domains.activity_types} value={type} onChange={(next) => change({ activityType: next })} />)}

      <Title>Local</Title>
      {at("place_kind",
        <Choice label="Onde foi" value={draft.place.kind} options={[{ code: "unit" as const, label: "Unidade" }, { code: "text" as const, label: "Outro local" }]}
          onChange={(next) => change({ place: next === "text" ? { kind: "text", text: "" } : { kind: "unit", unitId: null } })} />)}
      {draft.place.kind === "unit"
        ? at("unit", <Choice label="Unidade do local" options={options.units.map((unit) => ({ code: unit.id, label: unit.name }))} value={draft.place.unitId}
          onChange={(next) => change({ place: { kind: "unit", unitId: next } })} />)
        : <Field label="Descrição do local" value={draft.place.text} onChangeText={(text) => change({ place: { kind: "text", text } })} />}

      <Field label="Número de participantes" value={draft.participantsCount} keyboardType="number-pad" onChangeText={(participantsCount) => change({ participantsCount })} />
      {participantsRule !== "forbidden" && <Muted>{`Avaliações alteradas (calculado pela lista): ${alteredCount(draft)}`}</Muted>}

      {list("Temas para reunião", fieldRule(domains, type, "meeting_topics"), domains.meeting_topics, draft.meetingTopics, (meetingTopics) => change({ meetingTopics }))}
      {list("Público-alvo", fieldRule(domains, type, "target_audience"), domains.target_audience, draft.targetAudience, (targetAudience) => change({ targetAudience }))}
      {list("Temas para saúde", healthTopicsAllowed(domains, draft), offeredHealthTopics(domains, draft), draft.healthTopics, (healthTopics) => change({ healthTopics }))}
      {list("Práticas em saúde", fieldRule(domains, type, "health_practices"), offeredPractices(domains, type), draft.healthPractices, (healthPractices) => change({ healthPractices }))}
      {needsProcedure(domains, draft.healthPractices) && at("procedure",
        <Choice label="Procedimento (SIGTAP)" options={domains.procedures.map((p) => ({ code: p.code, label: `${p.code} — ${p.label}` }))}
          value={draft.procedureCode === "" ? null : draft.procedureCode} onChange={(next) => change({ procedureCode: next ?? "" })} />)}

      {team !== null && (team.professionals.length === 0
        ? <Muted>Nenhum outro profissional nesta equipe.</Muted>
        : <MultiChoice label="Profissionais participantes" showAll value={draft.professionals}
          options={team.professionals.map((p) => ({ code: p.id, label: p.has_cns ? p.name : `${p.name} — sem CNS no cadastro` }))}
          onChange={(professionals) => change({ professionals })} />)}

      {participantsRule !== "forbidden" && (
        <>
          <Title>{withRule("Participantes", participantsRule)}</Title>
          {draft.participants.length === 0 && <Muted>Nenhum participante na lista.</Muted>}
          {draft.participants.map((p, index) => {
            const warning = warnings.find((w) => w.path === `participants[${index}]`);
            return (
              <View key={`${index}-${nameOf(p)}`} testID={`participant-${index}`} style={card}>
                <Body>{nameOf(p)}</Body>
                {warning && <Muted>{warning.text}</Muted>}
                {at(`altered-${index}`, <YesNo label="Avaliação alterada" value={p.altered} onChange={(next) => patchParticipant(index, { altered: next === true })} />)}
                <Field label="Peso (kg)" value={p.weight} keyboardType="decimal-pad" onChangeText={(weight) => patchParticipant(index, { weight })} />
                <Field label="Altura (cm)" value={p.height} keyboardType="decimal-pad" onChangeText={(height) => patchParticipant(index, { height })} />
                {smoking && (
                  <>
                    <YesNo label="Cessou o hábito de fumar" value={p.smoking?.quit ?? false}
                      onChange={(next) => patchParticipant(index, { smoking: { quit: next === true, dropped_out: p.smoking?.dropped_out ?? false } })} />
                    <YesNo label="Abandonou o grupo" value={p.smoking?.dropped_out ?? false}
                      onChange={(next) => patchParticipant(index, { smoking: { quit: p.smoking?.quit ?? false, dropped_out: next === true } })} />
                  </>
                )}
                <Button label="Remover" variant="secondary" onPress={() => change({ participants: draft.participants.filter((_, i) => i !== index) })} />
              </View>
            );
          })}
          <Field label="Buscar participante pelo nome" value={query} autoCorrect={false} onChangeText={setQuery} />
          {found.map((person) => (
            <Button key={person.patientId} label={`Adicionar ${person.name}`} variant="secondary" onPress={() => {
              change({ participants: [...draft.participants, {
                kind: "patient", patientId: person.patientId, displayName: person.name, hasCpf: person.hasCpf, hasCns: person.hasCns, altered: false, weight: "", height: "", smoking: null,
              }] });
              setQuery("");
            }} />
          ))}
          {quick === null
            ? <Button label="Pessoa sem cadastro" variant="secondary" onPress={() => { setQuick(EMPTY_QUICK); setQuickProblems([]); }} />
            : (
              <View style={card}>
                <Field label="Nome completo" value={quick.full_name} onChangeText={(full_name) => setQuick({ ...quick, full_name })} />
                <Field label="Data de nascimento (dd/mm/aaaa)" value={quick.birth} keyboardType="number-pad" onChangeText={(birth) => setQuick({ ...quick, birth })} />
                {at("quick-sex", <Choice label="Sexo" options={SEXES} value={quick.sex} onChange={(sex) => setQuick({ ...quick, sex })} />)}
                <Field label="Nome da mãe" value={quick.mother_name} onChangeText={(mother_name) => setQuick({ ...quick, mother_name })} />
                <Field label="CPF" value={quick.cpf} keyboardType="number-pad" onChangeText={(cpf) => setQuick({ ...quick, cpf })} />
                {at("quick-no_cpf_reason",
                  <Choice label="Motivo de não ter CPF" options={noCpfReasons} value={quick.no_cpf_reason} onChange={(no_cpf_reason) => setQuick({ ...quick, no_cpf_reason })} />)}
                <Field label="CNS" value={quick.cns} keyboardType="number-pad" onChangeText={(cns) => setQuick({ ...quick, cns })} />
                {quickProblems.map((problem) => <Notice key={problem.path} tone="down">{problem.text}</Notice>)}
                <Button label="Adicionar à lista" onPress={addQuick} />
                <Button label="Cancelar" variant="secondary" onPress={() => { setQuick(null); setQuickProblems([]); }} />
              </View>
            )}
        </>
      )}

      {warnings.filter((w) => w.path === "participants").map((w) => <Notice key={w.text} tone="warn">{w.text}</Notice>)}
      <View style={{ gap: SIZES.gap }}>
        {[...new Map(problems.map((problem) => [problem.text, problem])).values()].map((problem) => <Notice key={problem.path} tone="down">{problem.text}</Notice>)}
      </View>
      {failed && <Notice tone="down">Não foi possível salvar. Tente de novo.</Notice>}
      <Button label={saving ? "Salvando…" : "Registrar atividade"} disabled={saving} onPress={() => { void save(); }} />
    </Screen>
  );
}
