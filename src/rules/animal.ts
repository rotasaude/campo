// The screen rules of the animal, the vaccine, the collar and the blood collection, ported from the dashboard (main 51b1871:
// src/lib/zoonoses.ts, animalProblems, vaccinationProblems and textProblem from src/lib/homeVisits.ts; the screens ZooAnimals,
// ZooCampaigns and ZooLeish). The rules and the phrases are the dashboard's, none is written here (Q24 of 35b): a refusal the api
// also makes carries its code and says ZOONOSES_ERRORS[code]; one the api would answer with invalid_request has code null and
// the dashboard's local phrase. Each `path` is the one of the item's body, so the screen can mark the field. The limits come from
// the reference (`zoonoses_domains.limits`), never from a constant here.
//
// Not here: the second dose in the same campaign is the api's call alone (Q19); the number of the microchip is checked and
// never kept (§16); toAnimalBody(draft, ctx) is built in src/features/animals/save.ts.
import type { LeishSurveyBody } from "../contract";
import type { AnimalRow } from "../db/repos/zoonosesRepo";
import type { ZoonosesDomains, ZoonosesLimits } from "./zoonosesDomains";
import { ZOONOSES_ERRORS, type ZoonosesErrorCode } from "./zoonosesErrors";

export type ZooProblem = { code: string | null; path: string; text: string };

const coded = (code: ZoonosesErrorCode, path: string): ZooProblem => ({ code, path, text: ZOONOSES_ERRORS[code] });
const local = (path: string, text: string): ZooProblem => ({ code: null, path, text });

// Code points after the trim (the api counts so). The dashboard's textProblem, phrase included.
function textProblem(value: string, min: number, max: number, path: string): ZooProblem | null {
  const n = [...value.trim()].length;
  if (n >= min && n <= max) return null;
  return local(path, min > 0 ? `escreva de ${min} a ${max} caracteres` : `escreva até ${max} caracteres`);
}
const optionalText = (value: string, max: number, path: string): ZooProblem | null => (value.trim() === "" ? null : textProblem(value, 1, max, path));
const push = (out: ZooProblem[], p: ZooProblem | null): void => { if (p) out.push(p); };

// What the animal form holds. `tutorKey` is the id of the tutor's patient, or the client_uuid of one born on the tablet;
// the screen sends it as tutor_patient_id or tutor_client_uuid. `microchip` is "" on an edit (the number goes on creation only).
export interface AnimalDraft {
  species: string; sex: string; size: string; name: string; coat: string; breed: string;
  birthEstimateMonth: string; microchip: string; tutorKey: string | null; community: boolean;
}
export const emptyAnimalDraft = (): AnimalDraft => ({
  species: "", sex: "", size: "", name: "", coat: "", breed: "", birthEstimateMonth: "", microchip: "", tutorKey: null, community: false,
});

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// Q22: name, coat and breed within the limits (blank = absent); microchip of `microchip_digits` digits; a tutor and "community"
// do not go together, and neither is valid ("tutor não identificado"). The birth month is `AAAA-MM`, not after today's month.
export function animalProblems(d: AnimalDraft, limits: ZoonosesLimits, today: string): ZooProblem[] {
  const out: ZooProblem[] = [];
  if (!d.species) out.push(local("species", "escolha a espécie"));
  if (!d.sex) out.push(local("sex", "escolha o sexo"));
  push(out, optionalText(d.name, limits.name_max, "name"));
  push(out, optionalText(d.coat, limits.coat_max, "coat"));
  push(out, optionalText(d.breed, limits.breed_max, "breed"));
  if (d.microchip.trim() !== "" && !new RegExp(`^[0-9]{${limits.microchip_digits}}$`).test(d.microchip)) {
    out.push(local("microchip", `microchip: ${limits.microchip_digits} dígitos, sem espaço`));
  }
  if (d.birthEstimateMonth.trim() !== "") {
    if (!MONTH.test(d.birthEstimateMonth)) out.push(local("birth_estimate_month", "informe uma data válida"));
    else if (d.birthEstimateMonth > today.slice(0, 7)) out.push(coded("date_out_of_range", "birth_estimate_month"));
  }
  if (d.tutorKey && d.community) out.push(local("tutor_patient_id", "animal comunitário não tem tutor — tire um dos dois"));
  return out;
}

// Vaccine: a dog or a cat, active; an open campaign; the adverse-event note only with the event, and within the limits.
// The api answers invalid_request for a species other than dog or cat: the dashboard's phrase for it is the species choice.
export function vaccinationProblems(
  animal: AnimalRow, domains: ZoonosesDomains, d: { adverseEvent: boolean; adverseNote: string | null }
): ZooProblem[] {
  const out: ZooProblem[] = [];
  if (animal.species !== "dog" && animal.species !== "cat") out.push(local("animal_id", "escolha a espécie: cão ou gato"));
  if (animal.status !== "active") out.push(coded("animal_not_active", "animal_id"));
  if (domains.open_campaign === null) out.push(coded("campaign_not_open", "campaign_id"));
  const note = d.adverseNote ?? "";
  if (d.adverseEvent) push(out, textProblem(note, domains.limits.adverse_note_min, domains.limits.adverse_note_max, "adverse_note"));
  else if (note.trim() !== "") out.push(local("adverse_note", "a nota só vale com evento adverso"));
  return out;
}

const dogProblems = (animal: AnimalRow): ZooProblem[] => [
  ...(animal.species !== "dog" ? [coded("animal_not_dog", "animal_id")] : []),
  ...(animal.status !== "active" ? [coded("animal_not_active", "animal_id")] : []),
];

// Collar: a dog, active.
export const collarProblems = (animal: AnimalRow): ZooProblem[] => dogProblems(animal);

// Blood collection: a dog, active; a survey the tablet no longer has (it closed or left the agent's scope) is survey_not_open.
export function collectionProblems(animal: AnimalRow, surveyId: string | null, surveys: LeishSurveyBody[]): ZooProblem[] {
  const out = dogProblems(animal);
  if (surveyId !== null && !surveys.some((s) => s.id === surveyId)) out.push(coded("survey_not_open", "leish_survey_id"));
  return out;
}
