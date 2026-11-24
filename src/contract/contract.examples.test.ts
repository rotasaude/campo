import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_HTTP_ERRORS, KNOWN_ITEM_ERRORS, type ChangesResponse, type ReferenceResponse, type SessionResponse, type UploadRequest, type UploadResponse } from "./index";
import { example } from "./fixtures";
import { expectValid, type SchemaName } from "./validate";

type Suite = { schema: string; cases: { file: string; expect: string }[] };
const manifest = JSON.parse(readFileSync(join(__dirname, "../../contracts/field-sync/examples/manifest.json"), "utf8")) as { suites: Suite[] };
const cases = manifest.suites.flatMap((suite) =>
  suite.cases.map((c) => [suite.schema.replace(/-v1\.json$/, "") as SchemaName, c.file, c.expect] as const));

test("the manifest covers the five schemas", () => {
  expect([...new Set(cases.map(([schema]) => schema))].sort()).toEqual(
    ["changes-response", "reference-response", "session-response", "upload-request", "upload-response"]);
  expect(cases.length).toBeGreaterThanOrEqual(168);
});

// Same verdict as the contract's own checker (json_schemer in the api): valid passes, anything else is refused.
test.each(cases)("%s %s", (schema, file, expected) => {
  const run = () => expectValid(schema, example(file));
  if (expected === "valid") expect(run).not.toThrow();
  else expect(run).toThrow();
});

test("a refusal names pointers and keywords, never the value", () => {
  const body = example<SessionResponse>("session-acs.json");
  const tampered = { ...body, contract: "segredo-do-teste" };
  expect(() => expectValid("session-response", tampered)).toThrow(/\/contract const/);
  expect(() => expectValid("session-response", tampered)).not.toThrow(/segredo-do-teste/);
});

test("session example carries map and reference_version", () => {
  const s = example<SessionResponse>("session-acs.json");
  expect(s.reference_version).toMatch(/^[0-9a-f]{64}$/);
  expect(s.map?.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(example<SessionResponse>("session-without-map.json").map).toBeNull();
});

test("Ajv agrees with json_schemer on 8 decimals (Q49)", () => {
  const request = example<UploadRequest>("upload-household-location.json");
  const withLatitude = (latitude: number): unknown => {
    const copy = JSON.parse(JSON.stringify(request)) as { items: { body: { location: { latitude: number } } }[] };
    copy.items[0].body.location.latitude = latitude;
    return copy;
  };
  expect(() => expectValid("upload-request", withLatitude(-25.42847123))).not.toThrow();
  expect(() => expectValid("upload-request", withLatitude(-25.428471234))).toThrow();
});

test("http error list carries the 24c codes (Q8)", () => {
  expect(KNOWN_HTTP_ERRORS).toEqual(expect.arrayContaining(
    ["device_suspended", "map_not_found", "range_not_satisfiable", "unknown_city", "city_suspended", "city_schema_behind"]));
});

test("item error list carries the 24c codes", () => {
  expect(KNOWN_ITEM_ERRORS).toEqual(expect.arrayContaining(["invalid_location", "family_not_found", "cpf_or_reason_required"]));
});

// field-sync-v1.3.0 (35a): everything new is optional, and the boletim is closed.
test("session without vector_control is valid (optional key)", () => {
  const s = example<SessionResponse>("session-acs.json");
  expect(s.features).not.toHaveProperty("vector_control");
  expect(() => expectValid("session-response", s)).not.toThrow();
  expect(example<SessionResponse>("session-endemic-agent.json").features.vector_control).toBe(true);
});

test("home_visit with vector_inspection, ovitrap_installation and ovitrap_collection examples validate", () => {
  const files = ["upload-home-visit-vector-inspection.json", "upload-ovitrap-installation.json", "upload-ovitrap-collection.json"];
  const types = files.flatMap((file) => {
    const request = example<UploadRequest>(file);
    expect(() => expectValid("upload-request", request)).not.toThrow();
    return request.items.map((item) => item.type);
  });
  expect(types).toEqual(expect.arrayContaining(["home_visit", "ovitrap_installation", "ovitrap_collection"]));
});

test("vector_inspection is closed: an unknown key is refused", () => {
  expect(() => expectValid("upload-request", example("invalid-vector-inspection-recovered-in-body.json")))
    .toThrow(/\/items\/0\/body\/vector_inspection/);
});

// The brief names reference.json; in the tag the limits live in reference-vector-control.json
// (reference.json has no vector_control_domains, which is optional).
test("reference limits carry the Q7 keys", () => {
  expect(Object.keys(example<ReferenceResponse>("reference-vector-control.json").vector_control_domains!.limits).sort())
    .toEqual(["charges_max", "deposit_count_max", "larvae_collected_max", "measures_max", "samples_max"]);
});

test("the new item codes are in errors.item", () => {
  expect(KNOWN_ITEM_ERRORS).toEqual(expect.arrayContaining(["situation_outcome_mismatch", "inspection_not_worked", "activity_property_mismatch",
    "liraa_item_not_found", "transmission_block_not_active", "deposit_counts_inconsistent", "product_not_allowed", "samples_exceed_larvae",
    "inspection_times_invalid", "reason_derived", "block_already_set", "household_without_block", "consent_required",
    "ovitrap_number_taken", "collection_out_of_range", "reading_not_open", "ovitrap_not_active", "vector_inspection_invalid", "sample_label_taken"]));
});

// field-sync-v1.4.0 (35b): zoonoses. Everything new is optional.
test("session and reference of v1.3.0 stay valid without the zoonoses keys", () => {
  const session = example<SessionResponse>("session-endemic-agent.json");
  expect(session.features).not.toHaveProperty("zoonoses");
  expect(() => expectValid("session-response", session)).not.toThrow();
  const reference = example<ReferenceResponse>("reference-vector-control.json");
  expect(reference).not.toHaveProperty("zoonoses_domains");
  expect(() => expectValid("reference-response", reference)).not.toThrow();
  expect(example<SessionResponse>("session-zoonoses-agent.json").features.zoonoses).toBe(true);
});

test("animal, rabies_vaccination, leish_collection and collar examples validate; each invalid example is refused", () => {
  const valid = ["upload-animal-new.json", "upload-animal-update.json", "upload-animal-community.json", "upload-rabies-vaccination.json",
    "upload-leish-collection.json", "upload-leish-collection-off-survey.json", "upload-collar.json", "upload-zoonoses-same-batch.json"];
  const types = valid.flatMap((file) => {
    const request = example<UploadRequest>(file);
    expect(() => expectValid("upload-request", request)).not.toThrow();
    return request.items.map((item) => item.type);
  });
  expect(types).toEqual(expect.arrayContaining(["animal", "rabies_vaccination", "leish_collection", "collar"]));
  const invalid = ["invalid-animal-microchip-14-digits.json", "invalid-animal-microchip-on-update.json", "invalid-animal-community-with-tutor.json",
    "invalid-animal-status-on-create.json", "invalid-rabies-vaccination-note-without-event.json", "invalid-leish-collection-dpp-without-date.json",
    "invalid-collar-due-on-in-body.json"];
  for (const file of invalid) expect(() => expectValid("upload-request", example(file))).toThrow();
});

test("the animal change body has has_microchip and no microchip key", () => {
  const page = example<ChangesResponse>("changes-zoonoses-page.json");
  expect(() => expectValid("changes-response", page)).not.toThrow();
  const animal = page.items.find((i) => i.type === "animal")!.body;
  expect(animal).toHaveProperty("has_microchip");
  expect(Object.keys(animal)).not.toContain("microchip");
  expect(() => expectValid("changes-response", example("invalid-changes-animal-with-microchip.json"))).toThrow();
});

test("leish_survey carries household_ids (Q21)", () => {
  const page = example<ChangesResponse>("changes-zoonoses-page.json");
  const survey = page.items.find((i) => i.type === "leish_survey")!.body as { household_ids: string[] };
  expect(Array.isArray(survey.household_ids)).toBe(true);
  expect(() => expectValid("changes-response", example("invalid-changes-leish-survey-without-household-ids.json"))).toThrow();
});

test("removals accept animal and leish_survey with out_of_scope", () => {
  const removals = example<ChangesResponse>("changes-zoonoses-removals.json");
  expect(() => expectValid("changes-response", removals)).not.toThrow();
  expect(removals.removals.map((r) => r.type)).toEqual(expect.arrayContaining(["animal", "leish_survey"]));
  expect(removals.removals.some((r) => r.reason === "out_of_scope")).toBe(true);
});

test("accepted animal carries version; leish_collection accepted and duplicate carry label", () => {
  const accepted = example<UploadResponse>("upload-response-zoonoses-accepted.json");
  expect(() => expectValid("upload-response", accepted)).not.toThrow();
  expect(accepted.results.some((r) => "version" in r && typeof r.version === "number")).toBe(true);
  expect(accepted.results.some((r) => "label" in r && /^LV-/.test(String(r.label)))).toBe(true);
  expect(() => expectValid("upload-response", example("invalid-response-animal-accepted-without-version.json"))).toThrow();
  expect(() => expectValid("upload-response", example("invalid-response-leish-collection-without-label.json"))).toThrow();
});

test("the zoonoses reference carries the limits and the product uses", () => {
  const reference = example<ReferenceResponse>("reference-zoonoses.json");
  expect(() => expectValid("reference-response", reference)).not.toThrow();
  expect(reference.zoonoses_domains).toBeDefined();
});

test("the new item codes are in errors.item", () => {
  expect(KNOWN_ITEM_ERRORS).toEqual(expect.arrayContaining(["microchip_taken", "registry_number_taken", "already_vaccinated_in_campaign",
    "campaign_not_open", "survey_not_open", "animal_not_dog", "animal_not_active", "date_out_of_range", "household_not_in_survey"]));
});
