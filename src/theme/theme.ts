// The app's look: the colour roles of the design tokens (govbr in light,
// govbr-escuro in dark), following the system. Sizes are for a tablet used
// standing, outdoors: large text and large touch targets.
import { useColorScheme } from "react-native";
import { PALETTES, type Palette } from "./tokens";

export const SIZES = { touch: 48, text: 18, small: 16, title: 24, gap: 16, pad: 20, radius: 8 } as const;

export interface Theme { colors: Palette; dark: boolean }

export function useTheme(): Theme {
  const dark = useColorScheme() === "dark";
  return { colors: dark ? PALETTES.dark : PALETTES.light, dark };
}
