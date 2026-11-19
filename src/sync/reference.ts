// The offline reference: what the forms need without a network (registration
// dictionaries, neighbourhoods, health units, the team's professionals and the
// domains of the visit and of the activity, and — where the city's vector_control gate is usable — the vector
// control domains of the bulletin, 35a). It has no citizen data.
//
// The session carries `reference_version` (a SHA-256 the api computes); the
// tablet only compares, never recomputes, and downloads again when it changes.
// A reference whose shape the app does not understand is not stored: the
// previous one keeps the forms working.
import type { ReferenceResponse } from "../contract";
import type { Db } from "../db/types";
import { ReferenceShapeError, parseRegistrationDictionaries, type RegistrationDictionaries } from "../rules/dictionaries";
import type { CollectiveDomains, HomeVisitDomains } from "../rules/domains";
import { parseVectorDomains, type VectorControlDomains } from "../rules/vectorDomains";
import type { FieldClient } from "./http";

export interface Reference {
  version: string;
  dictionaries: RegistrationDictionaries;
  neighborhoods: { id: string; name: string }[];
  healthUnits: { id: string; cnes: string | null; name: string }[];
  teamProfessionals: { team_id: string; professional_id: string; name: string; cbo: string; has_cns: boolean }[];
  homeVisitDomains: HomeVisitDomains;
  collectiveDomains: CollectiveDomains;
  // null = the block did not come (gate off in the city) or carries a code this app does not know (Q44(1)): no bulletin.
  vectorDomains: VectorControlDomains | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

function list<T>(raw: unknown, where: string, ok: (row: Record<string, unknown>) => boolean, take: (row: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(raw)) throw new ReferenceShapeError(where);
  return raw.map((row, index) => {
    if (!isObject(row) || !ok(row)) throw new ReferenceShapeError(`${where}[${index}]`);
    return take(row);
  });
}

// Throws ReferenceShapeError. The two domain blocks are taken as the api's own shape (the contract only requires their keys).
export function parseReference(raw: ReferenceResponse): Reference {
  const body = raw as unknown as Record<string, unknown>;
  if (!isObject(body) || !isText(body.reference_version)) throw new ReferenceShapeError("reference_version");
  if (!isObject(body.home_visit_domains)) throw new ReferenceShapeError("home_visit_domains");
  if (!isObject(body.collective_activity_domains)) throw new ReferenceShapeError("collective_activity_domains");
  return {
    version: body.reference_version,
    dictionaries: parseRegistrationDictionaries(body.registration_dictionaries, body.string_domains),
    neighborhoods: list(body.neighborhoods, "neighborhoods", (r) => isText(r.id) && isText(r.name), (r) => ({ id: r.id as string, name: r.name as string })),
    healthUnits: list(body.health_units, "health_units", (r) => isText(r.id) && isText(r.name) && (r.cnes === null || isText(r.cnes)),
      (r) => ({ id: r.id as string, cnes: r.cnes as string | null, name: r.name as string })),
    teamProfessionals: list(body.team_professionals, "team_professionals",
      (r) => isText(r.team_id) && isText(r.professional_id) && isText(r.name) && isText(r.cbo) && typeof r.has_cns === "boolean",
      (r) => ({ team_id: r.team_id as string, professional_id: r.professional_id as string, name: r.name as string, cbo: r.cbo as string, has_cns: r.has_cns as boolean })),
    homeVisitDomains: body.home_visit_domains as unknown as HomeVisitDomains,
    collectiveDomains: body.collective_activity_domains as unknown as CollectiveDomains,
    vectorDomains: parseVectorDomains(body.vector_control_domains),
  };
}

// The shapes the rules ported from the dashboard expect (Q6).
export function healthUnitOptions(ref: Reference): { id: string; name: string; cnes: string | null; has_cnes: boolean }[] {
  return ref.healthUnits.map((unit) => ({ id: unit.id, name: unit.name, cnes: unit.cnes, has_cnes: unit.cnes !== null }));
}
// The collective domains are one block for the city; who may take part comes from the team's professionals (Q7).
export function professionalOptions(ref: Reference, teamId: string): { id: string; name: string; cbo: string; has_cns: boolean }[] {
  return ref.teamProfessionals.filter((p) => p.team_id === teamId).map((p) => ({ id: p.professional_id, name: p.name, cbo: p.cbo, has_cns: p.has_cns }));
}

export async function loadReference(db: Db): Promise<Reference | null> {
  const row = await db.get<{ body: string }>("SELECT body FROM reference WHERE id = 1");
  return row ? parseReference(JSON.parse(row.body) as ReferenceResponse) : null;
}

// Shown by the home screen while `referenceNeedsAppUpdate` is true (Q71).
export const APP_UPDATE_NOTICE = "Atualize o app: há novidades no cadastro que esta versão não conhece. O app segue funcionando com as regras anteriores.";
const REFUSED = "reference_refused_version";

// True while the server's reference is one this version of the app could not read: the forms keep the previous one.
export async function referenceNeedsAppUpdate(db: Db): Promise<boolean> {
  return (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [REFUSED])) !== null;
}

// A FieldHttpError goes up to the round. "kept_previous": the answer came, but in a shape the app does not read —
// the version is remembered, so it is not downloaded again on every round, and the person is told to update the app.
export async function refreshReference(db: Db, client: Pick<FieldClient, "reference">, sessionVersion: string): Promise<"unchanged" | "updated" | "kept_previous"> {
  const stored = await db.get<{ version: string }>("SELECT version FROM reference WHERE id = 1");
  if (stored?.version === sessionVersion) {
    await db.run("DELETE FROM meta WHERE key = ?", [REFUSED]);
    return "unchanged";
  }
  const refused = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [REFUSED]);
  if (refused?.value === sessionVersion) return "kept_previous";

  const body = await client.reference();
  let version: string;
  try {
    version = parseReference(body).version;
  } catch (err) {
    if (!(err instanceof ReferenceShapeError)) throw err;
    await db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [REFUSED, sessionVersion]);
    return "kept_previous";
  }
  await db.tx(async (tx) => {
    await tx.run("INSERT INTO reference (id, version, body) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version, body = excluded.body",
      [version, JSON.stringify(body)]);
    await tx.run("DELETE FROM meta WHERE key = ?", [REFUSED]);
  });
  return "updated";
}
