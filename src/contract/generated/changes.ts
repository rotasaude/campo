// gerado de contracts/field-sync (field-sync-v1.3.0) — não editar

/**
 * GET /field/v1/changes (contrato do 24b §9.3): uma página do download incremental do escopo do aparelho, em ordem (updated_at, id). reset: true = o escopo mudou desde o cursor; o app apaga o que baixou (nunca o que falta enviar) e aplica as páginas. who_to_visit vem só na última página (has_more: false), sempre completo; nas outras, null. next_cursor é opaco e sempre vem: o app o guarda para a próxima sincronização (K-10).
 */
export type ChangesResponse = {
  reset: boolean;
  /**
   * @maxItems 500
   */
  items: ChangeItem[];
  removals: Removal[];
  who_to_visit: {} | null;
  /**
   * base64url sem padding; nenhum dado pessoal.
   */
  next_cursor: string;
  has_more: boolean;
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "change_item".
 */
export type ChangeItem = {
  type: "micro_area" | "household" | "registration" | "city_block" | "ovitrap" | "liraa_item" | "transmission_block";
  id: Uuid;
  version?: number;
  body: {};
};
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "uuid".
 */
export type Uuid = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "uuid_or_null".
 */
export type UuidOrNull = string | null;
/**
 * ISO 8601 com segundos e fuso explícito (Z ou ±hh:mm); nunca hora local sem fuso.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "datetime".
 */
export type Datetime = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "datetime_or_null".
 */
export type DatetimeOrNull = string | null;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "date".
 */
export type Date = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "date_or_null".
 */
export type DateOrNull = string | null;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "micro_area_code".
 */
export type MicroAreaCode = string;
/**
 * TerritoryRegistry::Catalog::PROPERTY_TYPES (texto, como no 24a). Não residencial: 2, 3, 4, 5, 6, 12, 13.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "property_type".
 */
export type PropertyType = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "99";
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "ovitrap_number".
 */
export type OvitrapNumber = string;
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "who_reason".
 */
export type WhoReason = {
  code: "care_line" | "registration_due" | "never_visited";
  /**
   * Nome da linha de cuidado.
   */
  care_line?: string;
  /**
   * Rótulo da boa prática.
   */
  practice?: string;
  status?: string;
  /**
   * Nulo só em care_line overdue de prática nunca feita (Q60); o app mostra 'nunca feita'.
   */
  due_on?: Date | null;
};

/**
 * No 24b só moved tem produtor (field_sync_tombstones). erased e out_of_scope ficam no enum mas são reservados no v1 (Q9): o api não os emite ainda, e o app já os trata (apaga o item).
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "removal".
 */
export interface Removal {
  type: "household" | "registration";
  id: Uuid;
  reason: "moved" | "erased" | "out_of_scope";
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "micro_area_ref".
 */
export interface MicroAreaRef {
  id: Uuid;
  code: MicroAreaCode;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "team_ref".
 */
export interface TeamRef {
  id: Uuid;
  ine: string;
  name: string;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "registered_by".
 */
export interface RegisteredBy {
  name: string | null;
}
/**
 * Chaves de TerritoryRegistry::Address::KEYS (24a L6). Objeto vazio no domicílio recusado sem endereço. Tamanhos são do api (invalid_household com path).
 *
 * This interface was referenced by `undefined`'s JSON-Schema
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
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "location".
 */
export interface Location {
  latitude: number;
  longitude: number;
  accuracy_m?: number;
  source: "gps" | "map";
}
/**
 * Quarteirão (35a, §13): número, vizinhança e situação. Sem dado de pessoa.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "city_block".
 */
export interface CityBlock {
  id: Uuid;
  neighborhood_id: Uuid;
  number: string;
  active: boolean;
  neighbor_ids: Uuid[];
  version: number;
}
/**
 * Ovitrampa (35a, §6, §13). Nunca leva morador; o fim vem pelo status, não por removal.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "ovitrap".
 */
export interface Ovitrap {
  id: Uuid;
  number: OvitrapNumber;
  household_id: Uuid;
  status: "active" | "removed" | "lost";
  open_reading: {
    installed_on: Date;
  } | null;
  last_reading: {
    collected_on: Date;
    condition: "ok" | "damaged" | "lost" | "dry";
    egg_count: number | null;
  } | null;
  version: number;
}
/**
 * Item sorteado do LIRAa (35a, §7, §13). closed = o levantamento fechou.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "liraa_item".
 */
export interface LiraaItem {
  id: Uuid;
  survey_id: Uuid;
  survey_name: string;
  household_id: Uuid;
  city_block_id: Uuid;
  status: "pending" | "inspected" | "substituted" | "closed";
  version: number;
}
/**
 * Bloqueio de transmissão (35a, §8, §13): quarteirões e ciclos de UBV. Nunca leva caso, notificação nem paciente (§8, §17); proposta e descarte nunca saem.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "transmission_block".
 */
export interface TransmissionBlock {
  id: Uuid;
  status: "active" | "closed";
  /**
   * @minItems 1
   */
  block_ids: [Uuid, ...Uuid[]];
  /**
   * @maxItems 3
   */
  cycles:
    | []
    | [
        {
          number: number;
          starts_on: Date;
          ends_on: Date;
        }
      ]
    | [
        {
          number: number;
          starts_on: Date;
          ends_on: Date;
        },
        {
          number: number;
          starts_on: Date;
          ends_on: Date;
        }
      ]
    | [
        {
          number: number;
          starts_on: Date;
          ends_on: Date;
        },
        {
          number: number;
          starts_on: Date;
          ends_on: Date;
        },
        {
          number: number;
          starts_on: Date;
          ends_on: Date;
        }
      ];
  version: number;
}
/**
 * <household> do 24a (§2; L6, L7, L30; TerritoryRegistry::Json.household com full: true): com families e living_conditions. Responsável da família só com patient_id e display_name, nunca CPF.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
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
 * This interface was referenced by `undefined`'s JSON-Schema
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
 * This interface was referenced by `undefined`'s JSON-Schema
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
 * This interface was referenced by `undefined`'s JSON-Schema
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
/**
 * <micro_area> do 24a (§2; TerritoryRegistry::Json.micro_area).
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "micro_area".
 */
export interface MicroArea {
  id: Uuid;
  team: TeamRef;
  code: MicroAreaCode;
  name: string;
  acs: {
    professional_id: Uuid;
    name: string | null;
  } | null;
  active: boolean;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "who_to_visit".
 */
export interface WhoToVisit {
  generated_at: Datetime;
  micro_areas: {
    micro_area_id: Uuid;
    people: WhoItem[];
  }[];
}
/**
 * Item de 'quem visitar' (§8). Nunca CID, problema ou condição.
 *
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "who_item".
 */
export interface WhoItem {
  patient_id: Uuid;
  display_name: string;
  /**
   * Nulo quando o paciente não tem nascimento (Q33); o app mostra o item sem idade.
   */
  age: number | null;
  household: {
    id: Uuid;
    address_short: string;
  } | null;
  family_id: UuidOrNull;
  micro_area: MicroAreaRef;
  last_visit_on: DateOrNull;
  /**
   * @minItems 1
   */
  reasons: [WhoReason, ...WhoReason[]];
}
