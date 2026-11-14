// The duplicate check the tablet can do by itself, offline. Two different
// things: somebody who looks like a person already on this tablet (same
// birth, a name at most two letters away) — a warning, the agent decides; and
// a CPF or CNS already typed in another record that is still in the line — a
// block, because the server would refuse the second one. Everything else
// about duplicates is the server's (duplicate_suspected), when the item goes.
import { outboxRepo } from "../../db/repos/outboxRepo";
import type { Db } from "../../db/types";
import { normalizeText } from "../../sync/text";

export const CPF_USED_HERE = "Este CPF já foi usado em outro cadastro deste tablet";
export const CNS_USED_HERE = "Este CNS já foi usado em outro cadastro deste tablet";
export const NAME_DISTANCE_MAX = 2;

// Levenshtein, on the normalized names.
export function nameDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

export interface SimilarPerson { key: string; display_name: string; birth_date: string | null }

export async function findSimilar(db: Db, q: { full_name: string; birth_date: string; mother_name?: string | null }): Promise<SimilarPerson[]> {
  const name = normalizeText(q.full_name);
  const mother = q.mother_name ? normalizeText(q.mother_name) : "";
  const rows = await db.all<{ key: string; body: string; name_norm: string; birth_date: string | null; mother_norm: string | null }>(
    "SELECT key, body, name_norm, birth_date, mother_norm FROM registrations WHERE birth_date = ?", [q.birth_date]);
  return rows
    .filter((row) => nameDistance(name, row.name_norm) <= NAME_DISTANCE_MAX)
    .filter((row) => mother === "" || !row.mother_norm || row.mother_norm === mother)
    .map((row) => ({ key: row.key, display_name: (JSON.parse(row.body) as { patient: { display_name: string } }).patient.display_name, birth_date: row.birth_date }));
}

const digits = (value: unknown): string => (typeof value === "string" ? value.replace(/\D/g, "") : "");

// `except`: the client_uuid of the item being corrected, which does not clash with itself.
export async function findDocumentClash(db: Db, q: { cpf?: string | null; cns?: string | null }, except?: string): Promise<string | null> {
  const cpf = digits(q.cpf);
  const cns = digits(q.cns);
  if (cpf === "" && cns === "") return null;
  for (const item of await outboxRepo.all(db)) {
    if ((item.type !== "individual_registration" && item.type !== "patient") || item.client_uuid === except) continue;
    const typed = item.body.new_patient as Record<string, unknown> | undefined;
    if (!typed) continue;
    if (cpf !== "" && digits(typed.cpf) === cpf) return CPF_USED_HERE;
    if (cns !== "" && digits(typed.cns) === cns) return CNS_USED_HERE;
  }
  return null;
}
