// gerado de contracts/field-sync (field-sync-v1.3.0) — não editar

/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "result".
 */
export type Result = {
  client_uuid?: UuidOrNull;
  /**
   * stale_version só para domicílio, família ou cadastro individual (versão esperada vencida); na família, nova ou existente, a versão é a do domicílio e id é o domicílio (Q4). Cadastro individual novo cujo domicílio citado mudou volta rejected household_changed (path household_id). Exceção inesperada num item volta rejected internal_error, sem path (Q63).
   */
  status: "accepted" | "duplicate" | "rejected" | "stale_version";
  type?:
    | "home_visit"
    | "home_visit_withdrawal"
    | "collective_activity"
    | "patient"
    | "household"
    | "family"
    | "individual_registration"
    | "ovitrap_installation"
    | "ovitrap_collection"
    | null;
  /**
   * accepted e duplicate: o id gravado. stale_version: o id do domicílio (também para family) ou do cadastro existente. rejected: só em already_registered (Q63), o registration_id do cadastro existente, e só quando ele está dentro do escopo do aparelho (6A); fora do escopo não há id. Proibido em qualquer outro rejected. Em ovitrap_installation e ovitrap_collection (35a), o id é o da ovitrampa (CV-3).
   */
  id?: string;
  /**
   * Só no accepted/duplicate de home_visit com boletim (opcional).
   */
  vector_inspection_id?: string;
  error?: ErrorCode;
  /**
   * Notação pontilhada/colchetes do contrato, relativa ao body do item para campos do body (occurred_at, reasons[0], participants[1].new_patient); chave nua para as chaves do próprio item fora do body (client_uuid, type); body quando o body não é objeto. Campo obrigatório ausente: o caminho do campo que falta (occurred_at, participants[1].patient_id). Falha do próprio objeto (pares um-ou-outro do Q27, local da atividade, par de medida): o caminho do objeto (body para o corpo, measurements, participants[i]). Nunca vazio. Nenhum *_body declara type, client_uuid ou body, para o path não ser ambíguo.
   */
  path?: string;
  /**
   * @maxItems 10
   */
  candidates?:
    | []
    | [Candidate]
    | [Candidate, Candidate]
    | [Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate]
    | [Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate, Candidate];
  /**
   * Só em duplicate_participant (Q54; a mesma pessoa duas vezes na atividade coletiva; path participants[i], a segunda ocorrência; sem candidates). true = é só semelhança (dois new_patient com o mesmo nome e a mesma data de nascimento, sem documento igual): o app ou o painel pode reenviar com duplicates_reviewed: true naquele participante, para dizer que é outra pessoa. false = não há como liberar (mesmo patient_id, ou CPF ou CNS iguais). Obrigatório com duplicate_participant e proibido em qualquer outro erro.
   */
  confirmable?: boolean;
  /**
   * Versão que o registro ficou depois do item (24c, Q5): obrigatória no accepted de household, family (a versão do domicílio) e individual_registration; opcional no duplicate desses três (recibo anterior à coluna result_version não a tem); proibida nos outros tipos e em rejected e stale_version.
   */
  version?: number;
  current_version?: number;
  current?: {};
};
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "uuid_or_null".
 */
export type UuidOrNull = string | null;
/**
 * Código do contrato do 24b §13, dos herdados e do 24a. Os conhecidos estão em domains-v1.json (errors.item); código novo do api é MINOR e o app mostra uma frase genérica (K-8).
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "error_code".
 */
export type ErrorCode = string;
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "uuid".
 */
export type Uuid = string;
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "date_or_null".
 */
export type DateOrNull = string | null;
/**
 * ISO 8601 com segundos e fuso explícito (Z ou ±hh:mm); nunca hora local sem fuso.
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "datetime".
 */
export type Datetime = string;
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "datetime_or_null".
 */
export type DatetimeOrNull = string | null;
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "date".
 */
export type Date = string;
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "micro_area_code".
 */
export type MicroAreaCode = string;
/**
 * TerritoryRegistry::Catalog::PROPERTY_TYPES (texto, como no 24a). Não residencial: 2, 3, 4, 5, 6, 12, 13.
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "property_type".
 */
export type PropertyType = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "99";

/**
 * Resposta 200 do POST /field/v1/uploads (contrato do 24b §9.3): um resultado por item, na ordem do pedido. accepted e duplicate trazem o id gravado; rejected traz o código (e path, quando o erro é de um campo; candidates só em duplicate_suspected; id só em already_registered, e só quando o cadastro existente está no escopo do aparelho, 6A); internal_error (exceção inesperada, Q63) volta rejected sem path, não entra no livro de idempotência e o reenvio o processa de novo; stale_version traz a versão atual de um domicílio ou cadastro que JÁ EXISTE, para o app resolver o conflito (24c); cadastro individual NOVO cujo domicílio citado mudou de versão volta rejected household_changed com path household_id (Q63). Envelope inválido (Q31) é 422 { error: invalid_request, path } para o lote inteiro, fora deste esquema; item fora do esquema do pedido volta aqui como rejected com error invalid_request e o path (client_uuid e type só quando válidos; sem eles o result os omite ou traz null), na ordem dos itens.
 */
export interface UploadResponse {
  /**
   * @minItems 1
   * @maxItems 50
   */
  results: [Result, ...Result[]];
}
/**
 * Candidato a duplicado (§5, Q8): sem CPF, CNS nem mãe; sex e has_cns acompanham o candidato do registro rápido. registration_id só vem do cadastro individual do 24a (L31), K-9, Q26.
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "candidate".
 */
export interface Candidate {
  patient_id: Uuid;
  display_name: string;
  birth_date: DateOrNull;
  sex?: "male" | "female" | null;
  has_cpf: boolean;
  has_cns?: boolean;
  registration_id?: UuidOrNull;
}
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "micro_area_ref".
 */
export interface MicroAreaRef {
  id: Uuid;
  code: MicroAreaCode;
}
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "team_ref".
 */
export interface TeamRef {
  id: Uuid;
  ine: string;
  name: string;
}
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "registered_by".
 */
export interface RegisteredBy {
  name: string | null;
}
/**
 * Chaves de TerritoryRegistry::Address::KEYS (24a L6). Objeto vazio no domicílio recusado sem endereço. Tamanhos são do api (invalid_household com path).
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "address".
 */
export interface Address {
  zip?: string | null;
  street_type?: string | null;
  street?: string | null;
  number?: string | null;
  no_number?: boolean | null;
  complement?: string | null;
  neighborhood_id?: UuidOrNull;
  district?: string | null;
  reference?: string | null;
}
/**
 * Coordenada do imóvel ou da visita (24c §4, Q3): latitude e longitude com até 8 casas, source gps (leitura do aparelho) ou map (ponto marcado no mapa). accuracy_m, em metros com até 1 casa, é obrigatório com source gps e opcional com map (o app manda a resolução do toque; o dashboard não manda). A visita só aceita gps: é regra do api (domains-v1.json, location.visit_sources), não deste esquema. Erro de esquema aqui dentro volta rejected invalid_location com o mesmo path (Q2).
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "location".
 */
export interface Location {
  latitude: number;
  longitude: number;
  accuracy_m?: number;
  source: "gps" | "map";
}
/**
 * <household> do 24a (§2; L6, L7, L30; TerritoryRegistry::Json.household com full: true): com families e living_conditions. Responsável da família só com patient_id e display_name, nunca CPF.
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "household".
 */
export interface Household {
  id: Uuid;
  micro_area: MicroAreaRef;
  address: Address;
  property_type: PropertyType;
  contact_phone: string | null;
  refused: boolean;
  status: "active" | "inactive";
  version: number;
  registered_at: Datetime;
  registered_by: RegisteredBy;
  /**
   * Ponto do imóvel (24c); null = sem ponto.
   */
  location: Location | null;
  families: Family[];
  /**
   * Seção do dicionário do 24a (§15): chaves e domínios do api, não deste esquema (K-2).
   */
  living_conditions: {};
  /**
   * Perfil de vigilância (35a), só leitura, na forma de GET /vector_control/households/:id. Acrescentado pelo FieldSync; o TerritoryRegistry::Json.household do 24a não muda (Q8). Ausente = gate vector_control não utilizável; null = sem perfil (Q6, CV-10). Nunca vai no item household.
   */
  vector?: HouseholdVector | null;
}
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "family".
 */
export interface Family {
  id: Uuid;
  responsible: {
    patient_id: Uuid;
    display_name: string;
  };
  income_band: string | null;
  members_count: number;
  living_since: string | null;
  moved_out: boolean;
  responsible_exited: boolean;
}
/**
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "household_vector".
 */
export interface HouseholdVector {
  city_block_id: UuidOrNull;
  risk_class: "green" | "yellow" | "red" | "gray" | "purple" | null;
  risk_assessed_on: DateOrNull;
  last_worked_on: DateOrNull;
  last_situation: "worked" | "closed" | "refused" | "vacant" | null;
}
/**
 * <registration> do 24a (§2; L4, L7, L9, L21, L24; TerritoryRegistry::Json.registration). CPF nunca: só has_cpf; CNS só mascarado.
 *
 * This interface was referenced by `UploadResponse`'s JSON-Schema
 * via the `definition` "registration".
 */
export interface Registration {
  id: Uuid;
  patient: {
    id: Uuid;
    display_name: string;
    full_name: string;
    mother_name: string | null;
    birth_date: DateOrNull;
    sex: "male" | "female" | null;
    has_cpf: boolean;
    no_cpf_reason: "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | null;
    cns_masked: string | null;
    identity_locked: boolean;
  };
  patient_demographics: {
    race_color: string | null;
    ethnicity: string | null;
  };
  household_id: UuidOrNull;
  family_id: UuidOrNull;
  is_responsible: boolean;
  team: TeamRef;
  micro_area: MicroAreaRef | null;
  identification: {};
  sociodemographic: {};
  health_conditions: {};
  street_situation: {} | null;
  refused: boolean;
  exit: {
    reason: "moved" | "death";
    on: Date;
    death_on: DateOrNull;
    death_certificate: string | null;
  } | null;
  status: "valid" | "due_soon" | "expired" | "missing" | "missing_identifier" | "refused" | "exited";
  version: number;
  registered_at: Datetime;
  registered_by: RegisteredBy;
  identity_changed_at: DatetimeOrNull;
  identity_review_pending: boolean;
}
