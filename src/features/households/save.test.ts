import type { ChangesResponse, HouseholdBody, HouseholdItemBody, SessionResponse, UploadRequest } from "../../contract";
import { example } from "../../contract/fixtures";
import { expectValid } from "../../contract/validate";
import { outboxRepo } from "../../db/repos/outboxRepo";
import { createTestDb } from "../../db/testing/sqljsDb";
import type { Db } from "../../db/types";
import { mapTapLocation } from "../../location/capture";
import { applyResults } from "../../sync/dispatch";
import { applyPage } from "../../sync/download";
import { accepted, newUuid, rejected } from "../../sync/testing";
import { AGENT_CBO_NOT_ALLOWED, ERROR_PHRASES } from "../messages/errorPhrases";
import { stationChanged } from "../testing";
import { AGENT_HAS_RESIDENT, CONFLICT_PENDING, HouseholdRefusedError, saveHousehold, type HouseholdFields } from "./save";
import { listHouseholds, readHousehold } from "./view";

const HH = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";
const AREA = "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d";
const NOW = Date.parse("2026-11-14T15:00:00Z");
const deps = { newUuid, now: () => NOW };

// The fields of the contract's own example of a household item.
function fields(over: Partial<HouseholdFields> = {}): HouseholdFields {
  const { household_id: _id, version: _version, ...body } = example<UploadRequest>("upload-household-location.json").items[0].body as HouseholdItemBody;
  return { ...body, ...over };
}
async function territory(): Promise<Db> {
  const db = await createTestDb();
  await applyPage(db, example<ChangesResponse>("changes-first-page.json"));
  return db;
}
const row = (db: Db, key: string) => db.get<{ key: string; id: string | null; client_uuid: string | null; version: number | null; body: string; base_version: number | null; micro_area_id: string; has_location: number }>(
  "SELECT key, id, client_uuid, version, body, base_version, micro_area_id, has_location FROM households WHERE key = ?", [key]);
const wire = (items: { client_uuid: string; type: string; body: Record<string, unknown> }[]) => ({ items: items.map(({ client_uuid, type, body }) => ({ client_uuid, type, body })) });

test("new household: a row born on the tablet and one household item, with the location and no household_id", async () => {
  const db = await territory();
  const gps = { latitude: -25.42847123, longitude: -49.27325411, accuracy_m: 8.5, source: "gps" as const };
  const saved = await saveHousehold(db, { fields: fields({ location: gps }) }, deps);
  expect(saved.key).toBe(saved.clientUuid);

  const born = (await row(db, saved.key))!;
  expect([born.id, born.client_uuid, born.version, born.base_version, born.micro_area_id, born.has_location]).toEqual([null, saved.clientUuid, null, null, AREA, 1]);
  const [item] = await outboxRepo.all(db);
  expect([item.type, item.client_uuid, item.target_id, item.state, item.edit_base_version]).toEqual(["household", saved.clientUuid, saved.key, "pending", null]);
  expect(item.body).toEqual(fields({ location: gps }));
  expect("household_id" in item.body).toBe(false);
  expectValid("upload-request", wire([item]));
});

test("a point marked on the map travels with source map, and validates too", async () => {
  const db = await territory();
  const saved = await saveHousehold(db, { fields: fields({ location: mapTapLocation(-25.4285, -49.2733, 18) }) }, deps);
  const [item] = await outboxRepo.all(db);
  expect((item.body.location as { source: string }).source).toBe("map");
  expectValid("upload-request", wire([item]));
  expect((await readHousehold(db, saved.key))!.body.location).toMatchObject({ latitude: -25.4285, longitude: -49.2733, source: "map" });
});

test("the household just registered is on screen at once: what was typed, marked as waiting to be sent", async () => {
  const db = await territory();
  const saved = await saveHousehold(db, { fields: fields({ contact_phone: "41988887777", location: undefined }) }, deps);
  const view = (await readHousehold(db, saved.key))!;
  expect([view.id, view.bornHere, view.pending, view.conflict]).toEqual([null, true, true, false]);
  expect(view.body.contact_phone).toBe("41988887777");
  expect(view.body.address.street).toBe("das Flores");
  expect(view.body.micro_area).toEqual({ id: AREA, code: "03" });
  expect(view.body.location).toBeNull();
  expect(view.body.families).toEqual([]);
  expect((await listHouseholds(db)).map((h) => h.key)).toContain(saved.key);
});

test("edit of a downloaded household: household_id, the row as target and the row's base as the edit base (Q41)", async () => {
  const db = await territory();
  const before = (await row(db, HH))!;
  const base = JSON.parse((await db.get<{ base_body: string }>("SELECT base_body FROM households WHERE key = ?", [HH]))!.base_body) as Record<string, unknown>;
  const saved = await saveHousehold(db, { key: HH, fields: fields({ contact_phone: "41988887777" }) }, deps);
  expect(saved.key).toBe(HH);

  const [item] = await outboxRepo.all(db);
  expect([item.type, item.target_id, item.edit_base_version, item.client_uuid]).toEqual(["household", HH, before.base_version, saved.clientUuid]);
  expect(item.edit_base_body).toEqual(base);
  expect(item.body).toMatchObject({ household_id: HH, contact_phone: "41988887777" });
  expect("version" in item.body).toBe(false); // filled when it is sent
  // The row keeps what the server said; the screen shows what the person typed.
  expect((await row(db, HH))!.body).toBe(before.body);
  const view = (await readHousehold(db, HH))!;
  expect([view.body.contact_phone, view.pending, view.bornHere]).toEqual(["41988887777", true, false]);
});

test("second edit while the first waits is the same item: same client_uuid, new body, the first base", async () => {
  const db = await territory();
  const first = await saveHousehold(db, { key: HH, fields: fields({ contact_phone: "41988887777" }) }, deps);
  const [waiting] = await outboxRepo.all(db);
  const second = await saveHousehold(db, { key: HH, fields: fields({ contact_phone: "41977776666", refused: false }) }, deps);
  const items = await outboxRepo.all(db);
  expect(items).toHaveLength(1);
  expect(second.clientUuid).toBe(first.clientUuid);
  expect(items[0].body.contact_phone).toBe("41977776666");
  expect([items[0].edit_base_version, items[0].edit_base_body]).toEqual([waiting.edit_base_version, waiting.edit_base_body]);
});

test("a household with an edit in conflict is not edited again until the conflict is solved", async () => {
  const db = await territory();
  await saveHousehold(db, { key: HH, fields: fields({ contact_phone: "41988887777" }) }, deps);
  const [item] = await outboxRepo.all(db);
  await outboxRepo.update(db, item.seq, { state: "conflict", conflicts: [{ field: "contact_phone", base: null, tablet: "41988887777", station: "4130000000" }] as never });
  await expect(saveHousehold(db, { key: HH, fields: fields({ contact_phone: "41900000000" }) }, deps)).rejects.toThrow(CONFLICT_PENDING);
  expect(CONFLICT_PENDING).toBe("Resolva o conflito deste domicílio antes de editar");
  expect(await outboxRepo.all(db)).toHaveLength(1);
  expect((await readHousehold(db, HH))!.conflict).toBe(true);
});

test("edit of a tablet-born household whose creation is already on its way waits for the creation's answer", async () => {
  const db = await territory();
  const born = await saveHousehold(db, { fields: fields() }, deps);
  const [creation] = await outboxRepo.all(db);
  await outboxRepo.update(db, creation.seq, { state: "sending" });
  const edit = await saveHousehold(db, { key: born.key, fields: fields({ contact_phone: "41988887777" }) }, deps);
  const items = await outboxRepo.all(db);
  expect(items).toHaveLength(2);
  expect(edit.clientUuid).not.toBe(born.clientUuid);
  expect(items[1].depends_on).toEqual([{ client_uuid: born.clientUuid, kind: "version" }]);
  expect([items[1].target_id, "household_id" in items[1].body]).toEqual([born.key, false]);
});

test("accepted: the row takes the server's id and version, and shows what was accepted with nothing left in the line", async () => {
  const db = await territory();
  const born = await saveHousehold(db, { fields: fields({ contact_phone: "41988887777" }) }, deps);
  const [creation] = await outboxRepo.all(db);
  const NEW_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
  await applyResults(db, [creation], [accepted(creation, { id: NEW_ID, version: 1 })], { onStale: async () => undefined });

  expect(await outboxRepo.all(db)).toEqual([]);
  const after = (await row(db, born.key))!;
  expect([after.id, after.version, after.base_version]).toEqual([NEW_ID, 1, 1]);
  const view = (await readHousehold(db, born.key))!;
  expect([view.id, view.pending, view.body.id, view.body.version, view.body.contact_phone]).toEqual([NEW_ID, false, NEW_ID, 1, "41988887777"]);

  // And an accepted edit of a downloaded one: the row's body carries the accepted fields until the next download.
  await saveHousehold(db, { key: HH, fields: fields({ contact_phone: "41977776666" }) }, deps);
  const [edit] = await outboxRepo.all(db);
  await applyResults(db, [{ ...edit, sent_version: 3 }], [accepted(edit, { id: HH, version: 4 })], { onStale: async () => undefined });
  const edited = (await readHousehold(db, HH))!;
  expect([edited.pending, edited.body.contact_phone, edited.body.version]).toEqual([false, "41977776666", 4]);
  expect((JSON.parse((await row(db, HH))!.body) as HouseholdBody).families.length).toBeGreaterThan(0); // the families were not touched
});

// Review C1: a round may download a newer version while the form is open (the PIN veil keeps forms mounted and unlocking
// starts a round). The edit must still say what the PERSON saw, or the station's change is overwritten with no merge.
test("the edit base is what the form loaded, not what a download wrote on the row meanwhile (Q41)", async () => {
  const db = await territory();
  const opened = (await readHousehold(db, HH))!;
  expect(opened.base).toEqual({ version: 3, body: expect.objectContaining({ contact_phone: "41999990000" }) });
  await stationChanged(db, "household", HH, { contact_phone: "4130000000" });
  expect((await row(db, HH))!.base_version).toBe(4);

  await saveHousehold(db, { key: HH, fields: fields({ refused: false }), editBase: opened.base }, deps);
  const [item] = await outboxRepo.all(db);
  expect(item.edit_base_version).toBe(3);
  expect(item.edit_base_body).toEqual(opened.base!.body);
});

test("an unknown household is refused", async () => {
  const db = await territory();
  await expect(saveHousehold(db, { key: "00000000-0000-4000-8000-00000000dead", fields: fields() }, deps)).rejects.toThrow("domicílio não encontrado");
});

// ── Q13(1): the endemic agent (515140, vector_control and territory_registry on) registers only non-residential properties ──
const AGENT_AREA = "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e"; // the micro-area assigned to him in the session
// `areas`: the micro-areas assigned to him in the session, in place of the example's (07).
function agentSession(areas?: { id: string; code: string }[]): SessionResponse {
  const session = example<SessionResponse>("session-endemic-agent.json");
  if (!areas) return session;
  const [team] = session.teams;
  return { ...session, teams: [{ ...team, micro_areas: areas.map((area) => ({ ...team.micro_areas[0], ...area, name: `Microárea ${area.code}` })) }] };
}
async function agentTerritory(areas?: { id: string; code: string }[]): Promise<Db> {
  const db = await territory();
  await db.run("INSERT INTO session (id, body, fetched_at) VALUES (1, ?, '2026-11-14T12:00:00.000Z')", [JSON.stringify(agentSession(areas))]);
  return db;
}

test("agent saving a residential type is refused on screen and nothing is enqueued", async () => {
  // HH's area is his too here: the type is what refuses.
  const db = await agentTerritory([{ id: AGENT_AREA, code: "07" }, { id: AREA, code: "03" }]);
  const before = await db.all("SELECT key FROM households");
  const refusal = saveHousehold(db, { fields: fields({ micro_area_id: AGENT_AREA, property_type: "1" }) }, deps);
  await expect(refusal).rejects.toBeInstanceOf(HouseholdRefusedError);
  // Q54: the dashboard's phrase for the agent, not "Seu CBO não permite" (his CBO is allowed, the type is not).
  await expect(refusal).rejects.toMatchObject({ problem: { path: "property_type", message: AGENT_CBO_NOT_ALLOWED } });
  // Nor a residential one turned into a shop: the api looks at the type the household has too (current_property_type).
  await expect(saveHousehold(db, { key: HH, fields: fields({ property_type: "2", living_conditions: {} }) }, deps))
    .rejects.toMatchObject({ problem: { path: "property_type", message: AGENT_CBO_NOT_ALLOWED } });
  expect(await outboxRepo.all(db)).toEqual([]);
  expect(await db.all("SELECT key FROM households")).toEqual(before);
});

test("agent creates a strategic point (type 4) in an assigned micro area: one household item, body valid for upload-request-v1.json", async () => {
  const db = await agentTerritory();
  const body = fields({ micro_area_id: AGENT_AREA, property_type: "4", living_conditions: {} });
  const saved = await saveHousehold(db, { fields: body }, deps);
  const items = await outboxRepo.all(db);
  expect(items).toHaveLength(1);
  expect([items[0].type, items[0].client_uuid, items[0].target_id]).toEqual(["household", saved.clientUuid, saved.key]);
  expect(items[0].body).toEqual(body);
  expectValid("upload-request", wire(items));
  const view = (await readHousehold(db, saved.key))!;
  expect([view.body.property_type, view.body.micro_area.id, view.pending]).toEqual(["4", AGENT_AREA, true]);

  // An edit of his own strategic point is the same item, as for the ACS.
  await saveHousehold(db, { key: saved.key, fields: { ...body, contact_phone: "41988887777" } }, deps);
  expect(await outboxRepo.all(db)).toHaveLength(1);
});

test("the server's cbo_not_allowed on the agent's household goes to needs attention, as in the 24c", async () => {
  const db = await agentTerritory();
  await saveHousehold(db, { fields: fields({ micro_area_id: AGENT_AREA, property_type: "2", living_conditions: {} }) }, deps);
  const [creation] = await outboxRepo.all(db);
  await applyResults(db, [creation], [rejected(creation, "cbo_not_allowed")], { onStale: async () => undefined });
  expect(await outboxRepo.bySeq(db, creation.seq)).toMatchObject({ state: "needs_attention", error: "cbo_not_allowed" });
});

test("agent: a micro area outside his session is refused on screen with the api's out_of_scope, on create and on edit of his draft", async () => {
  const db = await agentTerritory();
  const outside = { problem: { path: "micro_area_id", message: ERROR_PHRASES.out_of_scope } };
  await expect(saveHousehold(db, { fields: fields({ micro_area_id: AREA, property_type: "2", living_conditions: {} }) }, deps)).rejects.toMatchObject(outside);
  expect(await outboxRepo.all(db)).toEqual([]);

  // His own draft, moved to an area that is not his…
  const body = fields({ micro_area_id: AGENT_AREA, property_type: "2", living_conditions: {} });
  const saved = await saveHousehold(db, { fields: body }, deps);
  const [creation] = await outboxRepo.all(db);
  await expect(saveHousehold(db, { key: saved.key, fields: { ...body, micro_area_id: AREA } }, deps)).rejects.toMatchObject(outside);
  // …or kept in one whose assignment ended (the session no longer has it): nothing changes in the line.
  await db.run("UPDATE session SET body = ? WHERE id = 1", [JSON.stringify(agentSession([{ id: "9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0", code: "08" }]))]);
  await expect(saveHousehold(db, { key: saved.key, fields: { ...body, contact_phone: "41988887777" } }, deps)).rejects.toMatchObject(outside);
  expect(await outboxRepo.all(db)).toEqual([creation]);
});

test("agent: a non-residential property with an active resident on the tablet is not edited; an exited resident does not hold it", async () => {
  const db = await agentTerritory([{ id: AREA, code: "03" }]);
  // The station turned HH (with Joana's active registration) into a shop.
  await stationChanged(db, "household", HH, { property_type: "2", living_conditions: {} });
  const edit = { key: HH, fields: fields({ property_type: "2", living_conditions: {} }) };
  await expect(saveHousehold(db, edit, deps)).rejects.toMatchObject({ problem: { message: AGENT_HAS_RESIDENT } });
  expect(AGENT_HAS_RESIDENT).toBe("este imóvel tem morador ativo; só a equipe da APS edita");
  expect(await outboxRepo.all(db)).toEqual([]);

  const joana = (await db.get<{ key: string; body: string }>("SELECT key, body FROM registrations WHERE household_key = ?", [HH]))!;
  const exited = { ...JSON.parse(joana.body), status: "exited", exit: { reason: "mudanca_territorio", on: "2026-11-10", death_on: null, death_certificate: null } };
  await db.run("UPDATE registrations SET body = ? WHERE key = ?", [JSON.stringify(exited), joana.key]);
  await saveHousehold(db, edit, deps);
  expect(await outboxRepo.all(db)).toHaveLength(1);
});
