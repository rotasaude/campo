// A count typed or stepped with a finger: "−" and "+" of a touch target each, and the number between them, typed as text
// (as the dashboard's draft keeps it: blank stays blank, and the rules refuse it). Never below 0 nor above `max`.
import { Pressable, Text, TextInput, View } from "react-native";
import { SIZES, useTheme } from "../theme/theme";

const DIGITS = /^\d+$/;

function Step({ label, sign, disabled, onPress }: { label: string; sign: string; disabled: boolean; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{
        width: SIZES.touch, height: SIZES.touch, alignItems: "center", justifyContent: "center", borderRadius: SIZES.radius,
        borderWidth: 1, borderColor: colors.rule2, backgroundColor: disabled ? colors.sunken : colors.panel,
      }}>
      <Text style={{ fontSize: SIZES.title, color: disabled ? colors.ink2 : colors.ink }}>{sign}</Text>
    </Pressable>
  );
}

export function Counter({ label, value, max, onChange, testID }: { label: string; value: string; max: number; onChange(value: string): void; testID?: string }) {
  const { colors } = useTheme();
  const n = DIGITS.test(value.trim()) ? Number(value.trim()) : null;
  const clamp = (x: number) => String(Math.min(max, Math.max(0, x)));
  // What is typed keeps only its digits ("-1" is 1), and stops at the ceiling.
  const typed = (text: string) => {
    const digits = text.replace(/\D/g, "");
    onChange(digits === "" ? "" : clamp(Number(digits)));
  };
  return (
    <View testID={testID} style={{ gap: 6 }}>
      <Text style={{ fontSize: SIZES.small, color: colors.ink2 }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Step label={`Diminuir ${label}`} sign="−" disabled={n !== null && n <= 0} onPress={() => onChange(clamp((n ?? 0) - 1))} />
        <TextInput accessibilityLabel={label} value={value} keyboardType="number-pad" onChangeText={typed} placeholderTextColor={colors.ink4}
          style={{
            minHeight: SIZES.touch, minWidth: 72, paddingHorizontal: 12, fontSize: SIZES.text, color: colors.ink, textAlign: "center",
            backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.rule2, borderRadius: SIZES.radius,
          }} />
        <Step label={`Aumentar ${label}`} sign="+" disabled={n !== null && n >= max} onPress={() => onChange(clamp((n ?? 0) + 1))} />
      </View>
    </View>
  );
}
