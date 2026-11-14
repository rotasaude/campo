// gerado por scripts/tokens.mjs de design-tokens/dist/tokens.css (tokens-v1.1.0, sha256 631aaf4ff970487f7e0edf076f9aa5519c019c2b1e547203e814d106ab7a72b7) — não editar.
export const TOKENS_REF = "tokens-v1.1.0";
export const COLOR_ROLES = ["accent","accent-bg","bg","down","down-bg","focus","info","info-bg","ink","ink2","ink3","ink4","ok","ok-bg","on-accent","on-tone","panel","rule","rule2","sunken","sunken2","warn","warn-bg"] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
export type Palette = Record<ColorRole, string>;
export const PALETTES: { light: Palette; dark: Palette } = {
  "light": {
    "bg": "#f8f8f8",
    "panel": "#ffffff",
    "sunken": "#f0f0f0",
    "sunken2": "#e6e6e6",
    "rule": "#dcdcdc",
    "rule2": "#888888",
    "ink": "#1b1b1b",
    "ink2": "#333333",
    "ink3": "#555555",
    "ink4": "#888888",
    "accent": "#1351b4",
    "accent-bg": "#dbe8fb",
    "on-accent": "#ffffff",
    "on-tone": "#ffffff",
    "ok": "#0f6b1d",
    "ok-bg": "#e3f5e1",
    "warn": "#7a4b00",
    "warn-bg": "#fff5c2",
    "down": "#b31800",
    "down-bg": "#fde0db",
    "info": "#0c4ca3",
    "info-bg": "#d4e5ff",
    "focus": "#b35c00"
  },
  "dark": {
    "bg": "#121212",
    "panel": "#1b1b1b",
    "sunken": "#242424",
    "sunken2": "#2e2e2e",
    "rule": "#3a3a3a",
    "rule2": "#8a8a8a",
    "ink": "#f2f2f2",
    "ink2": "#d6d6d6",
    "ink3": "#b8b8b8",
    "ink4": "#8a8a8a",
    "accent": "#8ab4ff",
    "accent-bg": "#0c326f",
    "on-accent": "#000000",
    "on-tone": "#000000",
    "ok": "#6fdc8c",
    "ok-bg": "#0f2e18",
    "warn": "#ffcd07",
    "warn-bg": "#3a2d00",
    "down": "#ff8a75",
    "down-bg": "#3d0d06",
    "info": "#8ab4ff",
    "info-bg": "#0c2650",
    "focus": "#ffb54d"
  }
};
