// assets/map is a copy of map-style/dist of the map-style-v1.0.0 tag of rotasaude/contracts, made by
// scripts/map-style-sync.mjs. Editing the copy by hand, or leaving a file the lock does not know, fails here.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dir = join(__dirname, "../../assets/map");
const lock = JSON.parse(readFileSync(join(dir, "map-style.lock"), "utf8")) as { ref: string; files: Record<string, string> };

function listFiles(base: string): string[] {
  return readdirSync(base).filter((name) => name !== ".DS_Store").flatMap((name) => {
    const full = join(base, name);
    return statSync(full).isDirectory() ? listFiles(full) : [relative(dir, full)];
  });
}

test("the copy comes from the map-style-v1.0.0 tag", () => {
  expect(lock.ref).toBe("map-style-v1.0.0");
});

test("every file of the copy matches the lock", () => {
  expect(Object.keys(lock.files).length).toBeGreaterThan(1000);
  for (const [file, sha] of Object.entries(lock.files)) {
    expect(`${file} ${createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")}`).toBe(`${file} ${sha}`);
  }
});

test("nothing in assets/map is outside the lock", () => {
  expect(listFiles(dir).filter((f) => f !== "map-style.lock").sort()).toEqual(Object.keys(lock.files).sort());
});

test("both themes were copied: the app follows the system's light or dark", () => {
  for (const file of ["style-light.json", "style-dark.json", "manifest.json", "fonts/OFL.txt", "sprites/light.png", "sprites/dark.png"]) {
    expect([file, Object.prototype.hasOwnProperty.call(lock.files, file)]).toEqual([file, true]);
  }
});
