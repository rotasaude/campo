// Test support: the contract's own examples (contracts/field-sync/examples).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const examples = join(__dirname, "../../contracts/field-sync/examples");

export function example<T>(file: string): T {
  return JSON.parse(readFileSync(join(examples, file), "utf8")) as T;
}
