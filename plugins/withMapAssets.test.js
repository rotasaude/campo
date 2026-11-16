/* global test, expect, describe, beforeEach, afterEach */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { copyMapAssets } = require("./withMapAssets");

const FONTS = ["Noto Sans Regular", "Noto Sans Medium"];
const RANGES = 4; // the real manifest says 256; the rule is "as many as the manifest says"

let root;
let src;
let dst;

function range(i) {
  return `${i * 256}-${i * 256 + 255}.pbf`;
}

function seed({ fonts = FONTS, ranges = RANGES, sprites = ["light", "dark"] } = {}) {
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(src, "manifest.json"),
    JSON.stringify({ fonts: FONTS, sprites: ["light", "dark"], glyph_ranges: RANGES }),
  );
  fs.writeFileSync(path.join(src, "style-light.json"), "{}");
  for (const font of fonts) {
    fs.mkdirSync(path.join(src, "fonts", font), { recursive: true });
    for (let i = 0; i < ranges; i++) fs.writeFileSync(path.join(src, "fonts", font, range(i)), "glyphs");
  }
  fs.writeFileSync(path.join(src, "fonts", "OFL.txt"), "license");
  fs.mkdirSync(path.join(src, "sprites"), { recursive: true });
  for (const theme of sprites) {
    for (const suffix of [".json", ".png", "@2x.json", "@2x.png"]) {
      fs.writeFileSync(path.join(src, "sprites", theme + suffix), "sprite");
    }
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "campo-map-assets-"));
  src = path.join(root, "assets", "map");
  dst = path.join(root, "android", "app", "src", "main", "assets", "map");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("copyMapAssets", () => {
  test("copies fonts and sprites to the Android assets, where asset://map/… reads them (Q55)", () => {
    seed();
    copyMapAssets(src, dst);
    expect(fs.readFileSync(path.join(dst, "fonts", "Noto Sans Regular", "0-255.pbf"), "utf8")).toBe("glyphs");
    expect(fs.existsSync(path.join(dst, "fonts", "Noto Sans Medium", range(RANGES - 1)))).toBe(true);
    expect(fs.existsSync(path.join(dst, "fonts", "OFL.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "sprites", "dark@2x.png"))).toBe(true);
  });

  test("leaves the styles and the manifest out: they travel in the JS bundle", () => {
    seed();
    copyMapAssets(src, dst);
    expect(fs.readdirSync(dst).sort()).toEqual(["fonts", "sprites"]);
  });

  test("replaces what a previous prebuild left behind", () => {
    seed();
    fs.mkdirSync(path.join(dst, "fonts", "Old Font"), { recursive: true });
    fs.writeFileSync(path.join(dst, "fonts", "Old Font", "0-255.pbf"), "stale");
    copyMapAssets(src, dst);
    expect(fs.existsSync(path.join(dst, "fonts", "Old Font"))).toBe(false);
  });

  test("fails when assets/map is missing", () => {
    expect(() => copyMapAssets(src, dst)).toThrow(/assets\/map/);
  });

  test("fails when a font stack lacks a glyph range: one missing range blanks the whole map (Q61)", () => {
    seed();
    fs.rmSync(path.join(src, "fonts", "Noto Sans Medium", range(2)));
    expect(() => copyMapAssets(src, dst)).toThrow(/Noto Sans Medium.*3.*4/);
    expect(fs.existsSync(dst)).toBe(false);
  });

  test("fails when a glyph range is empty or a symbolic link (Q62)", () => {
    seed();
    const file = path.join(src, "fonts", "Noto Sans Regular", range(1));
    fs.writeFileSync(file, "");
    expect(() => copyMapAssets(src, dst)).toThrow(/vazi/);
    fs.rmSync(file);
    fs.symlinkSync(path.join(src, "fonts", "Noto Sans Regular", range(0)), file);
    expect(() => copyMapAssets(src, dst)).toThrow(/atalho/);
  });

  test("fails when a font stack of the manifest is missing or an unlisted one is present", () => {
    seed({ fonts: ["Noto Sans Regular"] });
    expect(() => copyMapAssets(src, dst)).toThrow(/Noto Sans Medium/);
    fs.rmSync(root, { recursive: true, force: true });
    seed({ fonts: [...FONTS, "Stray Font"] });
    expect(() => copyMapAssets(src, dst)).toThrow(/Stray Font/);
  });

  test("fails when a sprite file is missing", () => {
    seed();
    fs.rmSync(path.join(src, "sprites", "dark@2x.json"));
    expect(() => copyMapAssets(src, dst)).toThrow(/dark@2x\.json/);
  });
});
