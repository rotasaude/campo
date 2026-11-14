// Choosing from a list with a finger: every option is a touch target of its
// own. What is chosen is told by a mark and a border, never by colour alone.
// A long list (countries, street types) is searched, not scrolled.
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { normalizeText } from "../sync/text";
import { SIZES, useTheme } from "../theme/theme";
import { Field } from "./components";

export interface Option<T extends string | number> { code: T; label: string }

// More options than this and the list is searched.
export const SEARCH_FROM = 12;
const SEARCH_SHOWN = 8;

function OptionButton({ label, marked, role, onPress }: { label: string; marked: boolean; role: "radio" | "checkbox"; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole={role} accessibilityLabel={label} accessibilityState={{ checked: marked }} onPress={onPress}
      style={{
        minHeight: SIZES.touch, paddingHorizontal: 14, paddingVertical: 10, justifyContent: "center", borderRadius: SIZES.radius,
        borderWidth: marked ? 2 : 1, borderColor: marked ? colors.accent : colors.rule2, backgroundColor: marked ? colors["accent-bg"] : colors.panel,
      }}>
      <Text style={{ fontSize: SIZES.text, color: colors.ink, fontWeight: marked ? "700" : "400" }}>{marked ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
}

function useShown<T extends string | number>(label: string, options: Option<T>[], isMarked: (code: T) => boolean) {
  const [query, setQuery] = useState("");
  const long = options.length > SEARCH_FROM;
  if (!long) return { search: null, shown: options };
  const wanted = normalizeText(query);
  const found = wanted === "" ? [] : options.filter((option) => normalizeText(option.label).includes(wanted)).slice(0, SEARCH_SHOWN);
  // What is already chosen stays on screen whatever the search says.
  const shown = [...options.filter((option) => isMarked(option.code) && !found.includes(option)), ...found];
  return { search: <Field label={`Buscar em ${label}`} value={query} onChangeText={setQuery} autoCorrect={false} />, shown };
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: SIZES.small, color: colors.ink2 }}>{label}</Text>
      {children}
    </View>
  );
}

// One of the list, or none: touching the chosen one again clears the answer.
export function Choice<T extends string | number>({ label, options, value, onChange }: {
  label: string; options: Option<T>[]; value: T | null; onChange(value: T | null): void;
}) {
  const { search, shown } = useShown(label, options, (code) => code === value);
  return (
    <Group label={label}>
      {search}
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {shown.map((option) => (
          <OptionButton key={String(option.code)} role="radio" label={option.label} marked={option.code === value}
            onPress={() => onChange(option.code === value ? null : option.code)} />
        ))}
      </View>
    </Group>
  );
}

// Any number of the list, in the order they were marked.
export function MultiChoice<T extends string | number>({ label, options, value, onChange }: {
  label: string; options: Option<T>[]; value: T[]; onChange(value: T[]): void;
}) {
  const { search, shown } = useShown(label, options, (code) => value.includes(code));
  return (
    <Group label={label}>
      {search}
      <View accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {shown.map((option) => (
          <OptionButton key={String(option.code)} role="checkbox" label={option.label} marked={value.includes(option.code)}
            onPress={() => onChange(value.includes(option.code) ? value.filter((code) => code !== option.code) : [...value, option.code])} />
        ))}
      </View>
    </Group>
  );
}

const YES_NO: Option<"sim" | "nao">[] = [{ code: "sim", label: "Sim" }, { code: "nao", label: "Não" }];

// Yes, no, or not answered.
export function YesNo({ label, value, onChange }: { label: string; value: boolean | null; onChange(value: boolean | null): void }) {
  return (
    <Choice label={label} options={YES_NO} value={value === null ? null : value ? "sim" : "nao"}
      onChange={(next) => onChange(next === null ? null : next === "sim")} />
  );
}
