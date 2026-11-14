import { normalizeText } from "./text";

test("normalizeText('  Ána  Júlia ') === 'ana julia'", () => {
  expect(normalizeText("  Ána  Júlia ")).toBe("ana julia");
});

test("accents, cedilla, case and any run of white space go away; digits and punctuation stay", () => {
  expect(normalizeText("JOÃO  d'Ávila\tConceição\n")).toBe("joao d'avila conceicao");
  expect(normalizeText("Rua 7 de Setembro, nº 120")).toBe("rua 7 de setembro, nº 120");
  expect(normalizeText("")).toBe("");
  expect(normalizeText("   ")).toBe("");
});
