// gerado de contracts/field-sync (field-sync-v1.2.0) — não editar

/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "uuid".
 */
export type Uuid = string;

/**
 * GET /field/v1/reference (contrato do 24c §3.5): o que o app precisa para montar os formulários sem rede — dicionários do cadastro, bairros, unidades, profissionais da equipe e domínios da visita e da atividade coletiva. Nenhum dado de cidadão; do profissional, só nome, CBO e se tem CNS (nunca CPF nem CNS). Fechado no topo; as seções de dicionário ficam abertas, porque a fonte é o YAML do api (K-2). reference_version é o mesmo valor da sessão: o app compara, nunca recalcula.
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
  collective_activity_domains: {};
}
/**
 * This interface was referenced by `ReferenceResponse`'s JSON-Schema
 * via the `definition` "string_entry".
 */
export interface StringEntry {
  code: string;
  label: string;
}
