// gerado de contracts/field-sync (field-sync-v1.3.0) — não editar

/**
 * ISO 8601 com segundos e fuso explícito (Z ou ±hh:mm); nunca hora local sem fuso.
 *
 * This interface was referenced by `SessionResponse`'s JSON-Schema
 * via the `definition` "datetime".
 */
export type Datetime = string;
/**
 * This interface was referenced by `SessionResponse`'s JSON-Schema
 * via the `definition` "uuid".
 */
export type Uuid = string;
/**
 * This interface was referenced by `SessionResponse`'s JSON-Schema
 * via the `definition` "micro_area_code".
 */
export type MicroAreaCode = string;
/**
 * This interface was referenced by `SessionResponse`'s JSON-Schema
 * via the `definition` "date".
 */
export type Date = string;

/**
 * GET /field/v1/session (contrato do 24b §9.3): quem é o aparelho, as microáreas que ele baixa (ACS: as de que é responsável; outros CBOs da Tabela 7: as atribuídas pelo enfermeiro, 6A) e os interruptores. Sem trilha. Fechado.
 */
export interface SessionResponse {
  contract: "field-sync-v1";
  server_time: Datetime;
  user: {
    id: Uuid;
    name: string;
  };
  professional: {
    id: Uuid;
    /**
     * CBO do vínculo ativo (Tabela 7 do LEDI).
     */
    cbo: string;
    /**
     * Sem CNS a ficha de visita sai 'não gerada' (professional_without_cns).
     */
    has_cns: boolean;
  };
  /**
   * @minItems 1
   */
  teams: [
    {
      id: Uuid;
      ine: string;
      name: string;
      micro_areas: {
        id: Uuid;
        code: MicroAreaCode;
        name: string;
        /**
         * responsible: o ACS da microárea; assigned: atribuída pelo enfermeiro (6A). Não há 'team': enfermeiro e médico não têm aparelho.
         */
        scope: "responsible" | "assigned";
      }[];
      /**
       * Só o ACS registra fora de área (C3).
       */
      out_of_area_allowed: boolean;
    },
    ...{
      id: Uuid;
      ine: string;
      name: string;
      micro_areas: {
        id: Uuid;
        code: MicroAreaCode;
        name: string;
        /**
         * responsible: o ACS da microárea; assigned: atribuída pelo enfermeiro (6A). Não há 'team': enfermeiro e médico não têm aparelho.
         */
        scope: "responsible" | "assigned";
      }[];
      /**
       * Só o ACS registra fora de área (C3).
       */
      out_of_area_allowed: boolean;
    }[]
  ];
  features: {
    home_visits: boolean;
    collective_activities: boolean;
    territory_registry: boolean;
    /**
     * Vigilância ambiental de endemias (35a). Opcional: ausente = false (api anterior ao 35a).
     */
    vector_control?: boolean;
  };
  /**
   * Primeiro dia aceito pelo prazo do SIAPS (§3, C2).
   */
  min_date: string;
  /**
   * Mapa offline do município (24c §3.1): o arquivo que GET /field/v1/map entrega. null = a cidade ainda não tem mapa gerado. O app baixa de novo quando version ou sha256 mudam e confere o SHA-256 do arquivo inteiro antes de usar.
   */
  map: null | {
    version: Date;
    size_bytes: number;
    sha256: string;
  };
  /**
   * SHA-256 da referência offline (GET /field/v1/reference, reference-response-v1.json). O app baixa a referência de novo quando este valor muda.
   */
  reference_version: string;
}
