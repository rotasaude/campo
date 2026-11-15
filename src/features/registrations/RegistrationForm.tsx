// The individual registration form. A new resident: the person typed (name,
// birth, sex, mother, CPF or the reason for none, CNS) and the form's
// sections. An existing one: the sections only — who the person is is not
// changed in the app (Q47). What the api would refuse is refused here first,
// under the field; a look-alike already on the tablet is a warning the agent
// answers; a document repeated on the tablet blocks. Labels and sentences
// follow the dashboard's (modules/territory/RegistrationForm.tsx).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useServices } from "../../app/services";
import { fmtDay } from "../../rules/homeVisit";
import { createRegistryRules, type NewPatient, type PatientSex, type Problem, type RegistrationDraft } from "../../rules/registry";
import { loadReference, type Reference } from "../../sync/reference";
import { SIZES, useTheme } from "../../theme/theme";
import { Choice, YesNo } from "../../ui/choices";
import { Body, Button, Field, Muted, Notice, Screen, Title } from "../../ui/components";
import { SectionFields, dateFromScreen } from "../forms/SectionFields";
import { NOT_READY, READ_ONLY } from "../households/HouseholdForm";
import { AT_THE_DASHBOARD } from "../households/HouseholdScreen";
import { canEditRegistry, cityTodayOf, loadSession } from "../session";
import { CPF_USED_HERE, findDocumentClash, findSimilar, type SimilarPerson } from "./localDuplicates";
import { RegistrationInConflictError, saveRegistration, type RegistrationFields } from "./save";
import { readRegistration, type RegistrationView } from "./view";

export const LOOKS_LIKE = "Pode ser alguém que já está neste tablet. Confira antes de salvar.";
export const REFUSED_NOTE = "com a recusa, a ficha leva só a identificação; sociodemográfico, condições de saúde e situação de rua não vão";
export const REGISTRATION_NOT_FOUND = "Cadastro não encontrado neste tablet.";

// The patient's race/colour in the patient's own coding (the BPA's), as on the dashboard.
const RACE_COLORS = [
  { code: "01", label: "Branca" }, { code: "02", label: "Preta" }, { code: "03", label: "Parda" }, { code: "04", label: "Amarela" }, { code: "05", label: "Indígena" },
];
const INDIGENOUS = "05";
const SEXES: { code: PatientSex; label: string }[] = [{ code: "female", label: "Feminino" }, { code: "male", label: "Masculino" }];
const SECTION_TITLE = { identification: "Identificação", sociodemographic: "Sociodemográfico", health_conditions: "Condições de saúde", street_situation: "Situação de rua" } as const;

type Values = Record<string, unknown>;
interface PersonDraft { full_name: string; social_name: string; birth: string; sex: PatientSex | null; mother_name: string; cpf: string; no_cpf_reason: string | null; cns: string }
interface Draft {
  person: PersonDraft; race: string | null; ethnicity: string; refused: boolean; responsible: boolean;
  identification: Values; sociodemographic: Values; health_conditions: Values; street_situation: Values;
}
interface Loaded { reference: Reference; view: RegistrationView | null; today: string }

const digits = (text: string) => text.replace(/\D/g, "");
const squish = (text: string) => text.replace(/\s+/g, " ").trim();

export interface RegistrationFormProps {
  // Editing: the registration's local key. New: where the person lives.
  registrationKey?: string;
  householdKey?: string;
  // The family the new person enters; null when none (the head of a family yet to be registered, or nobody's).
  familyId: string | null;
  onSaved(key: string): void;
  // Opens a registration that looks like the person being typed (the form stays as it is underneath).
  onOpenExisting?(registrationKey: string): void;
}

export function RegistrationForm({ registrationKey, householdKey, familyId, onSaved, onOpenExisting }: RegistrationFormProps) {
  const { colors } = useTheme();
  const { db, crypto, now } = useServices();
  const [loaded, setLoaded] = useState<Loaded | "read_only" | "not_ready" | "missing" | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [similar, setSimilar] = useState<SimilarPerson[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Read once: a sync in the middle of the typing must not rewrite what the person sees.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!canEditRegistry(await loadSession(db))) { if (alive) setLoaded("read_only"); return; }
      const reference = await loadReference(db).catch(() => null);
      if (reference === null) { if (alive) setLoaded("not_ready"); return; }
      const view = registrationKey === undefined ? null : await readRegistration(db, registrationKey);
      if (registrationKey !== undefined && view === null) { if (alive) setLoaded("missing"); return; }
      const today = await cityTodayOf(db, now());
      if (!alive) return;
      const body = view?.body;
      setLoaded({ reference, view, today });
      setDraft({
        person: { full_name: "", social_name: "", birth: "", sex: null, mother_name: "", cpf: "", no_cpf_reason: null, cns: "" },
        race: body?.patient_demographics.race_color ?? null, ethnicity: body?.patient_demographics.ethnicity ?? "", refused: body?.refused ?? false,
        responsible: body?.is_responsible ?? false,
        identification: { ...((body?.identification ?? {}) as Values) }, sociodemographic: { ...((body?.sociodemographic ?? {}) as Values) },
        health_conditions: { ...((body?.health_conditions ?? {}) as Values) }, street_situation: { ...((body?.street_situation ?? {}) as Values) },
      });
    })();
    return () => { alive = false; };
  }, [db, now, registrationKey]);

  const reference = loaded !== null && typeof loaded === "object" ? loaded.reference : null;
  const rules = useMemo(() => (reference === null ? null : createRegistryRules(reference.dictionaries)), [reference]);
  const isNew = registrationKey === undefined;
  const title = isNew ? "Novo morador" : "Editar cadastro";

  if (loaded === null) return <Screen title={title}><Muted>Carregando…</Muted></Screen>;
  if (loaded === "read_only") return <Screen title={title}><Notice>{READ_ONLY}</Notice></Screen>;
  if (loaded === "missing") return <Screen title={title}><Notice tone="warn">{REGISTRATION_NOT_FOUND}</Notice></Screen>;
  if (loaded === "not_ready" || draft === null || rules === null || reference === null) return <Screen title={title}><Notice tone="warn">{NOT_READY}</Notice></Screen>;

  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setProblem(null); setSimilar(null); };
  const setPerson = (patch: Partial<PersonDraft>) => set({ person: { ...draft.person, ...patch } });
  const patient = loaded.view?.body.patient ?? null;
  const sex = isNew ? draft.person.sex : patient?.sex ?? null;
  const birth = isNew ? dateFromScreen(draft.person.birth) : patient?.birth_date ?? null;
  const pregnancyAsked = rules.canBePregnant(sex, birth, loaded.today);

  const typed = (): NewPatient => {
    const p = draft.person;
    return {
      full_name: squish(p.full_name), ...(p.social_name.trim() ? { social_name: squish(p.social_name) } : {}), birth_date: dateFromScreen(p.birth),
      sex: p.sex as PatientSex, ...(p.mother_name.trim() ? { mother_name: squish(p.mother_name) } : {}),
      ...(digits(p.cpf) ? { cpf: digits(p.cpf) } : {}), ...(p.no_cpf_reason ? { no_cpf_reason: p.no_cpf_reason } : {}), ...(digits(p.cns) ? { cns: digits(p.cns) } : {}),
    };
  };
  // With a refusal only the identification travels.
  const fields = (): RegistrationFields => ({
    is_responsible: draft.responsible, refused: draft.refused,
    patient_demographics: { race_color: draft.race, ethnicity: draft.race === INDIGENOUS && draft.ethnicity.trim() ? draft.ethnicity.trim() : null },
    identification: draft.identification, sociodemographic: draft.refused ? {} : draft.sociodemographic,
    health_conditions: draft.refused ? {} : draft.health_conditions,
    street_situation: draft.refused || Object.keys(draft.street_situation).length === 0 ? null : draft.street_situation,
  });

  const save = async (reviewed: boolean) => {
    const body = fields();
    const person = isNew ? typed() : null;
    const forRules = { ...body, street_situation: body.street_situation ?? undefined, ...(person ? { new_patient: person } : {}) } as RegistrationDraft;
    const found = rules.registrationProblem(forRules, loaded.today, loaded.view ? rules.patientFacts(loaded.view.body) : undefined);
    if (found) { setProblem(found); return; }
    if (person) {
      const clash = await findDocumentClash(db, { cpf: person.cpf, cns: person.cns });
      if (clash !== null) { setProblem({ path: clash === CPF_USED_HERE ? "new_patient.cpf" : "new_patient.cns", message: clash }); return; }
      if (!reviewed) {
        const alike = await findSimilar(db, { full_name: person.full_name, birth_date: person.birth_date, mother_name: person.mother_name ?? null });
        if (alike.length > 0) { setSimilar(alike); return; }
      }
    }
    setSaving(true);
    try {
      const saved = person
        ? await saveRegistration(db, {
          householdKey: householdKey ?? null, familyId, person: { kind: "new", patient: person, duplicatesReviewed: reviewed }, fields: body,
        }, { newUuid: crypto.randomUUID, now })
        : await saveRegistration(db, { key: registrationKey as string, fields: body, editBase: loaded.view?.base ?? null }, { newUuid: crypto.randomUUID, now });
      setSimilar(null);
      onSaved(saved.key);
    } catch (err) {
      setNotice(err instanceof RegistrationInConflictError ? err.message : "Não foi possível salvar. Tente de novo.");
    } finally {
      setSaving(false);
    }
  };

  const at = (key: string, path: string, children: ReactNode) => (
    <View testID={`field-${key}`} style={{ gap: 6 }}>
      {children}
      {problem?.path === path && <Text accessibilityRole="alert" style={{ fontSize: SIZES.small, color: colors.down }}>{problem.message}</Text>}
    </View>
  );
  const ownPaths = new Set([
    "new_patient.full_name", "new_patient.social_name", "new_patient.birth_date", "new_patient.sex", "new_patient.mother_name", "new_patient.cpf",
    "new_patient.no_cpf_reason", "new_patient.cns", "patient_demographics.race_color", "patient_demographics.ethnicity",
  ]);
  const inSection = problem !== null && (Object.keys(SECTION_TITLE) as string[]).some((name) => problem.path.startsWith(`${name}.`));
  const general = problem !== null && !ownPaths.has(problem.path) && !inSection ? problem.message : null;
  const noCpfReasons = (reference.dictionaries.domains.justificativa_nao_possui_cpf ?? []).map((entry) => ({ code: String(entry.code), label: entry.label }));
  const section = (name: keyof typeof SECTION_TITLE, show?: (key: string) => boolean) => (
    <>
      <Title>{SECTION_TITLE[name]}</Title>
      <SectionFields section={name} dict={reference.dictionaries} values={draft[name]} problem={problem} show={show} onChange={(next) => set({ [name]: next })} />
    </>
  );

  return (
    <Screen title={title}>
      {isNew ? (
        <>
          {at("full_name", "new_patient.full_name", <Field label="Nome completo" value={draft.person.full_name} onChangeText={(full_name) => setPerson({ full_name })} />)}
          {at("social_name", "new_patient.social_name", <Field label="Nome social" value={draft.person.social_name} onChangeText={(social_name) => setPerson({ social_name })} />)}
          {at("birth_date", "new_patient.birth_date",
            <Field label="Data de nascimento (dd/mm/aaaa)" value={draft.person.birth} keyboardType="number-pad" onChangeText={(value) => setPerson({ birth: value })} />)}
          {at("sex", "new_patient.sex", <Choice label="Sexo" options={SEXES} value={draft.person.sex} onChange={(next) => setPerson({ sex: next })} />)}
          {at("mother_name", "new_patient.mother_name", <Field label="Nome da mãe" value={draft.person.mother_name} onChangeText={(mother_name) => setPerson({ mother_name })} />)}
          {at("cpf", "new_patient.cpf", <Field label="CPF" value={draft.person.cpf} keyboardType="number-pad" onChangeText={(cpf) => setPerson({ cpf })} />)}
          {at("no_cpf_reason", "new_patient.no_cpf_reason",
            <Choice label="Motivo de não ter CPF" options={noCpfReasons} value={draft.person.no_cpf_reason} onChange={(next) => setPerson({ no_cpf_reason: next })} />)}
          {at("cns", "new_patient.cns", <Field label="CNS" value={draft.person.cns} keyboardType="number-pad" onChangeText={(cns) => setPerson({ cns })} />)}
          {familyId === null && at("is_responsible", "is_responsible",
            <YesNo label="Vai ser o responsável de uma família nova" value={draft.responsible} onChange={(next) => set({ responsible: next === true })} />)}
        </>
      ) : (
        <>
          <Body>{patient?.full_name || patient?.display_name || ""}</Body>
          {patient?.birth_date && <Body>{`Nascimento: ${fmtDay(patient.birth_date)}`}</Body>}
          <Muted>{AT_THE_DASHBOARD}</Muted>
        </>
      )}

      {at("race_color", "patient_demographics.race_color", <Choice label="Raça/cor" options={RACE_COLORS} value={draft.race} onChange={(next) => set({ race: next })} />)}
      {draft.race === INDIGENOUS && at("ethnicity", "patient_demographics.ethnicity",
        <Field label="Etnia (código)" value={draft.ethnicity} keyboardType="number-pad" onChangeText={(ethnicity) => set({ ethnicity })} />)}

      {section("identification")}
      {!draft.refused && section("sociodemographic", (key) => key !== "relacao_parentesco_cidadao" || !draft.responsible)}
      {!draft.refused && section("health_conditions", (key) => (key !== "status_eh_gestante" && key !== "maternidade_de_referencia") || pregnancyAsked)}
      {!draft.refused && section("street_situation")}

      <Title>Recusa</Title>
      {at("refused", "refused", <YesNo label="O cidadão recusou o cadastro (termo de recusa)" value={draft.refused} onChange={(next) => set({ refused: next === true })} />)}
      {draft.refused && <Muted>{REFUSED_NOTE}</Muted>}

      {similar !== null && (
        <Notice tone="warn">{LOOKS_LIKE}</Notice>
      )}
      {/* The warning names nobody (Q78): who the look-alike is, is seen in that person's own screen. */}
      {onOpenExisting && similar?.map((person, index) => (
        <Button key={person.key} label={similar.length === 1 ? "Ver cadastro parecido" : `Ver cadastro parecido ${index + 1}`} variant="secondary"
          onPress={() => onOpenExisting(person.key)} />
      ))}
      {similar !== null && <Button label="É outra pessoa: salvar" variant="secondary" disabled={saving} onPress={() => { void save(true); }} />}
      {notice !== null && <Notice tone="warn">{notice}</Notice>}
      {general !== null && <Notice tone="down">{general}</Notice>}
      <Button label={saving ? "Salvando…" : "Salvar cadastro"} disabled={saving} onPress={() => { void save(false); }} />
    </Screen>
  );
}
