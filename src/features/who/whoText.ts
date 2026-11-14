// The words of "who to visit". The reasons come from the server already
// decided (care line with its practice, registration due, never visited):
// never a diagnosis, a problem or a condition beyond the care line's name.
import type { WhoItem, WhoReason } from "../../contract";

// "2026-11-01" → "01/11/2026" (a calendar day: no time zone involved).
const day = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

export function reasonText(reason: WhoReason): string {
  if (reason.code === "never_visited") return "Nunca visitado";
  const due = typeof reason.due_on === "string" ? day(reason.due_on) : null;
  if (reason.code === "registration_due") {
    return reason.status === "expired" ? `Cadastro vencido desde ${due ?? "—"}` : `Cadastro a vencer em ${due ?? "—"}`;
  }
  // A care line's practice that was never done has no date (Q60 of the 24b).
  const when = due === null ? "nunca feita" : reason.status === "overdue" ? `atrasada desde ${due}` : `até ${due}`;
  return `${reason.care_line}: ${reason.practice} — ${when}`;
}

// Without the age when the patient has no birth date: nothing is shown in its place.
export function personLine(person: Pick<WhoItem, "display_name" | "age">): string {
  if (person.age === null) return person.display_name;
  const age = person.age === 0 ? "menos de 1 ano" : person.age === 1 ? "1 ano" : `${person.age} anos`;
  return `${person.display_name}, ${age}`;
}

export const lastVisitText = (lastVisitOn: string | null): string | null => (lastVisitOn === null ? null : `Última visita: ${day(lastVisitOn)}`);
