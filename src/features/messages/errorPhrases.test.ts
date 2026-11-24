import { KNOWN_HTTP_ERRORS, KNOWN_ITEM_ERRORS } from "../../contract";
import { VECTOR_ERRORS, VECTOR_ERROR_CODES, type VectorErrorCode } from "../../rules/vectorErrors";
import type { ItemType } from "../../contract";
import { ZOONOSES_ERRORS, type ZoonosesErrorCode } from "../../rules/zoonosesErrors";
import { AGENT_CBO_NOT_ALLOWED, AGENT_HAS_RESIDENT, ERROR_PHRASES, SHARED_24C_CODES, phraseFor, phraseForItem, type ItemContext } from "./errorPhrases";

// The 35a item codes take the dashboard's phrase as it is (lowercase, no period): the app does not write them (Q9).
const VECTOR_ITEM_CODES = new Set<string>(VECTOR_ERROR_CODES.filter((code) => KNOWN_ITEM_ERRORS.includes(code) && !SHARED_24C_CODES.includes(code)));

// The 35b item codes take the dashboard's phrase as it is (lowercase, no period): the app does not write them (Q24).
const ZOONOSES_NEW = ["microchip_taken", "registry_number_taken", "already_vaccinated_in_campaign", "campaign_not_open", "survey_not_open",
  "animal_not_dog", "animal_not_active", "date_out_of_range", "household_not_in_survey", "tutor_not_found"] as const;

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
    if (!VECTOR_ITEM_CODES.has(code) && !(ZOONOSES_NEW as readonly string[]).includes(code)) expect(phrase).toMatch(/^[A-ZÁÉÍÓÚ].*\.$/);
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

// Q54 (docs 622c77a): the server's refusal of the endemic agent's household, in the dashboard's words. The api sends
// cbo_not_allowed with no path both for a residential type and for a property with an active resident
// (TerritoryRegistry::Access.endemic_scope, SaveHousehold#write): the tablet tells them apart by what it has.
describe("phraseForItem — the endemic agent's household (Q54)", () => {
  const household = { type: "household" as const, path: null };
  const agent = (over: Partial<ItemContext> = {}): ItemContext => ({ agent: true, propertyTypes: ["2", "2"], hasResident: false, ...over });

  test("the dashboard's phrases, byte for byte", () => {
    expect(AGENT_CBO_NOT_ALLOWED).toBe("só o ACS da microárea, enfermeiro ou médico da equipe grava o cadastro — o agente de endemias, só imóvel não residencial");
    expect(AGENT_HAS_RESIDENT).toBe("este imóvel tem morador ativo; só a equipe da APS edita");
  });

  test("cbo_not_allowed on a residential type, sent or current, says AGENT_CBO_NOT_ALLOWED — even with a resident", () => {
    expect(phraseForItem("cbo_not_allowed", household, agent({ propertyTypes: ["1", null] }))).toBe(AGENT_CBO_NOT_ALLOWED);
    // The clinic turned the shop into a home while the agent's edit waited: the type, not the resident (offline, the typical case).
    expect(phraseForItem("cbo_not_allowed", household, agent({ propertyTypes: ["2", "1"], hasResident: true }))).toBe(AGENT_CBO_NOT_ALLOWED);
  });

  test("cbo_not_allowed on a non-residential property with an active resident on the tablet says AGENT_HAS_RESIDENT", () => {
    expect(phraseForItem("cbo_not_allowed", household, agent({ hasResident: true }))).toBe(AGENT_HAS_RESIDENT);
    expect(phraseForItem("cbo_not_allowed", household, agent({ propertyTypes: ["4", null], hasResident: true }))).toBe(AGENT_HAS_RESIDENT);
  });

  test("cbo_not_allowed the tablet cannot explain says AGENT_CBO_NOT_ALLOWED, never AGENT_HAS_RESIDENT", () => {
    expect(phraseForItem("cbo_not_allowed", household, agent())).toBe(AGENT_CBO_NOT_ALLOWED);
    expect(phraseForItem("cbo_not_allowed", household, agent({ propertyTypes: [null, null] }))).toBe(AGENT_CBO_NOT_ALLOWED);
  });

  test("out_of_scope keeps the 24c phrase, and the other codes are untouched", () => {
    expect(phraseForItem("out_of_scope", household, agent({ hasResident: true }))).toBe(ERROR_PHRASES.out_of_scope);
    expect(phraseForItem("out_of_scope", household, agent())).toBe("Esta microárea não está mais no seu território.");
    expect(phraseForItem("not_found", { type: "household", path: "household_id" }, agent())).toBe(ERROR_PHRASES.not_found);
  });

  test("the agent's other items keep their phrases", () => {
    expect(phraseForItem("cbo_not_allowed", { type: "ovitrap_installation", path: null }, agent({ hasResident: true }))).toBe(VECTOR_ERRORS.cbo_not_allowed);
    expect(phraseForItem("cbo_not_allowed", { type: "family", path: null }, agent({ hasResident: true }))).toBe(ERROR_PHRASES.cbo_not_allowed);
  });

  test("the ACS and every other caller: the same phrase with or without a context, for every code and item", () => {
    const types: ItemType[] = ["home_visit", "home_visit_withdrawal", "collective_activity", "patient", "household", "family", "individual_registration", "ovitrap_installation", "ovitrap_collection"];
    const notAgent: ItemContext = { agent: false, propertyTypes: ["1", "1"], hasResident: true };
    for (const code of [...Object.keys(ERROR_PHRASES), "no_such_code"]) {
      for (const type of types) {
        for (const path of [null, "vector_inspection", "property_type"]) {
          const item = { type, path };
          expect([code, type, path, phraseForItem(code, item, notAgent)]).toEqual([code, type, path, phraseForItem(code, item)]);
        }
      }
    }
    expect(phraseForItem("cbo_not_allowed", household, notAgent)).toBe("Seu CBO não permite este registro.");
    expect(phraseForItem("cbo_not_allowed", household)).toBe("Seu CBO não permite este registro.");
  });
});

describe("the zoonoses items (35b, Q24)", () => {
  test("every zoonoses item code of the contract has the dashboard phrase", () => {
    for (const code of ZOONOSES_NEW) {
      expect(KNOWN_ITEM_ERRORS).toContain(code);
      expect(ERROR_PHRASES[code]).toBe(ZOONOSES_ERRORS[code as ZoonosesErrorCode]);
    }
  });

  test("the codes shared with the 24c keep the 24c phrase on every zoonoses item, as the contract fixes", () => {
    for (const type of ["animal", "rabies_vaccination", "leish_collection", "collar"] as const) {
      expect(phraseForItem("not_found", { type, path: "animal_client_uuid" })).toBe(ERROR_PHRASES.not_found);
      expect(phraseForItem("feature_disabled", { type, path: null })).toBe(ERROR_PHRASES.feature_disabled);
      expect(phraseForItem("cbo_not_allowed", { type, path: null })).toBe(ERROR_PHRASES.cbo_not_allowed);
      expect(phraseForItem("invalid_transition", { type, path: "status" })).toBe(ERROR_PHRASES.invalid_transition);
      expect(phraseForItem("client_uuid_conflict", { type, path: null })).toBe(ERROR_PHRASES.client_uuid_conflict);
    }
    expect(ERROR_PHRASES.client_uuid_conflict).toBe("Este registro já foi enviado com outro conteúdo. Confira os dados e grave de novo.");
  });

  test("phraseForItem: not_found on a collar keeps the 24c phrase; animal_not_dog on a collar is the zoonoses one", () => {
    expect(phraseForItem("not_found", { type: "collar", path: "animal_client_uuid" })).toBe(ERROR_PHRASES.not_found);
    expect(phraseForItem("animal_not_dog", { type: "collar", path: "animal_id" })).toBe(ZOONOSES_ERRORS.animal_not_dog);
    expect(phraseForItem("animal_not_dog", { type: "leish_collection", path: "animal_id" })).toBe(ZOONOSES_ERRORS.animal_not_dog);
  });

  test("product_not_allowed reads by the item: the zoonoses phrase on a vaccine or a collar, the vector one on an ovitrap", () => {
    expect(phraseForItem("product_not_allowed", { type: "rabies_vaccination", path: "vector_product_id" })).toBe(ZOONOSES_ERRORS.product_not_allowed);
    expect(phraseForItem("product_not_allowed", { type: "collar", path: "vector_product_id" })).toBe(ZOONOSES_ERRORS.product_not_allowed);
    expect(phraseForItem("product_not_allowed", { type: "ovitrap_installation", path: null })).toBe(VECTOR_ERRORS.product_not_allowed);
    expect(phraseForItem("product_not_allowed", { type: "home_visit", path: "vector_inspection.measures[0].vector_product_id" })).toBe(VECTOR_ERRORS.product_not_allowed);
  });

  test("a 35b code on another item reads as the table's phrase, and an unknown code on a zoonoses item too", () => {
    expect(phraseForItem("animal_not_active", { type: "household", path: null })).toBe(ZOONOSES_ERRORS.animal_not_active);
    expect(phraseForItem("no_such_code", { type: "animal", path: null })).toBe(phraseFor("no_such_code"));
    expect(phraseForItem(null, { type: "collar", path: null })).toBe(phraseFor(null));
  });

  test("no phrase of a zoonoses code carries a value", () => {
    for (const code of ZOONOSES_NEW) expect(ERROR_PHRASES[code]).not.toMatch(/\d{5,}|_|\$\{/);
  });
});
