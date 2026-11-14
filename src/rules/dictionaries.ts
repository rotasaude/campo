// The LEDI registration dictionaries as the forms use them: domains (lists of
// code and label, in the LEDI order) and the fields of each section. They come
// from the offline reference (GET /field/v1/reference), not from the app's
// bundle — the same source that feeds the dashboard. The shape is checked
// before use: a reference the app does not fully understand is not used at
// all, and the previous one stays.

export type FieldType = "bool" | "code" | "codes" | "text" | "name" | "digits" | "date_month" | "date" | "count" | "object";
export type SectionKey = "identification" | "sociodemographic" | "health_conditions" | "street_situation" | "living_conditions";
export interface DictEntry { code: number; label: string }
export interface StringDictEntry { code: string; label: string }
export interface FieldSpec {
  key: string; ledi: string; type: FieldType; domain?: string; max?: number; min?: number; max_items?: number;
  required?: boolean; fields?: FieldSpec[];
}
export interface RegistrationDictionaries {
  domains: Record<string, DictEntry[]>;
  stringDomains: Record<"uf" | "tipo_logradouro", StringDictEntry[]>;
  sections: Record<SectionKey, FieldSpec[]>;
}

// The message says where the shape broke, never the value found there.
export class ReferenceShapeError extends Error {
  constructor(where: string) { super(`referência em formato inesperado: ${where}`); }
}

const FIELD_TYPES: readonly string[] = ["bool", "code", "codes", "text", "name", "digits", "date_month", "date", "count", "object"];
export const SECTION_KEYS: readonly SectionKey[] = ["identification", "sociodemographic", "health_conditions", "street_situation", "living_conditions"];
const STRING_DOMAINS = ["uf", "tipo_logradouro"] as const;
const FIELD_KEYS = new Set(["key", "ledi", "type", "domain", "max", "min", "max_items", "required", "fields"]);
const NUMBER_KEYS = ["max", "min", "max_items"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Q27: a domain is a LIST in the YAML order. An object of integer codes would be reordered by JavaScript.
function entries<C extends "number" | "string">(raw: unknown, where: string, code: C): (C extends "number" ? DictEntry : StringDictEntry)[] {
  if (!Array.isArray(raw)) throw new ReferenceShapeError(where);
  return raw.map((entry, index) => {
    const ok = isObject(entry) && typeof entry.label === "string"
      && (code === "number" ? Number.isInteger(entry.code) : typeof entry.code === "string");
    if (!ok) throw new ReferenceShapeError(`${where}[${index}]`);
    return { code: entry.code, label: entry.label } as C extends "number" ? DictEntry : StringDictEntry;
  });
}

function fields(raw: unknown, where: string, domains: Record<string, DictEntry[]>): FieldSpec[] {
  if (!Array.isArray(raw)) throw new ReferenceShapeError(where);
  return raw.map((spec, index) => {
    const at = `${where}[${index}]`;
    if (!isObject(spec) || typeof spec.key !== "string" || typeof spec.ledi !== "string") throw new ReferenceShapeError(at);
    if (typeof spec.type !== "string" || !FIELD_TYPES.includes(spec.type)) throw new ReferenceShapeError(`${at}.type`);
    // A rule the app does not know would be silently ignored: refuse the whole reference instead.
    const unknown = Object.keys(spec).find((key) => !FIELD_KEYS.has(key));
    if (unknown !== undefined) throw new ReferenceShapeError(`${at}.${unknown}`);
    const field: FieldSpec = { key: spec.key, ledi: spec.ledi, type: spec.type as FieldType };
    if (spec.domain !== undefined) {
      if (typeof spec.domain !== "string" || !Object.prototype.hasOwnProperty.call(domains, spec.domain)) throw new ReferenceShapeError(`${at}.domain`);
      field.domain = spec.domain;
    }
    for (const key of NUMBER_KEYS) {
      if (spec[key] === undefined) continue;
      if (typeof spec[key] !== "number" || !Number.isFinite(spec[key])) throw new ReferenceShapeError(`${at}.${key}`);
      field[key] = spec[key] as number;
    }
    if (spec.required !== undefined) {
      if (typeof spec.required !== "boolean") throw new ReferenceShapeError(`${at}.required`);
      field.required = spec.required;
    }
    if (field.type === "object" || spec.fields !== undefined) {
      if (field.type !== "object") throw new ReferenceShapeError(`${at}.fields`);
      field.fields = fields(spec.fields, `${at}.fields`, domains);
    }
    return field;
  });
}

export function parseRegistrationDictionaries(raw: unknown, stringDomains: unknown): RegistrationDictionaries {
  if (!isObject(raw) || !isObject(raw.domains)) throw new ReferenceShapeError("registration_dictionaries.domains");
  const domains: Record<string, DictEntry[]> = {};
  for (const [name, list] of Object.entries(raw.domains)) domains[name] = entries(list, `registration_dictionaries.domains.${name}`, "number");

  if (!isObject(raw.sections)) throw new ReferenceShapeError("registration_dictionaries.sections");
  const strange = Object.keys(raw.sections).find((key) => !(SECTION_KEYS as readonly string[]).includes(key));
  if (strange !== undefined) throw new ReferenceShapeError(`registration_dictionaries.sections.${strange}`);
  const sections = {} as Record<SectionKey, FieldSpec[]>;
  for (const key of SECTION_KEYS) {
    sections[key] = raw.sections[key] === undefined ? [] : fields(raw.sections[key], `registration_dictionaries.sections.${key}`, domains);
  }

  if (!isObject(stringDomains)) throw new ReferenceShapeError("string_domains");
  const strings = {} as RegistrationDictionaries["stringDomains"];
  for (const key of STRING_DOMAINS) strings[key] = entries(stringDomains[key], `string_domains.${key}`, "string");
  return { domains, stringDomains: strings, sections };
}

// The label of a code; the code itself when the dictionary does not have it; a dash when there is no code.
export function dictLabel(dict: RegistrationDictionaries, domain: string, code: number | string | null | undefined): string {
  if (code === null || code === undefined) return "—";
  const strings = dict.stringDomains as Record<string, StringDictEntry[]>;
  const list: readonly (DictEntry | StringDictEntry)[] | undefined = Object.prototype.hasOwnProperty.call(strings, domain)
    ? strings[domain] : Object.prototype.hasOwnProperty.call(dict.domains, domain) ? dict.domains[domain] : undefined;
  return list?.find((entry) => String(entry.code) === String(code))?.label ?? String(code);
}
