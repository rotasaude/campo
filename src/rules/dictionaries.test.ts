import type { ReferenceResponse } from "../contract";
import { example } from "../contract/fixtures";
import { ReferenceShapeError, dictLabel, parseRegistrationDictionaries } from "./dictionaries";

const REFERENCE = example<ReferenceResponse>("reference.json");
const RAW = REFERENCE.registration_dictionaries as unknown as { version: string; domains: Record<string, unknown>; sections: Record<string, unknown> };
const STRINGS = REFERENCE.string_domains;

// The shape the api sends for a section (FieldSync::Reference.fields): the dashboard generator's, in YAML order.
const SECTIONS = {
  living_conditions: [
    { key: "abastecimento_de_agua", ledi: "abastecimentoAgua", type: "code", domain: "abastecimento_de_agua" },
    { key: "nu_comodos", ledi: "nuComodos", type: "count", min: 0, max: 99 },
    { key: "animais", ledi: "animaisNoDomicilio", type: "codes", domain: "renda_familiar", max_items: 5 },
    { key: "instituicao", ledi: "instituicaoPermanencia", type: "object", fields: [{ key: "nome", ledi: "nomeInstituicaoPermanencia", type: "name", max: 100, required: true }] },
  ],
};
const parse = (over: Record<string, unknown> = {}, strings: unknown = STRINGS) => parseRegistrationDictionaries({ ...RAW, sections: SECTIONS, ...over }, strings);

test("keeps LEDI order of a domain sent as a list", () => {
  const dict = parse();
  expect(dict.domains.abastecimento_de_agua.map((d) => d.code).slice(0, 3)).toEqual([117, 214, 118]);
  expect(dict.domains.renda_familiar).toEqual([{ code: 3, label: "1/2 a 1 salário mínimo" }]);
  expect(dict.stringDomains.uf).toEqual([{ code: "41", label: "PARANÁ" }]);
  expect(dict.stringDomains.tipo_logradouro).toEqual([{ code: "081", label: "RUA" }]);
});

test("sections keep their fields in order, nested objects included; a section the reference does not bring is empty", () => {
  const dict = parse();
  expect(dict.sections.living_conditions.map((f) => [f.key, f.type])).toEqual([
    ["abastecimento_de_agua", "code"], ["nu_comodos", "count"], ["animais", "codes"], ["instituicao", "object"],
  ]);
  expect(dict.sections.living_conditions[1]).toEqual({ key: "nu_comodos", ledi: "nuComodos", type: "count", min: 0, max: 99 });
  expect(dict.sections.living_conditions[3].fields).toEqual([{ key: "nome", ledi: "nomeInstituicaoPermanencia", type: "name", max: 100, required: true }]);
  expect(dict.sections.identification).toEqual([]);
  expect(Object.keys(dict.sections).sort()).toEqual(["health_conditions", "identification", "living_conditions", "sociodemographic", "street_situation"]);
});

test("the contract's own example is read", () => {
  const dict = parseRegistrationDictionaries(RAW, STRINGS);
  expect(dict.sections.living_conditions).toEqual([]);
  expect(Object.keys(dict.domains).sort()).toEqual(["abastecimento_de_agua", "renda_familiar"]);
});

test("a domain sent as an object is refused (Q27): JavaScript would reorder its integer keys", () => {
  expect(() => parse({ domains: { ...RAW.domains, abastecimento_de_agua: { 117: "Rede", 214: "Poço" } } })).toThrow(ReferenceShapeError);
});

test.each<[string, Record<string, unknown>]>([
  ["domains missing", { domains: undefined }],
  ["domain entry without label", { domains: { x: [{ code: 1 }] } }],
  ["domain code that is not an integer", { domains: { x: [{ code: "1", label: "a" }] } }],
  ["sections not an object", { sections: [] }],
  ["unknown section", { sections: { ...SECTIONS, novidade: [] } }],
  ["field of unknown type", { sections: { living_conditions: [{ key: "x", ledi: "x", type: "geo" }] } }],
  ["field with an unknown rule", { sections: { living_conditions: [{ key: "x", ledi: "x", type: "text", pattern: "^a" }] } }],
  ["field without key", { sections: { living_conditions: [{ ledi: "x", type: "text" }] } }],
  ["field naming a domain that is not there", { sections: { living_conditions: [{ key: "x", ledi: "x", type: "code", domain: "nao_existe" }] } }],
  ["object field without fields", { sections: { living_conditions: [{ key: "x", ledi: "x", type: "object" }] } }],
  ["max that is not a number", { sections: { living_conditions: [{ key: "x", ledi: "x", type: "count", max: "9" }] } }],
])("refuses: %s", (_name, over) => {
  expect(() => parse(over)).toThrow(ReferenceShapeError);
});

test("string domains must be the two lists of text codes", () => {
  expect(() => parse({}, { uf: STRINGS.uf })).toThrow(ReferenceShapeError);
  expect(() => parse({}, { ...STRINGS, uf: [{ code: 41, label: "PARANÁ" }] })).toThrow(ReferenceShapeError);
  expect(() => parse({}, null)).toThrow(ReferenceShapeError);
});

test("a refusal says where, never what the value was", () => {
  try {
    parse({ domains: { segredo: [{ code: 1, label: 42 }] } });
    throw new Error("expected ReferenceShapeError");
  } catch (err) {
    expect(err).toBeInstanceOf(ReferenceShapeError);
    expect((err as Error).message).toContain("domains.segredo");
  }
});

test("dictLabel: the label of a code, the code itself when unknown, a dash when there is none", () => {
  const dict = parse();
  expect(dictLabel(dict, "abastecimento_de_agua", 118)).toBe("Cisterna");
  expect(dictLabel(dict, "uf", "41")).toBe("PARANÁ");
  expect(dictLabel(dict, "abastecimento_de_agua", 999)).toBe("999");
  expect(dictLabel(dict, "nao_existe", 1)).toBe("1");
  expect(dictLabel(dict, "uf", null)).toBe("—");
});
