// Test support: the complete registration dictionaries, in the shape the field API serves them in
// /reference. The JSON was generated from the dashboard's territoryDictionaries.generated.ts (LEDI 8.7.0,
// dashboard main ceb53af), which comes from the same YAML of the api. The contract's `reference` example
// carries only an excerpt, too small for the rules' cases.
import { parseRegistrationDictionaries, type RegistrationDictionaries } from "../dictionaries";
import fixture from "./registrationDictionaries.json";

export const LEDI_VERSION: string = fixture.ledi_version;

export function registrationDictionaries(): RegistrationDictionaries {
  return parseRegistrationDictionaries(fixture.registration_dictionaries, fixture.string_domains);
}
