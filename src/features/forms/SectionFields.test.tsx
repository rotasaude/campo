import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { useState } from "react";
import type { SectionKey } from "../../rules/dictionaries";
import { registrationDictionaries } from "../../rules/testing/dictionaries";
import { SectionFields } from "./SectionFields";

const DICT = registrationDictionaries();
type Values = Record<string, unknown>;

function Harness({ section, initial = {}, show, problem, onValues }: {
  section: SectionKey; initial?: Values; show?: (key: string) => boolean; problem?: { path: string; message: string } | null; onValues(v: Values): void;
}) {
  const [values, setValues] = useState<Values>(initial);
  return <SectionFields section={section} dict={DICT} values={values} show={show} problem={problem}
    onChange={(next) => { setValues(next); onValues(next); }} />;
}
async function mount(section: SectionKey, o: { initial?: Values; show?: (key: string) => boolean; problem?: { path: string; message: string } | null } = {}) {
  const seen: Values[] = [];
  await render(<Harness section={section} initial={o.initial} show={o.show} problem={o.problem} onValues={(v) => seen.push(v)} />);
  return { last: () => seen[seen.length - 1] };
}
const field = (key: string) => within(screen.getByTestId(`field-${key}`));

test("one question per field of the dictionary, in the order of the labels; what does not apply is not shown", async () => {
  await mount("living_conditions", { show: (key) => key !== "instituicao_permanencia" && !key.includes("animais") });
  expect(screen.getByText("Localização")).toBeTruthy();
  expect(screen.getByText("Número de moradores")).toBeTruthy();
  expect(screen.queryByText("Instituição de permanência")).toBeNull();
  expect(screen.queryByText("Tem animais no domicílio")).toBeNull();
  const shown = screen.getAllByTestId(/^field-/).map((node) => node.props.testID as string);
  expect(shown.slice(0, 3)).toEqual(["field-localizacao", "field-situacao_moradia_posse_terra", "field-area_producao_rural"]);
});

test("yes or no: Sim marks true, Não false, and touching the marked one again leaves the question unanswered", async () => {
  const t = await mount("living_conditions");
  await fireEvent.press(field("st_disponibilidade_energia_eletrica").getByRole("radio", { name: "Sim" }));
  expect(t.last()).toEqual({ st_disponibilidade_energia_eletrica: true });
  expect(field("st_disponibilidade_energia_eletrica").getByRole("radio", { name: "Sim" }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(field("st_disponibilidade_energia_eletrica").getByRole("radio", { name: "Não" }));
  expect(t.last()).toEqual({ st_disponibilidade_energia_eletrica: false });
  await fireEvent.press(field("st_disponibilidade_energia_eletrica").getByRole("radio", { name: "Não" }));
  expect(t.last()).toEqual({});
});

test("one option of a list: the code of the dictionary, as a number", async () => {
  const t = await mount("living_conditions");
  const urban = DICT.domains.localizacao_da_moradia.find((e) => e.code === 83)!;
  await fireEvent.press(field("localizacao").getByRole("radio", { name: urban.label }));
  expect(t.last()).toEqual({ localizacao: 83 });
});

test("several options: a list of codes; none marked removes the key", async () => {
  const t = await mount("living_conditions");
  const [first, second] = DICT.domains.animal_no_domicilio;
  await fireEvent.press(field("animais_no_domicilio").getByRole("checkbox", { name: first.label }));
  await fireEvent.press(field("animais_no_domicilio").getByRole("checkbox", { name: second.label }));
  expect(t.last()).toEqual({ animais_no_domicilio: [first.code, second.code] });
  await fireEvent.press(field("animais_no_domicilio").getByRole("checkbox", { name: first.label }));
  await fireEvent.press(field("animais_no_domicilio").getByRole("checkbox", { name: second.label }));
  expect(t.last()).toEqual({});
});

test("a count is a whole number; emptied, the key goes", async () => {
  const t = await mount("living_conditions");
  await fireEvent.changeText(screen.getByLabelText("Número de cômodos"), "4");
  expect(t.last()).toEqual({ nu_comodos: 4 });
  await fireEvent.changeText(screen.getByLabelText("Número de cômodos"), "4a");
  expect(t.last()).toEqual({ nu_comodos: 4 }); // only digits are taken
  await fireEvent.changeText(screen.getByLabelText("Número de cômodos"), "");
  expect(t.last()).toEqual({});
});

test("a group inside the form is an object; emptied, it goes whole", async () => {
  const t = await mount("living_conditions");
  await fireEvent.changeText(screen.getByLabelText("Nome da instituição"), "Lar São Vicente");
  expect(t.last()).toEqual({ instituicao_permanencia: { nome_instituicao_permanencia: "Lar São Vicente" } });
  await fireEvent.changeText(screen.getByLabelText("Nome da instituição"), "");
  expect(t.last()).toEqual({});
});

test("the refusal of a field is written under it", async () => {
  await mount("living_conditions", { problem: { path: "living_conditions.nu_moradores", message: "moradores menos que a soma das famílias (3)" } });
  expect(field("nu_moradores").getByText("moradores menos que a soma das famílias (3)")).toBeTruthy();
  expect(field("nu_comodos").queryByText(/moradores menos/)).toBeNull();
});

test("a long list is searched, not scrolled: typing narrows it, without accents or case", async () => {
  const t = await mount("identification");
  expect(field("pais_nascimento").queryByRole("radio", { name: "BRASIL" })).toBeNull();
  await fireEvent.changeText(field("pais_nascimento").getByLabelText("Buscar em País de nascimento"), "bras");
  await fireEvent.press(field("pais_nascimento").getByRole("radio", { name: "BRASIL" }));
  expect(t.last()).toEqual({ pais_nascimento: 31 });
  // The chosen one stays on screen after the search is cleared.
  await fireEvent.changeText(field("pais_nascimento").getByLabelText("Buscar em País de nascimento"), "");
  expect(field("pais_nascimento").getByRole("radio", { name: "BRASIL" }).props.accessibilityState.checked).toBe(true);
});

test("a date is typed as dd/mm/aaaa and kept as the contract wants it; a month as mm/aaaa", async () => {
  const t = await mount("identification", { initial: { dt_entrada_brasil: "2019-07-01" } });
  expect(screen.getByLabelText(/^Data de entrada no Brasil/).props.value).toBe("01/07/2019");
  await fireEvent.changeText(screen.getByLabelText(/^Data de naturalização/), "05/03/2001");
  expect(t.last()).toMatchObject({ dt_naturalizacao: "2001-03-05" });
  // Not a date yet: what was typed goes as it is, and the rules refuse it ("data inválida").
  await fireEvent.changeText(screen.getByLabelText(/^Data de naturalização/), "05/03");
  expect(t.last()).toMatchObject({ dt_naturalizacao: "05/03" });
});
