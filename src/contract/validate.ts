// Test support only: the app never validates against the schema at run time
// (the api does). Ajv 2020 with multipleOfPrecision 8 gives the same verdict as
// the api's json_schemer on coordinates with 8 decimals (Q49).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

export type SchemaName = "session-response" | "upload-request" | "upload-response" | "changes-response" | "reference-response";

const NAMES: SchemaName[] = ["session-response", "upload-request", "upload-response", "changes-response", "reference-response"];
const dir = join(__dirname, "../../contracts/field-sync");

let ajv: Ajv2020 | null = null;
const ids = new Map<SchemaName, string>();

function compiled(): Ajv2020 {
  if (ajv) return ajv;
  const instance = new Ajv2020({ strict: false, allErrors: true, multipleOfPrecision: 8 });
  addFormats(instance);
  for (const name of NAMES) {
    const schema = JSON.parse(readFileSync(join(dir, `${name}-v1.json`), "utf8")) as { $id: string };
    instance.addSchema(schema);
    ids.set(name, schema.$id);
  }
  ajv = instance;
  return instance;
}

// Throws naming only pointers and keywords: the bodies carry people, reasons and measurements.
export function expectValid(schema: SchemaName, value: unknown): void {
  const validate = compiled().getSchema(ids.get(schema) ?? "");
  if (!validate) throw new Error(`unknown schema ${schema}`);
  if (validate(value)) return;
  const problems = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.keyword}`);
  throw new Error(`${schema}: ${[...new Set(problems)].join("; ")}`);
}
