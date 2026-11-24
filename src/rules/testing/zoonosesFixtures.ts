// Test support for the zoonoses rules (35b). The domains are not typed in: they come from the v1.4.0 reference example
// (contracts/field-sync/examples/reference-zoonoses.json) through parseZoonosesDomains, as the app reads them. The animal
// rows and the survey follow the shapes of the download example (changes-zoonoses-page.json).
import type { AnimalBody, LeishSurveyBody, ReferenceResponse } from "../../contract";
import { example } from "../../contract/fixtures";
import type { AnimalRow } from "../../db/repos/zoonosesRepo";
import { parseZoonosesDomains, type ZoonosesDomains } from "../zoonosesDomains";

export const TODAY_ZOO = "2026-11-24";

export const ZOO_DOMAINS: ZoonosesDomains = parseZoonosesDomains(example<ReferenceResponse>("reference-zoonoses.json").zoonoses_domains)!;
export const ZOO_LIMITS = ZOO_DOMAINS.limits;

export const animalBody = (over: Partial<AnimalBody> = {}): AnimalBody => ({
  id: "a7b8c9d0-e1f2-4a3b-8c4d-6e7f8a9b0c1d", version: 1, household_id: "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f", species: "dog", name: "Pipoca",
  sex: "female", size: "medium", coat: "Caramelo", breed: "SRD", birth_estimate_on: "2022-03-01", status: "active", neutered: false, tutor: null,
  community: true, last_rabies_vaccination_on: null, collar_due_on: null, has_microchip: false, ...over,
});

export const animalRow = (over: Partial<AnimalBody> = {}): AnimalRow => {
  const body = animalBody(over);
  return { key: body.id, id: body.id, client_uuid: null, household_key: body.household_id, species: body.species, status: body.status, version: body.version, body };
};

export const leishSurvey = (over: Partial<LeishSurveyBody> = {}): LeishSurveyBody => ({
  id: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e", version: 1, name: "Inquérito do bairro", kind: "sample", household_ids: ["8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f"],
  starts_on: "2026-11-01", ends_on: "2026-12-15", ...over,
});
