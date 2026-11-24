// Test support for the form screens: a tablet after its first load — session, territory and a reference with the
// complete registration dictionaries (the contract's example carries only an excerpt of them).
import type { ChangesResponse, ReferenceResponse, SessionResponse } from "../contract";
import { example } from "../contract/fixtures";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import fullDictionaries from "../rules/testing/registrationDictionaries.json";
import { COLLECTIVE_DOMAINS } from "../rules/testing/visitFixtures";
import { applyPage } from "../sync/download";
import { enqueue } from "../sync/outbox";
import { referenceFixture } from "../sync/testing";

export const HH = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";
export const AREA = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
export const NEIGHBORHOOD = "c0ffee40-0000-4000-8000-000000000040";

export async function loadedTablet(o: { session?: Partial<SessionResponse>; reference?: Record<string, unknown> } = {}): Promise<Db> {
  const db = await createTestDb();
  const session = { ...example<SessionResponse>("session-acs.json"), ...o.session };
  await db.run("INSERT INTO session (id, body, fetched_at) VALUES (1, ?, '2026-11-14T12:00:00.000Z')", [JSON.stringify(session)]);
  const reference = {
    ...referenceFixture(), string_domains: fullDictionaries.string_domains,
    // The schema of the reference asks for the dictionaries' version (the LEDI release they come from).
    registration_dictionaries: { version: fullDictionaries.ledi_version, ...fullDictionaries.registration_dictionaries },
    // With the rules of each activity type, in the shape the api serves them (CollectiveActivities::Json.domains) — the
    // dashboard's own fixture.
    collective_activity_domains: COLLECTIVE_DOMAINS,
    ...o.reference,
  } as unknown as ReferenceResponse;
  await db.run("INSERT INTO reference (id, version, body) VALUES (1, ?, ?)", [reference.reference_version, JSON.stringify(reference)]);
  await db.run("INSERT INTO meta (key, value) VALUES ('city_offset_min', '-180') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await applyPage(db, example<ChangesResponse>("changes-last-page.json"));
  return db;
}

// The station changed a record and a round downloaded it: the same page shape as the server's, with one item.
export async function stationChanged(db: Db, type: "household" | "registration", id: string, change: Record<string, unknown>): Promise<void> {
  const first = example<ChangesResponse>("changes-first-page.json");
  const item = first.items.find((candidate) => candidate.type === type && candidate.id === id);
  if (!item) throw new Error(`no ${type} ${id} in the example page`);
  const version = (item.version ?? 0) + 1;
  const body = { ...(item.body as Record<string, unknown>), ...change, version };
  await applyPage(db, { ...first, items: [{ ...item, version, body }] } as unknown as ChangesResponse);
}

// ── 35a: the endemic agent's tablet ──
// City block 12A of NEIGHBORHOOD, and the active transmission block and the pending LIRAa item of the vector page.
export const BLOCK = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const LIRAA_ITEM = "d4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f8a";
export const TRANSMISSION_BLOCK = "f6a7b8c9-d0e1-4f2a-9b3c-5d6e7f8a9b0c";
export const OTHER_NEIGHBORHOOD_BLOCK = "c0ffee41-0000-4000-8000-000000000041";

// The tablet of the endemic agent (515140) with vector_control on: the reference with the v1.3.0 vector domains (`domains`
// null: without them; `limits`: over the example's) and the vector page, whose household HH has the profile with BLOCK.
// `household`: over HH's body as the vector page brings it (its profile, its address, its type).
export async function endemicTablet(o: {
  domains?: null; limits?: Record<string, number>; household?: Record<string, unknown>; session?: Partial<SessionResponse>;
} = {}): Promise<Db> {
  const vector = example<ReferenceResponse>("reference-vector-control.json").vector_control_domains!;
  const domains = o.domains === null ? undefined : { ...vector, limits: { ...vector.limits, ...o.limits } };
  const db = await loadedTablet({ session: { ...example<SessionResponse>("session-endemic-agent.json"), ...o.session }, reference: { vector_control_domains: domains } });
  const page = example<ChangesResponse>("changes-vector-page.json");
  const items = page.items.map((item) => (item.type === "household" && o.household ? { ...item, body: { ...item.body, ...o.household } } : item));
  // A block of another neighbourhood: never offered for HH.
  const other = { type: "city_block", id: OTHER_NEIGHBORHOOD_BLOCK, version: 1, body: { id: OTHER_NEIGHBORHOOD_BLOCK, neighborhood_id: "c0ffee42-0000-4000-8000-000000000042", number: "7", active: true, neighbor_ids: [], version: 1 } };
  await applyPage(db, { ...page, items: [...items, other] } as unknown as ChangesResponse);
  return db;
}

// ── 35b: zoonoses ──
// The animals of the zoonoses page, both in HH: Pipoca (Joana's dog, with a microchip, version 2) and a community dog.
export const ANIMAL = "a7b8c9d0-e1f2-4a3b-8c4d-6e7f8a9b0c1d";
export const COMMUNITY_ANIMAL = "b8c9d0e1-f2a3-4b4c-9d5e-7f8a9b0c1d2e";
// Joana Conceição, the resident of HH the download brings: her patient id.
export const JOANA = "0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a3b";

// A tablet with the zoonoses switch on, the v1.4.0 zoonoses domains (`domains: null`: without them) and the zoonoses page.
// `cbo`: the professional's (the ACS's 515105 by default); `zoonoses`: the switch.
export async function zoonosesTablet(o: { cbo?: string; zoonoses?: boolean; domains?: null } = {}): Promise<Db> {
  const acs = example<SessionResponse>("session-acs.json");
  const session = { ...acs, professional: { ...acs.professional, cbo: o.cbo ?? acs.professional.cbo }, features: { ...acs.features, zoonoses: o.zoonoses ?? true } };
  const domains = o.domains === null ? undefined : example<ReferenceResponse>("reference-zoonoses.json").zoonoses_domains;
  const db = await loadedTablet({ session, reference: { zoonoses_domains: domains } });
  await applyPage(db, example<ChangesResponse>("changes-zoonoses-page.json"));
  return db;
}

// A resident registered on this tablet (new_patient), not yet known to the server: the registration row and its item.
export async function bornResident(db: Db, o: { key: string; name: string; householdKey?: string; queued?: boolean }): Promise<void> {
  const body = { id: o.key, patient: { id: o.key, display_name: o.name }, household_id: o.householdKey ?? HH, family_id: null, is_responsible: false, exit: null };
  await db.run(
    "INSERT INTO registrations (key, id, client_uuid, household_key, patient_id, version, body, name_norm) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?)",
    [o.key, o.key, o.householdKey ?? HH, JSON.stringify(body), o.name.toLowerCase()]);
  if (o.queued !== false) {
    await enqueue(db, { type: "individual_registration", body: { new_patient: { full_name: o.name } }, targetId: o.key, clientUuid: o.key }, () => o.key);
  }
}
