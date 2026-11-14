// What the map screen draws, read from the local database in one go: the map
// file the tablet has (or none) and one point per household that has a
// location, coloured by what there is to do there today.
import type { WhoItem } from "../../contract";
import type { Db } from "../../db/types";
import { readMapFile, type MapFile } from "../../map/download";
import { householdFeatures, type HouseholdFeatureCollection, type HouseholdPoint } from "../../map/householdLayer";
import { cityToday } from "../../sync/clock";
import { listHouseholds } from "../households/view";

export interface MapData { file: MapFile | null; points: HouseholdFeatureCollection }

export const MAP_TABLES = ["map_file", "households", "outbox", "who_to_visit", "local_visits", "meta"];

// What a visit made on this tablet keeps for the screens: where it was. `household` is the household's
// local key or server id; null for a visit to a place with no registration.
export interface LocalVisitSummary { household: string | null }

export async function loadMapData(db: Db, now: number): Promise<MapData> {
  // As the screens show them: a point the person marked and has not sent yet is the one drawn.
  const points: HouseholdPoint[] = (await listHouseholds(db)).map((view) => {
    const at = view.body.location ?? null;
    return { key: view.key, id: view.id, location: at === null ? null : { latitude: at.latitude, longitude: at.longitude } };
  });

  const who = new Set<string>();
  for (const row of await db.all<{ people: string }>("SELECT people FROM who_to_visit")) {
    for (const person of JSON.parse(row.people) as WhoItem[]) if (person.household) who.add(person.household.id);
  }

  const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('city_offset_min', 'clock_skew_ms')")).map((row) => [row.key, row.value]));
  const today = cityToday(now, Number(meta.get("clock_skew_ms") ?? 0) || 0, Number(meta.get("city_offset_min") ?? 0) || 0);
  const visited = new Set<string>();
  for (const row of await db.all<{ summary: string }>("SELECT summary FROM local_visits WHERE city_day = ? AND state <> 'withdrawn'", [today])) {
    const household = (JSON.parse(row.summary) as Partial<LocalVisitSummary>).household;
    if (typeof household === "string") visited.add(household);
  }

  return { file: await readMapFile(db), points: householdFeatures(points, who, visited) };
}
