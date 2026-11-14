// The households on the map: one point per household that has a location,
// coloured by what the agent has to do there today. The feature carries the
// household's local key and its status — nothing about who lives there: no
// name, no document, no reason for the visit.
export interface HouseholdPoint {
  key: string;
  // The server id; null while the household only exists on the tablet.
  id: string | null;
  location: { latitude: number; longitude: number } | null;
}

export type HouseholdStatus = "visited_today" | "to_visit" | "registered";
export interface HouseholdFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { key: string; status: HouseholdStatus };
}
export interface HouseholdFeatureCollection { type: "FeatureCollection"; features: HouseholdFeature[] }

// `whoIds` and `visitedToday` may name a household by its server id or by its local key.
export function householdFeatures(rows: HouseholdPoint[], whoIds: ReadonlySet<string>, visitedToday: ReadonlySet<string>): HouseholdFeatureCollection {
  const named = (set: ReadonlySet<string>, row: HouseholdPoint) => set.has(row.key) || (row.id !== null && set.has(row.id));
  const features: HouseholdFeature[] = [];
  for (const row of rows) {
    if (row.location === null) continue;
    // Visited today wins: the point stops asking for a visit that was already made.
    const status: HouseholdStatus = named(visitedToday, row) ? "visited_today" : named(whoIds, row) ? "to_visit" : "registered";
    features.push({
      type: "Feature", geometry: { type: "Point", coordinates: [row.location.longitude, row.location.latitude] },
      properties: { key: row.key, status },
    });
  }
  return { type: "FeatureCollection", features };
}
