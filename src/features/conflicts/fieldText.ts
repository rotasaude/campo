// The name of a field of a record and its value, in words: what the conflict
// screen puts side by side ("No posto" × "No tablet") and what the attention
// screen points to. A code is shown by the label of its dictionary; a point
// on the map is told in words — the coordinates are never written.
import type { ItemType, Location } from "../../contract";
import { dictLabel, type FieldSpec, type RegistrationDictionaries, type SectionKey } from "../../rules/dictionaries";
import { sectionFieldLabel } from "../../rules/labels";
import { dateToScreen, monthToScreen } from "../forms/SectionFields";
import { addressLine, pointText } from "../households/view";
import { COUNTERS, SECTION_TITLE as BULLETIN_TITLE } from "../visits/InspectionSection";

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

// The ovitrap items' paths (Q13(2)): household_without_block → household_id, consent_required → consent,
// ovitrap_number_taken → number, reading_not_open and ovitrap_not_active → ovitrap_id, collection_out_of_range →
// collected_on; not_found names the `<kind>_client_uuid` the item cited. The date and the condition with the dashboard's
// labels (apps/dashboard src/modules/vectorControl/{InstallForm,CollectForm}.tsx).
const OVITRAP_LABEL: Record<string, string> = {
  household_id: "Imóvel", household_client_uuid: "Imóvel", consent: "Termo (TCLE)", number: "Número",
  ovitrap_id: "Ovitrampa", ovitrap_client_uuid: "Ovitrampa", collected_on: "Data da coleta",
  installed_on: "Data da instalação", condition: "Condição da palheta",
};
const OVITRAP_ITEMS: readonly ItemType[] = ["ovitrap_installation", "ovitrap_collection"];

// The paths of the four items of the 35b, with the labels of the dashboard's forms (apps/dashboard, main 51b1871,
// src/modules/zoonoses/{AnimalForm,VaccinationForm,CollarsPanel,TestsPanel}.tsx). They are keyed by item because `status`
// and `collected_on` mean other things on the household and the ovitrap.
const ANIMAL_LABEL: Record<string, string> = {
  animal_id: "Animal", animal_client_uuid: "Animal", species: "Espécie", name: "Nome", sex: "Sexo", size: "Porte", coat: "Pelagem", breed: "Raça",
  birth_estimate_month: "Mês de nascimento (estimado)", microchip: "Microchip", tutor_patient_id: "Tutor", tutor_client_uuid: "Tutor",
  community: "Comunitário", household_id: "Domicílio", household_client_uuid: "Domicílio", status: "Nova situação",
  status_on: "Data da nova situação",
};
const VACCINATION_LABEL: Record<string, string> = {
  animal_id: "Animal", animal_client_uuid: "Animal", campaign_id: "Campanha", vaccinated_on: "Data da vacinação", vector_product_id: "Produto",
  adverse_note: "Nota do evento adverso",
};
const COLLECTION_LABEL: Record<string, string> = {
  animal_id: "Animal", animal_client_uuid: "Animal", leish_survey_id: "Inquérito", collected_on: "Data da coleta", dpp_result: "Resultado do TR-DPP",
  dpp_on: "Data do TR-DPP",
};
const COLLAR_LABEL: Record<string, string> = { animal_id: "Animal", animal_client_uuid: "Animal", vector_product_id: "Produto", placed_on: "Data da colocação" };
const ZOONOSES_LABEL: Partial<Record<ItemType, Record<string, string>>> = {
  animal: ANIMAL_LABEL, rabies_vaccination: VACCINATION_LABEL, leish_collection: COLLECTION_LABEL, collar: COLLAR_LABEL,
};

// The bulletin's paths (35a, M5 of the Task 7 review) with the labels of its section on the visit form (InspectionSection,
// copied from the dashboard): a deposit by "Depósitos" and its counter, a measure or a sample by "Medida n" / "Amostra n"
// and its field, as participants[i]. The LIRAa draw and the transmission block are refused under "Atividade", where the
// form shows them. Anything else under the bulletin is the section's name, never the raw path.
const BULLETIN = "vector_inspection";
const INSPECTION_LABEL: Record<string, string> = {
  activity: "Atividade", liraa_draw_item_id: "Atividade", transmission_block_id: "Atividade", work_type: "Tipo de trabalho",
  situation: "Situação do imóvel", entered_at: "Entrada (hh:mm)", left_at: "Saída (hh:mm)", deposits: "Depósitos",
  measures: "Medidas de controle", samples: "Amostras", educational_action: "Ação educativa", city_block_id: "Quarteirão",
  risk_class: "Risco do imóvel",
};
const DEPOSIT_LABEL: Record<string, string> = { group: "Grupo do depósito", ...Object.fromEntries(COUNTERS) };
const MEASURE_LABEL: Record<string, string> = { method: "Método", vector_product_id: "Produto", charges: "Cargas" };
const SAMPLE_LABEL: Record<string, string> = { larvae_collected: "Larvas coletadas", deposit_group: "Grupo da amostra" };

function inspectionLabel(path: string): string {
  const indexed = /^(deposits|measures|samples)\[(\d+)\](?:\.(.+))?$/.exec(path);
  if (indexed) {
    const [, list, index, field] = indexed;
    if (list === "deposits") return field && DEPOSIT_LABEL[field] ? `Depósitos: ${DEPOSIT_LABEL[field]}` : "Depósitos";
    const head = `${list === "measures" ? "Medida" : "Amostra"} ${Number(index) + 1}`;
    const inner = field ? (list === "measures" ? MEASURE_LABEL : SAMPLE_LABEL)[field] : undefined;
    return inner ? `${head}: ${inner}` : head;
  }
  return INSPECTION_LABEL[path] ?? BULLETIN_TITLE;
}

// The field a refusal of the server points to (its `path`), in words: "participants[1].new_patient.cpf" → "Participante 2: CPF".
export function pathLabel(type: ItemType, path: string): string {
  if (OVITRAP_ITEMS.includes(type)) return OVITRAP_LABEL[path] ?? path;
  const zoonoses = ZOONOSES_LABEL[type];
  if (zoonoses) return zoonoses[path] ?? path;
  if (path === BULLETIN) return BULLETIN_TITLE;
  if (path.startsWith(`${BULLETIN}.`)) return inspectionLabel(path.slice(BULLETIN.length + 1));
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
