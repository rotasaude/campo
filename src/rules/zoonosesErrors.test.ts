// Ported from apps/dashboard/src/lib/zoonosesErrors.test.ts (dashboard commit 51b1871); the dashboard's ombudsman
// cross-check is told in literals, since the app has no OMBUDSMAN_ERRORS.
import { ANIMAL_STAY_OPEN, FORWARDING_ALREADY_PENDING, ZOONOSES_DISABLED, ZOONOSES_ERROR_CODES, ZOONOSES_ERRORS, ZOONOSES_OMBUDSMAN_DISABLED } from "./zoonosesErrors";

describe("zoonosesErrors", () => {
  it("one phrase per code, none left over", () => {
    expect(Object.keys(ZOONOSES_ERRORS).sort()).toEqual([...ZOONOSES_ERROR_CODES].sort());
    expect(new Set(ZOONOSES_ERROR_CODES).size).toBe(ZOONOSES_ERROR_CODES.length);
  });

  it("distinct phrases, no underscore (never the raw code), more than 10 characters", () => {
    const phrases = ZOONOSES_ERROR_CODES.map((code) => ZOONOSES_ERRORS[code]);
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const p of phrases) {
      expect(p.includes("_")).toBe(false);
      expect(p.length).toBeGreaterThan(10);
    }
  });

  it("the codes of the field-sync items are there, with the dashboard's words", () => {
    for (const code of ["tutor_not_found", "product_not_allowed", "microchip_taken", "registry_number_taken", "already_vaccinated_in_campaign", "campaign_not_open",
      "survey_not_open", "animal_not_dog", "animal_not_active", "date_out_of_range", "household_not_in_survey", "animal_changed"]) {
      expect(ZOONOSES_ERROR_CODES as readonly string[]).toContain(code);
    }
    expect(ZOONOSES_ERRORS.microchip_taken).toBe("este microchip já está em outro animal da cidade");
    expect(ZOONOSES_ERRORS.already_vaccinated_in_campaign).toBe("este animal já foi vacinado nesta campanha");
    expect(ZOONOSES_ERRORS.animal_not_dog).toBe("coleta de sorologia e coleira são só para cão");
    expect(ZOONOSES_ERRORS.animal_changed).toBe("o animal mudou enquanto a tela estava aberta — os dados foram relidos; confira antes de repetir");
    expect(ZOONOSES_ERRORS.tutor_not_found).toBe("o tutor deste animal não foi encontrado — confira o cadastro do tutor");
    expect(ZOONOSES_ERRORS.product_not_allowed).toBe("este produto não vale para esta finalidade");
  });

  it("the fixed phrases, letter by letter", () => {
    expect(ZOONOSES_ERRORS.feature_disabled).toBe(ZOONOSES_DISABLED);
    expect(ZOONOSES_ERRORS.forwarding_already_pending).toBe(FORWARDING_ALREADY_PENDING);
    expect(FORWARDING_ALREADY_PENDING).toBe("Já existe um encaminhamento pendente para este destino.");
    expect(ZOONOSES_OMBUDSMAN_DISABLED).toBe("A ouvidoria está desligada nesta cidade.");
    expect(ANIMAL_STAY_OPEN).toBe("Feche a estada no canil antes de mudar a situação");
    expect(ZOONOSES_ERRORS.veterinarian_required).toBe("Só o médico veterinário com CRMV e vínculo na unidade de vigilância ambiental pode registrar esta ação.");
  });
});
