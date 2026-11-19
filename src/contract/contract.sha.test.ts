import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// contracts/field-sync is a copy of the field-sync-v1.3.0 tag of rotasaude/contracts.
// Editing the copy by hand, or leaving a file the list does not know, fails here.
const dir = join(__dirname, "../../contracts/field-sync");

// The same six hashes the api pins (FieldSync::Schemas::SHA256): one contract, two readers.
const PINNED: Record<string, string> = {
  "session-response-v1.json": "ab8b9778841b8c1dea6215b794c2e85b6a0fb6093a74dccd6e12fd5d617d8c74",
  "upload-request-v1.json": "5fa0c171be285754c9a1e237eafdbc61b467edd6af9f026efb2552f8b96024e3",
  "upload-response-v1.json": "ae211029fda7662b29658f6e94df1cba5c01275db2e98ecc870ebfc50f2337aa",
  "changes-response-v1.json": "980a9992ebb549094260a1d02d3daea237ce0e0e1b63d892391600832d66c40b",
  "reference-response-v1.json": "d2db3e6ebe806210d15f872ee2012db2db7902acaee25ee25bf028b33d26890e",
  "domains-v1.json": "d8b92593e29c72c36c96b64ade69d9e8f8663456bc7f5328cf4c20a9263d6038",
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

test("TAG names field-sync-v1.3.0 and a commit", () => {
  expect(readFileSync(join(dir, "TAG"), "utf8").trim()).toMatch(/^field-sync-v1\.3\.0 [0-9a-f]{40}$/);
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
