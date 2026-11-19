// What the screens ask the session: who is using the tablet and what they may do here.
import type { SessionResponse } from "../contract";
import type { Db } from "../db/types";
import { cityToday } from "../sync/clock";
import type { Reference } from "../sync/reference";

export const ACS_CBO = "515105";
// The endemic agent (ACE). Moves to src/rules/vectorInspection.ts in Task 6.
const ENDEMIC_AGENT_CBO = "515140";

export async function loadSession(db: Db): Promise<SessionResponse | null> {
  const row = await db.get<{ body: string }>("SELECT body FROM session WHERE id = 1");
  return row ? (JSON.parse(row.body) as SessionResponse) : null;
}

// Decision 22: the registry is written in the app only by the community health agent, and only where the city has it on.
// Everybody else reads.
export function canEditRegistry(session: SessionResponse | null): boolean {
  return session !== null && session.features.territory_registry === true && session.professional.cbo === ACS_CBO;
}

// The city's vector_control switch (absent = off).
export function vectorControlOn(session: SessionResponse | null): boolean {
  return session?.features.vector_control === true;
}

// Who records the vector control bulletin at the visit: the endemic agent, with the switch on and the reference's
// vector domains in hand. Without the domains the bulletin is not shown. The ACS and the other CBOs see nothing new.
export function canRecordInspection(session: SessionResponse | null, reference: Reference | null): boolean {
  return vectorControlOn(session) && session?.professional.cbo === ENDEMIC_AGENT_CBO && (reference?.vectorDomains ?? null) !== null;
}

export interface MyMicroArea { id: string; code: string; name: string; teamId: string }
export function myMicroAreas(session: SessionResponse | null): MyMicroArea[] {
  return (session?.teams ?? []).flatMap((team) => team.micro_areas.map((area) => ({ id: area.id, code: area.code, name: area.name, teamId: team.id })));
}

// Today in the city (AAAA-MM-DD): the tablet's clock corrected by what the server said.
export async function cityTodayOf(db: Db, now: number): Promise<string> {
  const meta = new Map((await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('city_offset_min', 'clock_skew_ms')")).map((row) => [row.key, row.value]));
  return cityToday(now, Number(meta.get("clock_skew_ms") ?? 0) || 0, Number(meta.get("city_offset_min") ?? 0) || 0);
}
