// A section of a registration form (living conditions, identification, …)
// drawn from its dictionary: one question per field, of the kind its type
// asks for. The screen holds no list of fields — a field the reference adds
// appears by itself, with its key as the question until the app learns its
// label. An answer left empty is not in the values at all (the item does not
// carry the key).
import { View } from "react-native";
import type { FieldSpec, RegistrationDictionaries, SectionKey } from "../../rules/dictionaries";
import { FIELD_LABELS, sectionFieldLabel } from "../../rules/labels";
import { SIZES, useTheme } from "../../theme/theme";
import { Choice, MultiChoice, YesNo } from "../../ui/choices";
import { Field, FieldRefusal, Title } from "../../ui/components";

type Values = Record<string, unknown>;
export interface FieldProblem { path: string; message: string }

const isObject = (value: unknown): value is Values => typeof value === "object" && value !== null && !Array.isArray(value);

// dd/mm/aaaa on screen, AAAA-MM-DD in the item; what is not a whole date yet goes as typed (the rules refuse it).
export function dateToScreen(value: unknown): string {
  if (typeof value !== "string") return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : value;
}
export function dateFromScreen(text: string): string {
  const typed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  return typed ? `${typed[3]}-${typed[2]}-${typed[1]}` : text.trim();
}
export function monthToScreen(value: unknown): string {
  if (typeof value !== "string") return "";
  const iso = /^(\d{4})-(\d{2})$/.exec(value);
  return iso ? `${iso[2]}/${iso[1]}` : value;
}
export function monthFromScreen(text: string): string {
  const typed = /^(\d{2})\/(\d{4})$/.exec(text.trim());
  return typed ? `${typed[2]}-${typed[1]}` : text.trim();
}

const HINT: Partial<Record<FieldSpec["type"], string>> = { date: " (dd/mm/aaaa)", date_month: " (mm/aaaa)" };

function Question({ section, spec, path, value, set, dict, show, problem }: {
  section: SectionKey; spec: FieldSpec; path: string; value: unknown; set(value: unknown): void;
  dict: RegistrationDictionaries; show?: (key: string) => boolean; problem?: FieldProblem | null;
}) {
  const { colors } = useTheme();
  const label = sectionFieldLabel(section, path);
  const options = spec.domain ? dict.domains[spec.domain] ?? [] : [];
  const text = (toScreen: (v: unknown) => string, fromScreen: (t: string) => unknown, keyboard?: "number-pad") => (
    <Field label={label + (HINT[spec.type] ?? "")} value={toScreen(value)} keyboardType={keyboard} autoCorrect={false}
      onChangeText={(typed) => { const next = fromScreen(typed); set(next === "" || next === null ? undefined : next); }} />
  );

  let input: React.ReactNode;
  switch (spec.type) {
  case "bool":
    input = <YesNo label={label} value={typeof value === "boolean" ? value : null} onChange={(next) => set(next ?? undefined)} />;
    break;
  case "code":
    input = <Choice label={label} options={options} value={typeof value === "number" ? value : null} onChange={(next) => set(next ?? undefined)} />;
    break;
  case "codes":
    input = <MultiChoice label={label} options={options} value={Array.isArray(value) ? (value as number[]) : []}
      onChange={(next) => set(next.length === 0 ? undefined : next)} />;
    break;
  case "count":
    input = text((v) => (typeof v === "number" ? String(v) : ""), (typed) => { const digits = typed.replace(/\D/g, ""); return digits === "" ? null : Number(digits); }, "number-pad");
    break;
  case "digits":
    input = text((v) => (typeof v === "string" ? v : ""), (typed) => typed.replace(/\D/g, ""), "number-pad");
    break;
  case "date":
    input = text(dateToScreen, dateFromScreen, "number-pad");
    break;
  case "date_month":
    input = text(monthToScreen, monthFromScreen, "number-pad");
    break;
  case "object":
    input = (
      <View style={{ gap: SIZES.gap, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.rule }}>
        <Title>{label}</Title>
        <Questions section={section} fields={spec.fields ?? []} prefix={`${path}.`} values={isObject(value) ? value : {}} dict={dict} show={show} problem={problem}
          onChange={(next) => set(Object.keys(next).length === 0 ? undefined : next)} />
      </View>
    );
    break;
  default:
    input = text((v) => (typeof v === "string" ? v : ""), (typed) => typed);
  }

  return (
    <View testID={`field-${path}`} style={{ gap: 6 }}>
      {input}
      {problem && problem.path === `${section}.${path}` && <FieldRefusal problem={problem} />}
    </View>
  );
}

function Questions({ section, fields, prefix, values, onChange, dict, show, problem }: {
  section: SectionKey; fields: FieldSpec[]; prefix: string; values: Values; onChange(next: Values): void;
  dict: RegistrationDictionaries; show?: (key: string) => boolean; problem?: FieldProblem | null;
}) {
  // The order of the questions is the order of the labels (the dictionary's own is alphabetical); a field the app has
  // no label for comes after them, in the dictionary's order.
  const order = Object.keys(FIELD_LABELS[section] ?? {});
  const place = (spec: FieldSpec) => { const at = order.indexOf(prefix + spec.key); return at === -1 ? order.length : at; };
  const asked = fields.filter((spec) => show?.(prefix + spec.key) ?? true).sort((a, b) => place(a) - place(b));
  return (
    <>
      {asked.map((spec) => (
        <Question key={spec.key} section={section} spec={spec} path={prefix + spec.key} value={values[spec.key]} dict={dict} show={show} problem={problem}
          set={(next) => {
            const { [spec.key]: _old, ...rest } = values;
            onChange(next === undefined ? rest : { ...rest, [spec.key]: next });
          }} />
      ))}
    </>
  );
}

export function SectionFields({ section, dict, values, onChange, show, problem }: {
  section: SectionKey; dict: RegistrationDictionaries; values: Values; onChange(next: Values): void;
  // Whether a field applies now (by its path: "field" or "object.field"). Without it, every field is asked.
  show?: (key: string) => boolean;
  // The form's first refusal; it is written under the field it names.
  problem?: FieldProblem | null;
}) {
  return (
    <View style={{ gap: SIZES.gap }}>
      <Questions section={section} fields={dict.sections[section]} prefix="" values={values} onChange={onChange} dict={dict} show={show} problem={problem} />
    </View>
  );
}
