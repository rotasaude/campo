// What the map screen asks of whatever draws the map. The screen decides what
// is shown; the drawing (MapLibre, in src/app/mapCanvas.tsx) only obeys — and
// the tests put a fake in its place.
import type { HouseholdFeatureCollection, HouseholdStatus } from "./householdLayer";
import type { MapBounds } from "./pmtilesHeader";
import type { MapStyle } from "./style";

export interface MapPoint { latitude: number; longitude: number }
export interface MapTap extends MapPoint { zoom: number }

export interface MapCanvasProps {
  mapStyle: MapStyle;
  points: HouseholdFeatureCollection;
  colors: Record<HouseholdStatus, string> & { cluster: string; clusterText: string; outline: string; me: string; picked: string };
  // Where the map opens: the box the map file covers. Null: the drawing's own start.
  bounds: MapBounds | null;
  // The camera goes there each time this object changes; null leaves it where the person put it.
  focus: MapTap | null;
  // The agent's own position (after "Minha posição") and the point being marked for a household.
  me: MapPoint | null;
  picked: MapPoint | null;
  onPressMap?(at: MapTap): void;
  onPressHousehold?(key: string): void;
}
