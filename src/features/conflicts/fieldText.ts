// The name of a field of a record and its value, in words: what the conflict
// screen puts side by side ("No posto" × "No tablet") and what the attention
// screen points to. A code is shown by the label of its dictionary; a point
// on the map is told in words — the coordinates are never written.
import type { ItemType, Location } from "../../contract";
import { dictLabel, type FieldSpec, type RegistrationDictionaries, type SectionKey } from "../../rules/dictionaries";
import { sectionFieldLabel } from "../../rules/labels";
import { dateToScreen, monthToScreen } from "../forms/SectionFields";
import { addressLine, pointText } from "../households/view";

const SECTION_TITLE: Record<SectionKey, string> = {
  living_conditions: "Condições de moradia", identification: "Identificação", sociodemographic: "Sociodemográfico", health_conditions: "Condições de saúde",
  street_situation: "Situação de rua",
};
const FIELD_LABEL: Record<string, string> = {
  micro_area_id: "Microárea", address: "Endereço", property_type: "Tipo de imóvel", contact_phone: "Telefone de contato", refused: "Recusa do cadastro",
  status: "Situação do domicílio", location: "Ponto do imóvel",
  income_band: "Renda familiar", members_count: "Número de membros", living_since: "Reside desde", moved_out: "Mudou-se",
  is_responsible: "Responsável pela família", patient_demographics: "Raça/cor e etnia", household_id: "Domicílio", family_id: "Família", team_id: "Equipe",
};
const RACE: Record<string, string> = { "01": "Branca", "02": "Preta", "03": "Parda", "04": "Amarela", "05": "Indígena" };
const STATUS: Record<string, string> = { active: "Ativo", inactive: "Inativo" };
export const NOT_INFORMED = "não informado";

type Values = Record<string, unknown>;
const isObject = (value: unknown): value is Values => typeof value === "object" && value !== null && !Array.isArray(value);
const isSection = (name: string): name is SectionKey => name in SECTION_TITLE;

// "section.field" → the form's question; a field of the record → its name; unknown → the path as it is.
export function fieldLabel(_type: ItemType, path: string): string {
  const dot = path.indexOf(".");
  if (dot > 0 && isSection(path.slice(0, dot))) return sectionFieldLabel(path.slice(0, dot) as SectionKey, path.slice(dot + 1));
  if (isSection(path)) return SECTION_TITLE[path];
  return FIELD_LABEL[path] ?? path;
}

const PART_LABEL: Record<string, string> = {
  "address.zip": "CEP", "address.street_type": "Tipo de logradouro", "address.street": "Logradouro", "address.number": "Número",
  "address.no_number": "Sem número", "address.complement": "Complemento", "address.neighborhood_id": "Bairro", "address.district": "Bairro",
  "address.reference": "Ponto de referência",
  full_name: "Nome completo", social_name: "Nome social", birth_date: "Data de nascimento", sex: "Sexo", mother_name: "Nome da mãe", cpf: "CPF",
  no_cpf_reason: "Motivo de não ter CPF", cns: "CNS",
  occurred_at: "Data e hora", outcome: "Desfecho", subject: "Quem foi visitado", patient_id: "Pessoa", note: "Observação", shared: "Visita compartilhada",
  held_on: "Data da atividade", shift: "Turno", activity_type: "Tipo de atividade", place_health_unit_id: "Unidade do local", place_text: "Descrição do local",
  participants_count: "Número de participantes", meeting_topics: "Temas para reunião", target_audience: "Público-alvo", health_topics: "Temas para saúde",
  health_practices: "Práticas em saúde", procedure_code: "Procedimento (SIGTAP)", professionals: "Profissionais participantes", participants: "Participantes",
  reasons: "Motivos da visita", measurements: "Medidas", reason: "Motivo da retirada", responsible: "Responsável",
};

// The field a refusal of the server points to (its `path`), in words: "participants[1].new_patient.cpf" → "Participante 2: CPF".
export function pathLabel(type: ItemType, path: string): string {
  const participant = /^participants\[(\d+)\](?:\.(.*))?$/.exec(path);
  if (participant) {
    const rest = participant[2] ? pathLabel(type, participant[2]) : "";
    return `Participante ${Number(participant[1]) + 1}${rest === "" ? "" : `: ${rest}`}`;
  }
  const typed = /^(?:new_patient|patient)\.(.+)$/.exec(path);
  if (typed) return PART_LABEL[typed[1]] ?? typed[1];
  if (path === "new_patient") return "Pessoa";
  if (PART_LABEL[path]) return PART_LABEL[path];
  const head = path.split(/[.[]/)[0];
  if (head === "location") return FIELD_LABEL.location;
  if (head !== path && !isSection(head) && PART_LABEL[head]) return PART_LABEL[head];
  return fieldLabel(type, path);
}

function specOf(dict: RegistrationDictionaries, section: SectionKey, key: string): FieldSpec | null {
  let fields = dict.sections[section];
  let spec: FieldSpec | null = null;
  for (const part of key.split(".")) {
    spec = fields.find((field) => field.key === part) ?? null;
    if (spec === null) return null;
    fields = spec.fields ?? [];
  }
  return spec;
}

function sectionValue(dict: RegistrationDictionaries, section: SectionKey, key: string, value: unknown): string {
  const spec = specOf(dict, section, key);
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (spec?.type === "code" && spec.domain) return dictLabel(dict, spec.domain, value as number);
  if (spec?.type === "codes" && spec.domain && Array.isArray(value)) return value.map((code) => dictLabel(dict, spec.domain as string, code as number)).join(", ");
  if (spec?.type === "date") return dateToScreen(value);
  if (spec?.type === "date_month") return monthToScreen(value);
  if (isObject(value)) {
    return Object.entries(value).map(([inner, v]) => `${sectionFieldLabel(section, `${key}.${inner}`)}: ${sectionValue(dict, section, `${key}.${inner}`, v)}`).join("; ");
  }
  return String(value);
}

export function valueText(type: ItemType, path: string, value: unknown, dict: RegistrationDictionaries | null, areas: ReadonlyMap<string, string> = new Map()): string {
  if (path === "location") return pointText((value ?? null) as Location | null);
  if (value === undefined || value === null || value === "") return NOT_INFORMED;
  const dot = path.indexOf(".");
  if (dot > 0 && isSection(path.slice(0, dot))) return dict === null ? String(value) : sectionValue(dict, path.slice(0, dot) as SectionKey, path.slice(dot + 1), value);
  if (isSection(path)) {
    const answered = isObject(value) ? Object.keys(value).length : 0;
    return answered === 0 ? "em branco" : answered === 1 ? "1 resposta" : `${answered} respostas`;
  }
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  switch (path) {
  case "address": {
    const a = value as Values;
    return [addressLine({ address: a }, dict), typeof a.district === "string" ? a.district : "", typeof a.zip === "string" ? `CEP ${a.zip}` : ""].filter((part) => part !== "").join(" · ");
  }
  case "property_type": return dict === null ? String(value) : dictLabel(dict, "tipo_de_imovel", value as string);
  case "income_band": return dict === null ? String(value) : dictLabel(dict, "renda_familiar", value as string);
  case "living_since": return monthToScreen(String(value).slice(0, 7));
  case "status": return STATUS[String(value)] ?? String(value);
  case "micro_area_id": return areas.get(String(value)) ?? "outra microárea";
  case "patient_demographics": {
    const d = value as { race_color?: string | null; ethnicity?: string | null };
    if (!d.race_color) return NOT_INFORMED;
    return (RACE[d.race_color] ?? d.race_color) + (d.ethnicity ? ` (etnia ${d.ethnicity})` : "");
  }
  // Ids of other records say nothing to a person.
  case "household_id": case "family_id": case "team_id": return "outro registro";
  default: return String(value);
  }
}
