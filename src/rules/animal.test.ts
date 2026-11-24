import { animalProblems, collarDueOn, collarProblems, collectionProblems, emptyAnimalDraft, productProblems, vaccinationProblems, type AnimalDraft } from "./animal";
import { ZOONOSES_ERRORS } from "./zoonosesErrors";
import { TODAY_ZOO, ZOO_DOMAINS, ZOO_LIMITS, animalRow, leishSurvey } from "./testing/zoonosesFixtures";

const draft = (over: Partial<AnimalDraft> = {}): AnimalDraft => ({ ...emptyAnimalDraft(), species: "dog", sex: "female", ...over });
const problems = (over: Partial<AnimalDraft> = {}) => animalProblems(draft(over), ZOO_LIMITS, TODAY_ZOO);

describe("animalProblems", () => {
  test("a draft with a species and a sex and nothing else is valid: no tutor and no community is fine (Q22)", () => {
    expect(problems()).toEqual([]);
    expect(problems({ tutorKey: null, community: false })).toEqual([]);
    expect(problems({ tutorKey: "p1" })).toEqual([]);
    expect(problems({ community: true })).toEqual([]);
  });

  test("the empty draft asks for the species and the sex, in the dashboard's words", () => {
    expect(animalProblems(emptyAnimalDraft(), ZOO_LIMITS, TODAY_ZOO)).toEqual([
      { code: null, path: "species", text: "escolha a espécie" }, { code: null, path: "sex", text: "escolha o sexo" },
    ]);
  });

  test.each([["98514100012345", false], ["985141000123456", true], ["98514100012345a", false], ["985141000123 56", false]])("microchip %s valid = %s", (microchip, valid) => {
    expect(problems({ microchip })).toEqual(valid ? [] : [{ code: null, path: "microchip", text: "microchip: 15 dígitos, sem espaço" }]);
  });

  test("a blank microchip is absent (the edit sends none)", () => {
    expect(problems({ microchip: "" })).toEqual([]);
    expect(problems({ microchip: "  " })).toEqual([]);
  });

  test("name, coat and breed stay inside the limits of the reference; blank is absent", () => {
    expect(problems({ name: "a".repeat(ZOO_LIMITS.name_max), coat: "b".repeat(ZOO_LIMITS.coat_max), breed: "c".repeat(ZOO_LIMITS.breed_max) })).toEqual([]);
    expect(problems({ name: "a".repeat(ZOO_LIMITS.name_max + 1) })).toEqual([{ code: null, path: "name", text: `escreva de 1 a ${ZOO_LIMITS.name_max} caracteres` }]);
    expect(problems({ coat: "b".repeat(ZOO_LIMITS.coat_max + 1) }).map((p) => p.path)).toEqual(["coat"]);
    expect(problems({ breed: "c".repeat(ZOO_LIMITS.breed_max + 1) }).map((p) => p.path)).toEqual(["breed"]);
    expect(problems({ name: "   ", coat: "", breed: " " })).toEqual([]);
    expect(animalProblems(draft({ name: "abcd" }), { ...ZOO_LIMITS, name_max: 3 }, TODAY_ZOO)[0].text).toBe("escreva de 1 a 3 caracteres");
  });

  test("the birth month is AAAA-MM and not after today's month", () => {
    expect(problems({ birthEstimateMonth: "2026-11" })).toEqual([]);
    expect(problems({ birthEstimateMonth: "2019-01" })).toEqual([]);
    expect(problems({ birthEstimateMonth: "2026-12" })).toEqual([{ code: "date_out_of_range", path: "birth_estimate_month", text: ZOONOSES_ERRORS.date_out_of_range }]);
    expect(problems({ birthEstimateMonth: "2026-13" })).toEqual([{ code: null, path: "birth_estimate_month", text: "informe uma data válida" }]);
    expect(problems({ birthEstimateMonth: "2026-11-01" }).map((p) => p.path)).toEqual(["birth_estimate_month"]);
  });

  test("tutor with community true is refused at tutor_patient_id; no tutor and no community is fine (Q22)", () => {
    expect(problems({ tutorKey: "p1", community: true })).toEqual([{ code: null, path: "tutor_patient_id", text: "animal comunitário não tem tutor — tire um dos dois" }]);
    expect(problems({ tutorKey: null, community: false })).toEqual([]);
  });
});

describe("vaccinationProblems", () => {
  const none = { adverseEvent: false, adverseNote: null };

  test("a cat is fine; a dog is fine; the other species is refused", () => {
    expect(vaccinationProblems(animalRow({ species: "cat" }), ZOO_DOMAINS, none)).toEqual([]);
    expect(vaccinationProblems(animalRow({ species: "dog" }), ZOO_DOMAINS, none)).toEqual([]);
    expect(vaccinationProblems(animalRow({ species: "other" }), ZOO_DOMAINS, none)).toEqual([{ code: null, path: "animal_id", text: "escolha a espécie: cão ou gato" }]);
  });

  test("no open campaign → campaign_not_open at campaign_id, with the dashboard's phrase", () => {
    expect(ZOO_DOMAINS.open_campaign).not.toBeNull();
    expect(vaccinationProblems(animalRow(), { ...ZOO_DOMAINS, open_campaign: null }, none)).toEqual([
      { code: "campaign_not_open", path: "campaign_id", text: "a campanha não está aberta" },
    ]);
  });

  test("an animal that is not active → animal_not_active at animal_id", () => {
    expect(vaccinationProblems(animalRow({ status: "deceased" }), ZOO_DOMAINS, none)).toEqual([
      { code: "animal_not_active", path: "animal_id", text: "o animal não está ativo" },
    ]);
  });

  test("adverse_note without adverse_event is refused; with it, under the limit (or over) is refused", () => {
    const row = animalRow();
    expect(vaccinationProblems(row, ZOO_DOMAINS, { adverseEvent: false, adverseNote: "inchaço no local" })).toEqual([
      { code: null, path: "adverse_note", text: "a nota só vale com evento adverso" },
    ]);
    expect(vaccinationProblems(row, ZOO_DOMAINS, { adverseEvent: false, adverseNote: "  " })).toEqual([]);
    const { adverse_note_min: min, adverse_note_max: max } = ZOO_LIMITS;
    expect(vaccinationProblems(row, ZOO_DOMAINS, { adverseEvent: true, adverseNote: "a".repeat(min - 1) })).toEqual([
      { code: null, path: "adverse_note", text: `escreva de ${min} a ${max} caracteres` },
    ]);
    expect(vaccinationProblems(row, ZOO_DOMAINS, { adverseEvent: true, adverseNote: null }).map((p) => p.path)).toEqual(["adverse_note"]);
    expect(vaccinationProblems(row, ZOO_DOMAINS, { adverseEvent: true, adverseNote: "a".repeat(max + 1) }).map((p) => p.path)).toEqual(["adverse_note"]);
    expect(vaccinationProblems(row, ZOO_DOMAINS, { adverseEvent: true, adverseNote: "a".repeat(min) })).toEqual([]);
  });

  test("the second dose in the same campaign is not checked here (Q19)", () => {
    const vaccinated = animalRow({ last_rabies_vaccination_on: ZOO_DOMAINS.open_campaign!.starts_on });
    expect(vaccinationProblems(vaccinated, ZOO_DOMAINS, none)).toEqual([]);
  });
});

describe("collarProblems and collectionProblems", () => {
  test("collar and collection on a cat → animal_not_dog at animal_id", () => {
    const cat = animalRow({ species: "cat" });
    const refused = [{ code: "animal_not_dog", path: "animal_id", text: "coleta de sorologia e coleira são só para cão" }];
    expect(collarProblems(cat)).toEqual(refused);
    expect(collectionProblems(cat, null, [])).toEqual(refused);
  });

  test("a dog that is not active → animal_not_active; an active dog is fine", () => {
    expect(collarProblems(animalRow({ status: "missing" })).map((p) => p.code)).toEqual(["animal_not_active"]);
    expect(collectionProblems(animalRow({ status: "transferred" }), null, []).map((p) => p.code)).toEqual(["animal_not_active"]);
    expect(collarProblems(animalRow())).toEqual([]);
    expect(collectionProblems(animalRow(), null, [])).toEqual([]);
  });

  test("a survey the tablet no longer has → survey_not_open at leish_survey_id; a standalone collection has none to check", () => {
    const survey = leishSurvey();
    expect(collectionProblems(animalRow(), survey.id, [survey])).toEqual([]);
    expect(collectionProblems(animalRow(), "gone", [survey])).toEqual([{ code: "survey_not_open", path: "leish_survey_id", text: "o inquérito não está aberto" }]);
    expect(collectionProblems(animalRow(), null, [survey])).toEqual([]);
  });
});

test("no phrase of these rules carries a value (name, microchip)", () => {
  const out = [
    ...animalProblems(draft({ name: "Rex".repeat(40), microchip: "98514100012345", tutorKey: "p-9f2", community: true }), ZOO_LIMITS, TODAY_ZOO),
    ...vaccinationProblems(animalRow({ name: "Pipoca" }), ZOO_DOMAINS, { adverseEvent: false, adverseNote: "Pipoca inchou" }),
  ];
  expect(out.length).toBeGreaterThan(2);
  for (const p of out) expect(p.text).not.toMatch(/Rex|Pipoca|98514100012345|p-9f2|inchou/);
});

// Task 7: placed_on + collar_months, in calendar months, on the day that exists (31 → the month's last day).
test.each([
  ["2026-08-31", 6, "2027-02-28"], ["2027-08-31", 6, "2028-02-29"], ["2026-01-31", 1, "2026-02-28"], ["2026-03-15", 12, "2027-03-15"],
  ["2026-11-24", 6, "2027-05-24"], ["2026-12-31", 3, "2027-03-31"],
])("collarDueOn(%s, %i) = %s", (placedOn, months, due) => {
  expect(collarDueOn(placedOn, months)).toBe(due);
});

// The dashboard's phrases for a missing product (VaccinationForm and CollarsPanel, main 51b1871).
test("a product must be chosen, in the dashboard's words", () => {
  expect(productProblems("", "rabies_vaccine")).toEqual([{ code: null, path: "vector_product_id", text: "escolha o produto" }]);
  expect(productProblems("", "collar")).toEqual([{ code: null, path: "vector_product_id", text: "escolha a coleira" }]);
  expect(productProblems("e1f2a3b4-c5d6-4e7f-8a9b-1c2d3e4f5a6b", "collar")).toEqual([]);
});
