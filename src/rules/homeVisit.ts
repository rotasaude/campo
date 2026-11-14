// The screen rules of the home visit, ported from the dashboard so the app's form refuses what the api would
// refuse (Q28). Origin: apps/dashboard/src/lib/homeVisits.ts, dashboard main ceb53af, the parts "Regras da
// visita" and "Rascunho, problemas e corpo da visita" — a copy adapted, with no rule changed. What changed:
// the imports; the city's clock (the dashboard reads the time zone of its session; the app has the city's
// offset, learned from the server) and the check of a typed person (from the registry rules) come in by
// createVisitRules; the types of the dashboard's API are declared here. The visit rules themselves (reasons,
// property types, ranges, limits) are read from `domains`, which the app gets in the reference. Not ported:
// API calls, cache keys, the texts of the day sheet and the api's error phrases. No message repeats what was
// typed. A future divergence between this file and the dashboard's is a defect of one of them: a card.
import type { HomeVisitDomains, MeasurementKey } from "./domains";
import type { NewPatient, PatientSex, Problem as RegistryProblem } from "./registry";

// A refusal of the visit form: where (the api's path) and the sentence. (The registry's has `message`: each as in its origin.)
export interface VisitProblem { path: string; text: string }

export type VisitOutcome = 1 | 2 | 3;
export type VisitSubject = "resident" | "family_responsible" | "none";
export interface VisitMeasurements {
  weight_kg?: number; height_cm?: number; systolic?: number; diastolic?: number; temperature_c?: number; glucose_mg_dl?: number; glucose_type?: number;
}
export interface QuickPatient {
  full_name: string; birth_date: string; sex: PatientSex; mother_name?: string | null; cpf?: string | null; no_cpf_reason?: string | null; cns?: string | null;
}
export interface VisitHousehold {
  id: string; address_short: string; property_type: string; status: "active" | "inactive"; micro_area: { id: string; code: string };
  families: { id: string; responsible: { patient_id: string; display_name: string | null; sex: PatientSex | null }; moved_out: boolean; responsible_exited: boolean }[];
  has_active_family: boolean;
}
export interface VisitHouseholdDetail extends VisitHousehold {
  residents: { patient_id: string; display_name: string | null; sex: PatientSex | null; family_id: string | null; unidentified: boolean }[];
}
export interface HomeVisitTeam {
  id: string; ine: string; name: string | null; cbo: string;
  can_register: boolean; reads_whole_team: boolean; out_of_area_allowed: boolean; can_assign: boolean; can_register_device: boolean;
  micro_areas: { id: string; code: string; name: string; scope: string }[];
  professionals: { id: string; name: string; cbo: string }[];
}
export interface HomeVisitInput {
  client_uuid: string; team_id: string; occurred_at: string; household_id?: string; micro_area_id?: string; out_of_area?: boolean;
  property_type?: string; subject: VisitSubject; patient_id?: string; new_patient?: QuickPatient; family_id?: string; duplicates_reviewed?: boolean;
  outcome: VisitOutcome; reasons: number[]; shared: boolean; measurements?: VisitMeasurements; note?: string;
}

// dd/mm/aaaa (the dashboard's careLines.fmtDay).
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// The wall time of the city ("2026-11-12T09:15") as an instant and as ISO with the city's offset. The
// dashboard's format.parseCityLocal/cityLocalIso do the same from the session's time zone.
export function parseCityLocal(value: string, offsetMin: number): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetMin * 60_000);
}
export function cityLocalIso(value: string, offsetMin: number): string | null {
  if (!parseCityLocal(value, offsetMin)) return null;
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const SHIFT: Record<string, string> = { "1": "Manhã", "2": "Tarde", "3": "Noite" };
export const reasonLabel = (domains: HomeVisitDomains, code: number): string => domains.motivo_visita.find((r) => r.code === code)?.label ?? String(code);

// ─── Regras da visita (§3), lidas de `domains` ──────────────────────────────
export const isNonResidential = (domains: HomeVisitDomains, propertyType: string): boolean => domains.non_residential_property_types.includes(propertyType);

export type OfferedReason = { code: number; label: string; group: string; group_label: string; disabled: string | null };
export const MALE_REASON_TEXT = "não se aplica a pessoa do sexo masculino";
export const FAMILY_REASON_TEXT = "com família ativa no domicílio, escolha a família";
export const REASON_NOT_OFFERED = "este motivo não vale para esta visita";

// Motivos da visita, agrupados na ordem do domínio. `subject` e `hasActiveFamily` (Q34/Q44): sem pessoa, só
// `without_person_allowed_reasons`, mais os do documento do responsável quando o domicílio não tem família ativa.
// Sem domicílio vale `hasActiveFamily: false`. `sex` é o da pessoa da ficha (o do responsável quando a visita vira da família, Q35/Q43).
export function reasonsFor(
  domains: HomeVisitDomains,
  o: { propertyType: string; outcome: VisitOutcome | null; sex: PatientSex | null; subject?: VisitSubject | null; hasActiveFamily?: boolean }
): OfferedReason[] {
  if (o.outcome !== 1) return [];
  const rows = domains.motivo_visita;
  if (isNonResidential(domains, o.propertyType)) {
    return rows.filter((r) => domains.non_residential_reasons.includes(r.code)).map((r) => ({ ...r, disabled: null }));
  }
  if (o.subject === "none") {
    const document = domains.responsible_document_reasons;
    return rows.flatMap((r): OfferedReason[] => {
      if (domains.without_person_allowed_reasons.includes(r.code)) return [ { ...r, disabled: null } ];
      if (!document.includes(r.code)) return [];
      return [ { ...r, disabled: o.hasActiveFamily ? FAMILY_REASON_TEXT : null } ];
    });
  }
  return rows.map((r) => ({ ...r, disabled: o.sex === "male" && domains.male_forbidden_reasons.includes(r.code) ? MALE_REASON_TEXT : null }));
}

const MEASUREMENT_KEYS: MeasurementKey[] = [ "weight_kg", "height_cm", "systolic", "diastolic", "temperature_c", "glucose_mg_dl" ];
export type MeasureDraft = Record<MeasurementKey | "glucose_type", string>;
export const EMPTY_MEASURES: MeasureDraft = { weight_kg: "", height_cm: "", systolic: "", diastolic: "", temperature_c: "", glucose_mg_dl: "", glucose_type: "" };
const MEASURE_LABEL: Record<MeasurementKey | "glucose_type", string> = {
  weight_kg: "peso (kg)", height_cm: "altura (cm)", systolic: "pressão sistólica", diastolic: "pressão diastólica", temperature_c: "temperatura (°C)",
  glucose_mg_dl: "glicemia (mg/dL)", glucose_type: "tipo da glicemia"
};
const WITHOUT_PERSON_NO_MEASURES: MeasurementKey[] = [ "weight_kg", "height_cm" ];

// Q34: por chave. Só visita realizada em imóvel residencial leva medida; sem pessoa, nunca peso e altura.
export function measurementsAllowed(
  domains: HomeVisitDomains, o: { propertyType: string; outcome: VisitOutcome | null; subject?: VisitSubject | null }
): Record<MeasurementKey, boolean> {
  const open = o.outcome === 1 && !isNonResidential(domains, o.propertyType);
  return Object.fromEntries(MEASUREMENT_KEYS.map((k) => [ k, open && !(o.subject === "none" && WITHOUT_PERSON_NO_MEASURES.includes(k)) ])) as Record<MeasurementKey, boolean>;
}
export const measurementsAnyAllowed = (allowed: Record<MeasurementKey, boolean>): boolean => Object.values(allowed).some(Boolean);

// Vírgula ou ponto; "" = null (sem medida); fora do formato = undefined.
export function parseMeasure(raw: string): number | null | undefined {
  const s = raw.trim();
  if (s === "") return null;
  return /^\d+([.,]\d+)?$/.test(s) ? Number(s.replace(",", ".")) : undefined;
}
const decimalsOf = (raw: string): number => (raw.trim().replace(",", ".").split(".")[1] ?? "").replace(/0+$/, "").length;
const filled = (raw: string | undefined): boolean => (raw ?? "").trim() !== "";
const rangeText = (min: number, max: number): string => `de ${String(min).replace(".", ",")} a ${String(max).replace(".", ",")}`;

// Faixa, casas (a tela recusa o excesso que o api arredondaria, Q72) e os pares pressão e glicemia.
// A atividade coletiva passa só as faixas de peso e altura (as outras chaves vêm em branco e não são lidas).
export function measurementsProblems(
  domains: { measurement_ranges: Partial<HomeVisitDomains["measurement_ranges"]>; tipo_glicemia?: HomeVisitDomains["tipo_glicemia"] }, m: MeasureDraft
): VisitProblem[] {
  const out: VisitProblem[] = [];
  const at = (key: MeasurementKey | "glucose_type", text: string) => out.push({ path: `measurements.${key}`, text });
  for (const key of MEASUREMENT_KEYS) {
    if (!filled(m[key])) continue;
    const range = domains.measurement_ranges[key];
    const value = parseMeasure(m[key]);
    if (value === null || value === undefined) { at(key, `${MEASURE_LABEL[key]}: informe um número`); continue; }
    if (!range) continue;
    if (value < range.min || value > range.max) { at(key, `${MEASURE_LABEL[key]}: ${rangeText(range.min, range.max)}`); continue; }
    if (decimalsOf(m[key]) > range.decimals) {
      at(key, range.decimals === 0 ? `${MEASURE_LABEL[key]}: só número inteiro` : `${MEASURE_LABEL[key]}: até ${range.decimals} ${range.decimals === 1 ? "casa decimal" : "casas decimais"}`);
    }
  }
  if (filled(m.systolic) && !filled(m.diastolic)) at("diastolic", "informe também a pressão diastólica");
  if (filled(m.diastolic) && !filled(m.systolic)) at("systolic", "informe também a pressão sistólica");
  if (filled(m.glucose_mg_dl) && !filled(m.glucose_type)) at("glucose_type", "escolha o tipo da glicemia");
  if (filled(m.glucose_type)) {
    if (!filled(m.glucose_mg_dl)) at("glucose_mg_dl", "informe também a glicemia");
    if (!(domains.tipo_glicemia ?? []).some((g) => String(g.code) === m.glucose_type.trim())) at("glucose_type", "escolha o tipo da glicemia da lista");
  }
  return out;
}

// O turno nunca vai no corpo (o api o calcula pela hora); isto só mostra "Manhã/Tarde/Noite" ao lado da hora.
export function shiftPreview(time: string): string | null {
  const m = /^(\d{2}):\d{2}$/.exec(time);
  if (!m) return null;
  const hour = Number(m[1]);
  return SHIFT[hour < 12 ? "1" : hour < 18 ? "2" : "3"] ?? null;
}

// ─── Rascunho, problemas e corpo da visita ──────────────────────────────────
export type VisitPlace =
  | { kind: "household"; householdId: string; propertyType: string; microAreaId: string | null }
  | { kind: "no_household"; propertyType: string; microAreaId: string | null; outOfArea: boolean };
export type VisitPerson =
  | { kind: "patient"; patientId: string; sex: PatientSex | null }
  | { kind: "new"; patient: QuickPatient; duplicatesReviewed: boolean };
export interface VisitDraft {
  day: string; time: string; place: VisitPlace | null; subject: VisitSubject | null; person: VisitPerson | null; familyId: string | null;
  outcome: VisitOutcome | null; reasons: number[]; shared: boolean; measurements: MeasureDraft; note: string;
}
export const emptyVisitDraft = (): VisitDraft => ({
  day: "", time: "", place: null, subject: null, person: null, familyId: null, outcome: null, reasons: [], shared: false,
  measurements: { ...EMPTY_MEASURES }, note: ""
});

// Domicílio como a tela o tem: com `residents` (detalhe) a conversão em família é conhecida; sem eles, não.
export type DraftHousehold = VisitHousehold & { residents?: VisitHouseholdDetail["residents"] };

const NO_PERSON_TEXT = "imóvel não residencial não leva dados de pessoa";
const propertyOf = (draft: VisitDraft, household?: DraftHousehold | null): string => household?.property_type ?? draft.place?.propertyType ?? "";
const isResidential = (domains: HomeVisitDomains, propertyType: string): boolean => propertyType !== "" && !isNonResidential(domains, propertyType);

type Conversion = { kind: "family"; sex: PatientSex | null } | { kind: "without_family" };
// Q43/Q51 (record.rb `family_visit`): morador com motivo 29/34–37 em imóvel residencial vira visita da FAMÍLIA dele (ativa neste
// domicílio) ou, sem ela, visita sem pessoa (a pessoa digitada não é cadastrada). Sem os moradores do domicílio, desconhecido (null).
function conversionOf(domains: HomeVisitDomains, draft: VisitDraft, household?: DraftHousehold | null): Conversion | null {
  if (draft.subject !== "resident" || !draft.person || !draft.place) return null;
  if (!draft.reasons.some((r) => domains.responsible_document_reasons.includes(r))) return null;
  if (!isResidential(domains, propertyOf(draft, household))) return null;
  if (draft.person.kind === "new") return { kind: "without_family" };
  if (draft.place.kind !== "household" || !household) return { kind: "without_family" };
  if (!household.residents) return null;
  const resident = household.residents.find((r) => r.patient_id === (draft.person as { patientId: string }).patientId);
  const family = resident?.family_id ? household.families.find((f) => f.id === resident.family_id && !f.moved_out) : undefined;
  return family ? { kind: "family", sex: family.responsible.sex } : { kind: "without_family" };
}

export const FAMILY_NOTICE = "A visita será registrada para a família, no nome do responsável";
export const NO_FAMILY_NOTICE = "Sem família ativa: a visita será registrada ao imóvel";
export const TYPED_NOT_REGISTERED = "A pessoa digitada não será cadastrada";

// Aviso antes de gravar (Q43/Q51); null quando a visita fica como foi escolhida.
export function familyVisitNotice(domains: HomeVisitDomains, draft: VisitDraft, household?: DraftHousehold | null): string | null {
  const conversion = conversionOf(domains, draft, household);
  if (!conversion) return null;
  if (conversion.kind === "family") return FAMILY_NOTICE;
  return draft.person?.kind === "new" ? `${NO_FAMILY_NOTICE}. ${TYPED_NOT_REGISTERED}` : NO_FAMILY_NOTICE;
}

// O que a regra do api vê: sujeito, família ativa e o sexo da pessoa da ficha, depois da conversão.
function effective(domains: HomeVisitDomains, draft: VisitDraft, household?: DraftHousehold | null): {
  subject: VisitSubject | null; hasActiveFamily: boolean; sex: PatientSex | null
} {
  const conversion = conversionOf(domains, draft, household);
  if (conversion?.kind === "family") return { subject: "family_responsible", hasActiveFamily: true, sex: conversion.sex };
  if (conversion?.kind === "without_family") return { subject: "none", hasActiveFamily: false, sex: null };
  const hasActiveFamily = household?.has_active_family ?? false;
  if (draft.subject === "resident" && draft.person) {
    return { subject: "resident", hasActiveFamily, sex: draft.person.kind === "patient" ? draft.person.sex : draft.person.patient.sex };
  }
  if (draft.subject === "family_responsible") {
    return { subject: "family_responsible", hasActiveFamily, sex: household?.families.find((f) => f.id === draft.familyId)?.responsible.sex ?? null };
  }
  return { subject: draft.subject, hasActiveFamily, sex: null };
}

// O que a tela oferece agora, já com a conversão em família (Q43): motivos (com o porquê dos indisponíveis) e medidas por chave.
export function offeredReasons(domains: HomeVisitDomains, draft: VisitDraft, household?: DraftHousehold | null): OfferedReason[] {
  const eff = effective(domains, draft, household);
  return reasonsFor(domains, { propertyType: propertyOf(draft, household), outcome: draft.outcome, sex: eff.sex, subject: eff.subject, hasActiveFamily: eff.hasActiveFamily });
}
export function allowedMeasurements(domains: HomeVisitDomains, draft: VisitDraft, household?: DraftHousehold | null): Record<MeasurementKey, boolean> {
  return measurementsAllowed(domains, { propertyType: propertyOf(draft, household), outcome: draft.outcome, subject: effective(domains, draft, household).subject });
}

// Depois de trocar imóvel, sujeito, pessoa ou desfecho: tira o que deixou de valer (sem perguntar) e diz o quê, por rótulo
// (nunca dado pessoal). Imóvel não residencial limpa pessoa e família; motivo indisponível ou fora da oferta sai; medida
// proibida sai (o tipo da glicemia segue a glicemia).
export function pruneVisitDraft(domains: HomeVisitDomains, draft: VisitDraft, household?: DraftHousehold | null): { draft: VisitDraft; cleared: string[] } {
  const cleared: string[] = [];
  let next = draft;
  const property = propertyOf(draft, household);
  if (property !== "" && isNonResidential(domains, property) && (draft.person || draft.familyId || (draft.subject && draft.subject !== "none"))) {
    next = { ...next, subject: null, person: null, familyId: null };
    cleared.push("pessoa");
  }
  const offered = offeredReasons(domains, next, household);
  const keep = next.reasons.filter((code) => offered.some((r) => r.code === code && !r.disabled));
  if (keep.length !== next.reasons.length) {
    cleared.push(...next.reasons.filter((c) => !keep.includes(c)).map((c) => reasonLabel(domains, c)));
    next = { ...next, reasons: keep };
  }
  const allowed = allowedMeasurements(domains, next, household);
  const measures = { ...next.measurements };
  let measuresCleared = false;
  for (const key of [ ...MEASUREMENT_KEYS, "glucose_type" as const ]) {
    const ok = key === "glucose_type" ? allowed.glucose_mg_dl : allowed[key];
    if (!ok && filled(measures[key])) { measures[key] = ""; cleared.push(MEASURE_LABEL[key]); measuresCleared = true; }
  }
  if (measuresCleared) next = { ...next, measurements: measures };
  return { draft: cleared.length === 0 ? draft : next, cleared };
}
export const prunedText = (cleared: string[]): string => `Retirado por não valer para esta visita: ${cleared.join(", ")}.`;

export type VisitContext = { domains: HomeVisitDomains; today: string; minDate: string; team: HomeVisitTeam; household?: DraftHousehold | null; now?: Date };

// Code points depois do `trim` (o api conta assim).
export function textProblem(text: string, o: { min: number; max: number; path: string }): VisitProblem | null {
  const n = [ ...text.trim() ].length;
  if (n >= o.min && n <= o.max) return null;
  return { path: o.path, text: o.min > 0 ? `escreva de ${o.min} a ${o.max} caracteres` : `escreva até ${o.max} caracteres` };
}



const present = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([ , v ]) => v !== null && v !== undefined && !(typeof v === "string" && v.trim() === ""))) as Partial<T>;

// The part that depends on the city's clock and on the registry rules.
export interface VisitRulesEnv {
  // The city's offset from UTC, in minutes (−180 for UTC−3), as the server gave it.
  offsetMin: number;
  newPatientProblem(raw: NewPatient, today: string): RegistryProblem | null;
}
export type VisitRules = ReturnType<typeof createVisitRules>;

export function createVisitRules(env: VisitRulesEnv) {
  // Data e hora de parede da cidade, com o deslocamento ("2026-11-12T09:15:00-03:00"); incompleto → null.
  function occurredAt(day: string, time: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
    return cityLocalIso(`${day}T${time}`, env.offsetMin);
  }

  function quickPatientProblems(p: QuickPatient, today: string): VisitProblem[] {
    const found = env.newPatientProblem(p, today);
    return found ? [ { path: found.path, text: found.message } ] : [];
  }

  // Todas as recusas de uma vez (não para na primeira), com o `path` do api.
  function visitProblems(draft: VisitDraft, ctx: VisitContext): VisitProblem[] {
    const { domains } = ctx;
    const out: VisitProblem[] = [];
    const add = (path: string, text: string) => out.push({ path, text });

    const at = occurredAt(draft.day, draft.time);
    const moment = at ? parseCityLocal(`${draft.day}T${draft.time}`, env.offsetMin) : null;
    const outOfRange = `a data da visita vai de ${fmtDay(ctx.minDate)} até agora`;
    if (!at || !moment || draft.day < ctx.minDate || draft.day > ctx.today || moment.getTime() > (ctx.now ?? new Date()).getTime()) add("occurred_at", outOfRange);

    const place = draft.place;
    const property = propertyOf(draft, ctx.household);
    if (!place) add("household_id", "escolha o domicílio ou o imóvel sem cadastro");
    else if (place.kind === "no_household") {
      if (place.propertyType === "") add("property_type", "escolha o tipo de imóvel");
      if (!place.outOfArea && !place.microAreaId) add("micro_area_id", "escolha a microárea");
      if (place.outOfArea && !ctx.team.out_of_area_allowed) add("out_of_area", "fora de área é só para o ACS");
    }

    const nonResidential = property !== "" && isNonResidential(domains, property);
    const residential = isResidential(domains, property);
    if (nonResidential) {
      if (draft.person || (draft.subject && draft.subject !== "none")) add("subject", NO_PERSON_TEXT);
    } else if (residential) {
      if (!draft.subject) add("subject", "escolha quem foi visitado");
      else if (draft.subject === "resident" && !draft.person) add("patient_id", "escolha a pessoa visitada");
      else if (draft.subject === "family_responsible") {
        if (place?.kind !== "household") add("subject", "a visita à família precisa de um domicílio");
        else if (!draft.familyId) add("family_id", "escolha a família");
      }
      if (draft.subject === "resident" && draft.person?.kind === "new") out.push(...quickPatientProblems(draft.person.patient, ctx.today));
    }

    if (!draft.outcome) add("outcome", "escolha o desfecho");
    else if (draft.outcome !== 1) {
      if (draft.reasons.length > 0) add("reasons", "visita recusada ou ausente não leva motivo");
    } else if (property !== "") {
      const eff = effective(domains, draft, ctx.household);
      if (draft.reasons.length > domains.reasons_max) add("reasons", `no máximo ${domains.reasons_max} motivos`);
      const offered = reasonsFor(domains, { propertyType: property, outcome: 1, sex: eff.sex, subject: eff.subject, hasActiveFamily: eff.hasActiveFamily });
      draft.reasons.forEach((code, i) => {
        const row = offered.find((r) => r.code === code);
        if (draft.reasons.indexOf(code) !== i) add(`reasons[${i}]`, "motivo repetido");
        else if (!row) add(`reasons[${i}]`, REASON_NOT_OFFERED);
        else if (row.disabled) add(`reasons[${i}]`, row.disabled);
      });
    }

    if (draft.outcome) {
      const eff = effective(domains, draft, ctx.household);
      const allowed = measurementsAllowed(domains, { propertyType: property, outcome: draft.outcome, subject: eff.subject });
      const refused = new Set<string>();
      for (const key of MEASUREMENT_KEYS) {
        if (filled(draft.measurements[key]) && !allowed[key]) { add(`measurements.${key}`, "esta medida não vale para esta visita"); refused.add(key); }
      }
      if (filled(draft.measurements.glucose_type) && !allowed.glucose_mg_dl) { add("measurements.glucose_type", "esta medida não vale para esta visita"); refused.add("glucose_type"); }
      // A medida recusada sai antes de conferir faixa e par: uma causa, uma frase (sem "informe também" do par que falta).
      const rest = { ...draft.measurements };
      for (const key of refused) rest[key as keyof MeasureDraft] = "";
      out.push(...measurementsProblems(domains, rest));
    }

    const note = textProblem(draft.note, { min: 0, max: 500, path: "note" });
    if (note) out.push(note);
    return out;
  }

  // O corpo do POST /home_visits (sem `client_uuid` nem `team_id`, que a tela acrescenta). Opcional vazio não vai; com domicílio, nunca
  // imóvel nem microárea; `out_of_area` só como true; nenhum turno (o api o calcula).
  function visitBody(draft: VisitDraft): Omit<HomeVisitInput, "client_uuid" | "team_id"> {
    const place = draft.place;
    const subject: VisitSubject = draft.subject ?? "none";
    const m: VisitMeasurements = {};
    for (const key of MEASUREMENT_KEYS) {
      const v = parseMeasure(draft.measurements[key]);
      if (typeof v === "number") m[key] = v;
    }
    if (filled(draft.measurements.glucose_type)) m.glucose_type = Number(draft.measurements.glucose_type);
    const note = draft.note.trim();
    const person = draft.person;
    return {
      occurred_at: occurredAt(draft.day, draft.time) ?? "",
      ...(place?.kind === "household" ? { household_id: place.householdId } : {}),
      ...(place?.kind === "no_household" ? {
        property_type: place.propertyType, ...(place.outOfArea ? { out_of_area: true } : { micro_area_id: place.microAreaId ?? undefined })
      } : {}),
      subject,
      ...(subject === "resident" && person?.kind === "patient" ? { patient_id: person.patientId } : {}),
      ...(subject === "resident" && person?.kind === "new" ? {
        new_patient: present(person.patient) as QuickPatient, ...(person.duplicatesReviewed ? { duplicates_reviewed: true } : {})
      } : {}),
      ...(subject === "family_responsible" && draft.familyId ? { family_id: draft.familyId } : {}),
      outcome: (draft.outcome ?? 1) as VisitOutcome,
      reasons: draft.reasons,
      shared: draft.shared,
      ...(Object.keys(m).length > 0 ? { measurements: m } : {}),
      ...(note !== "" ? { note } : {})
    };
  }

  return { occurredAt, quickPatientProblems, visitProblems, visitBody };
}
