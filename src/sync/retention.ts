// How long things stay on the tablet. The territory is a copy of the server:
// 30 days without a complete download and it is erased (the person is warned
// from day 25). What the server already accepted leaves the "today" lists the
// next day. The outbox is never erased by time.
import { dbEvents } from "../db/events";
import { territoryRepo } from "../db/repos/territoryRepo";
import type { Db } from "../db/types";
import { wipeTerritory } from "../security/wipe";

export const TERRITORY_MAX_DAYS = 30;
export const TERRITORY_WARN_DAY = 25;
const DAY_MS = 86_400_000;

// `lastOkAt`: when the last download reached the end; null when none ever did (nothing to expire).
export function territoryAge(lastOkAt: string | null, now: number): { days: number | null; warn: boolean; expired: boolean } {
  const last = lastOkAt === null ? NaN : Date.parse(lastOkAt);
  if (Number.isNaN(last)) return { days: null, warn: false, expired: false };
  const days = Math.max(0, Math.floor((now - last) / DAY_MS));
  return { days, warn: days >= TERRITORY_WARN_DAY, expired: days >= TERRITORY_MAX_DAYS };
}

// True when the territory was erased. wipeTerritory also forgets the cursor and the date, so the next download is a full one.
export async function enforceTerritoryAge(db: Db, now: number): Promise<boolean> {
  if (!territoryAge(await territoryRepo.getMeta(db, "last_download_ok_at"), now).expired) return false;
  await wipeTerritory(db);
  territoryRepo.emitTerritory();
  return true;
}

// Visits and activities the server already has, of days before the city's today (decision 27). A withdrawn visit
// goes the same way. What is still pending stays: it is the only record the person has of it.
export async function purgeAccepted(db: Db, cityToday: string): Promise<void> {
  await db.run("DELETE FROM local_visits WHERE state IN ('accepted', 'withdrawn') AND city_day < ?", [cityToday]);
  await db.run("DELETE FROM local_activities WHERE state = 'accepted' AND held_on < ?", [cityToday]);
  dbEvents.emit("local_visits");
  dbEvents.emit("local_activities");
}

const pad = (n: number, size = 2) => String(n).padStart(size, "0");
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// Q65: the registration is due on the day of registered_at plus 24 calendar months (29/02 → 28/02), counted on the
// day as written in registered_at (the city's). Expired from the due day on; due soon in the 60 days before it.
export function validityBand(registeredAt: string, cityToday: string): "valid" | "due_soon" | "expired" {
  const [year, month, day] = registeredAt.slice(0, 10).split("-").map(Number);
  const dueYear = year + 2;
  const due = `${pad(dueYear, 4)}-${pad(month)}-${pad(Math.min(day, daysInMonth(dueYear, month)))}`;
  if (due <= cityToday) return "expired";
  const left = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${cityToday}T00:00:00Z`)) / DAY_MS);
  return left <= 60 ? "due_soon" : "valid";
}
