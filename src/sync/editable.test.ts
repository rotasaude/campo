import type { HouseholdBody, RegistrationBody, UploadResponse } from "../contract";
import { example } from "../contract/fixtures";
import { familyEditable, householdEditable, registrationEditable, splitItemBody } from "./editable";

const current = <T>(file: string) => (example<UploadResponse>(file).results[0] as unknown as { current: T }).current;
const HOUSEHOLD = current<HouseholdBody>("upload-response-stale-family.json");
const REGISTRATION = current<RegistrationBody>("upload-response-stale-registration.json");

test("householdEditable: the fields a household item sends, and nothing of families or bookkeeping", () => {
  expect(householdEditable(HOUSEHOLD)).toEqual({
    micro_area_id: HOUSEHOLD.micro_area.id, address: HOUSEHOLD.address, property_type: HOUSEHOLD.property_type,
    living_conditions: HOUSEHOLD.living_conditions, contact_phone: HOUSEHOLD.contact_phone, refused: HOUSEHOLD.refused,
    status: HOUSEHOLD.status, location: HOUSEHOLD.location,
  });
  expect(Object.keys(householdEditable(HOUSEHOLD))).not.toEqual(expect.arrayContaining(["families", "id", "version", "registered_by"]));
});

test("familyEditable: the family with that id, or null when it is not in the household", () => {
  const family = HOUSEHOLD.families[0];
  expect(familyEditable(HOUSEHOLD, family.id)).toEqual({
    income_band: family.income_band, members_count: family.members_count, living_since: family.living_since, moved_out: family.moved_out,
  });
  expect(familyEditable(HOUSEHOLD, "00000000-0000-4000-8000-000000000000")).toBeNull();
});

test("registrationEditable: no patient identity, no exit, no bookkeeping (Q47)", () => {
  const editable = registrationEditable(REGISTRATION);
  expect(editable).toEqual({
    household_id: REGISTRATION.household_id, family_id: REGISTRATION.family_id, is_responsible: REGISTRATION.is_responsible,
    team_id: REGISTRATION.team.id, patient_demographics: REGISTRATION.patient_demographics, identification: REGISTRATION.identification,
    sociodemographic: REGISTRATION.sociodemographic, health_conditions: REGISTRATION.health_conditions,
    street_situation: REGISTRATION.street_situation, refused: REGISTRATION.refused,
  });
  expect(JSON.stringify(editable)).not.toContain(REGISTRATION.patient.full_name);
});

test("splitItemBody separates what names the record from what the person edits", () => {
  expect(splitItemBody("household", { household_id: "h", version: 3, micro_area_id: "m", contact_phone: "1" }))
    .toEqual({ ids: { household_id: "h", version: 3 }, fields: { micro_area_id: "m", contact_phone: "1" } });
  expect(splitItemBody("family", { household_id: "h", family_id: "f", version: 4, responsible: { patient_id: "p" }, income_band: "3" }))
    .toEqual({ ids: { household_id: "h", family_id: "f", version: 4, responsible: { patient_id: "p" } }, fields: { income_band: "3" } });
  expect(splitItemBody("individual_registration", { registration_id: "r", version: 2, patient_id: "p", household_id: "h", refused: false }))
    .toEqual({ ids: { registration_id: "r", version: 2, patient_id: "p" }, fields: { household_id: "h", refused: false } });
});
