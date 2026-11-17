// What the home screen shows, read from the local database in one go. Counts
// only: no name, no address. The dates are written in the city's clock.
import type { SessionResponse } from "../../contract";
import type { Db } from "../../db/types";
import { formatCityDate, formatCityDateTime, needsClockWarning } from "../../sync/clock";
import { referenceNeedsAppUpdate } from "../../sync/reference";
import { TERRITORY_MAX_DAYS, territoryAge } from "../../sync/retention";
import { HIGH_WATER_KEY, trustedTime } from "../../sync/trustedTime";

export interface HomeData {
  microAreas: { id: string; code: string; name: string }[];
  toVisit: number;
  // Waiting to go by themselves; waiting for the person; waiting for a choice between the tablet and the station.
  pending: number; attention: number; conflicts: number;
  lastSync: string | null;
  territoryWarning: string | null;
  clockWarning: string | null;
  appUpdate: boolean;
  visitsOff: boolean;
  // The collective activity is offered to every tablet of a city that has it on; the api decides who may register.
  activitiesOn: boolean;
  // The households and the map are the territory registry's: they follow its own switch, not the visit's (Q82).
  registryOn: boolean;
}

const DAY_MS = 86_400_000;

export async function loadHome(db: Db, now: number): Promise<HomeData> {
  const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta")).map((row) => [row.key, row.value]));
  const sessionRow = await db.get<{ body: string }>("SELECT body FROM session WHERE id = 1");
  const session = sessionRow ? (JSON.parse(sessionRow.body) as SessionResponse) : null;
  const offset = Number(meta.get("city_offset_min") ?? 0) || 0;
  const skew = Number(meta.get("clock_skew_ms") ?? 0) || 0;
  const lastOk = meta.get("last_download_ok_at") ?? null;

  const states = new Map((await db.all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM outbox GROUP BY state")).map((row) => [row.state, row.n]));
  const count = (...names: string[]) => names.reduce((sum, name) => sum + (states.get(name) ?? 0), 0);
  const who = await db.all<{ people: string }>("SELECT people FROM who_to_visit");

  // The server's day, never before the latest time seen (campo#2); read only, the round is the one that moves it.
  const highWater = Number(meta.get(HIGH_WATER_KEY) ?? NaN);
  const age = territoryAge(lastOk, trustedTime(now, skew, Number.isFinite(highWater) ? highWater : null));
  const limit = lastOk === null ? null : formatCityDate(new Date(Date.parse(lastOk) + TERRITORY_MAX_DAYS * DAY_MS).toISOString(), offset);

  return {
    microAreas: (session?.teams ?? []).flatMap((team) => team.micro_areas.map((area) => ({ id: area.id, code: area.code, name: area.name }))),
    toVisit: who.reduce((sum, row) => sum + (JSON.parse(row.people) as unknown[]).length, 0),
    pending: count("pending", "sending", "blocked"), attention: count("needs_attention"), conflicts: count("conflict"),
    lastSync: formatCityDateTime(lastOk, offset),
    territoryWarning: age.warn && limit !== null ? `Sincronize até ${limit}: depois disso o território some do tablet` : null,
    clockWarning: needsClockWarning(skew) ? `O relógio do tablet está ${Math.round(Math.abs(skew) / 60_000)} min diferente do servidor` : null,
    appUpdate: await referenceNeedsAppUpdate(db),
    visitsOff: session !== null && session.features.home_visits === false,
    activitiesOn: session !== null && session.features.collective_activities === true,
    registryOn: session !== null && session.features.territory_registry === true,
  };
}
