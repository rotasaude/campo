// Test support for the form screens: a tablet after its first load — session, territory and a reference with the
// complete registration dictionaries (the contract's example carries only an excerpt of them).
import type { ChangesResponse, ReferenceResponse, SessionResponse } from "../contract";
import { example } from "../contract/fixtures";
import { createTestDb } from "../db/testing/sqljsDb";
import type { Db } from "../db/types";
import fullDictionaries from "../rules/testing/registrationDictionaries.json";
import { COLLECTIVE_DOMAINS } from "../rules/testing/visitFixtures";
import { applyPage } from "../sync/download";
import { referenceFixture } from "../sync/testing";

export const HH = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";
export const AREA = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
export const NEIGHBORHOOD = "c0ffee40-0000-4000-8000-000000000040";

export async function loadedTablet(o: { session?: Partial<SessionResponse> } = {}): Promise<Db> {
  const db = await createTestDb();
  const session = { ...example<SessionResponse>("session-acs.json"), ...o.session };
  await db.run("INSERT INTO session (id, body, fetched_at) VALUES (1, ?, '2026-11-14T12:00:00.000Z')", [JSON.stringify(session)]);
  const reference = {
    ...referenceFixture(), registration_dictionaries: fullDictionaries.registration_dictionaries, string_domains: fullDictionaries.string_domains,
    // With the rules of each activity type, in the shape the api serves them (CollectiveActivities::Json.domains) — the
    // dashboard's own fixture.
    collective_activity_domains: COLLECTIVE_DOMAINS,
  } as unknown as ReferenceResponse;
  await db.run("INSERT INTO reference (id, version, body) VALUES (1, ?, ?)", [reference.reference_version, JSON.stringify(reference)]);
  await db.run("INSERT INTO meta (key, value) VALUES ('city_offset_min', '-180') ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  await applyPage(db, example<ChangesResponse>("changes-last-page.json"));
  return db;
}
