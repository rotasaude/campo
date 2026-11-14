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
