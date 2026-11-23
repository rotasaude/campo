import type { ReferenceResponse, SessionResponse } from "../contract";
import { example } from "../contract/fixtures";
import { parseReference } from "../sync/reference";
import { AGENT_PROPERTY_TYPES, agentRegistersNonResidential, canEditHousehold, canEditRegistry, canRecordInspection, vectorControlOn } from "./session";

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

// ── Q13(1): the endemic agent registers the non-residential properties of the micro-areas assigned to him ──
test("the agent's property types are the api's non-residential list (HomeVisits::Catalog::NON_RESIDENTIAL)", () => {
  expect(AGENT_PROPERTY_TYPES).toEqual(["2", "3", "4", "5", "6", "12", "13"]);
  expect(agentRegistersNonResidential(ACE)).toBe(true);
});

test.each([["2", true], ["4", true], ["13", true], ["1", false], ["7", false], ["99", false], [null, true]])(
  "canEditHousehold for the endemic agent, type %s → %s", (propertyType, allowed) => {
    expect(canEditHousehold(ACE, propertyType)).toBe(allowed);
  });

test("ACS keeps editing every type; the agent never edits families nor registrations (canEditRegistry false)", () => {
  for (const type of ["1", "2", "4", "7", "99", null]) expect(canEditHousehold(ACS, type)).toBe(true);
  expect(agentRegistersNonResidential(ACS)).toBe(false);
  expect(canEditRegistry(ACE)).toBe(false);
  // Another field CBO with the switch on (the TACS) registers nothing, as the api (cbo_not_allowed).
  expect(canEditHousehold(sessionOf("515130", true), "4")).toBe(false);
  expect(canEditHousehold(null, null)).toBe(false);
});

test("agent without vector_control or without territory_registry edits nothing", () => {
  for (const session of [sessionOf("515140", false), sessionOf("515140", undefined), { ...ACE, features: { ...ACE.features, territory_registry: false } }]) {
    expect(agentRegistersNonResidential(session)).toBe(false);
    expect(canEditHousehold(session, "4")).toBe(false);
    expect(canEditHousehold(session, null)).toBe(false);
  }
});
