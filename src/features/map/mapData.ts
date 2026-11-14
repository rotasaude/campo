// What the map screen draws, read from the local database in one go: the map
// file the tablet has (or none) and one point per household that has a
// location, coloured by what there is to do there today.
import type { HouseholdBody, WhoItem } from "../../contract";
import type { Db } from "../../db/types";
import { readMapFile, type MapFile } from "../../map/download";
import { householdFeatures, type HouseholdFeatureCollection, type HouseholdPoint } from "../../map/householdLayer";
import { cityToday } from "../../sync/clock";

export interface MapData { file: MapFile | null; points: HouseholdFeatureCollection }

export const MAP_TABLES = ["map_file", "households", "who_to_visit", "local_visits", "meta"];

// What a visit made on this tablet keeps for the screens: where it was. `household` is the household's
// local key or server id; null for a visit to a place with no registration.
export interface LocalVisitSummary { household: string | null }

export async function loadMapData(db: Db, now: number): Promise<MapData> {
  const rows = await db.all<{ key: string; id: string | null; body: string; local_body: string | null }>(
    "SELECT key, id, body, local_body FROM households WHERE has_location = 1 OR local_body IS NOT NULL");
  const points: HouseholdPoint[] = rows.map((row) => {
    // What the person edited on the tablet and has not sent yet is what they expect to see.
    const body = JSON.parse(row.local_body ?? row.body) as Pick<HouseholdBody, "location">;
    const at = body.location ?? null;
    return { key: row.key, id: row.id, location: at === null ? null : { latitude: at.latitude, longitude: at.longitude } };
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
