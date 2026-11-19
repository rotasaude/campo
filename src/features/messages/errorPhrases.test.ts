import { KNOWN_HTTP_ERRORS, KNOWN_ITEM_ERRORS } from "../../contract";
import { VECTOR_ERRORS, VECTOR_ERROR_CODES, type VectorErrorCode } from "../../rules/vectorErrors";
import { ERROR_PHRASES, SHARED_24C_CODES, phraseFor } from "./errorPhrases";

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
