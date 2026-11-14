// The domains of the home visit and of the collective activity, as the api
// sends them in the offline reference (the same block the dashboard gets in
// its context; ported from the dashboard's lib/api.ts, module 24b §7).
export interface CodeLabel { code: number; label: string }
export type MeasurementKey = "weight_kg" | "height_cm" | "systolic" | "diastolic" | "temperature_c" | "glucose_mg_dl";
export interface MeasurementRange { min: number; max: number; decimals: number }
export type CollectiveField = "meeting_topics" | "target_audience" | "health_topics" | "health_practices" | "participants";
export type FieldRule = "required" | "forbidden" | "optional";

export interface HomeVisitDomains {
  motivo_visita: (CodeLabel & { group: string; group_label: string })[];
  desfecho: CodeLabel[]; turno: CodeLabel[]; tipo_glicemia: CodeLabel[];
  // Property type as TEXT, as the household registration stores it.
  tipo_de_imovel: { code: string; label: string }[];
  non_residential_property_types: string[];
  non_residential_reasons: number[];
  male_forbidden_reasons: number[];
  // Without a person only these reasons; the responsible's document is asked for these.
  without_person_allowed_reasons: number[];
  responsible_document_reasons: number[];
  reasons_max: number;
  measurement_ranges: Record<MeasurementKey, MeasurementRange>;
}

export interface CollectiveDomains {
  activity_types: CodeLabel[]; meeting_topics: CodeLabel[]; target_audience: CodeLabel[]; health_topics: CodeLabel[]; health_practices: CodeLabel[];
  // SIGTAP procedure only from this closed list, with the code as TEXT.
  procedures: { code: string; label: string }[];
  rules: {
    list_max: Record<"meeting_topics" | "target_audience" | "health_topics" | "health_practices", number>;
    by_type: Record<string, Record<CollectiveField, FieldRule>>;
    health_topics_with_meeting_topic: number[];
    practices_only_in_type: { type: number; practices: number[] }[];
    procedure_practices: number[]; smoking_practices: number[];
    participant_measurements: Record<"weight_kg" | "height_cm", MeasurementRange>;
  };
}
