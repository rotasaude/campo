// The map style comes ready from the contracts' map-style domain (tag
// map-style-v1.0.0, copy in assets/map, pinned by lock): Protomaps light and
// dark, labels in Portuguese. It has three placeholders, filled here: the map
// file (the city's PMTiles in the document directory) and where the fonts and
// icons are — inside the app. No URL of a third party: the map calls nobody.
import styleDark from "../../assets/map/style-dark.json";
import styleLight from "../../assets/map/style-light.json";

export interface MapStyle {
  version: number;
  sources: Record<string, { type: string; url?: string; attribution?: string }>;
  glyphs: string;
  sprite: string;
  layers: unknown[];
  [key: string]: unknown;
}

// Q55: fonts and sprites are read from the APK's assets (copied there by plugins/withMapAssets.js).
export const MAP_ASSET_PATHS = { glyphs: "asset://map/fonts", sprite: "asset://map/sprites" } as const;

const SOURCES = { light: styleLight, dark: styleDark } as const;

function fill(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => fill(item, replace));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fill(item, replace)]));
  }
  return value;
}

// A new object every time; only the three placeholders change.
export function buildStyle(theme: "light" | "dark", p: { pmtilesUri: string; glyphs: string; sprite: string }): MapStyle {
  return fill(SOURCES[theme], (text) => text
    .replace("__PMTILES__", p.pmtilesUri).replace("__GLYPHS__", p.glyphs).replace("__SPRITE__", p.sprite)) as MapStyle;
}
