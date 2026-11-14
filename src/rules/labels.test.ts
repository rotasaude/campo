import type { FieldSpec } from "./dictionaries";
import { SECTION_KEYS } from "./dictionaries";
import { sectionFieldLabel } from "./labels";
import { registrationDictionaries } from "./testing/dictionaries";

test("every field of the forms has its question; none shows its key", () => {
  const dict = registrationDictionaries();
  const missing: string[] = [];
  const walk = (section: (typeof SECTION_KEYS)[number], fields: FieldSpec[], prefix: string) => {
    for (const field of fields) {
      const key = prefix + field.key;
      if (sectionFieldLabel(section, key) === key) missing.push(`${section}.${key}`);
      if (field.fields) walk(section, field.fields, `${key}.`);
    }
  };
  for (const section of SECTION_KEYS) walk(section, dict.sections[section], "");
  expect(missing).toEqual([]);
});

test("a field the app does not know shows its key, never nothing", () => {
  expect(sectionFieldLabel("living_conditions", "campo_novo")).toBe("campo_novo");
  expect(sectionFieldLabel("living_conditions", "nu_moradores")).toBe("Número de moradores");
});
