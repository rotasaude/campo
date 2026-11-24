import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// contracts/field-sync is a copy of the field-sync-v1.4.0 tag of rotasaude/contracts.
// Editing the copy by hand, or leaving a file the list does not know, fails here.
const dir = join(__dirname, "../../contracts/field-sync");

// The same six hashes the api pins (FieldSync::Schemas::SHA256): one contract, two readers.
const PINNED: Record<string, string> = {
  "session-response-v1.json": "0ecca17934764f012c92f8a2d2f2092a77174867402b4e92c24879a48343e6b9",
  "upload-request-v1.json": "1e22ad13bfe061e1aba5b7874d849a451426269974ce99efee5d0ea1319945e9",
  "upload-response-v1.json": "04d30d759f88d1caafcb6a5ef37f3af2cc75695ef721e5a306d541e5967565a3",
  "changes-response-v1.json": "5154ae0f90b4537fb02a38b1a8d7853991874516dd1dd25834fae29feb36796b",
  "reference-response-v1.json": "13e3eb16e2606b8085751e8c930660145732df49a5cef5dba6a28291a1edc29a",
  "domains-v1.json": "4346776b7aaee1e8cbfece2228a3fe93a38891533525ccf4f85d2d91a58f7e1b",
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

test("TAG names field-sync-v1.4.0 and a commit", () => {
  expect(readFileSync(join(dir, "TAG"), "utf8").trim()).toMatch(/^field-sync-v1\.4\.0 [0-9a-f]{40}$/);
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
