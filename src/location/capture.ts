// The position of a household or of a visit. Two sources: the tablet's GPS —
// only a precise reading counts, a bad one is worse than none — and a point
// the agent marks on the map. Coordinates never go to a log, an error message
// or a URL: they leave this module only inside the item's body.
import type { Location } from "../contract";

export const GPS_TIMEOUT_MS = 15_000;
export const MAX_ACCURACY_M = 50;

export interface LocationPort {
  // Asks for the permission when it was not given yet. `precise`: Android's fine location (not the approximate one).
  permission(): Promise<{ granted: boolean; precise: boolean }>;
  // One high-accuracy reading; rejects when the device gives none. `accuracy` in metres.
  current(): Promise<{ latitude: number; longitude: number; accuracy: number | null }>;
}

// The contract takes at most 8 decimals in a coordinate and 1 in the accuracy (0 to 10000 m).
export const roundCoord = (x: number): number => Math.round(x * 1e8) / 1e8;
export const roundAccuracy = (m: number): number => Math.min(10000, Math.max(0, Math.round(m * 10) / 10));

// A precise GPS reading, or null: permission denied or approximate, no answer in 15 s, accuracy unknown or worse than 50 m.
export async function captureGps(loc: LocationPort): Promise<Location | null> {
  try {
    const permission = await loc.permission();
    if (!permission.granted || !permission.precise) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), GPS_TIMEOUT_MS); });
    const fix = await Promise.race([loc.current(), timeout]).finally(() => clearTimeout(timer));
    if (fix === null || fix.accuracy === null || !Number.isFinite(fix.accuracy) || fix.accuracy > MAX_ACCURACY_M) return null;
    return { latitude: roundCoord(fix.latitude), longitude: roundCoord(fix.longitude), accuracy_m: roundAccuracy(fix.accuracy), source: "gps" };
  } catch {
    return null;
  }
}

// A point marked on the map. accuracy_m is the resolution of the touch: how many metres 24 px are at that zoom and latitude.
export function mapTapLocation(latitude: number, longitude: number, zoom: number): Location {
  const metresPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
  return { latitude: roundCoord(latitude), longitude: roundCoord(longitude), accuracy_m: roundAccuracy(metresPerPixel * 24), source: "map" };
}
