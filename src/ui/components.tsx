// The few building blocks every screen uses. Colours only from the theme;
// every touch target at least 48 dp; text at least 18 sp.
import { useContext, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type TextInputProps } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { SIZES, useTheme } from "../theme/theme";

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

// The app draws edge to edge: the content keeps clear of the status bar, the navigation bar (on a tablet, the
// taskbar) and the cutouts, or the last button of a screen sits under a bar and the touch goes to the system.
// The background still fills the whole window. The insets come from the provider expo-router mounts at the root.
export function Screen({ children, title }: { children: ReactNode; title?: string }) {
  const { colors } = useTheme();
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const padding = {
    paddingTop: SIZES.pad + insets.top, paddingBottom: SIZES.pad + insets.bottom,
    paddingLeft: SIZES.pad + insets.left, paddingRight: SIZES.pad + insets.right,
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ ...padding, gap: SIZES.gap }} keyboardShouldPersistTaps="handled">
      {title !== undefined && <Title>{title}</Title>}
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text accessibilityRole="header" style={{ fontSize: SIZES.title, fontWeight: "700", color: colors.ink }}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ fontSize: SIZES.text, color: colors.ink }}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ fontSize: SIZES.small, color: colors.ink3 }}>{children}</Text>;
}

// A message the person must not miss. `alert` is announced by the screen reader as soon as it appears.
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "down" | "ok" }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole={tone === "down" || tone === "warn" ? "alert" : undefined}
      style={{ padding: SIZES.gap, borderRadius: SIZES.radius, backgroundColor: colors[`${tone}-bg`], borderWidth: 1, borderColor: colors[tone] }}>
      <Text style={{ fontSize: SIZES.text, color: colors[tone] }}>{children}</Text>
    </View>
  );
}

export function Button({ label, onPress, disabled = false, variant = "primary" }: {
  label: string; onPress(): void; disabled?: boolean; variant?: "primary" | "secondary" | "danger";
}) {
  const { colors } = useTheme();
  const fill = variant === "primary" ? colors.accent : colors.panel;
  const ink = variant === "primary" ? colors["on-accent"] : variant === "danger" ? colors.down : colors.ink;
  const border = variant === "primary" ? colors.accent : variant === "danger" ? colors.down : colors.rule2;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{
        minHeight: SIZES.touch, paddingHorizontal: SIZES.pad, justifyContent: "center", alignItems: "center", borderRadius: SIZES.radius,
        // Disabled is told by fill, text and a dashed border — never by opacity alone.
        backgroundColor: disabled ? colors.sunken : fill, borderWidth: disabled ? 2 : 1, borderStyle: disabled ? "dashed" : "solid",
        borderColor: disabled ? colors.rule2 : border,
      }}>
      <Text style={{ fontSize: SIZES.text, fontWeight: "600", color: disabled ? colors.ink2 : ink }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, ...input }: { label: string } & TextInputProps) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: SIZES.small, color: colors.ink2 }}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.ink4} {...input}
        style={{
          minHeight: SIZES.touch, paddingHorizontal: 12, fontSize: SIZES.text, color: colors.ink, backgroundColor: colors.panel,
          borderWidth: 1, borderColor: colors.rule2, borderRadius: SIZES.radius,
        }} />
    </View>
  );
}
