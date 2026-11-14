// What the screens ask the session: who is using the tablet and what they may do here.
import type { SessionResponse } from "../contract";
import type { Db } from "../db/types";

export const ACS_CBO = "515105";

export async function loadSession(db: Db): Promise<SessionResponse | null> {
  const row = await db.get<{ body: string }>("SELECT body FROM session WHERE id = 1");
  return row ? (JSON.parse(row.body) as SessionResponse) : null;
}

// Decision 22: the registry is written in the app only by the community health agent, and only where the city has it on.
// Everybody else reads.
export function canEditRegistry(session: SessionResponse | null): boolean {
  return session !== null && session.features.territory_registry === true && session.professional.cbo === ACS_CBO;
}

export interface MyMicroArea { id: string; code: string; name: string; teamId: string }
export function myMicroAreas(session: SessionResponse | null): MyMicroArea[] {
  return (session?.teams ?? []).flatMap((team) => team.micro_areas.map((area) => ({ id: area.id, code: area.code, name: area.name, teamId: team.id })));
}
