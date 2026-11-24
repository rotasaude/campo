// gerado de contracts/field-sync (field-sync-v1.4.0) — não editar

/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "uuid".
 */
export type Uuid = string;
/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "uuid_or_null".
 */
export type UuidOrNull = string | null;
/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "date".
 */
export type Date = string;

/**
 * GET /field/v1/reference (contrato do 24c §3.5): o que o app precisa para montar os formulários sem rede — dicionários do cadastro, bairros, unidades, profissionais da equipe e domínios da visita e da atividade coletiva e, só com o gate vector_control utilizável, vector_control_domains (35a), e só com Zoonoses::Gate.field_usable?, zoonoses_domains (35b). Nenhum dado de cidadão; do profissional, só nome, CBO e se tem CNS (nunca CPF nem CNS). Fechado no topo; as seções de dicionário ficam abertas, porque a fonte é o YAML do api (K-2). reference_version é o mesmo valor da sessão: o app compara, nunca recalcula.
 */
export interface ReferenceResponse {
  reference_version: string;
  /**
   * config/ledi/registration_dictionaries.yml do api sem string_domains. Cada domínio é uma LISTA na ordem do YAML (Q27): um objeto { "117": … } perderia a ordem, porque o JavaScript reordena chaves inteiras.
   */
  registration_dictionaries: {
    version: string;
    domains: {
      [k: string]:
        | {
            code: number | string;
            label: string;
          }[]
        | undefined;
    };
    sections: {};
  };
  string_domains: {
    uf: StringEntry[];
    tipo_logradouro: StringEntry[];
  };
  neighborhoods: {
    id: Uuid;
    name: string;
  }[];
  health_units: {
    id: Uuid;
    /**
     * null = unidade sem CNES (Q6): a atividade coletiva a recusa como local.
     */
    cnes: string | null;
    name: string;
  }[];
  /**
   * Profissionais das equipes do aparelho (Q6); o recorte por equipe é o team_id (Q7).
   */
  team_professionals: {
    team_id: Uuid;
    professional_id: Uuid;
    name: string;
    cbo: string;
    has_cns: boolean;
  }[];
  /**
   * HomeVisits::Json.domains do api, um bloco só.
   */
  home_visit_domains: {};
  /**
   * CollectiveActivities::Json.domains do api, um bloco só (Q7).
   */
  collective_activity_domains: {
    rules: CollectiveActivityRules;
  };
  vector_control_domains?: VectorControlDomains;
  zoonoses_domains?: ZoonosesDomains;
}
/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "string_entry".
 */
export interface StringEntry {
  code: string;
  label: string;
}
/**
 * As sete regras de CollectiveActivities::Json.domains[:rules] do api (Q3). Fechado: o vocabulário antigo (by_activity_type e afins) é recusado.
 *
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "collective_activity_rules".
 */
export interface CollectiveActivityRules {
  list_max: {
    meeting_topics: number;
    target_audience: number;
    health_topics: number;
    health_practices: number;
  };
  by_type: {
    [k: string]:
      | {
          meeting_topics: "required" | "forbidden" | "optional";
          target_audience: "required" | "forbidden" | "optional";
          health_topics: "required" | "forbidden" | "optional";
          health_practices: "required" | "forbidden" | "optional";
          participants: "required" | "forbidden" | "optional";
        }
      | undefined;
  };
  health_topics_with_meeting_topic: number[];
  practices_only_in_type: {
    type: number;
    practices: number[];
  }[];
  procedure_practices: number[];
  smoking_practices: number[];
  participant_measurements: {
    weight_kg: MeasurementRange;
    height_cm: MeasurementRange;
  };
}
/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "measurement_range".
 */
export interface MeasurementRange {
  min: number;
  max: number;
  decimals: number;
}
/**
 * Só com o gate vector_control utilizável (§13).
 */
export interface VectorControlDomains {
  /**
   * @minItems 1
   */
  activities: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  work_types: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  situations: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  deposit_groups: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  measure_methods: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  risk_classes: [StringEntry, ...StringEntry[]];
  products: {
    id: Uuid;
    code: string;
    name: string;
    unit: "g" | "ml" | "un";
    /**
     * numeric(10,2) como texto; "> 0" é do api.
     */
    charge_size: string;
    /**
     * @minItems 1
     */
    uses: ["focal" | "perifocal" | "spatial", ...("focal" | "perifocal" | "spatial")[]];
  }[];
  cadences: {
    neighborhood_id: UuidOrNull;
    risk_class: "green" | "yellow" | "red" | "gray" | "purple" | null;
    strategic_point: boolean;
    days: number;
  }[];
  parameters: {
    default_days: number;
    strategic_point_days: number;
    ovitrap_collection_days_min: number;
    ovitrap_collection_days_max: number;
  };
  limits: {
    deposit_count_max: number;
    charges_max: number;
    samples_max: number;
    larvae_collected_max: number;
    measures_max: number;
  };
}
/**
 * Só com Zoonoses::Gate.field_usable? (§11). open_campaign muda o reference_version (D9).
 */
export interface ZoonosesDomains {
  /**
   * @minItems 1
   */
  species: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  sexes: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  sizes: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  animal_statuses: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  dpp_results: [StringEntry, ...StringEntry[]];
  products: {
    id: Uuid;
    code: string;
    name: string;
    use: "rabies_vaccine" | "collar";
  }[];
  open_campaign: {
    id: Uuid;
    name: string;
    starts_on: Date;
    ends_on: Date;
  } | null;
  parameters: {
    collar_months: number;
  };
  limits: {
    name_max: number;
    coat_max: number;
    breed_max: number;
    microchip_digits: number;
    registry_number_max: number;
    adverse_note_min: number;
    adverse_note_max: number;
  };
}
/**
 * Domínios do controle vetorial (35a, contrato §13): listas de {code, label} espelhadas de domains-v1.json (vector_control), produtos, cadências, parâmetros e limites.
 *
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "vector_control_domains".
 */
export interface VectorControlDomains1 {
  /**
   * @minItems 1
   */
  activities: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  work_types: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  situations: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  deposit_groups: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  measure_methods: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  risk_classes: [StringEntry, ...StringEntry[]];
  products: {
    id: Uuid;
    code: string;
    name: string;
    unit: "g" | "ml" | "un";
    /**
     * numeric(10,2) como texto; "> 0" é do api.
     */
    charge_size: string;
    /**
     * @minItems 1
     */
    uses: ["focal" | "perifocal" | "spatial", ...("focal" | "perifocal" | "spatial")[]];
  }[];
  cadences: {
    neighborhood_id: UuidOrNull;
    risk_class: "green" | "yellow" | "red" | "gray" | "purple" | null;
    strategic_point: boolean;
    days: number;
  }[];
  parameters: {
    default_days: number;
    strategic_point_days: number;
    ovitrap_collection_days_min: number;
    ovitrap_collection_days_max: number;
  };
  limits: {
    deposit_count_max: number;
    charges_max: number;
    samples_max: number;
    larvae_collected_max: number;
    measures_max: number;
  };
}
/**
 * Domínios da zoonoses (35b, contrato §11): listas de {code, label} espelhadas de domains-v1.json (zoonoses), produtos, campanha aberta, parâmetros e limites. open_campaign é obrigatório e pode ser null.
 *
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "zoonoses_domains".
 */
export interface ZoonosesDomains1 {
  /**
   * @minItems 1
   */
  species: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  sexes: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  sizes: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  animal_statuses: [StringEntry, ...StringEntry[]];
  /**
   * @minItems 1
   */
  dpp_results: [StringEntry, ...StringEntry[]];
  products: {
    id: Uuid;
    code: string;
    name: string;
    use: "rabies_vaccine" | "collar";
  }[];
  open_campaign: {
    id: Uuid;
    name: string;
    starts_on: Date;
    ends_on: Date;
  } | null;
  parameters: {
    collar_months: number;
  };
  limits: {
    name_max: number;
    coat_max: number;
    breed_max: number;
    microchip_digits: number;
    registry_number_max: number;
    adverse_note_min: number;
    adverse_note_max: number;
  };
}
