// Field-by-field merge (decision 3B). When the station changed a record the
// tablet was editing, the api answers stale_version with the current body;
// the tablet keeps what only one side changed and asks the person about the
// rest. Three sides: `base` (what the person saw when the edit began), `local`
// (what the tablet wants to send) and `current` (what the station has now).
//
// A field is each top-level key. Inside a dictionary section that is an object
// on the three sides, each key of the section is a field ("section.key").
// Everything else — lists, address, location, a section that is null or absent
// on some side — is one field: half an address from each side is no address.

export const DICTIONARY_SECTIONS = ["living_conditions", "identification", "sociodemographic", "health_conditions", "street_situation"] as const;

export interface ConflictField { path: string; station: unknown; tablet: unknown }

type Body = Record<string, unknown>;
const ABSENT = "∅";

// JSON with sorted keys: the same value written in another key order is the same value. Absent is not null.
export function canonical(value: unknown): string {
  if (value === undefined) return ABSENT;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Body;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

const isObject = (value: unknown): value is Body => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const keysOf = (...sides: Body[]) => [...new Set(sides.flatMap((side) => Object.keys(side)))];

// One field: who changed it decides; both changed differently is a conflict (the body carries the station's until the choice).
function mergeField(path: string, base: unknown, local: unknown, current: unknown, conflicts: ConflictField[]): unknown {
  if (same(local, base)) return current;
  if (same(current, base)) return local;
  if (same(local, current)) return local;
  conflicts.push({ path, station: current, tablet: local });
  return current;
}

function mergeKeys(prefix: string, base: Body, local: Body, current: Body, conflicts: ConflictField[]): Body {
  const out: Body = {};
  for (const key of keysOf(base, local, current)) {
    const value = mergeField(`${prefix}${key}`, base[key], local[key], current[key], conflicts);
    if (value !== undefined) out[key] = value; // a key absent in the result is left out
  }
  return out;
}

export function merge(base: Body, local: Body, current: Body): { body: Body; conflicts: ConflictField[] } {
  const conflicts: ConflictField[] = [];
  const body: Body = {};
  const sections: readonly string[] = DICTIONARY_SECTIONS;
  for (const key of keysOf(base, local, current)) {
    const [b, l, c] = [base[key], local[key], current[key]];
    const value = sections.includes(key) && isObject(b) && isObject(l) && isObject(c)
      ? mergeKeys(`${key}.`, b, l, c, conflicts)
      : mergeField(key, b, l, c, conflicts);
    if (value !== undefined) body[key] = value;
  }
  return { body, conflicts };
}

export class MissingChoiceError extends Error {
  constructor(public paths: string[]) { super("falta escolher um dos lados em cada campo"); }
}

// Applies the person's choice to every conflict. `body` is the merged one (it already carries the station's values).
export function applyChoices(body: Body, conflicts: ConflictField[], choices: Record<string, "station" | "tablet">): Body {
  const missing = conflicts.filter((c) => choices[c.path] !== "station" && choices[c.path] !== "tablet").map((c) => c.path);
  if (missing.length > 0) throw new MissingChoiceError(missing);
  const out = JSON.parse(JSON.stringify(body)) as Body;
  for (const conflict of conflicts) {
    const value = choices[conflict.path] === "tablet" ? conflict.tablet : conflict.station;
    const dot = conflict.path.indexOf(".");
    const [holder, key] = dot < 0 ? [out, conflict.path] : [out[conflict.path.slice(0, dot)] as Body, conflict.path.slice(dot + 1)];
    if (value === undefined) delete holder[key];
    else holder[key] = value;
  }
  return out;
}
