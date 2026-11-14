#!/usr/bin/env node
// Generates src/contract/generated/*.ts from the pinned copy of the contract
// (contracts/field-sync, tag field-sync-v1.2.0). The generated files are
// committed; `--check` recompiles in memory and fails if they differ.
// Usage: node scripts/contract-types.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jsonSchemaToTypescript from "json-schema-to-typescript";

const { compile } = jsonSchemaToTypescript;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contract = join(root, "contracts/field-sync");
const out = join(root, "src/contract/generated");
const banner = "// gerado de contracts/field-sync (field-sync-v1.2.0) — não editar";

// [schema file, generated file, root type]
const SCHEMAS = [
  ["session-response-v1.json", "session.ts", "SessionResponse"],
  ["upload-request-v1.json", "uploadRequest.ts", "UploadRequest"],
  ["upload-response-v1.json", "uploadResponse.ts", "UploadResponse"],
  ["changes-response-v1.json", "changes.ts", "ChangesResponse"],
  ["reference-response-v1.json", "reference.ts", "ReferenceResponse"],
];

const read = (file) => JSON.parse(readFileSync(join(contract, file), "utf8"));

export async function generate() {
  const files = {};
  for (const [schemaFile, target, name] of SCHEMAS) {
    // The contract titles are dotted identifiers; the root type takes the app's name instead.
    const schema = { ...read(schemaFile), title: name };
    files[target] = await compile(schema, name, {
      bannerComment: banner,
      additionalProperties: false,
      strictIndexSignatures: true,
      // The item bodies hang from if/then, which the compiler does not follow: emit every $def.
      unreachableDefinitions: true,
    });
  }
  // domains-v1.json is data, not a schema: it becomes a typed constant.
  files["domains.ts"] = `${banner}\n\nexport const domains = ${JSON.stringify(read("domains-v1.json"), null, 2)} as const;\n`;
  return files;
}

const files = await generate();
const names = Object.keys(files);
if (process.argv.includes("--check")) {
  const stale = names.filter((name) => {
    try { return readFileSync(join(out, name), "utf8") !== files[name]; } catch { return true; }
  });
  if (stale.length > 0) {
    process.stderr.write(`stale generated files: ${stale.join(", ")} — run node scripts/contract-types.mjs\n`);
    process.exit(1);
  }
  process.stdout.write(`${names.length} files up to date\n`);
} else {
  mkdirSync(out, { recursive: true });
  for (const name of names) writeFileSync(join(out, name), files[name]);
  process.stdout.write(`${names.length} files written to src/contract/generated\n`);
}
