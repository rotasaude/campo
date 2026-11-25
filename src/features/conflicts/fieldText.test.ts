import type { ItemType } from "../../contract";
import { pathLabel } from "./fieldText";

const ZOONOSES_ITEMS: ItemType[] = ["animal", "rabies_vaccination", "leish_collection", "collar"];

// The paths the api refuses on the four items of the 35b (domains-v1.json), with the dashboard's labels.
const LABELS: [ItemType, string, string][] = [
  ["rabies_vaccination", "animal_id", "Animal"], ["rabies_vaccination", "animal_client_uuid", "Animal"],
  ["collar", "animal_id", "Animal"], ["leish_collection", "animal_client_uuid", "Animal"],
  ["animal", "microchip", "Microchip"], ["animal", "tutor_patient_id", "Tutor"], ["animal", "tutor_client_uuid", "Tutor"],
  ["animal", "birth_estimate_month", "Mês de nascimento (estimado)"], ["animal", "status", "Nova situação"], ["animal", "status_on", "Data da nova situação"],
  ["rabies_vaccination", "campaign_id", "Campanha"], ["rabies_vaccination", "vector_product_id", "Produto"], ["collar", "vector_product_id", "Produto"],
  ["rabies_vaccination", "vaccinated_on", "Data da vacinação"], ["rabies_vaccination", "adverse_note", "Nota do evento adverso"],
  ["leish_collection", "leish_survey_id", "Inquérito"], ["leish_collection", "collected_on", "Data da coleta"],
  ["leish_collection", "dpp_result", "Resultado do TR-DPP"], ["leish_collection", "dpp_on", "Data do TR-DPP"], ["collar", "placed_on", "Data da colocação"],
  ["animal", "species", "Espécie"], ["animal", "name", "Nome"], ["animal", "sex", "Sexo"], ["animal", "size", "Porte"], ["animal", "coat", "Pelagem"],
  ["animal", "breed", "Raça"], ["animal", "community", "Comunitário"], ["animal", "household_id", "Domicílio"], ["animal", "household_client_uuid", "Domicílio"],
];

test("fieldText puts every path of the four items in words; the raw path never shows", () => {
  for (const [type, path, label] of LABELS) {
    expect(ZOONOSES_ITEMS).toContain(type);
    expect([type, path, pathLabel(type, path)]).toEqual([type, path, label]);
  }
});

test("the same word on another item keeps its own label: status on a household is still the household's", () => {
  expect(pathLabel("household", "status")).toBe("Situação do domicílio");
  expect(pathLabel("ovitrap_collection", "collected_on")).toBe("Data da coleta");
});

test("a path the table does not know is not made up: it shows as it is", () => {
  expect(pathLabel("animal", "something_else")).toBe("something_else");
});

test("no label carries a value (microchip, name)", () => {
  for (const [type, path] of LABELS) expect(pathLabel(type, path)).not.toMatch(/\d{5,}/);
});
