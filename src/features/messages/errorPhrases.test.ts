import { KNOWN_HTTP_ERRORS, KNOWN_ITEM_ERRORS } from "../../contract";
import { ERROR_PHRASES, phraseFor } from "./errorPhrases";

test("every known http and item code has its own phrase", () => {
  for (const code of [...KNOWN_HTTP_ERRORS, ...KNOWN_ITEM_ERRORS]) expect([code, Boolean(ERROR_PHRASES[code])]).toEqual([code, true]);
});

test("no phrase for a code the contract does not have", () => {
  const known = new Set([...KNOWN_HTTP_ERRORS, ...KNOWN_ITEM_ERRORS]);
  expect(Object.keys(ERROR_PHRASES).filter((code) => !known.has(code))).toEqual([]);
});

test("phrases never echo values", () => {
  for (const phrase of Object.values(ERROR_PHRASES)) {
    expect(phrase).not.toMatch(/\$\{|%s/);
    expect(phrase).toMatch(/^[A-ZÁÉÍÓÚ].*\.$/);
  }
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
