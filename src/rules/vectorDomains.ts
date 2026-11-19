// The vector control domains of the offline reference (`vector_control_domains`, contract §13): the lists of the
// bulletin, the active products, the cadences, the parameters and the limits (Q7(3)). The api sends the block only
// where the city's vector_control gate is usable; absent = no bulletin. The shape is checked before use, as for the
// registration dictionaries: a block the app does not fully understand (a code it has never heard of included) is
// not used, and the previous reference stays.
// Names as in the dashboard (apps/dashboard src/lib/api.ts, 2e3a2a9); `charge_size` is text with two places (Q15).
import { ReferenceShapeError } from "./dictionaries";

export const VECTOR_ACTIVITIES = ["li", "li_t", "pe", "ie", "transmission_block", "liraa"] as const;
export const VECTOR_WORK_TYPES = ["routine", "pending"] as const;
export const VECTOR_SITUATIONS = ["worked", "closed", "refused", "vacant"] as const;
export const DEPOSIT_GROUPS = ["A1", "A2", "B", "C", "D1", "D2", "E"] as const;
export const MEASURE_METHODS = ["mechanical", "focal", "perifocal", "spatial"] as const;
export const RISK_CLASSES = ["green", "yellow", "red", "gray", "purple"] as const;
const PRODUCT_UNITS = ["g", "ml", "un"] as const;
const PRODUCT_USES = ["focal", "perifocal", "spatial"] as const;

export type VectorActivity = (typeof VECTOR_ACTIVITIES)[number];
export type VectorWorkType = (typeof VECTOR_WORK_TYPES)[number];
export type VectorSituation = (typeof VECTOR_SITUATIONS)[number];
export type DepositGroup = (typeof DEPOSIT_GROUPS)[number];
export type MeasureMethod = (typeof MEASURE_METHODS)[number];
export type RiskClass = (typeof RISK_CLASSES)[number];
export interface Cadence { neighborhood_id: string | null; risk_class: RiskClass | null; strategic_point: boolean; days: number }
export interface VectorProduct {
  id: string; code: string; name: string; unit: (typeof PRODUCT_UNITS)[number]; charge_size: string; uses: Exclude<MeasureMethod, "mechanical">[];
}
export interface VectorControlDomains {
  activities: { code: VectorActivity; label: string }[];
  work_types: { code: VectorWorkType; label: string }[];
  situations: { code: VectorSituation; label: string }[];
  deposit_groups: { code: DepositGroup; label: string }[];
  measure_methods: { code: MeasureMethod; label: string }[];
  risk_classes: { code: RiskClass; label: string }[];
  products: VectorProduct[];
  cadences: Cadence[];
  parameters: { default_days: number; strategic_point_days: number; ovitrap_collection_days_min: number; ovitrap_collection_days_max: number };
  limits: { deposit_count_max: number; charges_max: number; samples_max: number; larvae_collected_max: number; measures_max: number };
}

const WHERE = "vector_control_domains";
const CHARGE_SIZE = /^[0-9]{1,8}\.[0-9]{2}$/;
const PARAMETER_KEYS = ["default_days", "strategic_point_days", "ovitrap_collection_days_min", "ovitrap_collection_days_max"] as const;
const LIMIT_KEYS = ["deposit_count_max", "charges_max", "samples_max", "larvae_collected_max", "measures_max"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const oneOf = <T extends string>(codes: readonly T[], value: unknown): value is T => codes.includes(value as T);
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

function rows<T>(raw: unknown, where: string, take: (row: Record<string, unknown>) => T | null, nonEmpty = false): T[] {
  if (!Array.isArray(raw) || (nonEmpty && raw.length === 0)) throw new ReferenceShapeError(where);
  return raw.map((row, index) => {
    const taken = isObject(row) ? take(row) : null;
    if (taken === null) throw new ReferenceShapeError(`${where}[${index}]`);
    return taken;
  });
}

// A list of { code, label } whose codes are those the app knows (domains-v1.json, vector_control).
function codeList<T extends string>(raw: unknown, where: string, codes: readonly T[]): { code: T; label: string }[] {
  return rows(raw, where, (r) => (oneOf(codes, r.code) && isText(r.label) ? { code: r.code, label: r.label } : null), true);
}

function numbers<K extends string>(raw: unknown, where: string, keys: readonly K[]): Record<K, number> {
  if (!isObject(raw)) throw new ReferenceShapeError(where);
  return Object.fromEntries(keys.map((key) => {
    if (!positive(raw[key])) throw new ReferenceShapeError(`${where}.${key}`);
    return [key, raw[key]];
  })) as Record<K, number>;
}

function product(r: Record<string, unknown>): VectorProduct | null {
  const uses = r.uses;
  const usesOk = Array.isArray(uses) && uses.length > 0 && new Set(uses).size === uses.length && uses.every((use) => oneOf(PRODUCT_USES, use));
  if (!isText(r.id) || !isText(r.code) || !isText(r.name) || !oneOf(PRODUCT_UNITS, r.unit) || !isText(r.charge_size) || !CHARGE_SIZE.test(r.charge_size) || !usesOk) return null;
  return { id: r.id, code: r.code, name: r.name, unit: r.unit, charge_size: r.charge_size, uses: [...(uses as VectorProduct["uses"])] };
}

function cadence(r: Record<string, unknown>): Cadence | null {
  const neighborhoodOk = r.neighborhood_id === null || isText(r.neighborhood_id);
  const riskOk = r.risk_class === null || oneOf(RISK_CLASSES, r.risk_class);
  if (!neighborhoodOk || !riskOk || typeof r.strategic_point !== "boolean" || !positive(r.days)) return null;
  return { neighborhood_id: r.neighborhood_id as string | null, risk_class: r.risk_class as RiskClass | null, strategic_point: r.strategic_point, days: r.days };
}

// Absent → null (no bulletin). Present and out of shape → ReferenceShapeError (the message says where, never the value).
export function parseVectorDomains(raw: unknown): VectorControlDomains | null {
  if (raw === undefined) return null;
  if (!isObject(raw)) throw new ReferenceShapeError(WHERE);
  return {
    activities: codeList(raw.activities, `${WHERE}.activities`, VECTOR_ACTIVITIES),
    work_types: codeList(raw.work_types, `${WHERE}.work_types`, VECTOR_WORK_TYPES),
    situations: codeList(raw.situations, `${WHERE}.situations`, VECTOR_SITUATIONS),
    deposit_groups: codeList(raw.deposit_groups, `${WHERE}.deposit_groups`, DEPOSIT_GROUPS),
    measure_methods: codeList(raw.measure_methods, `${WHERE}.measure_methods`, MEASURE_METHODS),
    risk_classes: codeList(raw.risk_classes, `${WHERE}.risk_classes`, RISK_CLASSES),
    products: rows(raw.products, `${WHERE}.products`, product),
    cadences: rows(raw.cadences, `${WHERE}.cadences`, cadence),
    parameters: numbers(raw.parameters, `${WHERE}.parameters`, PARAMETER_KEYS),
    limits: numbers(raw.limits, `${WHERE}.limits`, LIMIT_KEYS),
  };
}
