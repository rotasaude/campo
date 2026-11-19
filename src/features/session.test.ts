import type { ReferenceResponse, SessionResponse } from "../contract";
import { example } from "../contract/fixtures";
import { parseReference } from "../sync/reference";
import { canEditRegistry, canRecordInspection, vectorControlOn } from "./session";

const ACE = example<SessionResponse>("session-endemic-agent.json");
const ACS = example<SessionResponse>("session-acs.json");
const WITH_DOMAINS = parseReference(example<ReferenceResponse>("reference-vector-control.json"));
const WITHOUT_DOMAINS = parseReference(example<ReferenceResponse>("reference.json"));

function sessionOf(cbo: string, vectorControl: boolean | undefined): SessionResponse {
  const { vector_control: _off, ...features } = ACE.features;
  return { ...ACE, professional: { ...ACE.professional, cbo },
    features: vectorControl === undefined ? features : { ...features, vector_control: vectorControl } };
}

test("canRecordInspection: ACE with the switch and the domains → true", () => {
  expect(ACE.professional.cbo).toBe("515140");
  expect(ACE.features.vector_control).toBe(true);
  expect(canRecordInspection(ACE, WITH_DOMAINS)).toBe(true);
  expect(canRecordInspection(sessionOf("515140", true), WITH_DOMAINS)).toBe(true);
  // Nothing loaded yet: no bulletin.
  expect(canRecordInspection(null, WITH_DOMAINS)).toBe(false);
  expect(canRecordInspection(ACE, null)).toBe(false);
});

test.each([["515105", true, true], ["515140", false, true], ["515140", true, false], ["515140", undefined, true]])(
  "canRecordInspection(cbo %s, vector_control %s, domains %s) → false", (cbo, vectorControl, withDomains) => {
    expect(canRecordInspection(sessionOf(cbo as string, vectorControl as boolean | undefined), withDomains ? WITH_DOMAINS : WITHOUT_DOMAINS)).toBe(false);
  });

test("vectorControlOn is only features.vector_control === true; the ACS sees nothing new", () => {
  expect(vectorControlOn(ACE)).toBe(true);
  expect(vectorControlOn(sessionOf("515140", false))).toBe(false);
  expect(vectorControlOn(sessionOf("515140", undefined))).toBe(false);
  expect(vectorControlOn(null)).toBe(false);
  expect(vectorControlOn(ACS)).toBe(false);
  expect(canRecordInspection(ACS, WITH_DOMAINS)).toBe(false);
  expect(canRecordInspection({ ...ACS, features: { ...ACS.features, vector_control: true } }, WITH_DOMAINS)).toBe(false);
  // The registry rule of the 24c does not change.
  expect(canEditRegistry(ACS)).toBe(true);
  expect(canEditRegistry(ACE)).toBe(false);
});
