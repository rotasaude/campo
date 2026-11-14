import { outboxRepo } from "../../db/repos/outboxRepo";
import { enqueue } from "../../sync/outbox";
import { newUuid } from "../../sync/testing";
import { loadedTablet } from "../testing";
import { CNS_USED_HERE, CPF_USED_HERE, findDocumentClash, findSimilar, nameDistance } from "./localDuplicates";

// Joana D'Arc Conceição, born 1961-03-14, mother Maria Conceição: the resident of the example territory.
const JOANA = { full_name: "Joana D'Arc Conceição", birth_date: "1961-03-14" };
const person = (o: Record<string, unknown>) => ({ full_name: "Benedita Aparecida Rocha", birth_date: "1948-05-02", sex: "female", ...o });

test("distance between names: letters changed, missing or extra; accents and case do not count", () => {
  expect(nameDistance("joana conceicao", "joana conceicao")).toBe(0);
  expect(nameDistance("joana conceicao", "joanna conceisao")).toBe(2);
  expect(nameDistance("joana conceicao", "joao conceicao")).toBe(2);
  expect(nameDistance("ana", "")).toBe(3);
});

test("the same name and the same birth warns; so does a name two letters away", async () => {
  const db = await loadedTablet();
  const exact = await findSimilar(db, JOANA);
  expect(exact).toEqual([{ key: "2a3b4c5d-6e7f-4a8b-8c9d-0e1f2a3b4c5d", display_name: "Joana Conceição", birth_date: "1961-03-14" }]);
  expect(await findSimilar(db, { ...JOANA, full_name: "JOANA DARC CONCEICAO" })).toHaveLength(1);
  expect(await findSimilar(db, { ...JOANA, full_name: "Joanna D'Arc Conseição" })).toHaveLength(1);
});

test("a different birth, or a name further away, does not warn", async () => {
  const db = await loadedTablet();
  expect(await findSimilar(db, { ...JOANA, birth_date: "1961-03-15" })).toEqual([]);
  expect(await findSimilar(db, { ...JOANA, full_name: "Joaquina D'Arc Conceição" })).toEqual([]);
});

test("when both have the mother's name, it must be the same; when one does not, the name and birth are enough", async () => {
  const db = await loadedTablet();
  expect(await findSimilar(db, { ...JOANA, mother_name: "Maria Conceição" })).toHaveLength(1);
  expect(await findSimilar(db, { ...JOANA, mother_name: "MARIA CONCEICAO" })).toHaveLength(1);
  expect(await findSimilar(db, { ...JOANA, mother_name: "Antônia Conceição" })).toEqual([]);
  expect(await findSimilar(db, { ...JOANA, mother_name: null })).toHaveLength(1);
});

test("a document already typed in another record of this tablet, still in the line, blocks", async () => {
  const db = await loadedTablet();
  const registration = await enqueue(db, { type: "individual_registration", body: { new_patient: person({ cpf: "52998224725" }), is_responsible: false } }, newUuid);
  await enqueue(db, { type: "patient", body: { new_patient: person({ no_cpf_reason: "2", cns: "702000000000001" }) } }, newUuid);
  expect(await findDocumentClash(db, { cpf: "529.982.247-25" })).toBe(CPF_USED_HERE);
  expect(await findDocumentClash(db, { cns: "702 0000 0000 0001" })).toBe(CNS_USED_HERE);
  expect(CPF_USED_HERE).toBe("Este CPF já foi usado em outro cadastro deste tablet");
  expect(await findDocumentClash(db, { cpf: "11144477735", cns: "898001160660761" })).toBeNull();
  expect(await findDocumentClash(db, {})).toBeNull();
  // The record being corrected does not clash with itself.
  expect(await findDocumentClash(db, { cpf: "52998224725" }, registration.client_uuid)).toBeNull();
  // Once the item left the line the server is the one who knows.
  await outboxRepo.remove(db, registration.seq);
  expect(await findDocumentClash(db, { cpf: "52998224725" })).toBeNull();
});
