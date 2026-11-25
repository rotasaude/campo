// "Coleiras a trocar" (35b; contract Q23): the active dogs of the session's households whose collar falls due within 15
// days (the overdue ones too), a list of its own in the animals area. It is NOT part of "Imóveis a visitar" (vector/): a
// collar is not a reason for a visit of the endemic agent. The dashboard's rule: "collars to replace counts only active
// dogs". The date is the row's collar_due_on (the server's), with a collar still in the line laid on top by readAnimals.
// No tutor, no microchip: the animal's name, the household's short address and the date.
import type { Db } from "../../db/types";
import { addressShort, listHouseholds } from "../households/view";
import { loadReference } from "../../sync/reference";
import { canUseZoonoses, cityTodayOf, loadSession, myMicroAreas } from "../session";
import { animalsContext, readAnimals } from "./view";

export const COLLAR_DUE_DAYS = 15;
export const COLLARS_TABLES = ["animals", "outbox", "households", "reference", "session"];

export interface CollarDue { animalKey: string; animalName: string | null; householdKey: string; address: string; dueOn: string }

function plusDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

export async function loadCollarsDue(db: Db, now: number): Promise<CollarDue[]> {
  const session = await loadSession(db);
  const reference = await loadReference(db).catch(() => null);
  if (!canUseZoonoses(session, reference)) return [];
  const limit = plusDays(await cityTodayOf(db, now), COLLAR_DUE_DAYS);
  const dict = reference?.dictionaries ?? null;
  // The line and the domains once for the whole list, and only the households that have a dog.
  const context = await animalsContext(db, reference);
  const withDogs = new Set((await db.all<{ household_key: string }>("SELECT DISTINCT household_key FROM animals WHERE species = 'dog'")).map((r) => r.household_key));
  const out: CollarDue[] = [];
  for (const area of myMicroAreas(session)) {
    for (const household of await listHouseholds(db, area.id)) {
      if (household.body.status !== "active" || !withDogs.has(household.key)) continue;
      const address = addressShort(household.body, dict);
      for (const animal of await readAnimals(db, household.key, context)) {
        if (animal.species !== "dog" || animal.status !== "active" || animal.collarDueOn === null || animal.collarDueOn > limit) continue;
        out.push({ animalKey: animal.key, animalName: animal.name, householdKey: household.key, address, dueOn: animal.collarDueOn });
      }
    }
  }
  return out.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.animalKey < b.animalKey ? -1 : a.animalKey > b.animalKey ? 1 : 0));
}
