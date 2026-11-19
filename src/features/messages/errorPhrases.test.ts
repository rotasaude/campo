import { KNOWN_HTTP_ERRORS, KNOWN_ITEM_ERRORS } from "../../contract";
import { VECTOR_ERRORS, VECTOR_ERROR_CODES, type VectorErrorCode } from "../../rules/vectorErrors";
import { ERROR_PHRASES, SHARED_24C_CODES, phraseFor, phraseForItem } from "./errorPhrases";

// The 35a item codes take the dashboard's phrase as it is (lowercase, no period): the app does not write them (Q9).
const VECTOR_ITEM_CODES = new Set<string>(VECTOR_ERROR_CODES.filter((code) => KNOWN_ITEM_ERRORS.includes(code) && !SHARED_24C_CODES.includes(code)));

test("every known http and item code has its own phrase", () => {
  for (const code of [...KNOWN_HTTP_ERRORS, ...KNOWN_ITEM_ERRORS]) expect([code, Boolean(ERROR_PHRASES[code])]).toEqual([code, true]);
});

test("no phrase for a code the contract does not have", () => {
  const known = new Set([...KNOWN_HTTP_ERRORS, ...KNOWN_ITEM_ERRORS]);
  expect(Object.keys(ERROR_PHRASES).filter((code) => !known.has(code))).toEqual([]);
});

test("phrases never echo values", () => {
  for (const [code, phrase] of Object.entries(ERROR_PHRASES)) {
    expect(phrase).not.toMatch(/\$\{|%s/);
    if (!VECTOR_ITEM_CODES.has(code)) expect(phrase).toMatch(/^[A-ZÁÉÍÓÚ].*\.$/);
  }
});

// The brief's test, over the codes new in v1.3.0: cbo_not_allowed, feature_disabled and invalid_transition were already
// 24c codes (registry, home visit, HTTP) and keep the 24c phrase, which the table keys by code alone.
test("vector item codes use VECTOR_ERRORS", () => {
  for (const code of VECTOR_ERROR_CODES) if (KNOWN_ITEM_ERRORS.includes(code) && !SHARED_24C_CODES.includes(code)) expect(ERROR_PHRASES[code]).toBe(VECTOR_ERRORS[code]);
  expect(VECTOR_ITEM_CODES.size).toBe(21);
});

test("the codes the 35a shares with the 24c keep the 24c phrase", () => {
  expect([...SHARED_24C_CODES].sort()).toEqual(["cbo_not_allowed", "feature_disabled", "invalid_transition"]);
  for (const code of SHARED_24C_CODES) expect(ERROR_PHRASES[code]).not.toBe(VECTOR_ERRORS[code as VectorErrorCode]);
  expect(phraseFor("invalid_transition")).toBe("Esta ação não vale para a situação atual do cadastro (já saiu ou recusou).");
});

test("the suspended device and the replaced one read the same (Q17)", () => {
  expect(phraseFor("device_suspended")).toBe("Acesso suspenso: procure o enfermeiro da equipe ou leia o QR novo.");
  expect(phraseFor("invalid_token")).toBe(phraseFor("device_suspended"));
});

test("unknown code: the fixed phrase with the code, and nothing that is not a code", () => {
  expect(phraseFor("disk_full")).toBe("O Rota Saúde recusou este registro (código disk_full). Fale com o enfermeiro da equipe.");
  expect(phraseFor(null)).toBe("O Rota Saúde recusou este registro (código desconhecido). Fale com o enfermeiro da equipe.");
  expect(phraseFor(undefined)).toContain("código desconhecido");
  expect(phraseFor("Maria das Dores, CPF 123")).toContain("código desconhecido");
  expect(phraseFor("constructor")).toContain("código constructor"); // not an inherited property of the table
});

// Review of Task 6: a code the 35a shares with the 24c reads by the item it came on. The bulletin refused by the server
// comes on a home_visit with a `path` under vector_inspection; the 24b's own refusals of the same codes come with none.
describe("phraseForItem", () => {
  test("ovitrap items take VECTOR_ERRORS, shared codes included", () => {
    for (const type of ["ovitrap_installation", "ovitrap_collection"] as const) {
      expect(phraseForItem("cbo_not_allowed", { type, path: null })).toBe(VECTOR_ERRORS.cbo_not_allowed);
      expect(phraseForItem("feature_disabled", { type, path: null })).toBe(VECTOR_ERRORS.feature_disabled);
      expect(phraseForItem("ovitrap_number_taken", { type, path: "number" })).toBe(VECTOR_ERRORS.ovitrap_number_taken);
    }
  });

  test("a home_visit refused at vector_inspection or under it takes VECTOR_ERRORS", () => {
    expect(phraseForItem("feature_disabled", { type: "home_visit", path: "vector_inspection" })).toBe(VECTOR_ERRORS.feature_disabled);
    expect(phraseForItem("cbo_not_allowed", { type: "home_visit", path: "vector_inspection" })).toBe(VECTOR_ERRORS.cbo_not_allowed);
    expect(phraseForItem("product_not_allowed", { type: "home_visit", path: "vector_inspection.measures[0].vector_product_id" })).toBe(VECTOR_ERRORS.product_not_allowed);
    expect(phraseForItem("feature_disabled", { type: "home_visit", path: "vector_inspection" })).not.toBe(ERROR_PHRASES.feature_disabled);
  });

  test("a home_visit with no path, or out of the bulletin, keeps the 24c phrase (the 24b's cbo_not_allowed)", () => {
    expect(phraseForItem("cbo_not_allowed", { type: "home_visit", path: null })).toBe(ERROR_PHRASES.cbo_not_allowed);
    expect(phraseForItem("feature_disabled", { type: "home_visit", path: null })).toBe(ERROR_PHRASES.feature_disabled);
    expect(phraseForItem("reason_not_allowed", { type: "home_visit", path: "reasons[0]" })).toBe(ERROR_PHRASES.reason_not_allowed);
    // A path that only starts with the same letters is not the bulletin.
    expect(phraseForItem("cbo_not_allowed", { type: "home_visit", path: "vector_inspection_id" })).toBe(ERROR_PHRASES.cbo_not_allowed);
  });

  test("invalid_transition keeps the 24c phrase on any item", () => {
    for (const [type, path] of [["ovitrap_collection", null], ["home_visit", "vector_inspection"], ["household", "status"]] as const) {
      expect(phraseForItem("invalid_transition", { type, path })).toBe(ERROR_PHRASES.invalid_transition);
    }
  });

  test("the 403 of the whole request keeps the 24c phrase", () => {
    expect(phraseFor("feature_disabled")).toBe("A visita domiciliar pelo app está desligada nesta cidade. Seus registros ficam guardados no tablet.");
  });

  test("the 24c items and codes outside VECTOR_ERRORS read as phraseFor", () => {
    expect(phraseForItem("cbo_not_allowed", { type: "household", path: null })).toBe(ERROR_PHRASES.cbo_not_allowed);
    expect(phraseForItem("not_found", { type: "ovitrap_collection", path: "ovitrap_client_uuid" })).toBe(ERROR_PHRASES.not_found);
    expect(phraseForItem("no_such_code", { type: "ovitrap_installation", path: null })).toBe(phraseFor("no_such_code"));
    expect(phraseForItem(null, { type: "home_visit", path: null })).toBe(phraseFor(null));
  });
});
