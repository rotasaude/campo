// Copies assets/map/{fonts,sprites} into android/app/src/main/assets/map at prebuild, so the
// map style reads glyphs and sprites by asset://map/… with no copy at start-up (Q55).
// The styles and the manifest stay out: they travel in the JS bundle.
//
// The copy is refused unless every font stack of the manifest has all its glyph ranges as
// real, non-empty files: MapLibre Native gives up on the whole map when one requested range
// has no file (Q61), and a symbolic link does not survive the APK (Q62).
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SPRITE_FILES = [".json", ".png", "@2x.json", "@2x.png"];

function fail(message) {
  throw new Error(`withMapAssets: ${message}`);
}

function checkMapAssets(src) {
  const manifestPath = path.join(src, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("assets/map ausente ou sem manifest.json; rode scripts/map-style-sync.mjs antes do prebuild");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { fonts, sprites, glyph_ranges: ranges } = manifest;
  if (!Array.isArray(fonts) || !Array.isArray(sprites) || !Number.isInteger(ranges) || ranges < 1) {
    fail("assets/map/manifest.json sem fonts, sprites ou glyph_ranges");
  }

  const fontsDir = path.join(src, "fonts");
  const present = fs.existsSync(fontsDir)
    ? fs
        .readdirSync(fontsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  for (const font of fonts) {
    if (!present.includes(font)) fail(`pilha de fonte do manifesto ausente em assets/map/fonts: ${font}`);
  }
  for (const font of present) {
    if (!fonts.includes(font)) fail(`pilha de fonte fora do manifesto em assets/map/fonts: ${font}`);
  }
  for (const font of fonts) {
    const files = fs.readdirSync(path.join(fontsDir, font)).filter((name) => name.endsWith(".pbf"));
    if (files.length !== ranges) {
      fail(`${font}: ${files.length} faixas de glifo, o manifesto pede ${ranges}`);
    }
    for (const name of files) {
      const stat = fs.lstatSync(path.join(fontsDir, font, name));
      if (stat.isSymbolicLink()) fail(`${font}/${name} é um atalho; o APK precisa do arquivo`);
      if (stat.size === 0) fail(`${font}/${name} está vazio`);
    }
  }

  for (const theme of sprites) {
    for (const suffix of SPRITE_FILES) {
      const file = path.join(src, "sprites", theme + suffix);
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        fail(`sprite ausente ou vazio: assets/map/sprites/${theme}${suffix}`);
      }
    }
  }
}

function copyMapAssets(src, dst) {
  checkMapAssets(src);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const dir of ["fonts", "sprites"]) {
    fs.cpSync(path.join(src, dir), path.join(dst, dir), { recursive: true });
  }
}

function withMapAssets(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      copyMapAssets(
        path.join(cfg.modRequest.projectRoot, "assets", "map"),
        path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "assets", "map"),
      );
      return cfg;
    },
  ]);
}

module.exports = withMapAssets;
module.exports.copyMapAssets = copyMapAssets;
