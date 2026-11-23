// One phrase per code of the contract (errors.http and errors.item of
// domains-v1.json). A phrase never carries a value: not the name, not the
// number typed, not a coordinate. The test fails when the contract gains a
// code that has no phrase here.
import type { ItemType } from "../../contract";
import { VECTOR_ERRORS } from "../../rules/vectorErrors";
import { AGENT_PROPERTY_TYPES } from "../session";

const CHECK_FIELD = "Confira o campo destacado.";

export const ERROR_PHRASES: Record<string, string> = {
  // ── errors.http ────────────────────────────────────────────────────────
  invalid_token: "Acesso suspenso: procure o enfermeiro da equipe ou leia o QR novo.",
  device_suspended: "Acesso suspenso: procure o enfermeiro da equipe ou leia o QR novo.",
  device_revoked: "Este aparelho foi revogado. Os dados do tablet foram apagados; cadastre o aparelho de novo no dashboard.",
  feature_disabled: "A visita domiciliar pelo app está desligada nesta cidade. Seus registros ficam guardados no tablet.",
  invalid_request: "O Rota Saúde não entendeu o envio. Atualize o app e tente de novo.",
  invalid_cursor: "A lista mudou no Rota Saúde. O tablet vai baixar tudo de novo.",
  invalid_limit: "O Rota Saúde não entendeu o pedido de download. Atualize o app e tente de novo.",
  too_many_requests: "Muitos envios em pouco tempo. O tablet tenta de novo em alguns minutos.",
  payload_too_large: "O envio ficou grande demais. Reduza o texto das observações.",
  json_required: "O Rota Saúde não entendeu o envio. Atualize o app e tente de novo.",
  map_not_found: "O mapa desta cidade ainda não foi gerado. O app funciona sem o mapa; avise o enfermeiro da equipe.",
  range_not_satisfiable: "O mapa mudou no Rota Saúde. O download recomeça do início.",
  unknown_city: "O Rota Saúde não reconhece o endereço desta cidade. Gere um QR novo no dashboard.",
  city_suspended: "O Rota Saúde está suspenso nesta cidade. Seus registros ficam guardados no tablet.",
  city_schema_behind: "O Rota Saúde está em atualização nesta cidade. O tablet tenta de novo em alguns minutos.",

  // ── errors.item ────────────────────────────────────────────────────────
  client_uuid_conflict: "Este registro já foi enviado com outro conteúdo. Confira os dados e grave de novo.",
  not_found: "O Rota Saúde não encontrou este registro. Sincronize e confira se ele ainda existe.",
  cbo_not_allowed: "Seu CBO não permite este registro.",
  out_of_scope: "Esta microárea não está mais no seu território.",
  invalid_home_visit: CHECK_FIELD,
  visit_date_out_of_range: "A data da visita está fora do período aceito. Confira a data.",
  non_residential_with_person: "Imóvel que não é domicílio não leva pessoa na visita.",
  reasons_forbidden: "Visita recusada ou com morador ausente não leva motivo.",
  reason_not_allowed: "Um dos motivos não vale para esta visita.",
  measurements_forbidden: "Esta medida não vale para esta visita.",
  patient_in_other_household: "Esta pessoa tem cadastro ativo em outro domicílio. Visite-a por lá.",
  family_without_responsible: "A família está sem responsável ativo. Escolha a pessoa moradora.",
  day_closed: "A folha deste dia já foi fechada. A visita não pode mais ser retirada.",
  visit_changed: "Esta visita mudou no Rota Saúde. Sincronize e confira.",
  invalid_collective_activity: CHECK_FIELD,
  activity_date_out_of_range: "A data da atividade está fora do período aceito. Confira a data.",
  duplicate_participant: "A mesma pessoa aparece duas vezes na atividade.",
  professional_without_cns: "Seu CNS não está no cadastro de profissionais. Procure o enfermeiro da equipe.",
  patient_unidentified: "Pessoa com cadastro provisório da urgência não pode ser registrada aqui. Ela precisa ser identificada no posto antes.",
  duplicate_suspected: "Pode ser que esta pessoa já tenha cadastro. Confira as pessoas parecidas antes de continuar.",
  cpf_taken: "Este CPF já pertence a outra pessoa. Confira o número.",
  cns_taken: "Este CNS já pertence a outra pessoa. Confira o número.",
  invalid_household: CHECK_FIELD,
  invalid_family: CHECK_FIELD,
  invalid_registration: CHECK_FIELD,
  cpf_or_reason_required: "Informe o CPF ou o motivo de não ter CPF.",
  already_registered: "Esta pessoa já tem cadastro individual ativo. Abra o cadastro dela para atualizar.",
  identity_locked: "A identidade desta pessoa já foi validada no posto e não se altera pelo app.",
  address_from_household: "O endereço desta pessoa vem do cadastro domiciliar. Altere pelo domicílio.",
  invalid_ethnicity: "Etnia inválida: só vale com raça/cor indígena e com um código da lista.",
  citizen_not_verified: "Este CPF tem cadastro feito pelo próprio cidadão, ainda sem validação no posto. A identidade precisa ser validada antes.",
  invalid_transition: "Esta ação não vale para a situação atual do cadastro (já saiu ou recusou).",
  household_inactive: "O domicílio está inativo. Escolha outro ou registre o imóvel sem cadastro.",
  family_moved_out: "A família se mudou do domicílio. Escolha outra pessoa.",
  micro_area_inactive: "A microárea está inativa.",
  invalid_cpf: "CPF inválido: confira os 11 dígitos.",
  invalid_cns: "CNS inválido: confira os 15 dígitos.",
  invalid_patient: "Confira o campo destacado da pessoa.",
  internal_error: "O Rota Saúde teve um erro ao gravar este registro. O tablet guarda o registro; tente enviar de novo mais tarde.",
  household_changed: "O domicílio mudou no Rota Saúde depois deste cadastro. Sincronize e confira o domicílio.",
  invalid_location: "Ponto inválido. Marque de novo no mapa ou leia o GPS outra vez.",
  family_not_found: "O Rota Saúde não encontrou a família deste registro. Sincronize e escolha a família de novo.",

  // ── errors.item of the 35a (field-sync v1.3.0) ────────────────────────────
  // The dashboard's phrases (src/rules/vectorErrors.ts), copied, never written here (Q9): lowercase, no period, as there.
  vector_inspection_invalid: VECTOR_ERRORS.vector_inspection_invalid,
  situation_outcome_mismatch: VECTOR_ERRORS.situation_outcome_mismatch,
  inspection_not_worked: VECTOR_ERRORS.inspection_not_worked,
  activity_property_mismatch: VECTOR_ERRORS.activity_property_mismatch,
  liraa_item_not_found: VECTOR_ERRORS.liraa_item_not_found,
  transmission_block_not_active: VECTOR_ERRORS.transmission_block_not_active,
  deposit_counts_inconsistent: VECTOR_ERRORS.deposit_counts_inconsistent,
  product_not_allowed: VECTOR_ERRORS.product_not_allowed,
  samples_exceed_larvae: VECTOR_ERRORS.samples_exceed_larvae,
  inspection_times_invalid: VECTOR_ERRORS.inspection_times_invalid,
  reason_derived: VECTOR_ERRORS.reason_derived,
  block_already_set: VECTOR_ERRORS.block_already_set,
  household_without_neighborhood: VECTOR_ERRORS.household_without_neighborhood,
  block_not_in_household_neighborhood: VECTOR_ERRORS.block_not_in_household_neighborhood,
  household_without_block: VECTOR_ERRORS.household_without_block,
  consent_required: VECTOR_ERRORS.consent_required,
  ovitrap_number_taken: VECTOR_ERRORS.ovitrap_number_taken,
  collection_out_of_range: VECTOR_ERRORS.collection_out_of_range,
  reading_not_open: VECTOR_ERRORS.reading_not_open,
  ovitrap_not_active: VECTOR_ERRORS.ovitrap_not_active,
  sample_label_taken: VECTOR_ERRORS.sample_label_taken,
};

// Codes the 35a items share with the 24c (registry, home visit, HTTP): the table is keyed by code alone, so they keep
// the 24c phrase above and not the VECTOR_ERRORS one (the screens show VECTOR_ERRORS for their own checks). Read by the
// spec only: it pins the list, so that a code new in both tables has its phrase chosen, never taken by accident.
export const SHARED_24C_CODES: readonly string[] = ["cbo_not_allowed", "feature_disabled", "invalid_transition"];

// The code is a contract identifier (letters, digits, underscore): anything else is not echoed.
const CODE = /^[a-z0-9_]{1,64}$/;

export function phraseFor(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_PHRASES, code)) return ERROR_PHRASES[code];
  const shown = code && CODE.test(code) ? code : "desconhecido";
  return `O Rota Saúde recusou este registro (código ${shown}). Fale com o enfermeiro da equipe.`;
}

const VECTOR_ITEMS: readonly ItemType[] = ["ovitrap_installation", "ovitrap_collection"];
const BULLETIN = "vector_inspection";

// The phrase of an item the server refused, read by the item it came on (review of Task 6). A code the 35a shares with
// the 24c (SHARED_24C_CODES) says the dashboard's VECTOR_ERRORS phrase when it is about the 35a: on an ovitrap item, or
// on a home_visit refused at its bulletin (`path` vector_inspection or under it). The same code on a home_visit with
// no path is the 24b's (its own cbo_not_allowed and feature_disabled), and invalid_transition is always the 24c's
// (the field sync sends it only for the registry). The 403 of the whole request is not an item: phraseFor. `context`
// (Q54) changes only the agent's household cbo_not_allowed; without it, or for anybody else, nothing changes.
// The dashboard's phrases for the endemic agent's household (apps/dashboard src/lib/territoryRegistry.ts, commit 0b98ddd,
// AGENT_CBO_NOT_ALLOWED and AGENT_HAS_RESIDENT), byte for byte (Q54).
export const AGENT_CBO_NOT_ALLOWED = "só o ACS da microárea, enfermeiro ou médico da equipe grava o cadastro — o agente de endemias, só imóvel não residencial";
export const AGENT_HAS_RESIDENT = "este imóvel tem morador ativo; só a equipe da APS edita";

// What the tablet knows of a refused item beyond its code and path (Q54): whether the endemic agent sent it, the property
// types (the one sent and the one the household has now) and whether the household has an active resident here.
export interface ItemContext { agent: boolean; propertyTypes: readonly (string | null)[]; hasResident: boolean }

// The api refuses the agent's household with cbo_not_allowed and no path both for a residential type (Access.endemic_scope,
// checked first) and for a non-residential property with an active resident (SaveHousehold#write). A residential type,
// sent or current, is the type; else a resident on the tablet is the resident; else the type's phrase. Not the
// dashboard's "every refusal on edit is the resident": offline, the clinic changing the type is the typical case.
function agentHouseholdRefusal(context: ItemContext): string {
  const residential = context.propertyTypes.some((type) => type !== null && !(AGENT_PROPERTY_TYPES as readonly string[]).includes(type));
  return !residential && context.hasResident ? AGENT_HAS_RESIDENT : AGENT_CBO_NOT_ALLOWED;
}

export function phraseForItem(code: string | null | undefined, item: { type: ItemType; path: string | null | undefined }, context?: ItemContext): string {
  if (context?.agent === true && item.type === "household" && code === "cbo_not_allowed") return agentHouseholdRefusal(context);
  if (!code || code === "invalid_transition" || !Object.prototype.hasOwnProperty.call(VECTOR_ERRORS, code)) return phraseFor(code);
  const path = item.path ?? "";
  const vector = VECTOR_ITEMS.includes(item.type) || (item.type === "home_visit" && (path === BULLETIN || path.startsWith(`${BULLETIN}.`)));
  return vector ? VECTOR_ERRORS[code as keyof typeof VECTOR_ERRORS] : phraseFor(code);
}
