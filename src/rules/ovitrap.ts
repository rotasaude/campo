// Ported from apps/dashboard/src/lib/vectorControl.ts (installProblems, collectionProblems, conditionLabel) and
// apps/dashboard/src/modules/FieldOvitraps.tsx (paddleWindowText, OVITRAP_TARGET_DAYS), dashboard main 2e3a2a9: the same
// signatures, order, `path` and phrases (Q76 of 24c; Q9, Q11 of 35a). The app does not write these phrases; a change goes
// to the dashboard first. The api (apps/api VectorControl::InstallOvitrap and ::CollectOvitrap, main 85dc80ee) decides;
// here only what it would refuse is refused before, with the same `path`, and the list starts with the api's first error.
//
// numberTaken is the tablet's own: the api refuses a number of another active ovitrap, without case
// (idx_ovitraps_number = lower(number) among the active) — ovitrap_number_taken at `number` (Q23). The tablet knows the
// active ovitraps of its scope and the installations still in its line; the server may know others.
import { fmtDay } from "./homeVisit";
import { addDays } from "./vectorDue";
import { VECTOR_ERRORS, type VectorErrorCode } from "./vectorErrors";

export type ReadingCondition = "ok" | "damaged" | "lost" | "dry";
export const READING_CONDITIONS: readonly ReadingCondition[] = ["ok", "damaged", "lost", "dry"];

// `code`: the api's code when it has one (with the table's phrase); null when the api would answer `invalid_request`.
export interface OvitrapProblem { code: string | null; path: string; text: string }

const DAY = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// AAAA-MM-DD that exists (the api's Date.strptime refuses 30 February); else null.
function isoDay(raw: string): number | null {
  const m = DATE.exec(raw);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === raw ? t : null;
}
const daysBetween = (from: number, to: number): number => Math.round((to - from) / DAY);
const coded = (code: VectorErrorCode, path: string): OvitrapProblem => ({ code, path, text: VECTOR_ERRORS[code] });
const local = (path: string, text: string): OvitrapProblem => ({ code: null, path, text });

// InstallOvitrap, in the api's order: number (Q7(6)) and date (invalid_request), then the profile's block and the consent.
// `householdHasBlock: null` = profile not read yet (not checked).
const OVITRAP_NUMBER = /^[0-9A-Za-z-]{1,12}$/;
export function installProblems(
  d: { number: string; consent: boolean; installedOn: string; householdHasBlock: boolean | null }, today: string,
): OvitrapProblem[] {
  const out: OvitrapProblem[] = [];
  if (!OVITRAP_NUMBER.test(d.number)) out.push(local("number", "número da ovitrampa: de 1 a 12 letras, dígitos ou hífen, sem espaço"));
  const installed = isoDay(d.installedOn);
  if (installed === null || d.installedOn > today) out.push(local("installed_on", "informe a data de instalação, até hoje"));
  if (d.householdHasBlock === false) out.push(coded("household_without_block", "household_id"));
  if (!d.consent) out.push(coded("consent_required", "consent"));
  return out;
}

// CollectOvitrap: date (up to today) and condition (invalid_request), then the paddle's window in calendar days
// (`collected_on − installed_on` in [min, max], Q9/D-11). `installedOn` is the open reading's.
export function collectionProblems(
  d: { installedOn: string; collectedOn: string; condition: ReadingCondition | null },
  p: { ovitrap_collection_days_min: number; ovitrap_collection_days_max: number }, today: string,
): OvitrapProblem[] {
  const out: OvitrapProblem[] = [];
  const collected = isoDay(d.collectedOn);
  const dateOk = collected !== null && d.collectedOn <= today;
  if (!dateOk) out.push(local("collected_on", "informe a data da coleta, até hoje"));
  if (!READING_CONDITIONS.includes(d.condition as ReadingCondition)) out.push(local("condition", "escolha a condição da palheta"));
  const installed = isoDay(d.installedOn);
  if (dateOk && collected !== null && installed !== null) {
    const days = daysBetween(installed, collected);
    if (days < p.ovitrap_collection_days_min || days > p.ovitrap_collection_days_max) out.push(coded("collection_out_of_range", "collected_on"));
  }
  return out;
}

// The tablet's check of ovitrap_number_taken: `taken` are the numbers of the active ovitraps of the scope and of the
// installations in the line (the one being corrected left out by the caller). Without case, as the api's index.
export function numberTaken(number: string, taken: readonly string[]): boolean {
  const wanted = number.toLowerCase();
  return taken.some((other) => other.toLowerCase() === wanted);
}

// The dashboard's conditionLabel; an unknown code shows as it is.
const CONDITION: Record<string, string> = { ok: "em bom estado", damaged: "avariada", lost: "perdida", dry: "seca" };
export const conditionLabel = (code: string): string => (Object.prototype.hasOwnProperty.call(CONDITION, code) ? CONDITION[code] : code);

// Contract §6: the 5-day target is guidance on screen (the api only checks min and max).
export const OVITRAP_TARGET_DAYS = 5;

const dayMonth = (iso: string): string => fmtDay(iso).slice(0, 5);

// "palheta desde 10/11/2026 — colete entre 13/11 e 20/11 (ideal 15/11)"; without the parameters, only the installation.
export function paddleWindowText(installedOn: string, p: { ovitrap_collection_days_min: number; ovitrap_collection_days_max: number } | null): string {
  const since = `palheta desde ${fmtDay(installedOn)}`;
  if (!p) return since;
  const min = p.ovitrap_collection_days_min;
  const max = p.ovitrap_collection_days_max;
  const ideal = Math.min(Math.max(OVITRAP_TARGET_DAYS, min), max);
  return `${since} — colete entre ${dayMonth(addDays(installedOn, min))} e ${dayMonth(addDays(installedOn, max))} (ideal ${dayMonth(addDays(installedOn, ideal))})`;
}
