// The editable projection of a record: the fields an upload item carries,
// taken from the download shape. It is what the merge compares (Q42) — the
// same shape on the three sides: what the person saw, what the tablet sends
// and what the station has now.
import type { HouseholdBody, ItemType, RegistrationBody } from "../contract";

type Body = Record<string, unknown>;

export interface HouseholdEditable {
  micro_area_id: string; address: HouseholdBody["address"]; property_type: string; living_conditions: HouseholdBody["living_conditions"];
  contact_phone: string | null; refused: boolean; status: string; location: HouseholdBody["location"];
}
export interface FamilyEditable { income_band: string | null; members_count: number; living_since: string | null; moved_out: boolean }
export interface RegistrationEditable {
  household_id: string | null; family_id: string | null; is_responsible: boolean; team_id: string;
  patient_demographics: RegistrationBody["patient_demographics"]; identification: RegistrationBody["identification"];
  sociodemographic: RegistrationBody["sociodemographic"]; health_conditions: RegistrationBody["health_conditions"];
  street_situation: RegistrationBody["street_situation"]; refused: boolean;
}

// Without `families`: a family is edited by its own item.
export function householdEditable(h: HouseholdBody): HouseholdEditable {
  return {
    micro_area_id: h.micro_area.id, address: h.address, property_type: h.property_type, living_conditions: h.living_conditions,
    contact_phone: h.contact_phone, refused: h.refused, status: h.status, location: h.location,
  };
}

// The other way round: the record as it reads once the fields of a household item are applied to it. Only the keys
// the item carries change (an absent key means "as the server has it"); the families are not the item's business.
// `area`: the micro-area the item names, when it is not the record's own.
export function applyHouseholdFields(h: HouseholdBody, fields: Body, area?: HouseholdBody["micro_area"] | null): HouseholdBody {
  const next = { ...h };
  const has = (key: string) => key in fields && fields[key] !== undefined;
  if (has("address")) next.address = fields.address as HouseholdBody["address"];
  if (has("property_type")) next.property_type = fields.property_type as HouseholdBody["property_type"];
  if (has("living_conditions")) next.living_conditions = (fields.living_conditions ?? {}) as HouseholdBody["living_conditions"];
  if (has("contact_phone")) next.contact_phone = fields.contact_phone as string | null;
  if (has("refused")) next.refused = fields.refused === true;
  if (has("status")) next.status = fields.status as HouseholdBody["status"];
  if (has("location")) next.location = (fields.location ?? null) as HouseholdBody["location"];
  if (has("micro_area_id") && fields.micro_area_id !== h.micro_area?.id && area) next.micro_area = area;
  return next;
}

// The family with that id inside its household (Q43); null when it is not there any more.
export function familyEditable(h: HouseholdBody, familyId: string): FamilyEditable | null {
  const family = h.families.find((f) => f.id === familyId);
  if (!family) return null;
  return { income_band: family.income_band, members_count: family.members_count, living_since: family.living_since, moved_out: family.moved_out };
}

// Without `patient`: identity and the exit from the registry are done at the dashboard, not in the app (Q47).
export function registrationEditable(r: RegistrationBody): RegistrationEditable {
  return {
    household_id: r.household_id, family_id: r.family_id, is_responsible: r.is_responsible, team_id: r.team.id,
    patient_demographics: r.patient_demographics, identification: r.identification, sociodemographic: r.sociodemographic,
    health_conditions: r.health_conditions, street_situation: r.street_situation, refused: r.refused,
  };
}

// The keys of an item's body that say which record it is (and its version), not what the person edited.
const ID_KEYS: Partial<Record<ItemType, readonly string[]>> = {
  household: ["household_id", "version"],
  family: ["household_id", "household_client_uuid", "family_id", "version", "responsible"],
  individual_registration: [
    "registration_id", "version", "patient_id", "patient_client_uuid", "new_patient", "citizen_id", "duplicates_reviewed",
    "household_client_uuid", "family_client_uuid",
  ],
};

export function splitItemBody(type: ItemType, body: Body): { ids: Body; fields: Body } {
  const idKeys = ID_KEYS[type] ?? [];
  const ids: Body = {};
  const fields: Body = {};
  for (const [key, value] of Object.entries(body)) (idKeys.includes(key) ? ids : fields)[key] = value;
  return { ids, fields };
}
