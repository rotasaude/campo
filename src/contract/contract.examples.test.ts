import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_HTTP_ERRORS, KNOWN_ITEM_ERRORS, type ReferenceResponse, type SessionResponse, type UploadRequest } from "./index";
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
