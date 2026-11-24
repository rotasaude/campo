// The zoonoses domains of the offline reference (`zoonoses_domains`, contract v1.4.0): the lists of the animal form,
// the products of the rabies vaccine and the collar, the open campaign, the collar parameter and the limits (Q20).
// The api sends the block only where Zoonoses::Gate.field_usable? is true; absent = no zoonoses screens. Same rule as
// the vector block (Q44(1)): present and out of shape refuses the whole reference; in shape but with a code the app
// does not know (species, sex, size, status, DPP result, product use) only drops this block — the reference is kept
// with no zoonoses domains and the ACS is not asked to update the app.
import { ReferenceShapeError } from "./dictionaries";

export const ANIMAL_SPECIES = ["dog", "cat", "other"] as const;
export const ANIMAL_SEXES = ["male", "female", "unknown"] as const;
export const ANIMAL_SIZES = ["small", "medium", "large"] as const;
export const ANIMAL_STATUSES = ["active", "deceased", "missing", "transferred"] as const;
export const DPP_RESULTS = ["reactive", "non_reactive", "invalid"] as const;
export const ZOONOSES_PRODUCT_USES = ["rabies_vaccine", "collar"] as const;

export type AnimalSpecies = (typeof ANIMAL_SPECIES)[number];
export type AnimalSex = (typeof ANIMAL_SEXES)[number];
export type AnimalSize = (typeof ANIMAL_SIZES)[number];
export type AnimalStatus = (typeof ANIMAL_STATUSES)[number];
export type DppResult = (typeof DPP_RESULTS)[number];
export type ZoonosesProductUse = (typeof ZOONOSES_PRODUCT_USES)[number];

const LIMIT_KEYS = ["name_max", "coat_max", "breed_max", "microchip_digits", "registry_number_max", "adverse_note_min", "adverse_note_max"] as const;
export type ZoonosesLimits = Record<(typeof LIMIT_KEYS)[number], number>;

export interface ZoonosesDomains {
  species: { code: AnimalSpecies; label: string }[];
  sexes: { code: AnimalSex; label: string }[];
  sizes: { code: AnimalSize; label: string }[];
  animal_statuses: { code: AnimalStatus; label: string }[];
  dpp_results: { code: DppResult; label: string }[];
  products: { id: string; code: string; name: string; use: ZoonosesProductUse }[];
  open_campaign: { id: string; name: string; starts_on: string; ends_on: string } | null;
  parameters: { collar_months: number };
  limits: ZoonosesLimits;
}

const WHERE = "zoonoses_domains";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

// Set when a code is text but not one the app knows (Q44(1)); the shape checks go on, so a broken shape still refuses.
interface Seen { unknown: boolean }
const known = <T extends string>(codes: readonly T[], value: string, seen: Seen): void => {
  if (!codes.includes(value as T)) seen.unknown = true;
};

function rows<T>(raw: unknown, where: string, take: (row: Record<string, unknown>) => T | null, nonEmpty = false): T[] {
  if (!Array.isArray(raw) || (nonEmpty && raw.length === 0)) throw new ReferenceShapeError(where);
  return raw.map((row, index) => {
    const taken = isObject(row) ? take(row) : null;
    if (taken === null) throw new ReferenceShapeError(`${where}[${index}]`);
    return taken;
  });
}

function codeList<T extends string>(raw: unknown, where: string, codes: readonly T[], seen: Seen): { code: T; label: string }[] {
  return rows(raw, where, (r) => {
    if (!isText(r.code) || !isText(r.label)) return null;
    known(codes, r.code, seen);
    return { code: r.code as T, label: r.label };
  }, true);
}

function product(r: Record<string, unknown>, seen: Seen): ZoonosesDomains["products"][number] | null {
  if (!isText(r.id) || !isText(r.code) || !isText(r.name) || !isText(r.use)) return null;
  known(ZOONOSES_PRODUCT_USES, r.use, seen);
  return { id: r.id, code: r.code, name: r.name, use: r.use as ZoonosesProductUse };
}

// The key is required: a campaign is an object or null, never absent.
function openCampaign(raw: unknown): ZoonosesDomains["open_campaign"] {
  const where = `${WHERE}.open_campaign`;
  if (raw === null) return null;
  const closed = isObject(raw) && Object.keys(raw).every((key) => ["id", "name", "starts_on", "ends_on"].includes(key));
  if (!closed || !isText(raw.id) || !isText(raw.name) || !isText(raw.starts_on) || !DATE.test(raw.starts_on) || !isText(raw.ends_on) || !DATE.test(raw.ends_on)) {
    throw new ReferenceShapeError(where);
  }
  return { id: raw.id, name: raw.name, starts_on: raw.starts_on, ends_on: raw.ends_on };
}

function parameters(raw: unknown): { collar_months: number } {
  if (!isObject(raw) || !positive(raw.collar_months) || raw.collar_months > 12) throw new ReferenceShapeError(`${WHERE}.parameters`);
  return { collar_months: raw.collar_months };
}

function limits(raw: unknown): ZoonosesLimits {
  const where = `${WHERE}.limits`;
  if (!isObject(raw)) throw new ReferenceShapeError(where);
  return Object.fromEntries(LIMIT_KEYS.map((key) => {
    if (!positive(raw[key])) throw new ReferenceShapeError(`${where}.${key}`);
    return [key, raw[key]];
  })) as ZoonosesLimits;
}

// Absent → null (no zoonoses screens). Present and out of shape → ReferenceShapeError (the message says where, never the value).
// In shape but with a code the app does not know → null, the same as absent (Q44(1)).
export function parseZoonosesDomains(raw: unknown): ZoonosesDomains | null {
  if (raw === undefined) return null;
  if (!isObject(raw)) throw new ReferenceShapeError(WHERE);
  const seen: Seen = { unknown: false };
  const parsed: ZoonosesDomains = {
    species: codeList(raw.species, `${WHERE}.species`, ANIMAL_SPECIES, seen),
    sexes: codeList(raw.sexes, `${WHERE}.sexes`, ANIMAL_SEXES, seen),
    sizes: codeList(raw.sizes, `${WHERE}.sizes`, ANIMAL_SIZES, seen),
    animal_statuses: codeList(raw.animal_statuses, `${WHERE}.animal_statuses`, ANIMAL_STATUSES, seen),
    dpp_results: codeList(raw.dpp_results, `${WHERE}.dpp_results`, DPP_RESULTS, seen),
    products: rows(raw.products, `${WHERE}.products`, (r) => product(r, seen)),
    open_campaign: openCampaign(raw.open_campaign),
    parameters: parameters(raw.parameters),
    limits: limits(raw.limits),
  };
  return seen.unknown ? null : parsed;
}
