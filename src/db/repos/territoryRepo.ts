// The copy of the server's territory: micro-areas, households (with their
// families inside), registrations and "who to visit". Every row that comes
// from the server is written here — by the download and by a stale answer —
// so the search columns never drift from the body.
//
// A row born on the tablet keeps its key (the client_uuid) for life: when the
// server's record arrives, it is filed under that key, and whatever points to
// the row (registrations, the outbox) stays valid.
import type { FamilyBody, HouseholdBody, MicroAreaBody, RegistrationBody, WhoToVisit } from "../../contract";
import { householdEditable, registrationEditable } from "../../sync/editable";
import { normalizeText } from "../../sync/text";
import { dbEvents } from "../events";
import type { Db } from "../types";

type Table = "households" | "registrations";
const CLIENT_TYPE: Record<Table, string> = { households: "household", registrations: "individual_registration" };

// The local key of the record with this server id: the row that already has it, or the tablet-born row the id was given to.
async function keyOf(db: Db, table: Table, id: string): Promise<string | null> {
  const byId = await db.get<{ key: string }>(`SELECT key FROM ${table} WHERE id = ?`, [id]);
  if (byId) return byId.key;
  const born = await db.get<{ key: string }>(
    `SELECT t.key AS key FROM client_ids c JOIN ${table} t ON t.key = c.client_uuid WHERE c.id = ? AND c.type = ?`, [id, CLIENT_TYPE[table]]);
  return born?.key ?? null;
}

export const territoryRepo = {
  householdKey: (db: Db, id: string) => keyOf(db, "households", id),
  registrationKey: (db: Db, id: string) => keyOf(db, "registrations", id),

  async putMicroArea(db: Db, body: MicroAreaBody): Promise<void> {
    await db.run("INSERT INTO micro_areas (id, body, team_id) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, team_id = excluded.team_id",
      [body.id, JSON.stringify(body), body.team.id]);
  },

  // The server's household becomes the row: body, version, merge base, search columns and the family index.
  // `local_body` (what the person is still editing) and the outbox are never touched here (Q41).
  async putHousehold(db: Db, body: HouseholdBody): Promise<string> {
    const key = (await keyOf(db, "households", body.id)) ?? body.id;
    const columns = [
      body.id, body.micro_area.id, body.version, JSON.stringify(body), body.version, JSON.stringify(householdEditable(body)),
      normalizeText(body.address?.street ?? ""), body.address?.number ?? "", body.location ? 1 : 0,
    ];
    await db.run(
      `INSERT INTO households (key, id, micro_area_id, version, body, base_version, base_body, needs_reload, street_norm, number, has_location)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET id = excluded.id, micro_area_id = excluded.micro_area_id, version = excluded.version, body = excluded.body,
         base_version = excluded.base_version, base_body = excluded.base_body, needs_reload = 0, street_norm = excluded.street_norm,
         number = excluded.number, has_location = excluded.has_location`,
      [key, ...columns]);
    await db.run("DELETE FROM families WHERE household_key = ?", [key]);
    for (const family of body.families) {
      await db.run("INSERT OR REPLACE INTO families (id, household_key, responsible_patient_id) VALUES (?, ?, ?)", [family.id, key, family.responsible.patient_id]);
    }
    return key;
  },

  async putRegistration(db: Db, body: RegistrationBody): Promise<string> {
    const key = (await keyOf(db, "registrations", body.id)) ?? body.id;
    // Filed under the household's local key, which is not the server id when the household was born on the tablet.
    const householdKey = body.household_id === null ? null : (await keyOf(db, "households", body.household_id)) ?? body.household_id;
    await db.run(
      `INSERT INTO registrations (key, id, household_key, family_id, patient_id, version, body, base_version, base_body, needs_reload, name_norm, birth_date, mother_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET id = excluded.id, household_key = excluded.household_key, family_id = excluded.family_id,
         patient_id = excluded.patient_id, version = excluded.version, body = excluded.body, base_version = excluded.base_version,
         base_body = excluded.base_body, needs_reload = 0, name_norm = excluded.name_norm, birth_date = excluded.birth_date, mother_norm = excluded.mother_norm`,
      [key, body.id, householdKey, body.family_id, body.patient.id, body.version, JSON.stringify(body), body.version,
        JSON.stringify(registrationEditable(body)), normalizeText(body.patient.full_name), body.patient.birth_date,
        body.patient.mother_name === null ? null : normalizeText(body.patient.mother_name)]);
    return key;
  },

  // A household that left the scope takes its families and the registrations filed under it.
  async removeHousehold(db: Db, id: string): Promise<void> {
    const key = await keyOf(db, "households", id);
    if (key === null) return;
    await db.run("DELETE FROM registrations WHERE household_key = ?", [key]);
    await db.run("DELETE FROM families WHERE household_key = ?", [key]);
    await db.run("DELETE FROM households WHERE key = ?", [key]);
  },
  async removeRegistration(db: Db, id: string): Promise<void> {
    const key = await keyOf(db, "registrations", id);
    if (key !== null) await db.run("DELETE FROM registrations WHERE key = ?", [key]);
  },

  // The list comes whole or not at all: a non-null one replaces everything.
  async replaceWhoToVisit(db: Db, who: WhoToVisit): Promise<void> {
    await db.exec("DELETE FROM who_to_visit");
    for (const area of who.micro_areas) {
      await db.run("INSERT OR REPLACE INTO who_to_visit (micro_area_id, people, generated_at) VALUES (?, ?, ?)",
        [area.micro_area_id, JSON.stringify(area.people), who.generated_at]);
    }
  },

  async setMeta(db: Db, key: string, value: string): Promise<void> {
    await db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]);
  },
  async getMeta(db: Db, key: string): Promise<string | null> {
    return (await db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? null;
  },

  // The people registered in a household, each with their family — or without one when the registration
  // names a family the household does not have (Q66): the person is shown, never an error.
  async residentsOf(db: Db, householdKey: string): Promise<{ registration: RegistrationBody; family: FamilyBody | null }[]> {
    const row = await db.get<{ body: string }>("SELECT body FROM households WHERE key = ?", [householdKey]);
    const families = row ? ((JSON.parse(row.body) as HouseholdBody).families ?? []) : [];
    const rows = await db.all<{ body: string }>("SELECT body FROM registrations WHERE household_key = ? ORDER BY name_norm, key", [householdKey]);
    return rows.map((r) => {
      const registration = JSON.parse(r.body) as RegistrationBody;
      return { registration, family: families.find((f) => f.id === registration.family_id) ?? null };
    });
  },

  emitTerritory(): void {
    for (const table of ["micro_areas", "households", "families", "registrations", "who_to_visit"]) dbEvents.emit(table);
  },
};
