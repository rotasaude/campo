import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// contracts/field-sync is a copy of the field-sync-v1.2.0 tag of rotasaude/contracts.
// Editing the copy by hand, or leaving a file the list does not know, fails here.
const dir = join(__dirname, "../../contracts/field-sync");

// The same six hashes the api pins (FieldSync::Schemas::SHA256): one contract, two readers.
const PINNED: Record<string, string> = {
  "session-response-v1.json": "b3615de707cc235457b2c94a62823f332c244a700a1c6444144f204bb82eb6fc",
  "upload-request-v1.json": "c971a785ceabd27602ee92765c656443b8d9e803c59c90bfb9c9b4e7d40c0284",
  "upload-response-v1.json": "4c9c04191030504bb13749bf57261d749f03e4c8782bc0f26a1edca1bf7cedb9",
  "changes-response-v1.json": "8c19be1cb7f72c98ff488acb1749daec0e1eba03efb99ec47640efd576c31882",
  "reference-response-v1.json": "484e0aabe3f3a3ff6e71fcae32c5f98ec5d36331cae7521ce97b03ad094f0a36",
  "domains-v1.json": "554d5b2353a26c19c2ae8a6be50055c04743be0d4fb39f24a790f5386f96c547",
};

const sha = (file: string) => createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");

function listFiles(base: string): string[] {
  return readdirSync(base).filter((name) => name !== ".DS_Store").flatMap((name) => {
    const full = join(base, name);
    return statSync(full).isDirectory() ? listFiles(full) : [`./${relative(dir, full)}`];
  });
}

const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => {
  const [hash, file] = line.split(/\s+/, 2);
  return { hash, file };
});

test("TAG names field-sync-v1.2.0 and a commit", () => {
  expect(readFileSync(join(dir, "TAG"), "utf8").trim()).toMatch(/^field-sync-v1\.2\.0 [0-9a-f]{40}$/);
});

test("every listed file matches its SHA-256", () => {
  expect(sums.length).toBeGreaterThan(100);
  for (const { hash, file } of sums) expect(`${file} ${sha(file)}`).toBe(`${file} ${hash}`);
});

test("no file in the copy is missing from the list", () => {
  const present = listFiles(dir).filter((f) => f !== "./SHA256SUMS" && f !== "./TAG").sort();
  expect(present).toEqual(sums.map((s) => s.file).sort());
});

test("the six schemas are the ones the api pins", () => {
  for (const [file, hash] of Object.entries(PINNED)) expect(`${file} ${sha(file)}`).toBe(`${file} ${hash}`);
});
