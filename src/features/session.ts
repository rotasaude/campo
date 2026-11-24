// What the screens ask the session: who is using the tablet and what they may do here.
import type { SessionResponse } from "../contract";
import type { Db } from "../db/types";
import { ENDEMIC_AGENT_CBO } from "../rules/vectorInspection";
import { cityToday } from "../sync/clock";
import type { Reference } from "../sync/reference";

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

// Q13(1): the property types the endemic agent registers — the api's non-residential list (HomeVisits::Catalog::
// NON_RESIDENTIAL): shop, vacant lot, strategic point, school, day-care, religious establishment, CASAI.
export const AGENT_PROPERTY_TYPES = ["2", "3", "4", "5", "6", "12", "13"] as const;

// The endemic agent with the vector_control and the registry on: he registers the non-residential properties of the
// micro-areas assigned to him (the session's), never a family, a resident or a home (TerritoryRegistry::Access).
export function agentRegistersNonResidential(session: SessionResponse | null): boolean {
  return session !== null && session.features.vector_control === true && session.features.territory_registry === true
    && session.professional.cbo === ENDEMIC_AGENT_CBO;
}

// Who creates or edits this household here: the ACS, any type; the endemic agent, a new one (null) or a non-residential
// one. Families and individual registrations stay with canEditRegistry.
export function canEditHousehold(session: SessionResponse | null, propertyType: string | null): boolean {
  if (canEditRegistry(session)) return true;
  return agentRegistersNonResidential(session) && (propertyType === null || (AGENT_PROPERTY_TYPES as readonly string[]).includes(propertyType));
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

// Who installs and collects ovitraps (Task 9): the endemic agent with the switch on (the api: vector gate usable and the
// 515140, else feature_disabled or cbo_not_allowed). The installation needs no vector domains; without them the
// collection's window is left to the api.
export function canUseOvitraps(session: SessionResponse | null): boolean {
  return vectorControlOn(session) && session?.professional.cbo === ENDEMIC_AGENT_CBO;
}

// The city's zoonoses switch (absent = off): Zoonoses::Gate.field_usable? (Q10).
export function zoonosesOn(session: SessionResponse | null): boolean {
  return session?.features.zoonoses === true;
}

// Who works with animals in the field: the endemic agent and the ACS (the api's registrar CBOs).
export const ZOONOSES_CBOS = [ENDEMIC_AGENT_CBO, ACS_CBO] as const;

// The zoonoses screens: the switch on, one of the two CBOs and the reference's zoonoses domains in hand. Without the
// domains there are no screens. The other CBOs see nothing new.
export function canUseZoonoses(session: SessionResponse | null, reference: Reference | null): boolean {
  return zoonosesOn(session) && (ZOONOSES_CBOS as readonly string[]).includes(session?.professional.cbo ?? "")
    && (reference?.zoonosesDomains ?? null) !== null;
}

// Only the endemic agent collects blood for the leishmaniasis survey.
export function canCollectLeish(session: SessionResponse | null, reference: Reference | null): boolean {
  return canUseZoonoses(session, reference) && session?.professional.cbo === ENDEMIC_AGENT_CBO;
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
