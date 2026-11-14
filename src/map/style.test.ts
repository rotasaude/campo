import { existsSync } from "node:fs";
import { join } from "node:path";
import manifest from "../../assets/map/manifest.json";
import styleLight from "../../assets/map/style-light.json";
import { MAP_ASSET_PATHS, buildStyle } from "./style";

const assets = join(__dirname, "../../assets/map");
const paths = { pmtilesUri: "pmtiles://file:///data/user/0/br.rotasaude.campo/files/map/2026-11-01-abababababab.pmtiles", ...MAP_ASSET_PATHS };

test("style has no remote URL", () => {
  for (const t of ["light", "dark"] as const) expect(JSON.stringify(buildStyle(t, paths))).not.toMatch(/https?:\/\//);
});

test("style source is the local pmtiles uri and no placeholder is left", () => {
  for (const theme of ["light", "dark"] as const) {
    const style = buildStyle(theme, paths);
    expect(style.sources.protomaps).toMatchObject({ type: "vector", url: paths.pmtilesUri, attribution: "© OpenStreetMap" });
    expect(style.glyphs).toBe("asset://map/fonts/{fontstack}/{range}.pbf");
    expect(style.sprite).toBe(`asset://map/sprites/${theme}`);
    expect(JSON.stringify(style)).not.toMatch(/__(PMTILES|GLYPHS|SPRITE)__/);
    expect(style.version).toBe(8);
  }
});

test("the fonts and sprites come from inside the app (asset://, Q55)", () => {
  expect(MAP_ASSET_PATHS).toEqual({ glyphs: "asset://map/fonts", sprite: "asset://map/sprites" });
});

test("labels are Portuguese", () => expect(JSON.stringify(styleLight)).toMatch(/name:pt/));

test("only the three placeholders change: the layers are the tag's, and the copy is not touched", () => {
  const first = buildStyle("light", paths);
  const second = buildStyle("light", { ...paths, pmtilesUri: "pmtiles://file:///other.pmtiles" });
  expect(first.layers).toEqual(styleLight.layers);
  expect(first.layers).not.toBe(second.layers);
  expect(second.sources.protomaps.url).toBe("pmtiles://file:///other.pmtiles");
  expect(styleLight.sources.protomaps.url).toBe("__PMTILES__");
  expect(styleLight.glyphs).toBe("__GLYPHS__/{fontstack}/{range}.pbf");
});

// A glyph range asked for and missing takes the whole map down (Q61): every stack of the manifest is whole.
test("every font stack of the manifest has its first and last range, and both themes have the four sprite files", () => {
  expect(manifest.fonts).toHaveLength(4);
  for (const stack of manifest.fonts) {
    for (const range of ["0-255", "65280-65535"]) expect([stack, range, existsSync(join(assets, "fonts", stack, `${range}.pbf`))]).toEqual([stack, range, true]);
  }
  for (const theme of manifest.sprites) {
    for (const file of [`${theme}.json`, `${theme}.png`, `${theme}@2x.json`, `${theme}@2x.png`]) expect([file, existsSync(join(assets, "sprites", file))]).toEqual([file, true]);
  }
});
